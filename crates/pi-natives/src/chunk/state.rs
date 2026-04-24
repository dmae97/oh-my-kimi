use std::{
	collections::HashMap,
	sync::{Arc, LazyLock},
};

use napi::{Error, Result};
use napi_derive::napi;
use regex::Regex;

use super::{
	build_chunk_tree,
	indent::{detect_file_indent_char, detect_file_indent_step, normalize_to_tabs},
	resolve::{
		ParsedSelector, chunk_region_range, format_region_ref, format_selector_tree,
		resolve_chunk_selector, resolve_chunk_with_crc, split_selector_crc_and_region,
	},
};
use crate::chunk::types::{
	ChunkInfo, ChunkNode, ChunkReadStatus, ChunkReadTarget, ChunkRegion, ChunkTree, EditParams,
	EditResult, ReadRenderParams, ReadResult, RenderParams, VisibleLineRange,
};

const LINE_RANGE_SELECTOR_RE: &str = r"^L(\d+)(?:-L?(\d+))?$";
const TLAPLUS_BEGIN_TRANSLATION_RE: &str = r"^\s*\\\*\s*BEGIN TRANSLATION\s*$";
const TLAPLUS_END_TRANSLATION_RE: &str = r"^\s*\\\*\s*END TRANSLATION\s*$";

static LINE_RANGE_SELECTOR_REGEX: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(LINE_RANGE_SELECTOR_RE).expect("line range regex must compile"));
static TLAPLUS_BEGIN_TRANSLATION_REGEX: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(TLAPLUS_BEGIN_TRANSLATION_RE).expect("tlaplus begin regex must compile")
});
static TLAPLUS_END_TRANSLATION_REGEX: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(TLAPLUS_END_TRANSLATION_RE).expect("tlaplus end regex must compile")
});

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConflictMeta {
	pub theirs_content:  String,
	pub ours_label:      String,
	pub theirs_label:    String,
	pub base_content:    Option<String>,
	pub base_label:      Option<String>,
	pub ours_start_byte: usize,
	pub ours_end_byte:   usize,
}

#[derive(Clone)]
pub struct ChunkStateInner {
	pub(crate) source:        String,
	pub(crate) language:      String,
	pub(crate) tree:          ChunkTree,
	pub(crate) notebook:      Option<crate::chunk::ast_ipynb::SharedNotebookContext>,
	pub(crate) conflict_meta: HashMap<String, ConflictMeta>,
	lookup:                   HashMap<String, usize>,
	checksum_lookup:          HashMap<String, Vec<usize>>,
	leaf_lookup:              HashMap<String, Vec<usize>>,
	suffix_lookup:            HashMap<String, Vec<usize>>,
}

impl ChunkStateInner {
	pub(crate) fn parse(source: String, language: String) -> Result<Self> {
		let normalized_language = normalize_language(language.as_str());
		if normalized_language == "ipynb" {
			let parsed =
				crate::chunk::ast_ipynb::parse_notebook(&source).map_err(napi::Error::from_reason)?;
			let kernel_lang = parsed.context.kernel_language.clone();
			let tree = crate::chunk::ast_ipynb::build_notebook_tree_from_virtual(
				parsed.virtual_source.as_str(),
				kernel_lang.as_str(),
			)
			.map_err(napi::Error::from_reason)?;
			let ctx = std::sync::Arc::new(parsed.context);
			let mut inner = Self::new(parsed.virtual_source, normalized_language, tree);
			inner.notebook = Some(ctx);
			return Ok(inner);
		}
		if crate::chunk::conflict::has_conflict_markers(source.as_str()) {
			let conflicts = crate::chunk::conflict::detect_conflicts(source.as_str());
			if !conflicts.is_empty() {
				let clean_result = crate::chunk::conflict::accept_ours(source.as_str(), &conflicts);
				let mut tree =
					build_chunk_tree(clean_result.source.as_str(), normalized_language.as_str())?;
				let conflict_meta = crate::chunk::conflict::inject_conflict_chunks(
					&mut tree,
					clean_result.source.as_str(),
					&clean_result,
				);
				let mut inner = Self::new(clean_result.source, normalized_language, tree);
				inner.conflict_meta = conflict_meta;
				return Ok(inner);
			}
		}
		let tree = build_chunk_tree(source.as_str(), normalized_language.as_str())?;
		Ok(Self::new(source, normalized_language, tree))
	}

	pub(crate) fn new(source: String, language: String, tree: ChunkTree) -> Self {
		let mut lookup = HashMap::new();
		let mut checksum_lookup = HashMap::new();
		let mut leaf_lookup = HashMap::new();
		let mut suffix_lookup = HashMap::new();
		for (index, chunk) in tree.chunks.iter().enumerate() {
			lookup.insert(chunk.path.clone(), index);
			checksum_lookup
				.entry(chunk.checksum.clone())
				.or_insert_with(Vec::new)
				.push(index);
			if chunk.path.is_empty() {
				continue;
			}
			if let Some(leaf) = chunk.path.rsplit('.').next() {
				leaf_lookup
					.entry(leaf.to_string())
					.or_insert_with(Vec::new)
					.push(index);
			}
			let segments = chunk.path.split('.').collect::<Vec<_>>();
			for start in 1..segments.len() {
				suffix_lookup
					.entry(segments[start..].join("."))
					.or_insert_with(Vec::new)
					.push(index);
			}
		}
		Self {
			source,
			language,
			tree,
			notebook: None,
			conflict_meta: HashMap::new(),
			lookup,
			checksum_lookup,
			leaf_lookup,
			suffix_lookup,
		}
	}

	pub(crate) const fn source(&self) -> &str {
		self.source.as_str()
	}

	pub(crate) const fn language(&self) -> &str {
		self.language.as_str()
	}

	pub(crate) const fn tree(&self) -> &ChunkTree {
		&self.tree
	}

	pub(crate) fn root(&self) -> Option<&ChunkNode> {
		self.chunk("")
	}

	pub(crate) fn chunk(&self, path: &str) -> Option<&ChunkNode> {
		self
			.lookup
			.get(path)
			.and_then(|index| self.tree.chunks.get(*index))
	}

	pub(crate) fn chunk_by_index(&self, index: usize) -> Option<&ChunkNode> {
		self.tree.chunks.get(index)
	}

	pub(crate) fn chunks_by_checksum(&self, checksum: &str) -> Vec<&ChunkNode> {
		self
			.checksum_lookup
			.get(checksum)
			.into_iter()
			.flatten()
			.filter_map(|index| self.chunk_by_index(*index))
			.collect()
	}

	pub(crate) fn chunks_by_leaf(&self, leaf: &str) -> Vec<&ChunkNode> {
		self
			.leaf_lookup
			.get(leaf)
			.into_iter()
			.flatten()
			.filter_map(|index| self.chunk_by_index(*index))
			.collect()
	}

	pub(crate) fn chunks_by_suffix(&self, suffix: &str) -> Vec<&ChunkNode> {
		self
			.suffix_lookup
			.get(suffix)
			.into_iter()
			.flatten()
			.filter_map(|index| self.chunk_by_index(*index))
			.collect()
	}

	pub(crate) fn chunks(&self) -> impl Iterator<Item = &ChunkNode> {
		self.tree.chunks.iter()
	}

	pub(crate) fn child_chunks(&self, parent_path: &str) -> Vec<&ChunkNode> {
		self
			.chunk(parent_path)
			.map(|parent| {
				parent
					.children
					.iter()
					.filter_map(|path| self.chunk(path.as_str()))
					.collect()
			})
			.unwrap_or_default()
	}

	pub(crate) fn line_to_containing_chunk_path(&self, line: u32) -> Option<String> {
		crate::chunk::line_to_chunk_path(&self.tree, line)
	}
}

/// Parsed file as a chunk tree: query nodes, render views, format grep hits,
/// and apply edits.
#[napi]
#[derive(Clone)]
pub struct ChunkState {
	inner: Arc<ChunkStateInner>,
}

impl ChunkState {
	pub(crate) fn from_inner(inner: ChunkStateInner) -> Self {
		Self { inner: Arc::new(inner) }
	}

	pub(crate) fn inner(&self) -> &ChunkStateInner {
		self.inner.as_ref()
	}
}

#[napi]
impl ChunkState {
	/// Build chunk state by parsing `source` with the given `language` id (e.g.
	/// `typescript`).
	#[napi(factory)]
	pub fn parse(source: String, language: String) -> Result<Self> {
		ChunkStateInner::parse(source, language).map(Self::from_inner)
	}

	/// Normalized language identifier used for the tree-sitter parse.
	#[napi(getter)]
	pub fn language(&self) -> String {
		self.inner.language().to_string()
	}

	/// Full source text for this file.
	#[napi(getter)]
	pub fn source(&self) -> String {
		self.inner.source().to_string()
	}

	/// Stable checksum for the entire file contents.
	#[napi(getter)]
	pub fn checksum(&self) -> String {
		self.inner.tree().checksum.clone()
	}

	/// Line count of the source buffer.
	#[napi(getter)]
	pub fn line_count(&self) -> u32 {
		self.inner.tree().line_count
	}

	/// Count of tree-sitter error nodes seen while building the tree.
	#[napi(getter)]
	pub fn parse_errors(&self) -> u32 {
		self.inner.tree().parse_errors
	}

	/// True when a fallback classifier produced the tree.
	#[napi(getter)]
	pub fn fallback(&self) -> bool {
		self.inner.tree().fallback
	}

	/// Selector path string for the synthetic root (often empty).
	#[napi(getter)]
	pub fn root_path(&self) -> String {
		self.inner.tree().root_path.clone()
	}

	/// Top-level child chunk paths under the root.
	#[napi(getter)]
	pub fn root_children(&self) -> Vec<String> {
		self.inner.tree().root_children.clone()
	}

	/// Total number of chunk nodes.
	#[napi(getter)]
	pub fn chunk_count(&self) -> u32 {
		self.inner.tree().chunks.len() as u32
	}

	/// True when the parsed file contains unresolved merge conflicts.
	#[napi]
	pub fn has_conflicts(&self) -> bool {
		!self.inner.conflict_meta.is_empty()
	}

	/// Count of unresolved merge conflicts represented in the chunk tree.
	#[napi]
	pub fn conflict_count(&self) -> u32 {
		self.inner.conflict_meta.len() as u32
	}

	/// Summary for the root chunk, if it exists.
	#[napi]
	pub fn root(&self) -> Option<ChunkInfo> {
		self.inner.root().map(chunk_info)
	}

	/// Look up [`ChunkInfo`] for a chunk selector path.
	#[napi]
	pub fn chunk(&self, chunk_path: String) -> Option<ChunkInfo> {
		let mut warnings = Vec::new();
		resolve_chunk_selector(self.inner(), Some(chunk_path.as_str()), &mut warnings)
			.ok()
			.map(chunk_info)
	}

	/// Every chunk node as a [`ChunkInfo`] list.
	#[napi]
	pub fn chunks(&self) -> Vec<ChunkInfo> {
		self.inner.chunks().map(chunk_info).collect()
	}

	/// Direct children of `chunkPath` (use empty or omit for root); errors if
	/// the path is missing.
	#[napi]
	pub fn children(&self, chunk_path: Option<String>) -> Result<Vec<ChunkInfo>> {
		let parent = if let Some(chunk_path) = chunk_path {
			let mut warnings = Vec::new();
			resolve_chunk_selector(self.inner(), Some(chunk_path.as_str()), &mut warnings)
				.map_err(Error::from_reason)?
		} else {
			self
				.inner
				.root()
				.ok_or_else(|| Error::from_reason("Chunk tree is missing the root chunk".to_string()))?
		};
		Ok(self
			.inner
			.child_chunks(parent.path.as_str())
			.into_iter()
			.map(chunk_info)
			.collect())
	}

	/// Chunk selector path that contains 1-based source line `line`, if any.
	#[napi]
	pub fn line_to_containing_chunk_path(&self, line: u32) -> Option<String> {
		self.inner.line_to_containing_chunk_path(line)
	}

	/// Render a chunk subtree or listing as UTF-8 text for tools.
	#[napi]
	pub fn render(&self, params: RenderParams) -> String {
		crate::chunk::render::render_state(self.inner(), &params)
	}

	/// Parse `readPath` (selector, line scope, etc.) and return rendered text or
	/// errors.
	#[napi]
	pub fn render_read(&self, params: ReadRenderParams) -> Result<ReadResult> {
		let ParsedChunkReadPath { selector, crc, region } =
			match parse_chunk_read_path(params.read_path.as_str()) {
				Ok(parsed) => parsed,
				Err(err) => {
					return Ok(ReadResult {
						text:  format!("{}\n\n{}", params.display_path, err),
						chunk: Some(ChunkReadTarget {
							status:   ChunkReadStatus::UnsupportedRegion,
							selector: params.read_path.clone(),
						}),
					});
				},
			};
		let visible_range = selector.as_deref().and_then(parse_visible_line_range);
		let Some(root) = self.inner.root() else {
			return Ok(ReadResult {
				text:  format!("{}\n\n[Chunk tree root missing]", params.display_path),
				chunk: None,
			});
		};

		if let Some(visible_range) = visible_range {
			if visible_range.start_line > self.inner.tree().line_count {
				let suggestion = if self.inner.tree().line_count == 0 {
					"The file is empty.".to_string()
				} else {
					format!(
						"Use sel=L1 to read from the start, or sel=L{} to read the last line.",
						self.inner.tree().line_count
					)
				};
				return Ok(ReadResult {
					text:  format!(
						"Line {} is beyond end of file ({} lines total). {suggestion}",
						visible_range.start_line,
						self.inner.tree().line_count,
					),
					chunk: None,
				});
			}

			let clamped_range = VisibleLineRange {
				start_line: visible_range.start_line,
				end_line:   visible_range.end_line.min(self.inner.tree().line_count),
			};
			let notice = format!(
				"[Notice: chunk view scoped to requested lines L{}-L{}; clipped chunks keep head/tail \
				 context and collapse non-overlapping children.]",
				clamped_range.start_line, clamped_range.end_line
			);
			let text = self.render(RenderParams {
				chunk_path:           Some(root.path.clone()),
				title:                params.display_path.clone(),
				language_tag:         params.language_tag.clone(),
				visible_range:        Some(clamped_range),
				render_children_only: true,
				omit_checksum:        params.omit_checksum,
				anchor_style:         params.anchor_style,
				show_leaf_preview:    true,
				tab_replacement:      params.tab_replacement,
				normalize_indent:     params.normalize_indent,
				focused_paths:        None,
			});
			return Ok(ReadResult { text: format!("{notice}\n\n{text}"), chunk: None });
		}

		if selector.as_deref().is_none_or(str::is_empty) && crc.is_none() && region.is_none() {
			return Ok(ReadResult {
				text:  self.render(RenderParams {
					chunk_path:           Some(root.path.clone()),
					title:                params.display_path.clone(),
					language_tag:         params.language_tag.clone(),
					visible_range:        None,
					render_children_only: true,
					omit_checksum:        params.omit_checksum,
					anchor_style:         params.anchor_style,
					show_leaf_preview:    true,
					tab_replacement:      params.tab_replacement,
					normalize_indent:     params.normalize_indent,
					focused_paths:        None,
				}),
				chunk: None,
			});
		}

		if selector.as_deref() == Some("?") {
			let mut lines = vec![format!("{} chunks (dot-joined paths):", params.display_path)];
			lines.extend(format_selector_tree(
				self.inner.tree(),
				&self.inner.tree().root_children,
				false,
			));
			return Ok(ReadResult { text: lines.join("\n"), chunk: None });
		}

		let mut warnings = Vec::new();
		let resolved = match resolve_chunk_with_crc(
			self.inner(),
			selector.as_deref(),
			crc.as_deref(),
			&mut warnings,
		) {
			Ok(resolved) => resolved,
			Err(err) => {
				let sel = selector.unwrap_or_default();
				return Ok(ReadResult {
					text:  format!("{}:{}\n\n{}", params.display_path, sel, err),
					chunk: Some(ChunkReadTarget { status: ChunkReadStatus::NotFound, selector: sel }),
				});
			},
		};
		let chunk = resolved.chunk;
		// Use the region from parse_chunk_read_path, NOT region,
		// because resolve_chunk_with_crc re-parses the already-cleaned
		// selector and loses the region suffix.
		let selector_ref = format_region_ref(chunk, region);

		// Fall back to whole-chunk read when the chunk has no real region
		// boundaries (e.g. markdown fenced blocks, leaf chunks without
		// prologue/epilogue). Without this, `^` on such chunks returns
		// "[Empty @^ region]" instead of the whole chunk.
		let region = if region.is_some()
			&& (chunk.prologue_end_byte.is_none() || chunk.epilogue_start_byte.is_none())
		{
			None
		} else {
			region
		};

		if let Some(absolute_line_range) = params.absolute_line_range {
			let req_start = absolute_line_range.start_line;
			let req_end = absolute_line_range.end_line;
			let low = chunk.start_line.max(req_start.min(req_end));
			let high = chunk.end_line.min(req_start.max(req_end));
			if low > high {
				let requested = if req_start == req_end {
					format!("L{req_start}")
				} else {
					format!("L{req_start}-L{req_end}")
				};
				return Ok(ReadResult {
					text:  format!(
						"Requested range {requested} does not overlap {}:{} (lines {}-{}).",
						params.display_path, chunk.path, chunk.start_line, chunk.end_line
					),
					chunk: Some(ChunkReadTarget {
						status:   ChunkReadStatus::Ok,
						selector: selector_ref,
					}),
				});
			}
		}

		if let Some(target_region) = region {
			let masked_source = mask_chunk_display_source(self.inner.source(), self.inner.language());
			let (start, end) = chunk_region_range(chunk, target_region);
			let tab_replacement = params.tab_replacement.as_deref().unwrap_or("    ");
			let normalize_indent = params.normalize_indent.unwrap_or(false).then(|| {
				(
					detect_file_indent_char(self.inner.source(), self.inner.tree()),
					detect_file_indent_step(self.inner.source(), self.inner.tree()) as usize,
				)
			});
			// Extend the region start to the beginning of the line so that the
			// leading indentation of the first line is included.  Without this,
			// regions whose start_byte is mid-line (e.g. a decorator `@property`
			// inside a class) would show the first line without indentation,
			// making the normalization inconsistent with subsequent lines.
			let display_start = masked_source[..start].rfind('\n').map_or(0, |nl| nl + 1);
			let region_text = masked_source
				.get(display_start..end)
				.unwrap_or_default()
				.split('\n')
				.map(|line| match normalize_indent {
					Some((indent_char, indent_step)) => {
						normalize_to_tabs(line, indent_char, indent_step)
					},
					None => line.replace('\t', tab_replacement),
				})
				.collect::<Vec<_>>()
				.join("\n");
			let text = if region_text.is_empty() {
				format!("{selector_ref}\n\n[Empty @{} region]", target_region.as_str())
			} else {
				format!("{selector_ref}\n\n{region_text}")
			};
			return Ok(ReadResult {
				text,
				chunk: Some(ChunkReadTarget { status: ChunkReadStatus::Ok, selector: selector_ref }),
			});
		}

		Ok(ReadResult {
			text:  self.render(RenderParams {
				chunk_path:           Some(chunk.path.clone()),
				title:                format!("{}:{}", params.display_path, chunk.path),
				language_tag:         params.language_tag.clone(),
				visible_range:        None,
				render_children_only: false,
				omit_checksum:        params.omit_checksum,
				anchor_style:         params.anchor_style,
				show_leaf_preview:    true,
				tab_replacement:      params.tab_replacement,
				normalize_indent:     params.normalize_indent,
				focused_paths:        None,
			}),
			chunk: Some(ChunkReadTarget { status: ChunkReadStatus::Ok, selector: selector_ref }),
		})
	}

	/// Prefix a grep line with `display_path` and the chunk path for
	/// `line_number`, when known.
	#[napi]
	pub fn format_grep_line(&self, display_path: String, line_number: u32, line: String) -> String {
		let chunk_path = self.inner.line_to_containing_chunk_path(line_number);
		let location = chunk_path.map_or_else(
			|| display_path.clone(),
			|chunk_path| {
				if chunk_path.is_empty() {
					display_path.clone()
				} else {
					format!("{display_path}:{chunk_path}")
				}
			},
		);
		format!("{location}>{line_number}|{line}")
	}

	/// Apply batch edits, re-parse, write files, and return updated state and
	/// messaging.
	#[napi]
	pub fn apply_edits(&self, params: EditParams) -> Result<EditResult> {
		crate::chunk::edit::apply_edits(self, &params).map_err(Error::from_reason)
	}
}

#[derive(Clone)]
struct ParsedChunkReadPath {
	selector: Option<String>,
	crc:      Option<String>,
	region:   Option<ChunkRegion>,
}

fn normalize_language(language: &str) -> String {
	language.trim().to_ascii_lowercase()
}

fn chunk_info(chunk: &ChunkNode) -> ChunkInfo {
	ChunkInfo {
		path:       chunk.path.clone(),
		identifier: chunk.identifier.clone(),
		checksum:   chunk.checksum.clone(),
		start_line: chunk.start_line,
		end_line:   chunk.end_line,
		leaf:       chunk.leaf,
	}
}

fn chunk_read_path_separator_index(read_path: &str) -> Option<usize> {
	if read_path.len() >= 3 {
		let bytes = read_path.as_bytes();
		if bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\') {
			return read_path[2..].find(':').map(|index| index + 2);
		}
	}
	read_path.find(':')
}

fn parse_chunk_read_path(read_path: &str) -> std::result::Result<ParsedChunkReadPath, String> {
	let raw_selector =
		chunk_read_path_separator_index(read_path).map(|index| &read_path[(index + 1)..]);
	let ParsedSelector { selector, crc, region, .. } =
		split_selector_crc_and_region(raw_selector, None, None)?;
	Ok(ParsedChunkReadPath { selector, crc, region })
}

fn parse_visible_line_range(selector: &str) -> Option<VisibleLineRange> {
	let captures = LINE_RANGE_SELECTOR_REGEX.captures(selector)?;
	let start_line = captures.get(1)?.as_str().parse::<u32>().ok()?.max(1);
	let end_line = captures
		.get(2)
		.and_then(|m| m.as_str().parse::<u32>().ok())
		.unwrap_or(start_line)
		.max(start_line);
	Some(VisibleLineRange { start_line, end_line })
}

pub fn mask_chunk_display_source(source: &str, language: &str) -> String {
	if language != "tlaplus" {
		return source.to_string();
	}
	let lines = source.split('\n').collect::<Vec<_>>();
	let mut masked = lines
		.iter()
		.map(|line| (*line).to_string())
		.collect::<Vec<_>>();
	let mut index = 0usize;
	while index < lines.len() {
		if !TLAPLUS_BEGIN_TRANSLATION_REGEX.is_match(lines[index]) {
			index += 1;
			continue;
		}
		let begin_index = index;
		let mut end_index = begin_index + 1;
		while end_index < lines.len() && !TLAPLUS_END_TRANSLATION_REGEX.is_match(lines[end_index]) {
			end_index += 1;
		}
		if begin_index + 1 < lines.len() {
			masked[begin_index + 1] = "\\* [translation hidden]".to_string();
			for line in masked
				.iter_mut()
				.take(end_index.min(lines.len()))
				.skip(begin_index + 2)
			{
				line.clear();
			}
		}
		index = end_index + 1;
	}
	masked.join("\n")
}

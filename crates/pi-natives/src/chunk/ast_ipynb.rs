//! Jupyter notebook (`.ipynb`) chunker.
//!
//! Notebooks are JSON documents whose `cells` array carries the code/markdown
//! that users actually edit. This module parses the JSON, extracts each cell
//! as its own source fragment, and assembles a *virtual source* — the
//! concatenation of all cell bodies with one-line marker headers — that the
//! rest of the chunk pipeline can treat like any other text file.
//!
//! The per-cell sub-chunks come from recursively running [`build_chunk_tree`]
//! on the individual cell sources with their appropriate language (code cells
//! use the notebook's kernel language, defaulting to Python; markdown cells
//! use `markdown`; raw cells fall through to the blank-line fallback). Their
//! byte and line offsets are shifted into the virtual source and then
//! rewrapped under `cell_<n>` parent chunks so the resulting tree looks to
//! edit.rs exactly like a normal multi-symbol file.
//!
//! On write-back, [`notebook_to_json`] walks the (possibly edited) virtual
//! source, splits it at the cell markers, updates each cell's `source` field
//! in a preserved [`NotebookContext`], and serializes the whole notebook back
//! to JSON. Cell metadata (`metadata`, `outputs`, `execution_count`, `id`,
//! attachments, etc.) is preserved verbatim.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::chunk::{
	build_chunk_tree, chunk_checksum,
	kind::ChunkKind,
	line_start_offsets,
	types::{ChunkNode, ChunkTree},
};

/// Marker line prefix placed before every cell body in the virtual source.
///
/// Format: `# %%% oh-my-pi cell_<N> [<type>]`
///
/// The leading `#` makes the marker a valid comment in Python and most other
/// code languages, and the `oh-my-pi` tag makes accidental collision with
/// user content vanishingly unlikely. Markdown cells get the same marker —
/// `#` in markdown is a heading, but the marker line itself is stripped
/// before the markdown chunker parses the cell body (see
/// [`build_cell_sub_tree`]).
const MARKER_PREFIX: &str = "# %%% oh-my-pi cell_";

/// Returns true if `line` is a cell marker; parses the cell index and type.
fn parse_marker_line(line: &str) -> Option<(usize, &str)> {
	let rest = line.strip_prefix(MARKER_PREFIX)?;
	let (num_str, after_num) = rest.split_once(' ')?;
	let index: usize = num_str.parse().ok()?;
	let cell_type = after_num.strip_prefix('[')?.strip_suffix(']')?;
	Some((index, cell_type))
}

fn format_marker(index: usize, cell_type: &str) -> String {
	format!("{MARKER_PREFIX}{index} [{cell_type}]")
}

/// Metadata for a single notebook cell. Everything except the joined `source`
/// is preserved verbatim for JSON round-tripping.
#[derive(Clone)]
pub struct NotebookCell {
	pub cell_type:         String,
	pub source:            String,
	pub metadata:          Value,
	pub outputs:           Option<Value>,
	pub execution_count:   Option<Value>,
	/// Additional fields on the cell object (`id`, `attachments`, …) so we
	/// emit the same keys we consumed.
	pub other:             Map<String, Value>,
	/// Whether the original cell used `"source"` as a string (`true`) or an
	/// array of lines (`false`). Preserved so round-trips stay byte-identical
	/// when only metadata or unrelated cells change.
	pub source_was_string: bool,
}

/// Preserved notebook-level state used for rebuilding the JSON after edits.
#[derive(Clone)]
pub struct NotebookContext {
	/// Cells in document order.
	pub cells:            Vec<NotebookCell>,
	/// Top-level notebook fields other than `cells`, in original key order.
	pub top_fields:       Map<String, Value>,
	/// Indent string detected from the original JSON (typically `" "`).
	pub indent:           String,
	/// Whether the original file ended with a trailing `\n`.
	pub trailing_newline: bool,
	/// Normalized kernel language used for code cells (e.g. `python`).
	pub kernel_language:  String,
}

/// Result of a notebook parse: the virtual source ready for chunking plus
/// the context needed to rebuild the JSON later.
pub struct NotebookParse {
	pub virtual_source: String,
	pub context:        NotebookContext,
}

// ────────────────────────────────────────────────────────────────────
// JSON parsing
// ────────────────────────────────────────────────────────────────────

/// Parse the raw ipynb JSON into a [`NotebookContext`] and the derived
/// virtual source text. Returns a descriptive error if the JSON is invalid
/// or not a notebook document.
pub fn parse_notebook(source: &str) -> Result<NotebookParse, String> {
	let normalized = strip_bom(source);
	let value: Value = serde_json::from_str(normalized)
		.map_err(|err| format!("Invalid Jupyter notebook JSON: {err}"))?;
	let Value::Object(obj) = value else {
		return Err("Invalid Jupyter notebook: top-level value must be an object.".to_string());
	};

	let cells_val = obj
		.get("cells")
		.ok_or_else(|| "Invalid Jupyter notebook: missing `cells` array.".to_string())?;
	let cells_arr = cells_val
		.as_array()
		.ok_or_else(|| "Invalid Jupyter notebook: `cells` is not an array.".to_string())?;

	let mut cells = Vec::with_capacity(cells_arr.len());
	for (i, raw) in cells_arr.iter().enumerate() {
		cells.push(parse_cell(raw, i)?);
	}

	// Top-level fields minus `cells`, preserving insertion order.
	let mut top_fields = Map::new();
	for (k, v) in &obj {
		if k != "cells" {
			top_fields.insert(k.clone(), v.clone());
		}
	}

	let kernel_language =
		extract_kernel_language(&top_fields).unwrap_or_else(|| "python".to_string());
	let indent = detect_json_indent(normalized);
	let trailing_newline = normalized.ends_with('\n');

	let ctx = NotebookContext { cells, top_fields, indent, trailing_newline, kernel_language };
	let virtual_source = build_virtual_source(&ctx);
	Ok(NotebookParse { virtual_source, context: ctx })
}

fn parse_cell(raw: &Value, index: usize) -> Result<NotebookCell, String> {
	let obj = raw
		.as_object()
		.ok_or_else(|| format!("Invalid Jupyter notebook: cell {} is not an object.", index + 1))?;

	let cell_type = obj
		.get("cell_type")
		.and_then(Value::as_str)
		.unwrap_or("code")
		.to_string();

	let (source, source_was_string) = match obj.get("source") {
		Some(Value::String(s)) => (s.clone(), true),
		Some(Value::Array(arr)) => {
			let mut joined = String::new();
			for item in arr {
				match item {
					Value::String(s) => joined.push_str(s),
					_ => {
						return Err(format!(
							"Invalid Jupyter notebook: cell {} source array contains non-string element.",
							index + 1
						));
					},
				}
			}
			(joined, false)
		},
		Some(Value::Null) | None => (String::new(), false),
		Some(_) => {
			return Err(format!(
				"Invalid Jupyter notebook: cell {} has a non-string `source` field.",
				index + 1
			));
		},
	};

	let metadata = obj
		.get("metadata")
		.cloned()
		.unwrap_or_else(|| Value::Object(Map::new()));
	let outputs = obj.get("outputs").cloned();
	let execution_count = obj.get("execution_count").cloned();

	// Additional fields (id, attachments, …) that we pass through untouched.
	let mut other = Map::new();
	for (k, v) in obj {
		if !matches!(k.as_str(), "cell_type" | "source" | "metadata" | "outputs" | "execution_count")
		{
			other.insert(k.clone(), v.clone());
		}
	}

	Ok(NotebookCell {
		cell_type,
		source,
		metadata,
		outputs,
		execution_count,
		other,
		source_was_string,
	})
}

fn strip_bom(source: &str) -> &str {
	source.strip_prefix('\u{feff}').unwrap_or(source)
}

fn extract_kernel_language(top_fields: &Map<String, Value>) -> Option<String> {
	if let Some(meta) = top_fields.get("metadata").and_then(Value::as_object) {
		if let Some(lang) = meta
			.get("kernelspec")
			.and_then(Value::as_object)
			.and_then(|k| k.get("language"))
			.and_then(Value::as_str)
			&& !lang.is_empty()
		{
			return Some(lang.to_ascii_lowercase());
		}
		if let Some(lang) = meta
			.get("language_info")
			.and_then(Value::as_object)
			.and_then(|k| k.get("name"))
			.and_then(Value::as_str)
			&& !lang.is_empty()
		{
			return Some(lang.to_ascii_lowercase());
		}
	}
	None
}

fn detect_json_indent(source: &str) -> String {
	// Look for the first `\n` followed by whitespace inside the top-level object
	// (i.e. after the opening `{`). This is a heuristic; Jupyter canonically
	// uses a single space per level.
	let Some(brace) = source.find('{') else {
		return " ".to_string();
	};
	let rest = &source[brace + 1..];
	let Some(nl) = rest.find('\n') else {
		return " ".to_string();
	};
	let after_nl = &rest[nl + 1..];
	let mut end = 0usize;
	for ch in after_nl.chars() {
		if ch == ' ' || ch == '\t' {
			end += ch.len_utf8();
		} else {
			break;
		}
	}
	if end == 0 {
		" ".to_string()
	} else {
		after_nl[..end].to_string()
	}
}

// ────────────────────────────────────────────────────────────────────
// Virtual source assembly
// ────────────────────────────────────────────────────────────────────

/// Build the virtual source text from the current cell list.
///
/// Each cell is preceded by a marker line and its body. Cells do not include
/// trailing blank separators — we rely purely on the marker line to delimit
/// adjacent cells so the reconstructed sources stay byte-identical to the
/// originals after whole-cell edits.
pub fn build_virtual_source(ctx: &NotebookContext) -> String {
	let mut out = String::new();
	for (i, cell) in ctx.cells.iter().enumerate() {
		out.push_str(&format_marker(i + 1, &cell.cell_type));
		out.push('\n');
		out.push_str(&cell.source);
		if !cell.source.is_empty() && !cell.source.ends_with('\n') {
			out.push('\n');
		}
	}
	out
}

// ────────────────────────────────────────────────────────────────────
// Chunk tree construction
// ────────────────────────────────────────────────────────────────────

/// Locate every cell marker in `source`, returning tuples of:
/// (`cell_number`, `marker_line_byte_start`, `content_byte_start`,
/// `content_byte_end`,  `marker_line_number_1based`,
/// `content_start_line_1based`,
///  `content_end_line_1based_inclusive_or_zero_if_empty`)
struct CellRegion {
	cell_num:         usize,
	cell_type:        String,
	marker_start:     usize, // byte offset of the `#` starting the marker line
	content_start:    usize, // byte offset of the first byte of the cell body
	content_end:      usize, // byte offset one past the last byte of the cell body
	marker_line:      u32,   // 1-based line number of the marker
	content_line:     u32,   // 1-based line number of the first body line (or marker_line + 1)
	content_end_line: u32,   /* 1-based line number of the last body line (== content_line - 1
	                          * for empty bodies) */
}

/// Scan a virtual source text for cell markers and return the list of
/// regions. Assumes markers occur at the very start of their line.
fn scan_cells(virtual_source: &str) -> Vec<CellRegion> {
	let line_starts = line_start_offsets(virtual_source);
	let mut regions: Vec<CellRegion> = Vec::new();

	for (line_idx, &line_start) in line_starts.iter().enumerate() {
		let line_end = if line_idx + 1 < line_starts.len() {
			// Exclude the trailing newline
			line_starts[line_idx + 1] - 1
		} else {
			virtual_source.len()
		};
		let line = &virtual_source[line_start..line_end];
		if let Some((cell_num, cell_type)) = parse_marker_line(line) {
			// Close the previous region if any.
			if let Some(prev) = regions.last_mut() {
				prev.content_end = line_start;
				// Trim trailing newline from content_end if present (i.e. the body ended with
				// \n). Actually we keep the newline: cell bodies end with \n except
				// possibly the last. content_end_line = line of the last body byte.
				if prev.content_end > prev.content_start {
					let body_last_char_line = line_idx; // line_idx is 0-based, so this is the previous line
					prev.content_end_line = body_last_char_line as u32;
				} else {
					prev.content_end_line = prev.content_line.saturating_sub(1);
				}
			}
			let content_start = if line_idx + 1 < line_starts.len() {
				line_starts[line_idx + 1]
			} else {
				virtual_source.len()
			};
			regions.push(CellRegion {
				cell_num,
				cell_type: cell_type.to_string(),
				marker_start: line_start,
				content_start,
				content_end: virtual_source.len(), // provisional, closed by the next marker
				marker_line: (line_idx as u32) + 1,
				content_line: (line_idx as u32) + 2,
				content_end_line: 0,
			});
		}
	}

	// Close the last region.
	if let Some(last) = regions.last_mut() {
		last.content_end = virtual_source.len();
		if last.content_end > last.content_start {
			// Count lines inside the body.
			let body = &virtual_source[last.content_start..last.content_end];
			let body_lines = body.matches('\n').count();
			// If body doesn't end with '\n', the final partial line still counts.
			let has_trailing_nl = body.ends_with('\n');
			let content_lines = if has_trailing_nl {
				body_lines
			} else {
				body_lines + 1
			};
			if content_lines > 0 {
				last.content_end_line = last.content_line + content_lines as u32 - 1;
			} else {
				last.content_end_line = last.content_line.saturating_sub(1);
			}
		} else {
			last.content_end_line = last.content_line.saturating_sub(1);
		}
	}

	regions
}

/// Build a chunk tree from a virtual source text.
///
/// Re-scans the virtual source for cell markers, parses each cell body with
/// its language, and wraps the results in `cell_<n>` parent chunks. This is
/// the entry point used by both the initial JSON-based parse (via
/// [`parse_notebook`] → `build_virtual_source` → this function) and the
/// post-edit rebuilds that operate directly on the mutated virtual source.
pub fn build_notebook_tree_from_virtual(
	virtual_source: &str,
	kernel_language: &str,
) -> Result<ChunkTree, String> {
	let total_lines = total_line_count(virtual_source);
	let root_checksum = chunk_checksum(virtual_source.as_bytes());
	let regions = scan_cells(virtual_source);

	// Accumulated chunk nodes. Index 0 is reserved for the synthetic root.
	let mut chunks: Vec<ChunkNode> = Vec::with_capacity(1 + regions.len() * 2);
	chunks.push(ChunkNode {
		path:                String::new(),
		identifier:          None,
		kind:                ChunkKind::Root,
		leaf:                false,
		virtual_content:     None,
		parent_path:         None,
		children:            Vec::new(),
		signature:           None,
		start_line:          u32::from(total_lines != 0),
		end_line:            total_lines as u32,
		line_count:          total_lines as u32,
		start_byte:          0,
		end_byte:            virtual_source.len() as u32,
		checksum_start_byte: 0,
		prologue_end_byte:   Some(0),
		epilogue_start_byte: Some(virtual_source.len() as u32),
		checksum:            root_checksum.clone(),
		error:               false,
		indent:              0,
		indent_char:         String::new(),
		group:               false,
	});

	let mut root_children: Vec<String> = Vec::with_capacity(regions.len());

	for region in &regions {
		let cell_path = format!("cell_{}", region.cell_num);
		let cell_language_str = match region.cell_type.as_str() {
			"code" => kernel_language.to_string(),
			"markdown" => "markdown".to_string(),
			_ => String::new(),
		};

		let body = &virtual_source[region.content_start..region.content_end];
		let body_has_content = !body.is_empty();
		let cell_checksum = chunk_checksum(body.as_bytes());

		// Build sub-chunks by parsing the cell body in isolation. Offsets in
		// the returned tree are relative to `body`; we translate them into
		// virtual-source coordinates by adding `region.content_start` bytes
		// and `region.content_line - 1` lines.
		let mut cell_children_paths: Vec<String> = Vec::new();
		if body_has_content {
			let sub_tree = build_chunk_tree(body, cell_language_str.as_str())
				.map_err(|err| format!("Failed to parse cell_{} body: {err}", region.cell_num))?;
			for sub_chunk in sub_tree.chunks.into_iter().skip(1) {
				let translated_path = format!("{}.{}", cell_path, sub_chunk.path);
				let translated_parent = match sub_chunk.parent_path.as_deref() {
					Some("") | None => Some(cell_path.clone()),
					Some(other) => Some(format!("{cell_path}.{other}")),
				};
				let translated_children: Vec<String> = sub_chunk
					.children
					.iter()
					.map(|c| format!("{cell_path}.{c}"))
					.collect();
				let shifted_start_byte = sub_chunk
					.start_byte
					.saturating_add(region.content_start as u32);
				let shifted_end_byte = sub_chunk
					.end_byte
					.saturating_add(region.content_start as u32);
				let line_shift = region.content_line.saturating_sub(1);
				chunks.push(ChunkNode {
					path:                translated_path.clone(),
					identifier:          sub_chunk.identifier,
					kind:                sub_chunk.kind,
					leaf:                sub_chunk.leaf,
					virtual_content:     sub_chunk.virtual_content,
					parent_path:         translated_parent,
					children:            translated_children,
					signature:           sub_chunk.signature,
					start_line:          sub_chunk.start_line.saturating_add(line_shift),
					end_line:            sub_chunk.end_line.saturating_add(line_shift),
					line_count:          sub_chunk.line_count,
					start_byte:          shifted_start_byte,
					end_byte:            shifted_end_byte,
					checksum_start_byte: sub_chunk
						.checksum_start_byte
						.saturating_add(region.content_start as u32),
					prologue_end_byte:   sub_chunk
						.prologue_end_byte
						.map(|b| b.saturating_add(region.content_start as u32)),
					epilogue_start_byte: sub_chunk
						.epilogue_start_byte
						.map(|b| b.saturating_add(region.content_start as u32)),
					checksum:            sub_chunk.checksum,
					error:               sub_chunk.error,
					indent:              sub_chunk.indent,
					indent_char:         sub_chunk.indent_char,
					group:               false,
				});
			}
			for sub_path in sub_tree.root_children {
				cell_children_paths.push(format!("{cell_path}.{sub_path}"));
			}
		}

		let cell_line_count = {
			let body_lines = if body_has_content {
				if body.ends_with('\n') {
					body.matches('\n').count()
				} else {
					body.matches('\n').count() + 1
				}
			} else {
				0
			};
			1 + body_lines as u32
		};
		let cell_end_line = region.marker_line + cell_line_count.saturating_sub(1);
		let cell_leaf = cell_children_paths.is_empty();
		chunks.push(ChunkNode {
			path:                cell_path.clone(),
			identifier:          Some(cell_path.clone()),
			kind:                ChunkKind::Cell,
			leaf:                cell_leaf,
			virtual_content:     None,
			parent_path:         Some(String::new()),
			children:            cell_children_paths,
			signature:           Some(format!("cell_{} ({})", region.cell_num, region.cell_type)),
			start_line:          region.marker_line,
			end_line:            cell_end_line,
			line_count:          cell_line_count,
			start_byte:          region.marker_start as u32,
			end_byte:            region.content_end as u32,
			checksum_start_byte: region.content_start as u32,
			prologue_end_byte:   Some(region.content_start as u32),
			epilogue_start_byte: Some(region.content_end as u32),
			checksum:            cell_checksum,
			error:               false,
			indent:              0,
			indent_char:         String::new(),
			group:               false,
		});
		root_children.push(cell_path);
	}

	// Populate root children now that every cell is known.
	if let Some(root) = chunks.get_mut(0) {
		root.children.clone_from(&root_children);
	}

	// Sort chunks so the cell parent always comes before its sub-chunks,
	// matching the invariant that other paths rely on (render, edit
	// scheduling, line-to-chunk lookup). Keep the root at index 0.
	// The insertion order above places sub-chunks before the cell parent, so
	// we need to reorder: for each cell region, move the cell parent ahead of
	// its sub-chunks.
	//
	// Simpler: rebuild the chunks list by iterating cells, emitting the cell
	// parent followed by its sub-chunks in path order.
	let mut reordered: Vec<ChunkNode> = Vec::with_capacity(chunks.len());
	reordered.push(chunks.remove(0)); // root

	let mut remaining: Vec<ChunkNode> = chunks;
	for cell_path in &root_children {
		// Extract the cell parent first.
		if let Some(pos) = remaining.iter().position(|c| &c.path == cell_path) {
			reordered.push(remaining.remove(pos));
		}
		// Then any descendants of this cell.
		let prefix = format!("{cell_path}.");
		let mut i = 0;
		while i < remaining.len() {
			if remaining[i].path.starts_with(&prefix) {
				reordered.push(remaining.remove(i));
			} else {
				i += 1;
			}
		}
	}
	// Anything left over (shouldn't happen, but be defensive).
	reordered.extend(remaining);

	Ok(ChunkTree {
		language: "ipynb".to_string(),
		checksum: root_checksum,
		line_count: total_lines as u32,
		parse_errors: 0,
		parse_error_lines: Vec::new(),
		fallback: false,
		root_path: String::new(),
		root_children,
		chunks: reordered,
	})
}

fn total_line_count(source: &str) -> usize {
	if source.is_empty() {
		0
	} else {
		source.bytes().filter(|b| *b == b'\n').count() + 1
	}
}

// ────────────────────────────────────────────────────────────────────
// Virtual → JSON round-trip
// ────────────────────────────────────────────────────────────────────

/// Update a [`NotebookContext`] from a (possibly edited) virtual source,
/// then serialize it back to JSON. Cells that no longer appear in the
/// virtual source are dropped; cells whose markers survive get their
/// `source` field replaced with the current body.
///
/// Returns the serialized JSON text ready to be written to disk.
pub fn notebook_to_json(
	virtual_source: &str,
	base_ctx: &NotebookContext,
) -> Result<String, String> {
	let mut ctx = base_ctx.clone();
	let regions = scan_cells(virtual_source);

	// Rebuild the cells array in the order markers appear in the virtual
	// source. Look up each marker's original cell by 1-based cell_num so
	// edits that reorder cells via sibling insertion continue to track the
	// right metadata.
	let mut new_cells: Vec<NotebookCell> = Vec::with_capacity(regions.len());
	for region in &regions {
		let body_slice = &virtual_source[region.content_start..region.content_end];
		// Trim the single trailing newline that the virtual source format
		// adds so edits that replace an entire cell body don't grow by one
		// line every round-trip.
		let body = trim_virtual_body(body_slice);

		let original = ctx.cells.get(region.cell_num.saturating_sub(1)).cloned();
		let cell = match original {
			Some(mut cell) => {
				cell.source = body.to_string();
				cell.cell_type.clone_from(&region.cell_type);
				cell
			},
			None => NotebookCell {
				cell_type:         region.cell_type.clone(),
				source:            body.to_string(),
				metadata:          Value::Object(Map::new()),
				outputs:           match region.cell_type.as_str() {
					"code" => Some(Value::Array(Vec::new())),
					_ => None,
				},
				execution_count:   match region.cell_type.as_str() {
					"code" => Some(Value::Null),
					_ => None,
				},
				other:             Map::new(),
				source_was_string: false,
			},
		};
		new_cells.push(cell);
	}
	ctx.cells = new_cells;

	let json = serialize_notebook(&ctx)?;
	Ok(json)
}

/// Strip a single trailing newline from `body`, if present. The virtual
/// source always terminates each cell body with `\n` to make the markers
/// start on a fresh line; we remove that byte so the cell's stored source
/// matches the semantic content.
fn trim_virtual_body(body: &str) -> &str {
	body.strip_suffix('\n').unwrap_or(body)
}

fn serialize_notebook(ctx: &NotebookContext) -> Result<String, String> {
	// Build the cells array first.
	let mut cells_arr: Vec<Value> = Vec::with_capacity(ctx.cells.len());
	for cell in &ctx.cells {
		cells_arr.push(cell_to_value(cell));
	}

	// Rebuild the top-level object preserving the original key order with
	// `cells` injected at the position it originally occupied. If the input
	// had no `cells` key (we wouldn't be here), we append.
	let mut top = Map::new();
	let mut cells_inserted = false;
	for (k, v) in &ctx.top_fields {
		top.insert(k.clone(), v.clone());
		if k == "metadata" && !cells_inserted {
			// Jupyter's canonical order is cells, metadata, nbformat,
			// nbformat_minor. We preserve whatever we found.
		}
	}
	// If the original document had `cells` somewhere, we want to re-insert
	// it at roughly the same slot. Jupyter always writes `cells` first, so
	// build a fresh Map in canonical order: cells then the preserved
	// top_fields.
	let mut final_top = Map::new();
	final_top.insert("cells".to_string(), Value::Array(cells_arr));
	cells_inserted = true;
	for (k, v) in top {
		if k != "cells" {
			final_top.insert(k, v);
		}
	}
	let _ = cells_inserted;

	let indent_bytes = ctx.indent.as_bytes().to_vec();
	let formatter = serde_json::ser::PrettyFormatter::with_indent(&indent_bytes);
	let mut buf: Vec<u8> = Vec::with_capacity(1024);
	{
		let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
		Value::Object(final_top)
			.serialize(&mut ser)
			.map_err(|err| format!("Failed to serialize notebook JSON: {err}"))?;
	}
	let mut text = String::from_utf8(buf)
		.map_err(|err| format!("Serialized notebook is not valid UTF-8: {err}"))?;
	if ctx.trailing_newline && !text.ends_with('\n') {
		text.push('\n');
	}
	Ok(text)
}

fn cell_to_value(cell: &NotebookCell) -> Value {
	let mut obj = Map::new();
	obj.insert("cell_type".to_string(), Value::String(cell.cell_type.clone()));
	// Preserve `id` and similar fields that idiomatically appear before
	// `metadata` in nbformat 4+.
	for (k, v) in &cell.other {
		if !matches!(k.as_str(), "metadata" | "outputs" | "execution_count" | "source") {
			obj.insert(k.clone(), v.clone());
		}
	}
	obj.insert("metadata".to_string(), cell.metadata.clone());
	if cell.cell_type == "code" {
		obj.insert(
			"execution_count".to_string(),
			cell.execution_count.clone().unwrap_or(Value::Null),
		);
		obj.insert(
			"outputs".to_string(),
			cell
				.outputs
				.clone()
				.unwrap_or_else(|| Value::Array(Vec::new())),
		);
	} else {
		if let Some(outputs) = &cell.outputs {
			obj.insert("outputs".to_string(), outputs.clone());
		}
		if let Some(ec) = &cell.execution_count {
			obj.insert("execution_count".to_string(), ec.clone());
		}
	}
	obj.insert("source".to_string(), source_to_value(&cell.source, cell.source_was_string));
	Value::Object(obj)
}

/// Convert a flat source string to the Jupyter `source` field representation.
///
/// If the cell originally used a string (or a new cell was inserted), we keep
/// it as a string. Otherwise we split into the canonical `Vec<String>` with
/// each element preserving its trailing `\n`.
fn source_to_value(source: &str, was_string: bool) -> Value {
	if was_string {
		return Value::String(source.to_string());
	}
	if source.is_empty() {
		return Value::Array(Vec::new());
	}
	let mut parts: Vec<Value> = Vec::new();
	for line in source.split_inclusive('\n') {
		parts.push(Value::String(line.to_string()));
	}
	Value::Array(parts)
}

// ────────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────────

/// Atomically-shareable notebook context; used by [`ChunkStateInner`] to
/// carry the notebook metadata through edit cycles.
pub type SharedNotebookContext = Arc<NotebookContext>;

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;
	use crate::chunk::state::ChunkStateInner;

	fn sample_notebook() -> String {
		let value = json!({
			"cells": [
				{
					"cell_type": "code",
					"source": ["def foo():\n", "    return 1\n"],
					"metadata": {},
					"outputs": [],
					"execution_count": null
				},
				{
					"cell_type": "markdown",
					"source": ["# Hello\n", "World\n"],
					"metadata": {}
				},
				{
					"cell_type": "code",
					"source": ["class Bar:\n", "    def baz(self):\n", "        pass\n"],
					"metadata": {},
					"outputs": [],
					"execution_count": 3
				}
			],
			"metadata": {
				"kernelspec": {
					"language": "python"
				}
			},
			"nbformat": 4,
			"nbformat_minor": 5
		});
		serde_json::to_string_pretty(&value).expect("static json")
	}

	#[test]
	fn parses_notebook_into_cells() {
		let nb = parse_notebook(&sample_notebook()).expect("valid notebook");
		assert_eq!(nb.context.cells.len(), 3);
		assert_eq!(nb.context.cells[0].cell_type, "code");
		assert_eq!(nb.context.cells[1].cell_type, "markdown");
		assert_eq!(nb.context.cells[2].cell_type, "code");
		assert_eq!(nb.context.kernel_language, "python");
	}

	#[test]
	fn virtual_source_contains_all_cells() {
		let nb = parse_notebook(&sample_notebook()).expect("valid notebook");
		let vs = &nb.virtual_source;
		assert!(vs.contains("def foo():"), "cell 1 body missing");
		assert!(vs.contains("# Hello"), "cell 2 body missing");
		assert!(vs.contains("class Bar:"), "cell 3 body missing");
		assert!(vs.contains("# %%% oh-my-pi cell_1 [code]"), "cell_1 marker missing");
		assert!(vs.contains("# %%% oh-my-pi cell_2 [markdown]"), "cell_2 marker missing");
		assert!(vs.contains("# %%% oh-my-pi cell_3 [code]"), "cell_3 marker missing");
	}

	#[test]
	fn builds_cell_level_chunks() {
		let nb = parse_notebook(&sample_notebook()).expect("valid notebook");
		let tree =
			build_notebook_tree_from_virtual(&nb.virtual_source, "python").expect("tree should build");
		assert_eq!(
			tree.root_children,
			vec!["cell_1", "cell_2", "cell_3"],
			"root children should be the three cells"
		);
		let cell1 = tree
			.chunks
			.iter()
			.find(|c| c.path == "cell_1")
			.expect("cell_1 chunk");
		assert!(!cell1.leaf, "code cell with a function should not be a leaf");
		assert!(
			cell1
				.children
				.iter()
				.any(|p| p.starts_with("cell_1.fn_foo")),
			"cell_1 should contain fn_foo, got {:?}",
			cell1.children
		);
	}

	#[test]
	fn sub_chunk_paths_are_prefixed_with_cell() {
		let nb = parse_notebook(&sample_notebook()).expect("valid notebook");
		let tree =
			build_notebook_tree_from_virtual(&nb.virtual_source, "python").expect("tree should build");
		let cell3 = tree
			.chunks
			.iter()
			.find(|c| c.path == "cell_3")
			.expect("cell_3 chunk");
		assert!(
			cell3
				.children
				.iter()
				.any(|p| p.starts_with("cell_3.cls_Bar")),
			"cell_3 should contain cls_Bar, got {:?}",
			cell3.children
		);
		let bar_method = tree
			.chunks
			.iter()
			.find(|c| c.path == "cell_3.cls_Bar.fn_baz");
		assert!(bar_method.is_some(), "cell_3.cls_Bar.fn_baz should exist");
	}

	#[test]
	fn chunk_state_parse_ipynb_carries_notebook_context() {
		let json = sample_notebook();
		let state =
			ChunkStateInner::parse(json, "ipynb".to_string()).expect("ChunkState should parse ipynb");
		assert_eq!(state.language(), "ipynb");
		// Source is the virtual source, not the JSON
		assert!(state.source().contains("# %%% oh-my-pi cell_1"));
		// The notebook context is preserved for JSON round-trip
		let ctx = state
			.notebook
			.as_ref()
			.expect("notebook context should be set");
		let json_out = notebook_to_json(state.source(), ctx).expect("should serialize back to JSON");
		let reparsed: serde_json::Value =
			serde_json::from_str(&json_out).expect("output should be valid JSON");
		let cells = reparsed["cells"].as_array().expect("cells array");
		assert_eq!(cells.len(), 3, "should still have 3 cells");
		assert_eq!(cells[0]["cell_type"], "code");
		assert_eq!(cells[2]["execution_count"], 3);
	}

	#[test]
	fn empty_notebook_produces_empty_tree() {
		let json = r#"{"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}"#;
		let state = ChunkStateInner::parse(json.to_string(), "ipynb".to_string())
			.expect("empty notebook should parse");
		assert!(state.tree().root_children.is_empty());
	}
}

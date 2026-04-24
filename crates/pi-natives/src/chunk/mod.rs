//! Chunk-tree parsing powered by tree-sitter with best-effort structural
//! grouping.
//!
//! The module is split into:
//! - `types` — napi-exported data structures
//! - `common` — shared helpers used by all classifiers
//! - `defaults` — default classification logic (language-agnostic node kinds)
//! - `classify` — `LangClassifier` trait and dispatch
//! - `ast_*` — per-language classifier implementations

mod atom_list;
mod classify;
pub(crate) mod common;
pub(crate) mod conflict;
mod defaults;
pub(crate) mod edit;
pub(crate) mod indent;
mod render;
pub(crate) mod resolve;
mod schema;
mod shape;
pub(crate) mod state;
pub mod types;

pub mod kind;

// Per-language classifiers
mod ast_astro;
mod ast_bash_make_diff;
mod ast_c_cpp_objc;
mod ast_clojure;
mod ast_cmake;
mod ast_csharp_java;
mod ast_css;
mod ast_data_formats;
mod ast_dockerfile;
mod ast_elixir;
mod ast_erlang;
mod ast_go;
mod ast_graphql;
mod ast_haskell_scala;
mod ast_html_xml;
mod ast_ini;
pub(crate) mod ast_ipynb;
mod ast_js_ts;
mod ast_just;
mod ast_markup;
mod ast_misc;
mod ast_nix_hcl;
mod ast_ocaml;
mod ast_perl;
mod ast_powershell;
mod ast_proto;
mod ast_python;
mod ast_r;
mod ast_ruby_lua;
mod ast_rust;
mod ast_sql;
mod ast_svelte;
mod ast_tlaplus;
mod ast_vue;

use std::collections::HashMap;

use ast_grep_core::tree_sitter::LanguageExt;
use napi::{Error, Result};
use napi_derive::napi;
use tree_sitter::{Node, Parser, Tree};
use xxhash_rust::xxh64::xxh64;

use self::{
	classify::{LangClassifier, classifier_for, classify_with_defaults, structural_overrides},
	common::*,
	kind::ChunkKind,
};
pub use self::{
	state::ChunkState,
	types::{ChunkNode, ChunkTree},
};
use crate::{chunk::types::ChunkAnchorStyle, language::SupportLang};

// ── Napi exports ─────────────────────────────────────────────────────────

/// Format one chunk anchor string for a node at `depth` using `style` and
/// optional checksum omission.
#[napi]
pub fn format_anchor(
	name: String,
	checksum: String,
	style: ChunkAnchorStyle,
	omit_checksum: Option<bool>,
) -> String {
	style
		.with_omit_checksum(omit_checksum.unwrap_or(false))
		.render("", name.as_str(), checksum.as_str())
}

// ── Core build logic ─────────────────────────────────────────────────────

pub(crate) fn build_chunk_tree(source: &str, language: &str) -> Result<ChunkTree> {
	let normalized_language = language.trim().to_ascii_lowercase();
	let total_lines = total_line_count(source);
	let root_checksum = chunk_checksum(source.as_bytes());

	// Notebooks (`.ipynb`) are parsed by `ChunkStateInner::parse`, which
	// converts the JSON file to a *virtual source* and then re-enters
	// `build_chunk_tree` with the `ipynb` language tag. When we arrive here
	// with that tag, `source` is the virtual concatenated cell text and the
	// per-cell sub-trees are built via `ast_ipynb`.
	if normalized_language == "ipynb" {
		return ast_ipynb::build_notebook_tree_from_virtual(source, "python")
			.map_err(Error::from_reason);
	}
	let Some(chunk_lang) = resolve_chunk_lang(normalized_language.as_str()) else {
		return Ok(build_blank_line_tree(source, language.to_string(), total_lines, root_checksum));
	};

	let _schema_language = schema::enter_language(chunk_lang.canonical_name());
	let classifier = classifier_for(normalized_language.as_str());
	let tree = parse_tree(source, chunk_lang)?;
	let root = tree.root_node();
	let (parse_errors, parse_error_lines) = count_parse_errors(root);
	let mut acc = ChunkAccumulator::default();
	let mut root_children =
		collect_children_for_context(root, ChunkContext::Root, source, classifier)
			.into_iter()
			.map(|candidate| build_chunk(candidate, "", source, &mut acc, classifier))
			.collect::<Result<Vec<_>>>()?;

	classifier.post_process(&mut acc.chunks, &mut root_children, source);

	insert_preamble_chunk(source, &mut acc.chunks, &mut root_children);

	acc.chunks.insert(0, ChunkNode {
		path:                String::new(),
		identifier:          None,
		kind:                ChunkKind::Root,
		leaf:                false,
		virtual_content:     None,
		parent_path:         None,
		children:            root_children.clone(),
		signature:           None,
		start_line:          u32::from(total_lines != 0),
		end_line:            total_lines as u32,
		line_count:          total_lines as u32,
		start_byte:          0,
		end_byte:            source.len() as u32,
		checksum_start_byte: 0,
		prologue_end_byte:   Some(0),
		epilogue_start_byte: Some(source.len() as u32),
		checksum:            root_checksum.clone(),
		error:               false,
		indent:              0,
		indent_char:         String::new(),
		group:               false,
	});

	Ok(ChunkTree {
		language: normalized_language,
		checksum: root_checksum,
		line_count: total_lines as u32,
		parse_errors: parse_errors as u32,
		parse_error_lines,
		fallback: false,
		root_path: String::new(),
		root_children,
		chunks: acc.chunks,
	})
}

/// Smallest chunk path containing `line` (1-based file line), preferring the
/// innermost leaf when multiple chunks overlap.
pub(crate) fn line_to_chunk_path(tree: &ChunkTree, line: u32) -> Option<String> {
	if line == 0 {
		return None;
	}

	if let Some(chunk) = tree
		.chunks
		.iter()
		.filter(|chunk| {
			chunk.leaf && !chunk.path.is_empty() && chunk.start_line <= line && line <= chunk.end_line
		})
		.min_by_key(|chunk| chunk.line_count)
	{
		return Some(chunk.path.clone());
	}

	tree
		.chunks
		.iter()
		.filter(|chunk| chunk.start_line <= line && line <= chunk.end_line)
		.min_by_key(|chunk| chunk.line_count)
		.map(|chunk| chunk.path.clone())
}

fn parse_tree(source: &str, language: SupportLang) -> Result<Tree> {
	let mut parser = Parser::new();
	let ts_language = language.get_ts_language();
	parser
		.set_language(&ts_language)
		.map_err(|err| Error::from_reason(format!("Failed to set parser language: {err}")))?;
	parser
		.parse(source, None)
		.ok_or_else(|| Error::from_reason("Tree-sitter failed to parse source".to_string()))
}

fn build_blank_line_tree(
	source: &str,
	language: String,
	total_lines: usize,
	checksum: String,
) -> ChunkTree {
	let mut chunks = vec![ChunkNode {
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
		end_byte:            source.len() as u32,
		checksum_start_byte: 0,
		prologue_end_byte:   Some(0),
		epilogue_start_byte: Some(source.len() as u32),
		checksum:            checksum.clone(),
		error:               false,
		indent:              0,
		indent_char:         String::new(),
		group:               false,
	}];
	let line_starts = line_start_offsets(source);
	let mut root_children = Vec::new();
	let mut seen_names = HashMap::<String, usize>::new();
	let lines: Vec<&str> = if source.is_empty() {
		Vec::new()
	} else {
		source.split('\n').collect()
	};
	let mut start_line = 0usize;

	while start_line < lines.len() {
		while start_line < lines.len() && lines[start_line].trim().is_empty() {
			start_line += 1;
		}
		if start_line >= lines.len() {
			break;
		}

		let mut end_line = start_line;
		while end_line + 1 < lines.len() && !lines[end_line + 1].trim().is_empty() {
			end_line += 1;
		}

		let name = infer_fallback_block_name(lines[start_line], &mut seen_names);
		let start_byte = line_starts[start_line];
		let end_byte = line_end_offset(source, &line_starts, end_line);
		root_children.push(name.clone());
		chunks.push(ChunkNode {
			path:                name.clone(),
			identifier:          Some(name.clone()),
			kind:                ChunkKind::Chunk,
			leaf:                true,
			virtual_content:     None,
			parent_path:         Some(String::new()),
			children:            Vec::new(),
			signature:           None,
			start_line:          (start_line + 1) as u32,
			end_line:            (end_line + 1) as u32,
			line_count:          (end_line - start_line + 1) as u32,
			start_byte:          start_byte as u32,
			end_byte:            end_byte as u32,
			checksum_start_byte: start_byte as u32,
			prologue_end_byte:   None,
			epilogue_start_byte: None,
			checksum:            chunk_checksum(
				source
					.as_bytes()
					.get(start_byte..end_byte)
					.unwrap_or_default(),
			),
			error:               false,
			indent:              0,
			indent_char:         String::new(),
			group:               false,
		});
		start_line = end_line + 1;
	}

	if let Some(root) = chunks.first_mut() {
		root.children.clone_from(&root_children);
	}

	ChunkTree {
		language,
		checksum,
		line_count: total_lines as u32,
		parse_errors: 0,
		parse_error_lines: Vec::new(),
		fallback: true,
		root_path: String::new(),
		root_children,
		chunks,
	}
}

// ── Chunk building ───────────────────────────────────────────────────────

fn build_chunk(
	candidate: RawChunkCandidate<'_>,
	parent_path: &str,
	source: &str,
	acc: &mut ChunkAccumulator,
	classifier: &dyn classify::LangClassifier,
) -> Result<String> {
	let segment = candidate.kind.path_segment(candidate.identifier.as_deref());
	let path = if parent_path.is_empty() {
		segment
	} else {
		format!("{parent_path}.{segment}")
	};
	let line_count = candidate
		.range_end_line
		.saturating_sub(candidate.range_start_line)
		+ 1;
	let checksum = chunk_checksum(
		source
			.as_bytes()
			.get(candidate.checksum_start_byte..candidate.range_end_byte)
			.unwrap_or_default(),
	);
	let recurse = candidate.recurse;
	let injected = candidate.injected;
	let chunk_start = candidate.range_start_byte;
	let mut chunk_end = candidate.range_end_byte;
	let region_boundaries = candidate.region_node.map(|region_node| {
		let (pro_end, epi_start) =
			compute_body_inner_boundaries(source, region_node.start_byte(), region_node.end_byte());
		// For indent-based languages (Python, Ruby, etc.) the body boundary
		// computation may extend past the tree-sitter node to include a
		// trailing newline that logically terminates the last body line.
		// When this happens and the source byte at chunk_end is indeed a
		// newline, extend the chunk's end_byte to match so that:
		//   - ~ covers complete lines including their trailing newline
		//   - ^ and ~ are the only supported sub-chunk regions
		if epi_start > chunk_end
			&& epi_start <= source.len()
			&& source.as_bytes().get(chunk_end) == Some(&b'\n')
		{
			chunk_end = epi_start;
		}
		let pro_end = pro_end.max(chunk_start).min(chunk_end);
		let epi_start = epi_start.max(pro_end).min(chunk_end);
		(pro_end, epi_start)
	});
	let child_candidates = recurse
		.map(|recurse| {
			collect_children_for_context(recurse.node, recurse.context, source, classifier)
		})
		.unwrap_or_default();
	let recurse_parse_errors = recurse.map_or(0, |recurse| count_parse_errors(recurse.node).0);
	let has_injected_children = injected.is_some();
	let should_collapse = !has_injected_children
		&& !classifier.preserve_children(&candidate, &child_candidates)
		&& recurse.is_some()
		&& recurse_parse_errors == 0
		&& should_collapse_trivial_children(&candidate, &child_candidates);
	let always_recurse = !candidate.groupable && !child_candidates.is_empty();
	// A child that already committed to splitting further (force_recurse +
	// recurse) should always pull its parent along. Otherwise a small
	// wrapper parent would keep the child's sub-structure hidden just
	// because the wrapper itself fits under LEAF_THRESHOLD — e.g. a tiny
	// function whose body is one JSX return.
	let has_forced_child = child_candidates
		.iter()
		.any(|c| c.force_recurse && c.recurse.is_some());
	let should_recurse = !has_injected_children
		&& !candidate.error
		&& recurse.is_some()
		&& !should_collapse
		&& (candidate.force_recurse
			|| always_recurse
			|| recurse_parse_errors > 0
			|| has_forced_child
			|| (line_count > *LEAF_THRESHOLD
				&& recursion_narrows_scope(line_count, &child_candidates)));
	let children = if let Some(injected) = injected {
		translate_injected_subtree(path.as_str(), injected, source, acc)?
	} else if should_recurse {
		child_candidates
			.into_iter()
			.map(|child| build_chunk(child, path.as_str(), source, acc, classifier))
			.collect::<Result<Vec<_>>>()?
	} else {
		Vec::new()
	};

	let leaf = children.is_empty() && (!candidate.force_recurse || should_collapse);
	let (indent, indent_char) = detect_indent(source, candidate.range_start_byte);
	acc.chunks.push(ChunkNode {
		path: path.clone(),
		identifier: candidate.identifier,
		kind: candidate.kind,
		leaf,
		virtual_content: None,
		parent_path: Some(parent_path.to_string()),
		children,
		signature: candidate.signature,
		start_line: candidate.range_start_line as u32,
		end_line: candidate.range_end_line as u32,
		line_count: line_count as u32,
		start_byte: candidate.range_start_byte as u32,
		end_byte: chunk_end as u32,
		checksum_start_byte: candidate.checksum_start_byte as u32,
		prologue_end_byte: region_boundaries.map(|(start, _)| start as u32),
		epilogue_start_byte: region_boundaries.map(|(_, end)| end as u32),
		checksum,
		error: candidate.error,
		indent,
		indent_char,
		group: candidate.groupable,
	});
	Ok(path)
}

fn translate_injected_subtree(
	parent_path: &str,
	injected: InjectedChunkSpec<'_>,
	source: &str,
	acc: &mut ChunkAccumulator,
) -> Result<Vec<String>> {
	let content_start = injected.content_node.start_byte();
	let content_end = injected.content_node.end_byte();
	let content = node_text(source, content_start, content_end);
	if content.is_empty() {
		return Ok(Vec::new());
	}

	let sub_tree = build_chunk_tree(content, injected.language.canonical_name())?;
	let content_line_shift = injected.content_node.start_position().row as u32;
	let mut translated_root_children = Vec::new();

	for sub_chunk in sub_tree.chunks.into_iter().skip(1) {
		let translated_path = format!("{parent_path}.{}", sub_chunk.path);
		let translated_parent = match sub_chunk.parent_path.as_deref() {
			Some("") | None => Some(parent_path.to_string()),
			Some(other) => Some(format!("{parent_path}.{other}")),
		};
		let translated_children = sub_chunk
			.children
			.iter()
			.map(|child| format!("{parent_path}.{child}"))
			.collect();
		acc.chunks.push(ChunkNode {
			path:                translated_path,
			identifier:          sub_chunk.identifier,
			kind:                sub_chunk.kind,
			leaf:                sub_chunk.leaf,
			virtual_content:     sub_chunk.virtual_content,
			parent_path:         translated_parent,
			children:            translated_children,
			signature:           sub_chunk.signature,
			start_line:          sub_chunk.start_line.saturating_add(content_line_shift),
			end_line:            sub_chunk.end_line.saturating_add(content_line_shift),
			line_count:          sub_chunk.line_count,
			start_byte:          sub_chunk.start_byte.saturating_add(content_start as u32),
			end_byte:            sub_chunk.end_byte.saturating_add(content_start as u32),
			checksum_start_byte: sub_chunk
				.checksum_start_byte
				.saturating_add(content_start as u32),
			prologue_end_byte:   sub_chunk
				.prologue_end_byte
				.map(|byte| byte.saturating_add(content_start as u32)),
			epilogue_start_byte: sub_chunk
				.epilogue_start_byte
				.map(|byte| byte.saturating_add(content_start as u32)),
			checksum:            sub_chunk.checksum,
			error:               sub_chunk.error,
			indent:              sub_chunk.indent,
			indent_char:         sub_chunk.indent_char,
			group:               sub_chunk.group,
		});
	}

	for root_child in sub_tree.root_children {
		translated_root_children.push(format!("{parent_path}.{root_child}"));
	}

	Ok(translated_root_children)
}

// ── Child collection ─────────────────────────────────────────────────────

pub(crate) fn collect_children_for_context<'tree>(
	container: Node<'tree>,
	context: ChunkContext,
	source: &str,
	classifier: &dyn LangClassifier,
) -> Vec<RawChunkCandidate<'tree>> {
	let named_children_list = children_for_context(container, context, classifier);
	let overrides = structural_overrides(classifier);
	let mut raw = Vec::new();

	for (index, child) in named_children_list.iter().enumerate() {
		let is_error_node = child.is_error() || child.kind() == "ERROR";
		let is_skippable_trivia =
			!is_error_node && is_trivia_for_classifier(*child, classifier, overrides);
		let is_absorbable_attr = !is_error_node
			&& (is_absorbable_attribute(child.kind())
				|| overrides.is_absorbable_attr(child.kind())
				|| classifier.is_absorbable_attr(child.kind()));
		let is_skipped = !is_error_node && classifier.should_skip_child(child.kind());
		if is_skipped
			|| is_skippable_trivia
			|| is_absorbable_attr
			|| (child.is_missing() && !is_error_node)
		{
			continue;
		}

		let mut candidate = classify_node(*child, context, source, classifier);
		attach_leading_trivia(&mut candidate, &named_children_list, index, classifier);
		raw.push(candidate);
	}

	group_candidates(raw)
}

fn children_for_context<'tree>(
	container: Node<'tree>,
	context: ChunkContext,
	classifier: &dyn LangClassifier,
) -> Vec<Node<'tree>> {
	match context {
		ChunkContext::Root => flatten_root_children(container, classifier),
		ChunkContext::ClassBody | ChunkContext::FunctionBody => named_children(container),
	}
}

fn flatten_root_children<'tree>(
	container: Node<'tree>,
	classifier: &dyn LangClassifier,
) -> Vec<Node<'tree>> {
	let children = named_children(container);
	let overrides = structural_overrides(classifier);
	if children.len() == 1 && is_root_wrapper_for_classifier(children[0], classifier, overrides) {
		return flatten_root_children(children[0], classifier);
	}
	// When a root wrapper's only non-trivia child is another wrapper,
	// flatten through it. Handles YAML's `document` containing a leading
	// comment alongside a single `block_node`.
	if children.len() > 1 {
		let non_trivia: Vec<_> = children
			.iter()
			.filter(|child| !is_trivia_for_classifier(**child, classifier, overrides))
			.collect();
		if non_trivia.len() == 1
			&& is_root_wrapper_for_classifier(*non_trivia[0], classifier, overrides)
		{
			return flatten_root_children(*non_trivia[0], classifier);
		}
	}
	children
}

fn classify_node<'tree>(
	node: Node<'tree>,
	context: ChunkContext,
	source: &str,
	classifier: &dyn LangClassifier,
) -> RawChunkCandidate<'tree> {
	classify_with_defaults(classifier, context, node, source)
}

fn attach_leading_trivia<'tree>(
	candidate: &mut RawChunkCandidate<'tree>,
	named_children_list: &[Node<'tree>],
	index: usize,
	classifier: &dyn LangClassifier,
) {
	let overrides = structural_overrides(classifier);
	let mut cursor = index;
	while cursor > 0 {
		let prev = named_children_list[cursor - 1];
		if !is_trivia_for_classifier(prev, classifier, overrides)
			&& !is_absorbable_attribute(prev.kind())
			&& !overrides.is_absorbable_attr(prev.kind())
			&& !classifier.is_absorbable_attr(prev.kind())
		{
			break;
		}

		let prev_end_line = prev.end_position().row + 1;
		if candidate.range_start_line > prev_end_line + 1 {
			break;
		}

		candidate.range_start_byte = prev.start_byte();
		candidate.range_start_line = prev.start_position().row + 1;
		if prev.kind() == "comment" {
			candidate.has_leading_comment = true;
		}
		cursor -= 1;
	}
}

fn is_trivia_for_classifier(
	node: Node<'_>,
	classifier: &dyn LangClassifier,
	overrides: classify::StructuralOverrides,
) -> bool {
	let kind = node.kind();
	((is_trivia_node(node) || classifier.is_trivia(kind))
		&& !overrides.preserves_trivia(kind)
		&& !classifier.preserve_trivia(kind))
		|| (overrides.is_extra_trivia(kind)
			&& !overrides.preserves_trivia(kind)
			&& !classifier.preserve_trivia(kind))
}

fn is_root_wrapper_for_classifier(
	node: Node<'_>,
	classifier: &dyn LangClassifier,
	overrides: classify::StructuralOverrides,
) -> bool {
	let kind = node.kind();
	if overrides.preserves_root_wrapper(kind) || classifier.preserve_root_wrapper(kind) {
		return false;
	}
	overrides.is_extra_root_wrapper(kind)
		|| classifier.is_root_wrapper(kind)
		|| is_root_wrapper_node(node)
}

// ── Grouping / deduplication ─────────────────────────────────────────────

fn group_candidates(candidates: Vec<RawChunkCandidate<'_>>) -> Vec<RawChunkCandidate<'_>> {
	let mut grouped: Vec<RawChunkCandidate<'_>> = Vec::new();

	for candidate in candidates {
		if let Some(last) = grouped.last_mut() {
			let last_line_count = line_span(last.range_start_line, last.range_end_line);
			let next_line_count = line_span(candidate.range_start_line, candidate.range_end_line);
			let can_merge = last.groupable
				&& candidate.groupable
				&& last.kind == candidate.kind
				&& last.identifier == candidate.identifier
				&& !candidate.has_leading_comment
				&& candidate.range_start_line <= last.range_end_line + 1
				&& last_line_count + next_line_count <= *MAX_CHUNK_LINES;
			if can_merge {
				last.range_end_byte = candidate.range_end_byte;
				last.range_end_line = candidate.range_end_line;
				continue;
			}
		}
		grouped.push(candidate);
	}

	assign_unique_names(grouped)
}

/// Truncate a chunk identifier to at most `MAX_IDENT_CHARS` characters for
/// compact path segments. Trailing underscores left by mid-word truncation
/// are stripped.
fn truncate_path_name(name: &str) -> String {
	const MAX_IDENT_CHARS: usize = 3;
	if name.len() <= MAX_IDENT_CHARS {
		return name.to_string();
	}
	let end = name
		.char_indices()
		.nth(MAX_IDENT_CHARS)
		.map_or(name.len(), |(idx, _)| idx);
	name[..end].trim_end_matches('_').to_string()
}

fn assign_unique_names(mut candidates: Vec<RawChunkCandidate<'_>>) -> Vec<RawChunkCandidate<'_>> {
	// Truncate identifiers for path brevity before grouping.
	for candidate in &mut candidates {
		candidate.identifier = candidate
			.identifier
			.take()
			.map(|id| truncate_path_name(&id));
	}

	let mut totals = HashMap::<String, usize>::new();
	for candidate in &candidates {
		let key = candidate.kind.path_segment(candidate.identifier.as_deref());
		*totals.entry(key).or_insert(0) += 1;
	}
	let mut seen = HashMap::<String, usize>::new();

	for candidate in &mut candidates {
		let key = candidate.kind.path_segment(candidate.identifier.as_deref());
		let count = seen.entry(key.clone()).or_insert(0);
		*count += 1;
		let occurrence = *count;
		let total = *totals.get(key.as_str()).unwrap_or(&1);

		candidate.identifier = match candidate.name_style {
			NameStyle::Error => {
				if total > 1 {
					Some(occurrence.to_string())
				} else {
					None
				}
			},
			NameStyle::Named => {
				if total > 1 {
					match candidate.identifier.as_deref() {
						Some(identifier) => Some(format!("{identifier}_{occurrence}")),
						None => Some(occurrence.to_string()),
					}
				} else {
					candidate.identifier.clone()
				}
			},
			NameStyle::Group => {
				if total == 1 || occurrence == 1 {
					candidate.identifier.clone()
				} else {
					match candidate.identifier.as_deref() {
						Some(identifier) => Some(format!("{identifier}_{occurrence}")),
						None => Some(occurrence.to_string()),
					}
				}
			},
		};
	}

	candidates
}

// ── Collapse heuristics ──────────────────────────────────────────────────

/// Returns `true` when splitting a parent into children actually provides
/// meaningful scope narrowing. Recursion is only worthwhile if addressing
/// the largest child saves at least `PI_CHUNK_MIN_SAVINGS` lines compared
/// to addressing the parent directly — or when a child already wants to
/// recurse further (in which case the scope narrowing happens at the next
/// level and should not be cut off here).
fn recursion_narrows_scope(parent_lines: usize, children: &[RawChunkCandidate<'_>]) -> bool {
	if children.is_empty() {
		return false;
	}
	// If any child has already been marked as needing its own recursion,
	// always recurse through it. Otherwise a wrapper parent whose single
	// child covers almost the whole body (function -> return_statement,
	// arrow body -> JSX element, etc.) would fail the simple savings
	// heuristic even though splitting down the chain exposes real
	// structure.
	if children
		.iter()
		.any(|c| c.force_recurse && c.recurse.is_some())
	{
		return true;
	}
	let max_child_lines = children
		.iter()
		.map(|c| line_span(c.range_start_line, c.range_end_line))
		.max()
		.unwrap_or(0);
	parent_lines.saturating_sub(max_child_lines) >= *MIN_RECURSE_SAVINGS
}

fn should_collapse_trivial_children(
	parent: &RawChunkCandidate<'_>,
	children: &[RawChunkCandidate<'_>],
) -> bool {
	if children.is_empty() {
		return false;
	}

	let has_addressable_leaf_members = children.iter().all(|child| child.kind.traits().packed);
	if has_addressable_leaf_members && parent.kind.traits().has_addressable_members {
		return false;
	}
	if parent.kind.traits().always_preserve_children {
		return false;
	}

	if children.len() == 1 && is_collapsible_flat_child(&children[0]) {
		return true;
	}

	if !children.iter().all(is_collapsible_flat_child) {
		return false;
	}
	let total_lines: usize = children
		.iter()
		.map(|c| line_span(c.range_start_line, c.range_end_line))
		.sum();
	total_lines <= *LEAF_THRESHOLD
}

const fn is_trivial_child_candidate(candidate: &RawChunkCandidate<'_>) -> bool {
	!candidate.error
		&& !candidate.has_leading_comment
		&& candidate.injected.is_none()
		&& candidate.recurse.is_none()
		&& line_span(candidate.range_start_line, candidate.range_end_line) == 1
}

const fn is_collapsible_flat_child(candidate: &RawChunkCandidate<'_>) -> bool {
	(candidate.groupable || is_trivial_child_candidate(candidate))
		&& !candidate.error
		&& !candidate.has_leading_comment
		&& candidate.injected.is_none()
		&& candidate.recurse.is_none()
}

// ── Utility ──────────────────────────────────────────────────────────────

fn count_parse_errors(node: Node<'_>) -> (usize, Vec<u32>) {
	let mut count = 0;
	let mut lines = Vec::new();
	collect_parse_errors(node, &mut count, &mut lines);
	lines.sort_unstable();
	lines.dedup();
	(count, lines)
}

fn collect_parse_errors(node: Node<'_>, count: &mut usize, lines: &mut Vec<u32>) {
	if node.is_error() || node.is_missing() || node.kind() == "ERROR" {
		*count += 1;
		lines.push(node.start_position().row as u32 + 1);
	}
	for child in named_children(node) {
		collect_parse_errors(child, count, lines);
	}
}

fn resolve_chunk_lang(language: &str) -> Option<SupportLang> {
	SupportLang::from_alias(language)
}

fn infer_fallback_block_name(first_line: &str, seen: &mut HashMap<String, usize>) -> String {
	let trimmed = first_line.trim();
	let base = trimmed
		.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
		.next()
		.unwrap_or("")
		.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
	let base = if base.is_empty() { "chunk" } else { base };
	let count = seen.entry(base.to_string()).or_insert(0);
	*count += 1;
	if *count == 1 {
		base.to_string()
	} else {
		format!("{base}#{count}")
	}
}

pub(crate) fn line_start_offsets(source: &str) -> Vec<usize> {
	let mut starts = vec![0usize];
	for (index, byte) in source.bytes().enumerate() {
		if byte == b'\n' {
			starts.push(index + 1);
		}
	}
	starts
}

fn line_end_offset(source: &str, line_starts: &[usize], line_index: usize) -> usize {
	if line_index + 1 < line_starts.len() {
		line_starts[line_index + 1]
	} else {
		source.len()
	}
}

/// Same 16-character nibble alphabet as
/// `packages/coding-agent/src/patch/hashline.ts` (no digits).
const HASHLINE_NIBBLE_ALPHABET: &[u8; 16] = b"ZPMQVRWSNKTXJBYH";

/// Low 16 bits of XXH64, encoded as four letters (two bytes × two nibbles
/// each).
pub(crate) fn chunk_checksum(bytes: &[u8]) -> String {
	let h = xxh64(bytes, 0);
	let w = (h & 0xffff) as u16;
	let b0 = (w >> 8) as u8;
	let b1 = (w & 0xff) as u8;
	let mut out = String::with_capacity(4);
	for byte in [b0, b1] {
		let hi = usize::from(byte >> 4);
		let lo = usize::from(byte & 0x0f);
		out.push(char::from(HASHLINE_NIBBLE_ALPHABET[hi]));
		out.push(char::from(HASHLINE_NIBBLE_ALPHABET[lo]));
	}
	out
}

/// When the first structural chunk begins after line 1, insert a leaf chunk
/// `preamble` covering leading comments/whitespace so they stay
/// addressable via chunk paths (not only raw line ops).
fn insert_preamble_chunk(
	source: &str,
	chunks: &mut Vec<ChunkNode>,
	root_children: &mut Vec<String>,
) {
	if root_children.is_empty() {
		return;
	}
	if chunks.iter().any(|c| c.path == "preamble") || root_children.iter().any(|p| p == "preamble") {
		return;
	}
	let mut min_start = u32::MAX;
	for path in root_children.iter() {
		if let Some(chunk) = chunks.iter().find(|c| c.path == *path) {
			min_start = min_start.min(chunk.start_line);
		}
	}
	if min_start <= 1 {
		return;
	}
	let line_starts = line_start_offsets(source);
	let start_byte: u32 = 0;
	let end_byte = line_starts
		.get(min_start as usize - 1)
		.copied()
		.unwrap_or(source.len()) as u32;
	if end_byte <= start_byte {
		return;
	}
	let preamble_end_line = min_start - 1;
	let line_count = preamble_end_line;
	let checksum = chunk_checksum(
		source
			.as_bytes()
			.get(start_byte as usize..end_byte as usize)
			.unwrap_or_default(),
	);
	let preamble = ChunkNode {
		path: "preamble".to_string(),
		identifier: None,
		kind: ChunkKind::Preamble,
		leaf: true,
		virtual_content: None,
		parent_path: Some(String::new()),
		children: Vec::new(),
		signature: None,
		start_line: 1,
		end_line: preamble_end_line,
		line_count,
		start_byte,
		end_byte,
		checksum_start_byte: start_byte,
		prologue_end_byte: None,
		epilogue_start_byte: None,
		checksum,
		error: false,
		indent: 0,
		indent_char: String::new(),
		group: false,
	};
	chunks.push(preamble);
	root_children.insert(0, "preamble".to_string());
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use std::fmt::Write as _;

	use super::{
		build_chunk_tree, line_to_chunk_path, resolve_chunk_lang,
		state::ChunkState,
		types::{ChunkAnchorStyle, ReadRenderParams},
	};
	use crate::{chunk::ChunkKind, language::SupportLang};

	fn assert_supported_sample(language: &str, source: &str) {
		let tree = build_chunk_tree(source, language)
			.unwrap_or_else(|err| panic!("expected {language} sample to parse: {err}"));
		assert!(!tree.fallback, "{language} unexpectedly fell back to blank-line chunking");
		assert_eq!(tree.parse_errors, 0, "{language} sample should parse cleanly");
		assert!(
			!tree.root_children.is_empty(),
			"{language} should expose at least one structural chunk"
		);
	}

	#[test]
	fn resolves_every_supported_canonical_language() {
		for language in SupportLang::all_langs() {
			assert_eq!(
				resolve_chunk_lang(language.canonical_name()),
				Some(*language),
				"missing canonical alias for {}",
				language.canonical_name()
			);
		}
	}

	#[test]
	fn resolves_handlebars_and_tlaplus_aliases() {
		assert_eq!(resolve_chunk_lang("handlebars"), Some(SupportLang::Handlebars));
		assert_eq!(resolve_chunk_lang("hbs"), Some(SupportLang::Handlebars));
		assert_eq!(resolve_chunk_lang("hsb"), Some(SupportLang::Handlebars));
		assert_eq!(resolve_chunk_lang("tla"), Some(SupportLang::Tlaplus));
		assert_eq!(resolve_chunk_lang("pluscal"), Some(SupportLang::Tlaplus));
	}

	#[test]
	fn builds_structural_tree_for_each_supported_language() {
		let cases = [
			(
				"astro",
				"---\nconst title = \"Hello\";\n---\n<Layout><h1>{title}</h1><script>console.log(title)</script></Layout>\n",
			),
			("bash", "build() { echo ok; }\n"),
			("c", "#include <stdio.h>\nint main(void) { return 0; }\n"),
			(
				"cmake",
				"cmake_minimum_required(VERSION 3.28)\nproject(App)\nfunction(run_it NAME)\n  message(STATUS ${NAME})\nendfunction()\n",
			),
			("cpp", "#include <vector>\nclass App {};\nint main() { return 0; }\n"),
			("csharp", "using System;\nclass App { void Run() {} }\n"),
			("clojure", "(ns demo.core)\n(defn greet [x] x)\n"),
			("css", "@import \"a.css\";\n.app { color: red; }\n"),
			("diff", "@@ -1,1 +1,1 @@\n-a\n+b\n"),
			(
				"dockerfile",
				"FROM alpine AS base\nARG PORT=3000\nRUN echo hi\nCMD [\"sh\", \"-c\", \"echo ok\"]\n",
			),
			("elixir", "defmodule App do\n  def run(x) do\n    x\n  end\nend\n"),
			(
				"erlang",
				"-module(app).\n-export([run/1]).\nrun(X) ->\n    case X of\n        ok -> ok;\n        _ -> error\n    end.\n",
			),
			("go", "package main\nimport \"fmt\"\nfunc main() { fmt.Println(\"ok\") }\n"),
			("graphql", "type Query { hello: String }\nquery AppQuery { hello }\n"),
			("handlebars", "{{#if ready}}<div class=\"ok\">{{name}}</div>{{/if}}\n"),
			("haskell", "module App where\nimport Data.List\nmain = putStrLn \"ok\"\n"),
			("hcl", "locals { foo = 1 }\n"),
			("html", "<div><span>ok</span></div>\n"),
			("ini", "[app]\nname=demo\nport=3000\n"),
			("java", "import java.util.*;\nclass App { void run() {} }\n"),
			("javascript", "import x from \"x\";\nexport function run() {}\n"),
			("json", "{\"name\":\"app\",\"scripts\":{\"start\":\"bun\"}}\n"),
			("just", "set shell := [\"bash\", \"-cu\"]\nrun name:\n    echo {{name}}\n"),
			("julia", "module App\nfunction run(x)\n  x\nend\nend\n"),
			("kotlin", "package app\nclass App { fun run() {} }\n"),
			("lua", "local function run(x) return x end\n"),
			("make", "all:\n\t@echo hi\n"),
			("markdown", "# Title\n\n## Child\n\ntext\n"),
			("nix", "{ hello = \"world\"; }\n"),
			(
				"objc",
				"#import <Foundation/Foundation.h>\n@interface App : NSObject\n- (void)run;\n@end\n",
			),
			("ocaml", "open Printf\nlet run x = x + 1\nmodule App = struct let value = 1 end\n"),
			("odin", "package main\nmain :: proc() {}\n"),
			("perl", "package App;\nuse strict;\nsub run { return 1; }\n"),
			("php", "<?php\nclass App { function run() {} }\n"),
			(
				"powershell",
				"param([string]$Name)\nfunction Invoke-App { Write-Host $Name }\nInvoke-App\n",
			),
			(
				"protobuf",
				"syntax = \"proto3\";\nmessage App { string name = 1; }\nservice Api { rpc Run (App) returns (App); }\n",
			),
			("python", "class App:\n    def run(self):\n        return 1\n"),
			("r", "run <- function(x) { x + 1 }\nvalue <- run(1)\n"),
			("regex", "[a-z]+"),
			("ruby", "module App\n  class User\n    def run\n    end\n  end\nend\n"),
			("rust", "use std::fmt;\nfn main() {}\n"),
			("scala", "package demo\nobject App { def run(): Unit = {} }\n"),
			("solidity", "pragma solidity ^0.8.0;\ncontract App { function run() public {} }\n"),
			("sql", "create table app(id int primary key);\nselect * from app;\n"),
			("starlark", "def build(ctx):\n    pass\n"),
			("svelte", "<script>let count = 0;</script>\n{#if count}<p>{count}</p>{/if}\n"),
			("swift", "import Foundation\nclass App { func run() {} }\n"),
			("toml", "[package]\nname = \"app\"\n"),
			(
				"tlaplus",
				"---- MODULE Spec ----\nVARIABLE x\n\n(* --algorithm Demo\nvariables x = 0;\nbegin\n  Inc:\n    x := x + 1;\nend algorithm; *)\n====\n",
			),
			("tsx", "export function App() { return <div />; }\n"),
			("typescript", "export function run(): void {}\n"),
			("verilog", "module app; endmodule\n"),
			(
				"vue",
				"<template><div>{{ msg }}</div></template>\n<script setup>const msg = 'hi'</script>\n",
			),
			("xml", "<root><item /></root>\n"),
			("yaml", "apiVersion: v1\nmetadata:\n  name: app\n"),
			("zig", "const std = @import(\"std\");\npub fn main() void {}\n"),
		];

		for (language, source) in cases {
			assert_supported_sample(language, source);
		}
	}

	#[test]
	fn tlaplus_keeps_module_and_hides_translation_generated_chunks() {
		let tree = build_chunk_tree(
			"---- MODULE Spec ----\nVARIABLE x\n\nInit == x = 0\n\n(* --algorithm Demo\nvariables x \
			 = 0;\nbegin\n  Inc:\n    x := x + 1;\nend algorithm; *)\n\\* BEGIN \
			 TRANSLATION\nVARIABLES pc\nNext == pc' = pc\n\\* END TRANSLATION\n====\n",
			"tlaplus",
		)
		.expect("tlaplus tree should build");

		assert_eq!(tree.root_children, vec!["mod_Spe"]);

		let module = tree
			.chunks
			.iter()
			.find(|chunk| chunk.path == "mod_Spe")
			.expect("mod_Spe chunk should exist");
		assert!(
			module
				.children
				.iter()
				.any(|child| child == "mod_Spe.oper_Ini"),
			"expected Init operator child, got {:?}",
			module.children
		);
		assert!(
			module
				.children
				.iter()
				.any(|child| child == "mod_Spe.translation_12"),
			"expected synthetic translation chunk, got {:?}",
			module.children
		);
		assert!(
			tree
				.chunks
				.iter()
				.all(|chunk| !chunk.path.ends_with("oper_Nex")),
			"translation-generated operator should be hidden: {:?}",
			tree
				.chunks
				.iter()
				.map(|chunk| chunk.path.as_str())
				.collect::<Vec<_>>()
		);
	}

	#[test]
	fn json_and_hcl_chunk_names_are_structural() {
		let json = build_chunk_tree("{\"scripts\":{\"start\":\"bun\"}}\n", "json")
			.expect("json tree should build");
		assert!(
			json.root_children.contains(&"key_scr".to_string()),
			"expected key_scr, got {:?}",
			json.root_children
		);

		let hcl = build_chunk_tree("locals { foo = 1 }\n", "hcl").expect("hcl tree should build");
		assert!(
			hcl.root_children.contains(&"blk_loc".to_string()),
			"expected blk_loc, got {:?}",
			hcl.root_children
		);
	}

	#[test]
	fn yaml_nested_keys_produce_sub_chunks() {
		// YAML keys with container values always recurse (force_recurse=true),
		// so even small mappings produce sub-chunks.
		let source = "database:\n  host: localhost\n  port: 5432\n  credentials:\n    username: \
		              admin\n    password: secret\n";
		let tree = build_chunk_tree(source, "yaml").expect("yaml tree should build");

		assert!(
			tree.root_children.contains(&"key_dat".to_string()),
			"expected key_dat, got {:?}",
			tree.root_children
		);

		let db = tree
			.chunks
			.iter()
			.find(|c| c.path == "key_dat")
			.expect("key_dat");
		assert!(!db.leaf, "key_dat should have children: {:?}", db.children);
		assert!(
			db.children.iter().any(|c| c.contains("key_hos")),
			"expected key_hos child, got {:?}",
			db.children
		);
		assert!(
			db.children.iter().any(|c| c.contains("key_cre")),
			"expected key_cre child, got {:?}",
			db.children
		);

		// 3-level deep: credentials should also have sub-chunks.
		let creds = tree
			.chunks
			.iter()
			.find(|c| c.path == "key_dat.key_cre")
			.expect("key_cre");
		assert!(!creds.leaf, "key_cre should have children: {:?}", creds.children);
		assert!(
			creds.children.iter().any(|c| c.contains("key_use")),
			"expected key_use child of credentials, got {:?}",
			creds.children
		);
	}

	#[test]
	fn yaml_key_region_boundaries_separate_key_from_value() {
		use super::{resolve::chunk_region_range, types::ChunkRegion};

		let source = "server:\n  host: 0.0.0.0\n  port: 8080\n";
		let tree = build_chunk_tree(source, "yaml").expect("yaml tree should build");
		let server = tree
			.chunks
			.iter()
			.find(|c| c.path == "key_ser")
			.expect("key_ser");

		// ^ should contain "server:" but not the nested keys.
		let (head_s, head_e) = chunk_region_range(server, ChunkRegion::Head);
		let head = &source[head_s..head_e];
		assert!(head.contains("server"), "^ should contain the key, got {head:?}");
		assert!(!head.contains("host"), "^ should not contain value content, got {head:?}");

		// ~ should contain the nested keys but not "server:".
		let (body_s, body_e) = chunk_region_range(server, ChunkRegion::Body);
		let body = &source[body_s..body_e];
		assert!(body.contains("host"), "~ should contain nested keys, got {body:?}");
		assert!(!body.contains("server"), "~ should not contain the key header, got {body:?}");
	}

	#[test]
	fn yaml_leading_comment_does_not_prevent_sub_chunks() {
		let source = "# Global settings\napp:\n  name: my-app\n  debug: true\n  features:\n    - \
		              auth\n    - logging\n";
		let tree = build_chunk_tree(source, "yaml").expect("yaml tree should build");

		// The leading comment becomes a preamble; key_app is a separate chunk.
		let app = tree
			.chunks
			.iter()
			.find(|c| c.path == "key_app")
			.expect("key_app");

		// Sub-keys should be individually addressable.
		assert!(!app.leaf, "key_app should have children: {:?}", app.children);
		assert!(
			app.children.iter().any(|c| c.contains("key_nam")),
			"expected key_nam child, got {:?}",
			app.children
		);
		assert!(
			app.children.iter().any(|c| c.contains("key_deb")),
			"expected key_deb child, got {:?}",
			app.children
		);
		assert!(
			app.children.iter().any(|c| c.contains("key_fea")),
			"expected key_fea child, got {:?}",
			app.children
		);
	}

	#[test]
	fn handlebars_chunks_blocks_and_tags() {
		let tree =
			build_chunk_tree("{{#if ready}}<div class=\"ok\">{{name}}</div>{{/if}}\n", "handlebars")
				.expect("handlebars tree should build");
		assert!(
			tree.root_children.contains(&"blk_if".to_string()),
			"expected blk_if, got {:?}",
			tree.root_children
		);
		let block = tree
			.chunks
			.iter()
			.find(|chunk| chunk.path == "blk_if")
			.expect("blk_if chunk should exist");
		assert!(!block.leaf);
		assert!(
			block.children.iter().any(|child| child == "blk_if.tag_div"),
			"expected nested div tag, got {:?}",
			block.children
		);
	}

	#[test]
	fn builds_typescript_chunk_tree() {
		let source = format!(
			r#"import a from "a";
import b from "b";

class Bla extends Base {{
	value = 1;

	constructor(config: Config) {{
		this.value = config.value;
	}}

	async onEvent(ev: Event, ctx?: Context): Promise<void> {{
		if (!ev) return;
{body}
	}}
}}

function main(): void {{
	console.log("ok");
}}
"#,
			body = (0..60)
				.map(|index| format!("\t\tthis.value += {index};"))
				.collect::<Vec<_>>()
				.join("\n"),
		);

		let tree = build_chunk_tree(source.as_str(), "typescript").expect("tree should build");
		let child_names = tree
			.root_children
			.iter()
			.map(std::string::String::as_str)
			.collect::<Vec<_>>();
		assert_eq!(child_names, vec!["imp", "cls_Bla", "fn_mai"]);

		let class_chunk = tree
			.chunks
			.iter()
			.find(|chunk| chunk.path == "cls_Bla")
			.expect("class chunk should exist");
		assert!(!class_chunk.leaf);
		assert!(
			class_chunk
				.children
				.iter()
				.any(|child| child == "cls_Bla.ctor")
		);
		assert!(
			class_chunk
				.children
				.iter()
				.any(|child| child == "cls_Bla.fn_onE")
		);

		let line_path = line_to_chunk_path(&tree, 15).expect("line should resolve");
		assert!(line_path.starts_with("cls_Bla.fn_onE"));
	}

	#[test]
	fn call_with_trailing_callback_promotes_to_named_expression() {
		// Test that `describe(...)` / `it(...)` patterns with trailing callback
		// arguments are promoted to named expression chunks with children,
		// rather than being flat groupable stmts leaves.
		let source = "import { describe, it } from \"bun:test\";\n\ndescribe(\"suite\", () => \
		              {\n\tit(\"does a\", () => {\n\t\texpect(1).toBe(1);\n\t});\n\n\tit(\"does \
		              b\", () => {\n\t\texpect(2).toBe(2);\n\t});\n});\n";
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");

		// describe(...) should be promoted to a named expr chunk, not grouped into
		// stmts.
		let describe_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "ex_des")
			.expect("describe should be a named chunk");
		assert!(!describe_chunk.leaf, "describe chunk should have children (not a leaf)");
		assert!(!describe_chunk.group, "describe chunk should not be groupable");

		// The nested calls inside should stay addressable under the promoted parent.
		let it_chunks = tree
			.chunks
			.iter()
			.filter(|c| c.path.starts_with("ex_des.ex"))
			.count();
		assert_eq!(
			it_chunks,
			2,
			"nested calls under describe() should stay addressable; chunks: {:?}",
			tree.chunks.iter().map(|c| &c.path).collect::<Vec<_>>()
		);
	}

	#[test]
	fn call_with_trailing_callback_works_for_member_expressions() {
		// Test member expression calls like `describe.serial(...)` or `app.use(...)`.
		let source = "describe.serial(\"ordered\", () => {\n\tit(\"first\", () => \
		              {\n\t\texpect(true).toBe(true);\n\t});\n});\n";
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");

		let describe_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "ex_des")
			.expect("describe.serial should be a named chunk");
		assert!(!describe_chunk.group, "describe.serial chunk should not be groupable");
	}

	#[test]
	fn call_without_callback_stays_grouped() {
		// Plain call expressions without trailing callbacks should remain as
		// groupable stmts, not promoted.
		let source = "console.log(\"a\");\nconsole.log(\"b\");\n";
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");

		let stmts_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "st")
			.expect("plain calls should be grouped into st");
		assert!(stmts_chunk.group, "stmts should be a group");
		assert!(stmts_chunk.leaf, "stmts with no callback should be a leaf");
	}

	#[test]
	fn nested_call_with_callback_has_body_region() {
		// Nested test()/it() calls inside describe() should be promoted with
		// prologue/epilogue set so that `~` targets the callback body, not the
		// entire chunk.
		let source = "\
describe(\"suite\", () => {
\ttest(\"my test\", () => {
\t\tconst x = 1;
\t\tconst y = 2;
\t\tconst z = 3;
\t\texpect(x + y).toBe(z);
\t});

\ttest(\"other test\", () => {
\t\tconst a = 10;
\t\tconst b = 20;
\t\tconst c = 30;
\t\texpect(a + b).toBe(c);
\t});
});
";
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");

		let test_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path.starts_with("ex_des.ex_tes"))
			.expect("test() should be a promoted named chunk under describe");
		assert!(
			test_chunk.prologue_end_byte.is_some(),
			"test() chunk should have prologue_end_byte for ~ region support"
		);
		assert!(
			test_chunk.epilogue_start_byte.is_some(),
			"test() chunk should have epilogue_start_byte for ~ region support"
		);
	}

	#[test]
	fn jsx_return_with_map_callback_exposes_nested_chunks() {
		// A React component body that returns `items.map(item =>
		// <Link>...children...</Link>)` used to collapse into a single opaque return
		// chunk, forcing any edit to replace the full return body. The pipeline must
		// now surface:
		//   * the `.map()` call as a promoted `expr_*` container
		//   * the inner `return (<Link>...)` as a `ret` container
		//   * every direct JSX child of the returned element as its own `tag_*` chunk
		let source = r#"
	const runsBody = () => {
		return items.map(run => {
			return (
				<Link
					key={run.uid}
					href={`/runs/${run.uid}`}
				>
					<div className="col-a">
						{run.uid}
					</div>
					<div className="col-b">
						{run.name}
					</div>
					<div className="col-c">
						{run.state}
					</div>
				</Link>
			);
		});
	};
	"#;
		let tree = build_chunk_tree(source, "tsx").expect("tsx tree should build");
		let paths: Vec<&str> = tree.chunks.iter().map(|c| c.path.as_str()).collect();

		let ret = tree
			.chunks
			.iter()
			.find(|c| c.path == "fn_run.ex_ite.ret")
			.unwrap_or_else(|| panic!("expected fn_run.ex_ite.ret; chunks: {paths:?}"));
		assert!(!ret.leaf, "JSX return chunk must expose children, got leaf");

		let div_children: Vec<&str> = tree
			.chunks
			.iter()
			.filter(|c| c.path.starts_with("fn_run.ex_ite.ret.tag_div"))
			.map(|c| c.path.as_str())
			.collect();
		assert_eq!(
			div_children.len(),
			3,
			"expected 3 top-level div chunks inside the returned <Link>, got {div_children:?}"
		);

		// The JSX opening/closing elements must not leak into the chunk tree.
		assert!(
			!paths
				.iter()
				.any(|p| p.contains("ch_jsx") || p.contains("ch_jsx")),
			"jsx opening/closing elements must be filtered out; chunks: {paths:?}"
		);
	}

	#[test]
	fn jsx_return_does_not_absorb_opening_tag_into_first_child() {
		// When the outer `<Link>` has a multi-line opening element, the first
		// `<div>` child must still report its own real start line and not be
		// extended backward to swallow the opening element.
		let source = r#"
	const row = (run: Run) => {
		return (
			<Link
				key={run.uid}
				href={`/runs/${run.uid}`}
				className="row"
			>
				<div className="first-cell">
					{run.uid}
				</div>
				<div className="second-cell">
					{run.name}
				</div>
			</Link>
		);
	};
	"#;
		let tree = build_chunk_tree(source, "tsx").expect("tsx tree should build");
		let first_div = tree
			.chunks
			.iter()
			.find(|c| c.path == "fn_row.ret.tag_div_1")
			.expect("first tag_div_1 should exist");
		// The `<div className="first-cell">` starts well below the `<Link` opening;
		// it must NOT have its start line dragged backward onto the opening tag.
		assert!(
			first_div.start_line >= 9,
			"first div chunk must start at its own opening line (>=9), got {}",
			first_div.start_line
		);
	}

	#[test]
	fn jsx_return_directly_returning_element_exposes_children() {
		// `return <Foo>...</Foo>` without parens should still recurse into the JSX.
		let source = r#"
	const header = () => {
		return <header className="h">
			<div>title</div>
			<div>subtitle</div>
			<div>body</div>
			<div>footer</div>
		</header>;
	};
	"#;
		let tree = build_chunk_tree(source, "tsx").expect("tsx tree should build");
		let ret = tree
			.chunks
			.iter()
			.find(|c| c.path == "fn_hea.ret")
			.expect("ret chunk should exist");
		assert!(!ret.leaf, "bare JSX return should expose its children");
	}

	#[test]
	fn small_jsx_return_stays_collapsed() {
		// Short JSX returns (well under the leaf threshold) should NOT explode
		// into per-element chunks — otherwise small React components get drowned
		// in noise.
		let source = r"
		const Loading = () => {
			return <div>Loading…</div>;
		};
		";
		let tree = build_chunk_tree(source, "tsx").expect("tsx tree should build");
		let has_tag_children = tree
			.chunks
			.iter()
			.any(|c| c.path.starts_with("fn_Loading.") && c.path.contains("tag_"));
		assert!(
			!has_tag_children,
			"tiny JSX components should not explode; chunks: {:?}",
			tree.chunks.iter().map(|c| &c.path).collect::<Vec<_>>()
		);
	}

	#[test]
	fn surfaces_error_chunks() {
		let source = r"class Broken {
	method() {
		if (
	}

	ok(): void {
		return;
	}
}
";

		let tree = build_chunk_tree(source, "typescript").expect("tree should build");
		assert!(tree.parse_errors > 0);
		assert!(
			tree
				.chunks
				.iter()
				.any(|chunk| chunk.kind == ChunkKind::Error && chunk.identifier.is_none()),
			"expected error chunk, got {:?}",
			tree
				.chunks
				.iter()
				.map(|chunk| (&chunk.path, chunk.kind, chunk.identifier.as_deref()))
				.collect::<Vec<_>>()
		);
	}

	#[test]
	fn falls_back_to_blank_line_blocks() {
		let source = "A=1\nB=2\n\nC=3\n";
		let tree = build_chunk_tree(source, "env").expect("fallback tree should build");
		assert!(tree.fallback);
		assert_eq!(tree.root_children, vec!["A", "C"]);
	}

	#[test]
	fn always_recurses_small_class() {
		let source = r"class Tiny {
	foo() { return 1; }
	bar() { return 2; }
}";
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");
		let class_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "cls_Tin")
			.expect("cls_Tin");
		assert!(!class_chunk.leaf);
		assert!(class_chunk.children.iter().any(|c| c == "cls_Tin.fn_foo"));
		assert!(class_chunk.children.iter().any(|c| c == "cls_Tin.fn_bar"));
	}

	#[test]
	fn empty_class_is_a_branch() {
		let source = r"class Empty {}";
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");
		let class_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "cls_Emp")
			.expect("cls_Emp");
		assert!(!class_chunk.leaf);
	}

	#[test]
	fn promotes_arrow_function_to_fn_chunk() {
		let source = r"const handler = (ev) => {
	console.log(ev);
	return ev;
};";
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");
		assert!(tree.chunks.iter().any(|c| c.path == "fn_han"), "expected fn_han chunk");
		assert!(
			!tree.root_children.contains(&"decls".to_string()),
			"arrow fn should not be grouped as decls"
		);
	}

	#[test]
	fn promotes_const_class_expression() {
		let source = r"const Foo = class {
	method() { return 42; }
};";
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");
		assert!(tree.chunks.iter().any(|c| c.path == "cls_Foo"), "expected cls_Foo chunk");
		assert!(
			!tree.root_children.contains(&"decls".to_string()),
			"class expr should not be grouped as decls"
		);
	}

	#[test]
	fn promotes_exported_arrow_function_and_preserves_wrapper_range() {
		let source = r#"export const handler = () => {
	console.log("handled");
};"#;
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");
		let chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "fn_han")
			.expect("fn_han");
		assert!(chunk.leaf);
		assert_eq!(chunk.start_line, 1);
		assert_eq!(chunk.end_line, 3);
		assert!(
			!tree.root_children.contains(&"decls".to_string()),
			"exported arrow fn should not fall back to decls"
		);
	}

	#[test]
	fn promotes_exported_const_class_expression() {
		let source = r"export const Foo = class {
	method() { return 42; }
};";
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");
		let chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "cls_Foo")
			.expect("cls_Foo");
		assert!(!chunk.leaf);
		assert_eq!(chunk.start_line, 1);
		assert_eq!(chunk.end_line, 3);
	}

	#[test]
	fn promotes_export_default_class_to_default_export_chunk() {
		let source = r"export default class Foo {
	method() { return 42; }
}";
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");
		let chunk = tree.chunks.iter().find(|c| c.path == "dex").expect("dex");
		assert_eq!(chunk.start_line, 1);
		assert_eq!(chunk.end_line, 3);
		assert!(
			!tree.root_children.contains(&"cls_Foo".to_string()),
			"default export should be remapped to defexp"
		);
	}

	#[test]
	fn small_interfaces_keep_children() {
		let source = r"interface Config {
    name: string;
    getValue(): number;
}";
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");
		let iface = tree
			.chunks
			.iter()
			.find(|c| c.path == "intf_Con")
			.expect("intf_Con");
		assert!(!iface.children.is_empty(), "interface members should be addressable as children");
	}

	#[test]
	fn unicode_identifiers_preserved() {
		let source = r"class 服务器 {
	启动() { return true; }
}";
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");
		assert!(tree.chunks.iter().any(|c| c.path == "cls_服务器"), "expected cls_服务器 chunk");
	}

	#[test]
	fn python_chunk_tree() {
		let source = r"import os
import sys

class Server:
    def __init__(self):
        self.running = False

    def start(self):
        self.running = True

def main():
    s = Server()
    s.start()
"
		.to_string();
		let tree = build_chunk_tree(source.as_str(), "python").expect("tree should build");
		let names: Vec<&str> = tree.root_children.iter().map(String::as_str).collect();
		assert!(names.contains(&"imp"), "expected imports, got {names:?}");
		assert!(names.contains(&"cls_Ser"), "expected cls_Ser, got {names:?}");
		assert!(names.contains(&"fn_mai"), "expected fn_mai, got {names:?}");
		let cls = tree
			.chunks
			.iter()
			.find(|c| c.path == "cls_Ser")
			.expect("cls_Ser");
		assert!(!cls.leaf);
		assert!(
			cls.children.iter().any(|c| c == "cls_Ser.fn_ini"),
			"expected fn_ini (__init__ sanitized)"
		);
		assert!(cls.children.iter().any(|c| c == "cls_Ser.fn_sta"), "expected fn_sta");
		assert_eq!(cls.signature.as_deref(), Some("class Server"));
	}

	#[test]
	fn python_loops_are_named_loop() {
		let mut body = String::new();
		body.push_str("    total = 0\n");
		body.push_str("    for item in range(3):\n");
		body.push_str("        total += item\n");
		for index in 0..55 {
			let _ = writeln!(body, "    filler_{index} = {index}");
		}
		body.push_str("    return total\n");
		let source = format!("def worker():\n{body}");
		let tree = build_chunk_tree(source.as_str(), "python").expect("tree should build");
		let worker = tree
			.chunks
			.iter()
			.find(|c| c.path == "fn_wor")
			.expect("fn_wor");
		assert!(!worker.leaf);
		assert!(tree.chunks.iter().any(|c| c.path == "fn_wor.loop"), "expected loop chunk");
	}

	#[test]
	fn python_class_signature_strips_colon() {
		let source = r"class Foo(Base):
    pass
";
		let tree = build_chunk_tree(source, "python").expect("tree should build");
		let class_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "cls_Foo")
			.expect("cls_Foo");
		assert_eq!(class_chunk.signature.as_deref(), Some("class Foo(Base)"));
		assert!(class_chunk.leaf);
	}

	#[test]
	fn rust_chunk_tree() {
		let source = r#"use std::io;

struct Config {
    name: String,
}

impl Config {
    fn new(name: String) -> Self {
        Config { name }
    }

    fn name(&self) -> &str {
        &self.name
    }
}

fn main() {
    let c = Config::new("test".into());
    println!("{}", c.name());
}"#;
		let tree = build_chunk_tree(source, "rust").expect("tree should build");
		let names: Vec<&str> = tree.root_children.iter().map(String::as_str).collect();
		assert!(names.contains(&"imp"), "expected imports, got {names:?}");
		assert!(names.contains(&"stc_Con"), "expected stc_Con, got {names:?}");
		assert!(names.contains(&"ipl_Con"), "expected ipl_Con, got {names:?}");
		assert!(names.contains(&"fn_mai"), "expected fn_mai, got {names:?}");
		let impl_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "ipl_Con")
			.expect("ipl_Con");
		assert!(!impl_chunk.leaf);
		assert!(impl_chunk.children.iter().any(|c| c == "ipl_Con.fn_new"), "expected fn_new");
		assert!(impl_chunk.children.iter().any(|c| c == "ipl_Con.fn_nam"), "expected fn_nam");
	}

	#[test]
	fn rust_trait_impl_naming() {
		let source = r#"use std::fmt;

struct Config {
    name: String,
}

impl fmt::Display for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.name)
    }
}

impl Config {
    fn new(name: String) -> Self {
        Config { name }
    }
}"#;
		let tree = build_chunk_tree(source, "rust").expect("tree should build");
		let names: Vec<&str> = tree.root_children.iter().map(String::as_str).collect();
		assert!(names.contains(&"ipl_Dis"), "expected ipl_Dis, got {names:?}");
		assert!(names.contains(&"ipl_Con"), "expected ipl_Con, got {names:?}");
	}

	#[test]
	fn rust_field_naming() {
		let fields: Vec<String> = (0..32).map(|i| format!("    field_{i}: u32,")).collect();
		let source = format!("struct Server {{\n{}\n}}\n", fields.join("\n"));
		let tree = build_chunk_tree(&source, "rust").expect("tree should build");
		let server = tree
			.chunks
			.iter()
			.find(|c| c.path == "stc_Ser")
			.expect("stc_Ser should exist");
		assert!(!server.leaf, "large struct should be a branch");
		assert!(
			server.children.iter().any(|c| c == "stc_Ser.fld_fie_1"),
			"expected fld_fie_1 in children: {:?}",
			server.children
		);
	}

	#[test]
	fn go_chunk_tree() {
		let source = r#"package main

	import "fmt"

	type Config struct {
		Name string
	}

	type Reader interface {
		Read(p []byte) (int, error)
	}

	func main() {
		fmt.Println("hello")
	}"#;
		let tree = build_chunk_tree(source, "go").expect("tree should build");
		let names: Vec<&str> = tree.root_children.iter().map(String::as_str).collect();
		assert!(names.contains(&"imp"), "expected imports, got {names:?}");
		assert!(names.contains(&"ty_Con"), "expected ty_Con, got {names:?}");
		assert!(names.contains(&"ty_Rea"), "expected ty_Rea, got {names:?}");
		assert!(names.contains(&"fn_mai"), "expected fn_mai, got {names:?}");
		let config = tree
			.chunks
			.iter()
			.find(|c| c.path == "ty_Con")
			.expect("ty_Con");
		assert!(!config.leaf);
		assert!(
			config
				.children
				.iter()
				.any(|child| child == "ty_Con.fld_Nam"),
			"expected ty_Con.fld_Nam, got {:?}",
			config.children
		);
		let reader = tree
			.chunks
			.iter()
			.find(|c| c.path == "ty_Rea")
			.expect("ty_Rea");
		assert!(reader.leaf);
		assert!(reader.children.is_empty(), "single-line interfaces should render inline");
	}

	#[test]
	fn nix_chunk_tree_exposes_attr_bindings() {
		let source = r#"{
	        hello = "world";
	        nested = {
	          value = 1;
	        };
	      }
	    "#;
		let tree = build_chunk_tree(source, "nix").expect("tree should build");
		let attrset = tree
			.chunks
			.iter()
			.find(|chunk| chunk.path == "ats")
			.expect("ats chunk");
		assert!(!tree.fallback, "nix should use tree-sitter chunking");
		assert!(!attrset.leaf, "top-level attrset should recurse into bindings");
		assert!(
			attrset.children.iter().any(|child| child == "ats.attr_hel"),
			"expected attr_hel child, got {:?}",
			attrset.children
		);
		assert!(
			attrset.children.iter().any(|child| child == "ats.attr_nes"),
			"expected attr_nes child, got {:?}",
			attrset.children
		);
	}

	#[test]
	fn preamble_chunk_covers_leading_lines_before_first_item() {
		let source = "// header\n// second\n\nfn main() {}\n";
		let tree = build_chunk_tree(source, "rust").expect("tree should build");
		assert!(
			tree.root_children.iter().any(|c| c == "preamble"),
			"expected preamble in {:?}",
			tree.root_children
		);
		let preamble = tree
			.chunks
			.iter()
			.find(|c| c.path == "preamble")
			.expect("preamble");
		assert_eq!(preamble.start_line, 1);
		assert_eq!(preamble.end_line, 3);
		let main_fn = tree
			.chunks
			.iter()
			.find(|c| c.path == "fn_mai")
			.expect("fn_mai");
		assert!(
			main_fn.start_line > preamble.end_line,
			"first structural chunk should start after preamble"
		);
	}

	#[test]
	fn indent_fields_populated() {
		let source = "class Foo {\n\tbar() {\n\t\treturn 1;\n\t}\n}";
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");
		let method = tree
			.chunks
			.iter()
			.find(|c| c.path == "cls_Foo.fn_bar")
			.expect("fn_bar");
		assert_eq!(method.indent, 1, "method should have indent=1");
		assert_eq!(method.indent_char, "\t", "method should use tab indentation");
	}

	#[test]
	fn keeps_trivial_rust_enum_variants_addressable() {
		let source = r"pub enum LogLevel {
	    Debug,
	    Info,
	    Warn,
	    Error,
	}";
		let tree = build_chunk_tree(source, "rust").expect("tree should build");
		let enum_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "en_Log")
			.expect("en_Log");
		assert!(!enum_chunk.leaf);
		assert!(
			enum_chunk
				.children
				.iter()
				.any(|child| child == "en_Log.vr_Deb")
		);
		assert!(
			enum_chunk
				.children
				.iter()
				.any(|child| child == "en_Log.vr_Err")
		);
	}

	#[test]
	fn rust_trait_members_stay_addressable() {
		let source = r"trait Handler {
	    fn handle(&self, method: &str, path: &str) -> OpResult;
	}";
		let tree = build_chunk_tree(source, "rust").expect("tree should build");
		let trait_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "tr_Han")
			.expect("tr_Han");
		assert!(!trait_chunk.children.is_empty(), "trait members should be addressable as children");
	}

	#[test]
	fn collapses_trivial_go_interface_children() {
		let source = r"package main

	type Handler interface {
	    Handle(method, path string) Result
	}";
		let tree = build_chunk_tree(source, "go").expect("tree should build");
		let iface = tree
			.chunks
			.iter()
			.find(|c| c.path == "ty_Han")
			.expect("ty_Han");
		assert!(iface.leaf);
		assert!(iface.children.is_empty(), "single-line interface methods should render inline");
	}

	#[test]
	fn typescript_interfaces_use_interface_prefix() {
		let source = r"interface Settings {
    enabled: boolean;
}
";
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");
		assert!(
			tree.chunks.iter().any(|chunk| chunk.path == "intf_Set"),
			"expected intf_Set in {:?}",
			tree
				.chunks
				.iter()
				.map(|chunk| chunk.path.as_str())
				.collect::<Vec<_>>()
		);
		assert!(
			!tree.chunks.iter().any(|chunk| chunk.path == "ifc_Set"),
			"legacy ifc_ prefix should not remain addressable"
		);
	}

	#[test]
	fn read_resolves_partial_selectors_and_bare_checksums() {
		let filler = (0..60)
			.map(|index| format!("    const value{index} = {index};"))
			.collect::<Vec<_>>()
			.join("\n");
		let source = format!(
			"function handleTerraform() {{\n{filler}\n    try {{\n        if (ready) {{\n            \
			 work();\n        }}\n    }} catch (error) {{\n        throw error;\n    }}\n}}\n"
		);
		let state = ChunkState::parse(source, "typescript".to_string()).expect("state should parse");
		let chunk = state
			.chunks()
			.into_iter()
			.find(|candidate| candidate.path == "fn_han.try")
			.expect("try chunk path should exist");
		let selectors = vec![
			format!("sample.ts:{}", "fn_han.try"),
			format!("sample.ts:{}", "handle.try"),
			format!("sample.ts:{}", "try"),
			format!("sample.ts:try#{}", chunk.checksum),
			format!("sample.ts:#{}", chunk.checksum),
			format!("sample.ts:{}", chunk.checksum),
		];
		for selector in selectors {
			let result = state
				.render_read(ReadRenderParams {
					read_path:           selector.clone(),
					display_path:        "sample.ts".to_string(),
					language_tag:        Some("ts".to_string()),
					omit_checksum:       false,
					anchor_style:        Some(ChunkAnchorStyle::Full),
					absolute_line_range: None,
					tab_replacement:     Some("    ".to_string()),
					normalize_indent:    Some(true),
				})
				.unwrap_or_else(|err| panic!("selector {selector} should resolve: {err}"));
			let resolved = result
				.chunk
				.expect("selector read should resolve a chunk target");
			assert_eq!(resolved.selector, format!("fn_han.try#{}", chunk.checksum));
		}
	}

	#[test]
	fn read_lists_chunks_for_question_selector() {
		let source = "function run() {\n    return 1;\n}\n";
		let state = ChunkState::parse(source.to_string(), "typescript".to_string())
			.expect("state should parse");
		let result = state
			.render_read(ReadRenderParams {
				read_path:           "sample.ts:?".to_string(),
				display_path:        "sample.ts".to_string(),
				language_tag:        Some("ts".to_string()),
				omit_checksum:       false,
				anchor_style:        Some(ChunkAnchorStyle::Full),
				absolute_line_range: None,
				tab_replacement:     Some("    ".to_string()),
				normalize_indent:    Some(true),
			})
			.expect("listing should succeed");
		assert!(result.text.contains("sample.ts chunks"), "{}", result.text);
		assert!(result.text.contains("fn_run#"));
		// Region listing removed — all chunks accept all regions now.
		assert!(!result.text.contains("return 1"));
	}

	#[test]
	fn read_renders_full_chunk_paths_in_full_anchor_style() {
		let source = "class Worker {
    run(): void {
        work();
    }
}
";
		let state = ChunkState::parse(source.to_string(), "typescript".to_string())
			.expect("state should parse");
		let result = state
			.render_read(ReadRenderParams {
				read_path:           "sample.ts".to_string(),
				display_path:        "sample.ts".to_string(),
				language_tag:        Some("ts".to_string()),
				omit_checksum:       false,
				anchor_style:        Some(ChunkAnchorStyle::Full),
				absolute_line_range: None,
				tab_replacement:     Some("    ".to_string()),
				normalize_indent:    Some(true),
			})
			.expect("root read should succeed");
		assert!(result.text.contains("cls_Wor.fn_run#"), "{}", result.text);
	}

	#[test]
	fn read_missing_chunk_returns_error_with_suggestions() {
		let filler = (0..60)
			.map(|index| format!("    const value{index} = {index};"))
			.collect::<Vec<_>>()
			.join("\n");
		let source = format!(
			"function loadSkills() {{\n{filler}\n    try {{\n        work();\n    }} catch (error) \
			 {{\n        throw error;\n    }}\n}}\n\nfunction handleTerraform() {{\n{filler}\n    \
			 try {{\n        work();\n    }} catch (error) {{\n        throw error;\n    }}\n}}\n"
		);
		let state = ChunkState::parse(source, "typescript".to_string()).expect("state should parse");
		let result = state
			.render_read(ReadRenderParams {
				read_path:           "sample.ts:fn_loa.try_2".to_string(),
				display_path:        "sample.ts".to_string(),
				language_tag:        Some("ts".to_string()),
				omit_checksum:       false,
				anchor_style:        Some(ChunkAnchorStyle::Full),
				absolute_line_range: None,
				tab_replacement:     Some("    ".to_string()),
				normalize_indent:    Some(true),
			})
			.expect("rnd_rea should succeed");

		let chunk = result.chunk.expect("should have a chunk target");
		assert_eq!(chunk.status, super::types::ChunkReadStatus::NotFound);

		let text = &result.text;
		assert!(text.contains("Chunk path not found: \"fn_loa.try_2\""), "{text}");
		assert!(text.contains("Direct children of \"fn_loa\""), "{text}");
		assert!(text.contains("fn_loa.try"), "{text}");
	}

	#[test]
	fn read_reports_unsupported_region_distinctly() {
		let source = "function run() {\n    return 1;\n}\n";
		let state = ChunkState::parse(source.to_string(), "typescript".to_string())
			.expect("state should parse");
		let result = state
			.render_read(ReadRenderParams {
				read_path:           "sample.ts:fn_run@unknown".to_string(),
				display_path:        "sample.ts".to_string(),
				language_tag:        Some("ts".to_string()),
				omit_checksum:       false,
				anchor_style:        Some(ChunkAnchorStyle::Full),
				absolute_line_range: None,
				tab_replacement:     Some("    ".to_string()),
				normalize_indent:    Some(true),
			})
			.expect("rnd_rea should succeed");

		let read_target = result.chunk.expect("should include read target");
		assert_eq!(read_target.status, super::types::ChunkReadStatus::UnsupportedRegion);
		assert_eq!(read_target.selector, "sample.ts:fn_run@unknown");
		assert!(result.text.contains("Unknown chunk region"), "{}", result.text);
	}

	#[test]
	fn read_body_region_returns_only_body_content() {
		let source = "/// A doc.\nfunction run() {\n    return 1;\n}\n";
		let state = ChunkState::parse(source.to_string(), "typescript".to_string())
			.expect("state should parse");
		let result = state
			.render_read(ReadRenderParams {
				read_path:           "sample.ts:fn_run~".to_string(),
				display_path:        "sample.ts".to_string(),
				language_tag:        Some("ts".to_string()),
				omit_checksum:       false,
				anchor_style:        Some(ChunkAnchorStyle::Full),
				absolute_line_range: None,
				tab_replacement:     Some("    ".to_string()),
				normalize_indent:    Some(true),
			})
			.expect("rnd_rea should succeed");

		// Should contain only the body, not the signature or doc comment.
		assert!(
			!result.text.contains("/// A doc"),
			"body read should not contain the doc comment: {}",
			result.text
		);
		assert!(
			!result.text.contains("function run"),
			"body read should not contain the signature: {}",
			result.text
		);
		assert!(
			result.text.contains("return 1"),
			"body read should contain the body content: {}",
			result.text
		);
	}

	#[test]
	fn python_prologue_read_has_consistent_indentation() {
		let source =
			"class Server:\n    @property\n    def address(self) -> str:\n        return self._addr\n";
		let state =
			ChunkState::parse(source.to_string(), "python".to_string()).expect("state should parse");
		let result = state
			.render_read(ReadRenderParams {
				read_path:           "test.py:cls_Ser.fn_add^".to_string(),
				display_path:        "test.py".to_string(),
				language_tag:        Some("py".to_string()),
				omit_checksum:       false,
				anchor_style:        Some(ChunkAnchorStyle::Full),
				absolute_line_range: None,
				tab_replacement:     Some("    ".to_string()),
				normalize_indent:    Some(true),
			})
			.expect("rnd_rea should succeed");

		// Both lines of the prologue should have the same indent depth.
		// Skip the first line (selector_ref header).
		let content_lines: Vec<&str> = result
			.text
			.split('\n')
			.filter(|l| !l.trim().is_empty())
			.skip(1)
			.collect();
		assert!(
			content_lines.len() >= 2,
			"prologue should have at least 2 lines (decorator + def): {content_lines:?}"
		);
		let decorator_tabs = content_lines[0].chars().take_while(|c| *c == '\t').count();
		let def_tabs = content_lines[1].chars().take_while(|c| *c == '\t').count();
		assert_eq!(
			decorator_tabs, def_tabs,
			"decorator and def should have same indent: decorator={decorator_tabs} tabs, \
			 def={def_tabs} tabs in {content_lines:?}"
		);
	}

	#[test]
	fn go_struct_checksum_ignores_method_body_changes() {
		let before = r"package main

type Server struct {
    Addr string
}

func (s *Server) Start() string {
    return s.Addr
}
";
		let after = r#"package main

type Server struct {
    Addr string
}

func (s *Server) Start() string {
    return s.Addr + ":80"
}
"#;
		let before_tree = build_chunk_tree(before, "go").expect("before tree should build");
		let after_tree = build_chunk_tree(after, "go").expect("after tree should build");
		let before_struct = before_tree
			.chunks
			.iter()
			.find(|chunk| chunk.path == "ty_Ser")
			.expect("before struct chunk");
		let after_struct = after_tree
			.chunks
			.iter()
			.find(|chunk| chunk.path == "ty_Ser")
			.expect("after struct chunk");
		let before_method = before_tree
			.chunks
			.iter()
			.find(|chunk| chunk.path == "fn_Sta")
			.expect("before method chunk");
		let after_method = after_tree
			.chunks
			.iter()
			.find(|chunk| chunk.path == "fn_Sta")
			.expect("after method chunk");
		assert_eq!(before_struct.checksum, after_struct.checksum);
		assert_ne!(before_method.checksum, after_method.checksum);
	}

	#[test]
	fn keeps_trivial_typescript_enum_variants_addressable() {
		let source = r#"enum Status {
		Idle = "idle",
		Busy = "busy",
	}"#;
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");
		let enum_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "en_Sta")
			.expect("en_Sta");
		assert!(!enum_chunk.leaf);
		assert!(
			enum_chunk
				.children
				.iter()
				.any(|child| child == "en_Sta.vr_Idl")
		);
		assert!(
			enum_chunk
				.children
				.iter()
				.any(|child| child == "en_Sta.vr_Bus")
		);
	}

	#[test]
	fn rust_attribute_absorbed_into_struct_chunk() {
		let source = r"#[derive(Debug, Clone)]
struct Record {
    name: String,
}
";
		let tree = build_chunk_tree(source, "rust").expect("tree should build");
		let struct_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "stc_Rec")
			.expect("stc_Rec");
		assert_eq!(struct_chunk.start_line, 1, "struct chunk should start at attribute line");
	}

	#[test]
	fn rust_multi_attribute_absorbed_into_struct_chunk() {
		let source = r#"#[derive(Debug)]
#[serde(rename_all = "camelCase")]
struct Config {
    name: String,
}
"#;
		let tree = build_chunk_tree(source, "rust").expect("tree should build");
		let struct_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "stc_Con")
			.expect("stc_Con");
		assert_eq!(struct_chunk.start_line, 1, "struct chunk should start at first attribute line");
	}

	#[test]
	fn rust_struct_checksum_ignores_leading_attributes_absorbed_into_display_range() {
		let one_attr = r"#[derive(Debug)]
struct Config {
    name: String,
}
";
		let two_attrs = r"#[derive(Debug, Clone)]
struct Config {
    name: String,
}
";
		let ta = build_chunk_tree(one_attr, "rust").expect("tree");
		let tb = build_chunk_tree(two_attrs, "rust").expect("tree");
		let ca = ta
			.chunks
			.iter()
			.find(|c| c.path == "stc_Con")
			.expect("stc_Con");
		let cb = tb
			.chunks
			.iter()
			.find(|c| c.path == "stc_Con")
			.expect("stc_Con");
		assert_eq!(
			ca.checksum, cb.checksum,
			"checksum hashes from the struct item, not absorbed outer attributes"
		);
	}

	#[test]
	fn rust_enum_variant_naming() {
		let source = r"enum Message {
    Ok,
    Error {
        code: u32,
        message: String,
    },
}
";
		let tree = build_chunk_tree(source, "rust").expect("tree should build");
		let enum_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "en_Mes")
			.expect("en_Mes");
		assert!(!enum_chunk.children.is_empty(), "non-trivial enum should have children");
		assert!(
			tree.chunks.iter().any(|c| c.path == "en_Mes.vr_Ok"),
			"expected vr_Ok, got children: {:?}",
			enum_chunk.children
		);
		assert!(
			tree.chunks.iter().any(|c| c.path == "en_Mes.vr_Err"),
			"expected vr_Err, got children: {:?}",
			enum_chunk.children
		);
	}

	#[test]
	fn ruby_class_methods_chunked() {
		let source = r#"module PaymentProcessing
  class Money
    include Comparable

    attr_reader :amount, :currency

    def initialize(amount, currency = :usd)
      @amount = amount
      @currency = currency
    end

    def self.zero(currency = :usd)
      new(0, currency)
    end

    def to_s
      "$#{amount}"
    end

    private

    def validate!
      raise "Invalid" if amount < 0
    end
  end
end
"#;
		let tree = build_chunk_tree(source, "ruby").expect("tree should build");
		assert_eq!(tree.root_children, vec!["mod_Pay"]);
		let module = tree
			.chunks
			.iter()
			.find(|c| c.path == "mod_Pay")
			.expect("mod_Pay");
		assert!(!module.leaf);
		assert!(
			module.children.iter().any(|c| c == "mod_Pay.cls_Mon"),
			"expected cls_Mon inside module, got {:?}",
			module.children
		);
		let class = tree
			.chunks
			.iter()
			.find(|c| c.path == "mod_Pay.cls_Mon")
			.expect("cls_Mon");
		assert!(!class.leaf);
		assert!(
			class.children.iter().any(|c| c == "mod_Pay.cls_Mon.ctor"),
			"expected constructor in class children: {:?}",
			class.children
		);
		assert!(
			class.children.iter().any(|c| c == "mod_Pay.cls_Mon.fn_zer"),
			"expected fn_zer in class children: {:?}",
			class.children
		);
		assert!(
			class.children.iter().any(|c| c == "mod_Pay.cls_Mon.fn_to"),
			"expected fn_to in class children: {:?}",
			class.children
		);
		assert!(
			class.children.iter().any(|c| c == "mod_Pay.cls_Mon.fn_val"),
			"expected fn_val in class children: {:?}",
			class.children
		);
	}

	#[test]
	fn keeps_mixed_enum_children_addressable() {
		let source = r"enum Message {
	    Ok,
	    Error {
	        code: u32,
	    },
	}";
		let tree = build_chunk_tree(source, "rust").expect("tree should build");
		let enum_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "en_Mes")
			.expect("en_Mes");
		assert!(!enum_chunk.leaf);
		assert!(!enum_chunk.children.is_empty(), "mixed-size variants should stay addressable");
	}

	#[test]
	fn typescript_namespace_members_stay_addressable() {
		let source = r"namespace Foo {
	    export function bar() {
	        return 1;
	    }
	}
	";
		let tree = build_chunk_tree(source, "typescript").expect("tree should build");

		let module = tree
			.chunks
			.iter()
			.find(|c| c.path == "mod_Foo")
			.expect("mod_Foo");
		assert!(!module.leaf);
		assert!(
			module
				.children
				.iter()
				.any(|child| child == "mod_Foo.fn_bar"),
			"expected fn_bar inside namespace, got {:?}",
			module.children
		);
	}

	#[test]
	fn php_namespace_definition_keeps_inner_members_addressable() {
		let source = "<?php\nnamespace App {\nclass User {}\nfunction boot() {}\n}\n";
		let tree = build_chunk_tree(source, "php").expect("tree should build");

		let module = tree
			.chunks
			.iter()
			.find(|c| c.path == "mod_App")
			.expect("mod_App");
		assert!(!module.leaf);
		assert!(
			module
				.children
				.iter()
				.any(|child| child == "mod_App.cls_Use"),
			"expected cls_Use inside namespace, got {:?}",
			module.children
		);
		assert!(
			module
				.children
				.iter()
				.any(|child| child == "mod_App.fn_boo"),
			"expected fn_boo inside namespace, got {:?}",
			module.children
		);
	}

	#[test]
	fn adjacent_markdown_sections_do_not_overlap() {
		let source = "# Top\n\n## A\n\na body\n\n## B\n\nb body\n\n## C\n\nc body\n";
		let tree = build_chunk_tree(source, "markdown").expect("markdown tree");

		let a = tree
			.chunks
			.iter()
			.find(|c| c.path == "sct_Top.sct_A")
			.expect("sct_A");
		let b = tree
			.chunks
			.iter()
			.find(|c| c.path == "sct_Top.sct_B")
			.expect("sct_B");
		let c = tree
			.chunks
			.iter()
			.find(|c| c.path == "sct_Top.sct_C")
			.expect("sct_C");

		assert!(
			a.end_line < b.start_line,
			"sct_A ({}-{}) must not overlap section_B ({}-{})",
			a.start_line,
			a.end_line,
			b.start_line,
			b.end_line,
		);
		assert!(
			b.end_line < c.start_line,
			"sct_B ({}-{}) must not overlap section_C ({}-{})",
			b.start_line,
			b.end_line,
			c.start_line,
			c.end_line,
		);
	}

	#[test]
	fn adjacent_toml_tables_do_not_overlap() {
		let source = "[package]\nname = \"x\"\n\n[deps]\na = 1\n\n[tool]\nb = 2\n";
		let tree = build_chunk_tree(source, "toml").expect("toml tree");

		let package = tree
			.chunks
			.iter()
			.find(|c| c.path == "tbl_pac")
			.expect("tbl_pac");
		let deps = tree
			.chunks
			.iter()
			.find(|c| c.path == "tbl_dep")
			.expect("tbl_dep");
		let tool = tree
			.chunks
			.iter()
			.find(|c| c.path == "tbl_too")
			.expect("tbl_too");

		assert!(
			package.end_line < deps.start_line,
			"tbl_pac ({}-{}) must not overlap tbl_dep ({}-{})",
			package.start_line,
			package.end_line,
			deps.start_line,
			deps.end_line,
		);
		assert!(
			deps.end_line < tool.start_line,
			"tbl_dep ({}-{}) must not overlap tbl_too ({}-{})",
			deps.start_line,
			deps.end_line,
			tool.start_line,
			tool.end_line,
		);
	}

	#[test]
	fn python_property_no_orphan_return_chunk() {
		// Build a function large enough to trigger recursion (> LEAF_THRESHOLD)
		// with multiple control-flow children that narrow scope enough to trigger
		// recursion, plus a `return` statement that must NOT become a standalone
		// chunk.
		let mut body = String::new();
		body.push_str("class Server:\n");
		body.push_str("    @property\n");
		body.push_str("    def address(self) -> str:\n");
		body.push_str("        if self._host:\n");
		for i in 0..20 {
			let _ = writeln!(body, "            x{i} = {i}");
		}
		body.push_str("        if self._port:\n");
		for i in 0..20 {
			let _ = writeln!(body, "            y{i} = {i}");
		}
		body.push_str("        return f\"{{self._host}}:{{self._port}}\"\n");
		let source = body;
		let tree = build_chunk_tree(source.as_str(), "python").expect("tree should build");

		// Dump all chunk paths for debugging
		for chunk in &tree.chunks {
			eprintln!(
				"chunk: path={:?} kind={:?} leaf={} lines={}-{}",
				chunk.path, chunk.kind, chunk.leaf, chunk.start_line, chunk.end_line
			);
		}

		// The function body should recurse (it's large enough) but the return
		// statement should NOT become a standalone addressable chunk.
		let fn_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "cls_Ser.fn_add")
			.expect("fn_add should exist");

		let orphan_ret = tree.chunks.iter().find(|c| c.path.contains("ret"));
		assert!(
			orphan_ret.is_none(),
			"return statement inside property method should not be a separate chunk, found: {:?}",
			orphan_ret.map(|c| (&c.path, &c.kind))
		);

		// Verify the function actually recursed (has children)
		assert!(!fn_chunk.leaf, "fn_add should recurse into children for this test to be meaningful");
	}

	#[test]
	fn python_region_boundaries_correct_for_function() {
		use super::{resolve::chunk_region_range, types::ChunkRegion};

		let source = "def run():\n   return 1\n";
		let tree = build_chunk_tree(source, "python").expect("tree should build");
		let fn_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "fn_run")
			.expect("fn_run");

		let (head_s, head_e) = chunk_region_range(fn_chunk, ChunkRegion::Head);
		let head = &source[head_s..head_e];
		assert!(head.contains("def run():"), "fn ^ should contain def signature, got {head:?}");
		assert!(!head.contains("return"), "fn ^ should not contain body, got {head:?}");

		let (body_s, body_e) = chunk_region_range(fn_chunk, ChunkRegion::Body);
		let body = &source[body_s..body_e];
		assert!(body.contains("return 1"), "fn ~ should contain body, got {body:?}");
		assert!(!body.contains("def run"), "fn ~ should not contain head, got {body:?}");
		assert!(body.ends_with('\n'), "fn ~ should end with newline, got {body:?}");
	}

	#[test]
	fn python_region_boundaries_correct_for_class() {
		use super::{resolve::chunk_region_range, types::ChunkRegion};

		let source =
			"class Server:\n    def start(self) -> None:\n        self.running = True\n        \
			 print('ok')\n\n    def stop(self):\n        pass\n";
		let tree = build_chunk_tree(source, "python").expect("tree should build");
		let class_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "cls_Ser")
			.expect("cls_Ser");

		let (head_s, head_e) = chunk_region_range(class_chunk, ChunkRegion::Head);
		let head = &source[head_s..head_e];
		assert!(head.contains("class Server:"), "class ^ should contain class def, got {head:?}");
		assert!(!head.contains("def start"), "class ^ should not contain methods, got {head:?}");

		let (body_s, body_e) = chunk_region_range(class_chunk, ChunkRegion::Body);
		let body = &source[body_s..body_e];
		assert!(body.contains("def start"), "class ~ should contain methods, got {body:?}");
		assert!(body.contains("def stop"), "class ~ should contain all methods, got {body:?}");
		assert!(!body.contains("class Server"), "class ~ should not contain header, got {body:?}");
	}

	#[test]
	fn python_decorated_function_region_boundaries() {
		use super::{resolve::chunk_region_range, types::ChunkRegion};

		let source =
			"class Server:\n    @property\n    def address(self) -> str:\n        return self._addr\n";
		let tree = build_chunk_tree(source, "python").expect("tree should build");
		let fn_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "cls_Ser.fn_add")
			.expect("fn_add");

		let (head_s, head_e) = chunk_region_range(fn_chunk, ChunkRegion::Head);
		let head = &source[head_s..head_e];
		assert!(head.contains("@property"), "^ should include decorator, got {head:?}");
		assert!(head.contains("def address"), "^ should include def, got {head:?}");
		assert!(!head.contains("return"), "^ should not include body, got {head:?}");

		let (body_s, body_e) = chunk_region_range(fn_chunk, ChunkRegion::Body);
		let body = &source[body_s..body_e];
		assert!(body.contains("return self._addr"), "~ should contain return, got {body:?}");
		assert!(!body.contains("@property"), "~ should not contain decorator, got {body:?}");
		assert!(!body.contains("def address"), "~ should not contain def, got {body:?}");
	}

	#[test]
	fn python_body_replace_preserves_surrounding_code() {
		use super::{resolve::chunk_region_range, types::ChunkRegion};

		let source =
			"import os\n\ndef main():\n    x = 1\n    print(x)\n\ndef helper():\n    return 42\n";
		let tree = build_chunk_tree(source, "python").expect("tree should build");
		let fn_main = tree
			.chunks
			.iter()
			.find(|c| c.path == "fn_mai")
			.expect("fn_mai");

		let (body_s, body_e) = chunk_region_range(fn_main, ChunkRegion::Body);
		let body = &source[body_s..body_e];
		assert!(!body.contains("def main"), "body should not include def");
		assert!(body.contains("x = 1"), "body should contain body lines");
		assert!(!body.contains("def helper"), "body should not leak into next function");
		assert!(!body.contains("return 42"), "body should not include helper's code");
		assert!(!body.contains("import"), "body should not include imports");

		// Simulate body replace and verify the result
		let replacement = "    y = 2\n    print(y)\n";
		let mut result = String::new();
		result.push_str(&source[..body_s]);
		result.push_str(replacement);
		result.push_str(&source[body_e..]);
		assert!(
			result.starts_with("import os"),
			"import should remain at column 0 after body replace: {:?}",
			&result[..40.min(result.len())]
		);
		assert!(result.contains("def helper"), "helper fn should survive body replace: {result:?}");
		assert!(result.contains("return 42"), "helper's body should survive: {result:?}");
	}

	#[test]
	fn python_class_body_replace_does_not_corrupt() {
		use super::{resolve::chunk_region_range, types::ChunkRegion};

		let source =
			"class Server:\n    def __init__(self, host: str, port: int):\n        self.host = \
			 host\n        self.port = port\n\n    def start(self) -> None:\n        if \
			 self.running:\n            raise RuntimeError(\"already running\")\n        \
			 self.running = True\n        print(f\"Started on {self.host}:{self.port}\")\n\n    \
			 @property\n    def address(self) -> str:\n        return f\"{self.host}:{self.port}\"\n";
		let tree = build_chunk_tree(source, "python").expect("tree should build");

		// Verify class regions
		let cls = tree
			.chunks
			.iter()
			.find(|c| c.path == "cls_Ser")
			.expect("cls_Ser");
		let (body_s, body_e) = chunk_region_range(cls, ChunkRegion::Body);
		let body = &source[body_s..body_e];
		assert!(body.contains("def __init__"), "class body should contain __init__");
		assert!(body.contains("def start"), "class body should contain start");
		assert!(body.contains("@property"), "class body should contain @property");
		assert!(body.contains("def address"), "class body should contain address");
		assert!(!body.contains("class Server"), "class body should not contain header");

		// Verify fn_start regions
		let fn_start = tree
			.chunks
			.iter()
			.find(|c| c.path == "cls_Ser.fn_sta")
			.expect("fn_sta");
		let (fn_body_s, fn_body_e) = chunk_region_range(fn_start, ChunkRegion::Body);
		let fn_body = &source[fn_body_s..fn_body_e];
		assert!(fn_body.contains("if self.running"), "fn_sta ~ should contain body, got {fn_body:?}");
		assert!(
			fn_body.contains("self.running = True"),
			"fn_sta ~ should contain all lines, got {fn_body:?}"
		);
		assert!(!fn_body.contains("def start"), "fn_sta ~ should not include head, got {fn_body:?}");
		assert!(
			!fn_body.contains("@property"),
			"fn_sta ~ should not leak into next method, got {fn_body:?}"
		);
	}

	#[test]
	fn diff_block_produces_file_chunks() {
		let source = "diff --git a/src/foo.ts b/src/foo.ts\nindex abcdef0..1234567 100644\n--- \
		              a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,4 @@\n line1\n+added\n line2\n \
		              line3\ndiff --git a/src/bar.ts b/src/bar.ts\nindex 1111111..2222222 \
		              100644\n--- a/src/bar.ts\n+++ b/src/bar.ts\n@@ -5,2 +5,3 @@\n x\n+y\n z\n";
		let tree = build_chunk_tree(source, "diff").expect("diff tree should build");
		assert!(
			tree.root_children.contains(&"file_src_1".to_string()),
			"expected file_src_1, got {:?}",
			tree.root_children
		);
		assert!(
			tree.root_children.contains(&"file_src_1".to_string()),
			"expected file_src_1, got {:?}",
			tree.root_children
		);
	}

	#[test]
	fn diff_hunks_individually_addressable() {
		let source = "diff --git a/app.rs b/app.rs\nindex abcdef0..1234567 100644\n--- \
		              a/app.rs\n+++ b/app.rs\n@@ -1,3 +1,4 @@\n line1\n+added1\n line2\n line3\n@@ \
		              -10,3 +11,4 @@\n line10\n+added2\n line11\n line12\n";
		let tree = build_chunk_tree(source, "diff").expect("diff tree should build");
		let file_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "file_app")
			.expect("file_app chunk should exist");
		assert!(!file_chunk.leaf, "file chunk with hunks should not be leaf");
		assert!(
			file_chunk.children.iter().any(|c| c == "file_app.hunk_1"),
			"expected hunk_1 child, got {:?}",
			file_chunk.children
		);
		assert!(
			file_chunk.children.iter().any(|c| c == "file_app.hunk_2"),
			"expected hunk_2 child, got {:?}",
			file_chunk.children
		);
	}

	#[test]
	fn diff_deleted_file_uses_old_path() {
		let source = "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\nindex \
		              abcdef0..0000000 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1,2 +0,0 \
		              @@\n-line1\n-line2\n";
		let tree = build_chunk_tree(source, "diff").expect("diff tree should build");
		assert!(
			tree.root_children.contains(&"file_old".to_string()),
			"expected file_old for deleted file, got {:?}",
			tree.root_children
		);
	}

	#[test]
	fn diff_single_hunk_has_no_suffix() {
		let source = "diff --git a/one.rs b/one.rs\nindex abcdef0..1234567 100644\n--- \
		              a/one.rs\n+++ b/one.rs\n@@ -1,2 +1,3 @@\n line1\n+added\n line2\n";
		let tree = build_chunk_tree(source, "diff").expect("diff tree should build");
		let file_chunk = tree
			.chunks
			.iter()
			.find(|c| c.path == "file_one")
			.expect("file_one should exist");
		assert!(!file_chunk.leaf);
		// Single hunk should be named "hunk" without a numeric suffix
		assert!(
			file_chunk.children.iter().any(|c| c == "file_one.hunk"),
			"expected hunk child (no suffix), got {:?}",
			file_chunk.children
		);
	}

	#[test]
	fn visible_range_clip_shows_truncation_markers() {
		// Build a TypeScript file with a function spanning lines 1-10.
		let source = "function longFunc() {\nlet a = 1;\nlet b = 2;\nlet c = 3;\nlet d = 4;\nlet e \
		              = 5;\nlet f = 6;\nlet g = 7;\nlet h = 8;\nreturn a + b + c + d + e + f + g + \
		              h;\n}\n";
		let state = ChunkState::parse(source.to_string(), "typescript".to_string())
			.expect("state should parse");

		// Read only lines 3-7 — the function spans L1-L11, so it should be clipped.
		let result = state
			.render_read(ReadRenderParams {
				read_path:           "test.ts:L3-L7".to_string(),
				display_path:        "test.ts".to_string(),
				language_tag:        Some("ts".to_string()),
				omit_checksum:       true,
				anchor_style:        Some(ChunkAnchorStyle::FullOmit),
				absolute_line_range: None,
				tab_replacement:     Some("  ".to_string()),
				normalize_indent:    Some(true),
			})
			.expect("rnd_rea should succeed");

		// The output should keep the chunk head and tail context and collapse the
		// omitted middle ranges with generic expansion markers.
		assert!(
			result.text.contains("1^|function longFunc() {"),
			"should keep the chunk signature when the visible range clips the head: {}",
			result.text
		);
		assert!(
			result.text.contains("9 |let h = 8;"),
			"should keep tail context when the visible range clips the body: {}",
			result.text
		);
		assert!(
			result.text.contains("let c = 3"),
			"visible content should be rendered: {}",
			result.text
		);
		assert!(
			result.text.contains("[truncated… sel=L2-L2 to expand]"),
			"should show a generic truncation marker above the requested lines: {}",
			result.text
		);
		assert!(
			result.text.contains("[truncated… sel=L8-L8 to expand]"),
			"should show a generic truncation marker below the requested lines: {}",
			result.text
		);
	}

	#[test]
	fn visible_range_no_clip_markers_when_chunk_fits() {
		// A small file fully contained in the visible range should have no clip
		// markers.
		let source = "const x = 1;\nconst y = 2;\n";
		let state = ChunkState::parse(source.to_string(), "typescript".to_string())
			.expect("state should parse");

		let result = state
			.render_read(ReadRenderParams {
				read_path:           "test.ts:L1-L2".to_string(),
				display_path:        "test.ts".to_string(),
				language_tag:        Some("ts".to_string()),
				omit_checksum:       true,
				anchor_style:        Some(ChunkAnchorStyle::FullOmit),
				absolute_line_range: None,
				tab_replacement:     Some("  ".to_string()),
				normalize_indent:    Some(true),
			})
			.expect("rnd_rea should succeed");

		// Should NOT have any truncation markers.
		assert!(
			!result.text.contains("[truncated…"),
			"no clip marker when chunk fits: {}",
			result.text
		);
	}

	#[test]
	fn nix_let_expression_bindings_are_individually_addressable() {
		// A Nix file with { args }: let bindings in body should produce
		// individual chunks for each binding, not a single opaque chunk.
		let source = r"{ pkgs }:
	let
	  foo = 1;
	  bar = pkgs.hello;
	  baz = {
		x = 1;
		y = 2;
	  };
	in
	{
	  inherit foo bar baz;
	}
	";
		let tree = build_chunk_tree(source, "nix").expect("nix tree should build");

		// There should be chunks for individual bindings, not just a single
		// opaque chunk containing all of them.
		let has_foo = tree.chunks.iter().any(|c| c.path.contains("foo"));
		let has_bar = tree.chunks.iter().any(|c| c.path.contains("bar"));
		let has_baz = tree.chunks.iter().any(|c| c.path.contains("baz"));

		assert!(
			has_foo && has_bar && has_baz,
			"individual bindings should be addressable chunks. Chunks: {:?}",
			tree.chunks.iter().map(|c| &c.path).collect::<Vec<_>>()
		);
	}

	#[test]
	fn md_fenced_block_caret_read_falls_back_to_whole_chunk() {
		// `^` on a markdown fenced code block should NOT return [Empty @^ region].
		// Fenced blocks have no meaningful head/body distinction, so `^` should
		// fall back to whole-chunk rendering, matching the documented behavior.
		let source = "# Title\n\nIntro text.\n\n```python\ndef hello():\n    return 1\n```\n";
		let state =
			ChunkState::parse(source.to_owned(), "markdown".to_owned()).expect("state should parse");
		let tree = state.inner().tree();
		let fence = tree
			.chunks
			.iter()
			.find(|c| {
				!c.path.is_empty()
					&& state
						.inner()
						.source()
						.lines()
						.nth(c.start_line.saturating_sub(1) as usize)
						.is_some_and(|line| line.trim_start().starts_with("```"))
			})
			.expect("fenced code block chunk should exist");

		let read_path = format!("sample.md:{}#{}^", fence.path, fence.checksum);
		let result = state
			.render_read(ReadRenderParams {
				read_path,
				display_path: "sample.md".to_owned(),
				language_tag: Some("md".to_owned()),
				omit_checksum: false,
				anchor_style: Some(ChunkAnchorStyle::Full),
				absolute_line_range: None,
				tab_replacement: Some("    ".to_owned()),
				normalize_indent: Some(true),
			})
			.expect("rnd_rea should succeed");

		assert!(
			!result.text.contains("[Empty @^ region]"),
			"^ on fenced block must not return an empty region, got: {}",
			result.text
		);
		assert!(
			result.text.contains("```python") || result.text.contains("def hello"),
			"^ fallback must show fenced block content, got: {}",
			result.text
		);
	}

	#[test]
	fn md_fenced_block_display_preserves_space_indentation() {
		// When rendering a markdown fenced code block, the 4-space indentation
		// inside the fence must NOT be normalized to tabs — code-block content is
		// opaque to the chunk renderer.
		let source = "# Title\n\n```python\ndef hello():\n    return 1\n```\n";
		let state =
			ChunkState::parse(source.to_owned(), "markdown".to_owned()).expect("state should parse");
		let result = state
			.render_read(ReadRenderParams {
				read_path:           "sample.md".to_owned(),
				display_path:        "sample.md".to_owned(),
				language_tag:        Some("md".to_owned()),
				omit_checksum:       false,
				anchor_style:        Some(ChunkAnchorStyle::Full),
				absolute_line_range: None,
				tab_replacement:     Some("    ".to_owned()),
				normalize_indent:    Some(true),
			})
			.expect("rnd_rea should succeed");

		assert!(
			result.text.contains("    return 1"),
			"fenced block must keep 4-space indentation in display, got:\n{}",
			result.text
		);
		assert!(
			!result.text.contains("\treturn 1"),
			"fenced block must NOT normalize spaces to tabs in display, got:\n{}",
			result.text
		);
	}

	#[test]
	fn markdown_fenced_code_blocks_build_injected_subtrees() {
		let source = "# Title\n\n```js\nfunction hello(name) {\n  return name;\n}\n```\n";
		let tree = build_chunk_tree(source, "markdown").expect("markdown tree");
		let fence = tree
			.chunks
			.iter()
			.find(|chunk| chunk.path == "sct_Tit.code_js")
			.expect("expected semantic fenced-code chunk");

		assert!(!fence.leaf, "fenced block should recurse into the injected JS tree");
		assert!(
			tree
				.chunks
				.iter()
				.any(|chunk| chunk.path == "sct_Tit.code_js.fn_hel"),
			"expected translated JS descendant under code_js, got {:?}",
			tree
				.chunks
				.iter()
				.map(|chunk| &chunk.path)
				.collect::<Vec<_>>()
		);
		assert!(
			fence.prologue_end_byte.is_none() && fence.epilogue_start_byte.is_none(),
			"markdown fenced host should stay regionless"
		);
	}

	#[test]
	fn html_script_and_style_hosts_recurse_into_embedded_languages() {
		let source = "<div>\n<script>\nfunction greet() {\n  return 1;\n}\n</script>\n<style>\n.app \
		              { color: red; }\n</style>\n</div>\n";
		let tree = build_chunk_tree(source, "html").expect("html tree");
		let script = tree
			.chunks
			.iter()
			.find(|chunk| chunk.path == "tag_div.scr")
			.expect("expected script host");
		let style = tree
			.chunks
			.iter()
			.find(|chunk| chunk.path == "tag_div.sty")
			.expect("expected style host");

		assert!(!script.leaf, "script host should expose nested JS chunks");
		assert!(!style.leaf, "style host should expose nested CSS chunks");
		assert!(
			tree
				.chunks
				.iter()
				.any(|chunk| chunk.path.starts_with("tag_div.scr.") && chunk.path != "tag_div.scr"),
			"expected translated JS descendants, got {:?}",
			tree
				.chunks
				.iter()
				.map(|chunk| &chunk.path)
				.collect::<Vec<_>>()
		);
		assert!(
			tree
				.chunks
				.iter()
				.any(|chunk| chunk.path.starts_with("tag_div.sty.") && chunk.path != "tag_div.sty"),
			"expected translated CSS descendants, got {:?}",
			tree
				.chunks
				.iter()
				.map(|chunk| &chunk.path)
				.collect::<Vec<_>>()
		);
		assert!(script.prologue_end_byte.is_some(), "script host should expose a body region");
		assert!(style.prologue_end_byte.is_some(), "style host should expose a body region");
	}

	#[test]
	fn small_html_wrappers_do_not_hide_embedded_script_hosts() {
		let source = "<div><script>const value = 1;</script></div>\n";
		let tree = build_chunk_tree(source, "html").expect("html tree");

		assert!(
			tree.chunks.iter().any(|chunk| chunk.path == "tag_div.scr"),
			"script host should stay addressable inside a small wrapper, got {:?}",
			tree
				.chunks
				.iter()
				.map(|chunk| &chunk.path)
				.collect::<Vec<_>>()
		);
	}

	#[test]
	fn framework_block_hosts_expose_injected_descendants() {
		let cases = [
			(
				"astro",
				"---\nconst title: string = \"Hello\";\n---\n<script>const count = \
				 1;</script>\n<style>.app { color: red; }</style>\n",
				&["fm", "scr", "sty"][..],
			),
			(
				"svelte",
				"<script>let count = 0;\nfunction inc() { count += 1; }\n</script>\n<style>.app { \
				 color: red; }</style>\n<div>{count}</div>\n",
				&["scr", "sty"][..],
			),
			(
				"vue",
				"<template><div>{{ msg }}</div></template>\n<script setup lang=\"ts\">const msg = \
				 \"hi\";\nfunction greet() { return msg; }\n</script>\n<style scoped>.app { color: \
				 red; }</style>\n",
				&["sse", "sco"][..],
			),
		];

		for (language, source, hosts) in cases {
			let tree = build_chunk_tree(source, language).unwrap_or_else(|err| {
				panic!("expected {language} tree to build: {err}");
			});
			for host in hosts {
				let chunk = tree
					.chunks
					.iter()
					.find(|chunk| chunk.path == *host)
					.unwrap_or_else(|| panic!("missing {language} host {host}"));
				assert!(!chunk.leaf, "{language} host {host} should expose embedded descendants");
			}
		}
	}
}

//! Language-specific chunk classifiers for Markdown and Handlebars.

use tree_sitter::Node;

use super::{
	chunk_checksum,
	classify::{ClassifierTables, LangClassifier},
	common::*,
	kind::ChunkKind,
	types::ChunkNode,
};
use crate::language::SupportLang;

pub struct MarkupClassifier;

impl MarkupClassifier {
	fn classify_section<'t>(node: Node<'t>, source: &str) -> RawChunkCandidate<'t> {
		let name = extract_markdown_heading(node, source).unwrap_or_else(|| "anonymous".to_string());
		force_container(make_container_chunk(
			node,
			ChunkKind::Section,
			Some(name),
			source,
			Some(recurse_self(node, ChunkContext::ClassBody)),
		))
	}

	fn classify_block_statement<'t>(node: Node<'t>, source: &str) -> RawChunkCandidate<'t> {
		let name =
			extract_glimmer_block_name(node, source).unwrap_or_else(|| "anonymous".to_string());
		force_container(make_container_chunk(
			node,
			ChunkKind::Block,
			Some(name),
			source,
			Some(recurse_self(node, ChunkContext::ClassBody)),
		))
	}

	fn classify_mustache_statement<'t>(node: Node<'t>, source: &str) -> RawChunkCandidate<'t> {
		let name =
			extract_glimmer_mustache_name(node, source).unwrap_or_else(|| "anonymous".to_string());
		make_kind_chunk(node, ChunkKind::Mustache, Some(name), source, None)
	}

	/// Classify HTML-like element nodes that appear inside handlebars blocks.
	fn classify_element<'t>(node: Node<'t>, source: &str) -> Option<RawChunkCandidate<'t>> {
		match node.kind() {
			"element" | "script_element" | "style_element" | "element_node" => {
				let name =
					extract_element_tag_name(node, source).unwrap_or_else(|| "anonymous".to_string());
				Some(force_container(make_container_chunk(
					node,
					ChunkKind::Tag,
					Some(name),
					source,
					Some(recurse_self(node, ChunkContext::ClassBody)),
				)))
			},
			"text_node" => Some(group_candidate(node, ChunkKind::Text, source)),
			_ => None,
		}
	}
}

impl LangClassifier for MarkupClassifier {
	fn tables(&self) -> &'static ClassifierTables {
		static TABLES: ClassifierTables = ClassifierTables {
			root:                 &[],
			class:                &[],
			function:             &[],
			structural_overrides: super::classify::StructuralOverrides::EMPTY,
		};
		&TABLES
	}

	fn classify_override<'t>(
		&self,
		context: ChunkContext,
		node: Node<'t>,
		source: &str,
	) -> Option<RawChunkCandidate<'t>> {
		if !matches!(context, ChunkContext::Root | ChunkContext::ClassBody) {
			return None;
		}
		match node.kind() {
			"section" => Some(Self::classify_section(node, source)),
			"fenced_code_block" => Some(classify_fenced_code_block(node, source)),
			"html_block" => Some(classify_html_block(node, source)),
			"block_statement" => Some(Self::classify_block_statement(node, source)),
			"mustache_statement" => Some(Self::classify_mustache_statement(node, source)),
			"element" | "script_element" | "style_element" | "element_node" | "text_node" => {
				Self::classify_element(node, source)
			},
			_ => None,
		}
	}

	fn post_process(
		&self,
		chunks: &mut Vec<ChunkNode>,
		_root_children: &mut Vec<String>,
		source: &str,
	) {
		add_markdown_table_row_chunks(chunks, source);
	}
}

const fn force_container(mut candidate: RawChunkCandidate<'_>) -> RawChunkCandidate<'_> {
	candidate.force_recurse = true;
	candidate
}

fn classify_fenced_code_block<'t>(node: Node<'t>, source: &str) -> RawChunkCandidate<'t> {
	let embedded_language = fenced_code_language(node, source);
	let identifier = embedded_language
		.map(embedded_selector_token)
		.map(str::to_string);
	let candidate =
		with_region_node(make_kind_chunk(node, ChunkKind::Code, identifier, source, None), None);
	match (child_by_kind(node, &["code_fence_content"]), embedded_language) {
		(Some(content_node), Some(language)) => {
			with_injected_subtree(candidate, language, content_node)
		},
		_ => candidate,
	}
}

fn classify_html_block<'t>(node: Node<'t>, source: &str) -> RawChunkCandidate<'t> {
	let candidate =
		with_region_node(make_kind_chunk(node, ChunkKind::Html, None, source, None), None);
	with_injected_subtree(candidate, SupportLang::Html, node)
}

fn add_markdown_table_row_chunks(chunks: &mut Vec<ChunkNode>, source: &str) {
	let original_len = chunks.len();
	let mut additions = Vec::<(usize, Vec<ChunkNode>)>::new();
	for (index, chunk) in chunks.iter().enumerate().take(original_len) {
		if !chunk.children.is_empty() || matches!(chunk.kind, ChunkKind::Code | ChunkKind::Html) {
			continue;
		}
		let rows = markdown_table_rows_for_chunk(source, chunk);
		if rows.len() < 2
			|| !rows
				.iter()
				.any(|row| markdown_table_separator_row(row.text))
		{
			continue;
		}
		let nodes = rows
			.into_iter()
			.enumerate()
			.map(|(row_index, row)| {
				let identifier = (row_index + 1).to_string();
				let path = format!("{}.row_{}", chunk.path, identifier);
				let (indent, indent_char) = detect_indent(source, row.start_byte);
				let row_source = source.get(row.start_byte..row.end_byte).unwrap_or_default();
				ChunkNode {
					path,
					identifier: Some(identifier),
					kind: ChunkKind::Row,
					leaf: true,
					virtual_content: None,
					parent_path: Some(chunk.path.clone()),
					children: Vec::new(),
					signature: Some(row.text.trim().to_owned()),
					start_line: row.line,
					end_line: row.line,
					line_count: 1,
					start_byte: row.start_byte as u32,
					end_byte: row.end_byte as u32,
					checksum_start_byte: row.start_byte as u32,
					prologue_end_byte: None,
					epilogue_start_byte: None,
					checksum: chunk_checksum(row_source.as_bytes()),
					error: false,
					indent,
					indent_char,
					group: false,
				}
			})
			.collect();
		additions.push((index, nodes));
	}

	for (index, nodes) in additions {
		let child_paths = nodes.iter().map(|node| node.path.clone()).collect();
		chunks[index].leaf = false;
		chunks[index].children = child_paths;
		chunks.extend(nodes);
	}
}

struct MarkdownTableRow<'a> {
	line:       u32,
	start_byte: usize,
	end_byte:   usize,
	text:       &'a str,
}

fn markdown_table_rows_for_chunk<'a>(
	source: &'a str,
	chunk: &ChunkNode,
) -> Vec<MarkdownTableRow<'a>> {
	let line_offsets = source_line_offsets(source);
	let mut rows = Vec::new();
	let mut saw_non_empty = false;
	for line in chunk.start_line..=chunk.end_line {
		let Some((start_byte, end_byte)) = line_bounds(source, &line_offsets, line) else {
			continue;
		};
		let text = source
			.get(start_byte..end_byte)
			.unwrap_or_default()
			.trim_end_matches('\n');
		if text.trim().is_empty() {
			continue;
		}
		saw_non_empty = true;
		if !markdown_table_row(text) {
			return Vec::new();
		}
		rows.push(MarkdownTableRow { line, start_byte, end_byte, text });
	}
	if saw_non_empty { rows } else { Vec::new() }
}

fn source_line_offsets(source: &str) -> Vec<usize> {
	let mut offsets = vec![0usize];
	for (index, ch) in source.char_indices() {
		if ch == '\n' {
			offsets.push(index + 1);
		}
	}
	offsets
}

fn line_bounds(source: &str, offsets: &[usize], line: u32) -> Option<(usize, usize)> {
	if line == 0 {
		return None;
	}
	let start = *offsets.get((line - 1) as usize)?;
	let end = offsets.get(line as usize).copied().unwrap_or(source.len());
	Some((start, end))
}

fn markdown_table_row(line: &str) -> bool {
	let trimmed = line.trim();
	trimmed.starts_with('|') && trimmed.ends_with('|') && trimmed.matches('|').count() >= 2
}

fn markdown_table_separator_row(line: &str) -> bool {
	let trimmed = line.trim();
	trimmed.contains('-')
		&& trimmed
			.chars()
			.all(|ch| matches!(ch, '|' | '-' | ':' | ' ' | '\t'))
}

/// Extract heading text from a Markdown `section` node's `atx_heading` or
/// `setext_heading` child.
fn extract_markdown_heading(node: Node<'_>, source: &str) -> Option<String> {
	named_children(node)
		.into_iter()
		.find(|child| child.kind() == "atx_heading" || child.kind() == "setext_heading")
		.and_then(|heading| {
			sanitize_identifier(node_text(source, heading.start_byte(), heading.end_byte()))
		})
}

/// Extract name from a Handlebars `block_statement` via its
/// `block_statement_start` child.
fn extract_glimmer_block_name(node: Node<'_>, source: &str) -> Option<String> {
	child_by_kind(node, &["block_statement_start"]).and_then(|start| {
		start
			.child_by_field_name("path")
			.or_else(|| child_by_kind(start, &["identifier"]))
			.and_then(|name| {
				sanitize_identifier(node_text(source, name.start_byte(), name.end_byte()))
			})
	})
}

fn fenced_code_language(node: Node<'_>, source: &str) -> Option<SupportLang> {
	child_by_kind(node, &["info_string"])
		.and_then(|info| child_by_kind(info, &["language"]))
		.and_then(|lang| {
			SupportLang::from_alias(node_text(source, lang.start_byte(), lang.end_byte()))
		})
}

/// Extract name from a Handlebars `mustache_statement`:
/// tries `helper_invocation`'s helper field first, then direct
/// `identifier`/`path_expression`.
fn extract_glimmer_mustache_name(node: Node<'_>, source: &str) -> Option<String> {
	let children = named_children(node);
	for child in children {
		if child.kind() == "helper_invocation"
			&& let Some(helper) = child
				.child_by_field_name("helper")
				.or_else(|| child_by_kind(child, &["identifier", "path_expression"]))
		{
			return sanitize_identifier(node_text(source, helper.start_byte(), helper.end_byte()));
		}
		if matches!(child.kind(), "identifier" | "path_expression") {
			return sanitize_identifier(node_text(source, child.start_byte(), child.end_byte()));
		}
	}
	None
}

/// Extract tag name from an HTML-like element node.
///
/// Handles both standard HTML (`element` → `start_tag`/`self_closing_tag` →
/// `tag_name`) and Handlebars element nodes (`element_node` →
/// `element_node_start`/`element_node_void` → `tag_name`).
fn extract_element_tag_name(node: Node<'_>, source: &str) -> Option<String> {
	// Handlebars element_node uses element_node_start / element_node_void
	if node.kind() == "element_node" {
		return named_children(node).into_iter().find_map(|child| {
			if child.kind() == "element_node_start" || child.kind() == "element_node_void" {
				child_by_kind(child, &["tag_name"]).and_then(|tag| {
					sanitize_identifier(node_text(source, tag.start_byte(), tag.end_byte()))
				})
			} else {
				None
			}
		});
	}

	// Standard HTML: element → start_tag / self_closing_tag → tag_name
	named_children(node).into_iter().find_map(|child| {
		if child.kind() == "start_tag" || child.kind() == "self_closing_tag" {
			child_by_kind(child, &["tag_name"]).and_then(|tag| {
				sanitize_identifier(node_text(source, tag.start_byte(), tag.end_byte()))
			})
		} else {
			None
		}
	})
}

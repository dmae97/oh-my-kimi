//! Shared helpers for chunk classification.
//!
//! These are the building blocks that per-language classifiers use to construct
//! [`RawChunkCandidate`] values. They are also used by the default (shared)
//! classification in [`super::defaults`].

use tree_sitter::Node;

use super::{
	kind::{ChunkKind, SummaryStyle},
	shape,
	types::ChunkNode,
};
use crate::{env_uint, language::SupportLang};

// ── Configuration (environment overrides) ────────────────────────────────
env_uint! {
	// Configured leaf threshold.
	pub static LEAF_THRESHOLD: usize = "PI_CHUNK_LEAF_THRESHOLD" or 8 => [1, usize::MAX];
	// Configured max chunk lines.
	pub static MAX_CHUNK_LINES: usize = "PI_CHUNK_MAX_LINES" or 25 => [1, usize::MAX];
	// Configured min recurse savings.
	pub static MIN_RECURSE_SAVINGS: usize = "PI_CHUNK_MIN_SAVINGS" or 4 => [1, usize::MAX];
}

// ── Internal types ───────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChunkContext {
	Root,
	ClassBody,
	FunctionBody,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameStyle {
	Named,
	Group,
	Error,
}

#[derive(Clone, Copy, Debug)]
pub struct RecurseSpec<'tree> {
	pub node:    Node<'tree>,
	pub context: ChunkContext,
}

#[derive(Clone, Copy, Debug)]
pub struct InjectedChunkSpec<'tree> {
	pub language:     SupportLang,
	pub content_node: Node<'tree>,
}

#[derive(Clone, Debug)]
pub struct RawChunkCandidate<'tree> {
	pub identifier:          Option<String>,
	pub kind:                ChunkKind,
	pub name_style:          NameStyle,
	pub range_start_byte:    usize,
	pub range_end_byte:      usize,
	/// Start byte for `chunk_checksum`; stays at the primary node's start while
	/// `range_start_byte` may be extended backward to include leading
	/// attributes/comments.
	pub checksum_start_byte: usize,
	pub range_start_line:    usize,
	pub range_end_line:      usize,
	pub signature:           Option<String>,
	pub error:               bool,
	pub groupable:           bool,
	pub has_leading_comment: bool,
	pub force_recurse:       bool,
	pub region_node:         Option<Node<'tree>>,
	pub injected:            Option<InjectedChunkSpec<'tree>>,
	pub recurse:             Option<RecurseSpec<'tree>>,
}

#[derive(Default)]
pub struct ChunkAccumulator {
	pub chunks: Vec<ChunkNode>,
}

// ── Candidate constructors ───────────────────────────────────────────────

/// Convert a tree-sitter `end_position` into a 1-indexed line number.
///
/// Tree-sitter byte ranges are half-open, so `end_position` points to the byte
/// immediately *after* the last byte of the node. When that byte lands at
/// column 0 of a new row, the node's last byte actually sits on the previous
/// row and the 1-indexed last line is exactly `end.row` — not `end.row + 1`.
/// This matters for grammars whose container nodes terminate on the start of
/// the next sibling (tree-sitter-markdown sections, tree-sitter-toml tables,
/// etc.): the naive `end.row + 1` would claim the sibling's heading line and
/// make `replace_range_by_lines` clobber it.
const fn end_row_as_line(start: tree_sitter::Point, end: tree_sitter::Point) -> usize {
	if end.column == 0 && end.row > start.row {
		end.row
	} else {
		end.row + 1
	}
}

pub fn make_candidate<'tree>(
	node: Node<'tree>,
	kind: ChunkKind,
	identifier: impl Into<Option<String>>,
	name_style: NameStyle,
	signature: Option<String>,
	recurse: Option<RecurseSpec<'tree>>,
	source: &str,
) -> RawChunkCandidate<'tree> {
	let identifier = identifier.into();
	let start = node.start_position();
	let end = node.end_position();
	let summary = summary_for_node(node, kind, identifier.as_deref(), signature.as_deref(), source);
	let start_byte = node.start_byte();
	RawChunkCandidate {
		identifier,
		kind,
		name_style,
		range_start_byte: start_byte,
		range_end_byte: node.end_byte(),
		checksum_start_byte: start_byte,
		range_start_line: start.row + 1,
		range_end_line: end_row_as_line(start, end),
		signature: summary,
		error: kind == ChunkKind::Error,
		groupable: kind.traits().groupable,
		has_leading_comment: false,
		force_recurse: kind.traits().container || (recurse.is_some() && node.has_error()),
		region_node: recurse.map(|spec| spec.node),
		injected: None,
		recurse,
	}
}

pub fn group_candidate<'tree>(
	node: Node<'tree>,
	kind: ChunkKind,
	source: &str,
) -> RawChunkCandidate<'tree> {
	make_candidate(node, kind, None, NameStyle::Group, None, None, source)
}

pub fn positional_candidate<'tree>(
	node: Node<'tree>,
	kind: ChunkKind,
	source: &str,
) -> RawChunkCandidate<'tree> {
	make_candidate(node, kind, None, NameStyle::Named, None, None, source)
}

pub fn named_candidate<'tree>(
	node: Node<'tree>,
	kind: ChunkKind,
	source: &str,
	recurse: Option<RecurseSpec<'tree>>,
) -> RawChunkCandidate<'tree> {
	make_kind_chunk(node, kind, extract_identifier(node, source), source, recurse)
}

pub fn container_candidate<'tree>(
	node: Node<'tree>,
	kind: ChunkKind,
	source: &str,
	recurse: Option<RecurseSpec<'tree>>,
) -> RawChunkCandidate<'tree> {
	make_kind_chunk(node, kind, extract_identifier(node, source), source, recurse)
}

pub fn make_kind_chunk<'tree>(
	node: Node<'tree>,
	kind: ChunkKind,
	identifier: Option<String>,
	source: &str,
	recurse: Option<RecurseSpec<'tree>>,
) -> RawChunkCandidate<'tree> {
	make_candidate(
		node,
		kind,
		identifier,
		NameStyle::Named,
		signature_for_node(node, source),
		recurse,
		source,
	)
}

pub fn make_kind_chunk_from<'tree>(
	range_node: Node<'tree>,
	signature_node: Node<'tree>,
	kind: ChunkKind,
	identifier: Option<String>,
	source: &str,
	recurse: Option<RecurseSpec<'tree>>,
) -> RawChunkCandidate<'tree> {
	make_candidate(
		range_node,
		kind,
		identifier,
		NameStyle::Named,
		signature_for_node(signature_node, source),
		recurse,
		source,
	)
}

pub fn make_container_chunk<'tree>(
	node: Node<'tree>,
	kind: ChunkKind,
	identifier: Option<String>,
	source: &str,
	recurse: Option<RecurseSpec<'tree>>,
) -> RawChunkCandidate<'tree> {
	make_candidate(
		node,
		kind,
		identifier,
		NameStyle::Named,
		signature_for_node(node, source),
		recurse,
		source,
	)
}

pub fn make_container_chunk_from<'tree>(
	range_node: Node<'tree>,
	signature_node: Node<'tree>,
	kind: ChunkKind,
	identifier: Option<String>,
	source: &str,
	recurse: Option<RecurseSpec<'tree>>,
) -> RawChunkCandidate<'tree> {
	make_candidate(
		range_node,
		kind,
		identifier,
		NameStyle::Named,
		signature_for_node(signature_node, source),
		recurse,
		source,
	)
}

/// Derive a "`prefix_identifier`" name from a node.
pub fn prefixed_name(prefix: &str, node: Node<'_>, source: &str) -> String {
	let identifier = extract_identifier(node, source).unwrap_or_else(|| "anonymous".to_string());
	format!("{prefix}_{identifier}")
}

pub const fn with_region_node<'tree>(
	mut candidate: RawChunkCandidate<'tree>,
	region_node: Option<Node<'tree>>,
) -> RawChunkCandidate<'tree> {
	candidate.region_node = region_node;
	candidate
}

pub const fn with_injected_subtree<'tree>(
	mut candidate: RawChunkCandidate<'tree>,
	language: SupportLang,
	content_node: Node<'tree>,
) -> RawChunkCandidate<'tree> {
	candidate.injected = Some(InjectedChunkSpec { language, content_node });
	candidate
}

pub const fn embedded_selector_token(language: SupportLang) -> &'static str {
	match language {
		SupportLang::Bash => "bash",
		SupportLang::C => "c",
		SupportLang::Cmake => "cmake",
		SupportLang::Cpp => "cpp",
		SupportLang::CSharp => "cs",
		SupportLang::Css => "css",
		SupportLang::Go => "go",
		SupportLang::Html => "html",
		SupportLang::Java => "java",
		SupportLang::JavaScript => "js",
		SupportLang::Json => "json",
		SupportLang::Kotlin => "kt",
		SupportLang::Lua => "lua",
		SupportLang::Markdown => "md",
		SupportLang::Php => "php",
		SupportLang::Python => "py",
		SupportLang::Ruby => "rb",
		SupportLang::Rust => "rust",
		SupportLang::Scala => "scala",
		SupportLang::Sql => "sql",
		SupportLang::Swift => "swift",
		SupportLang::Toml => "toml",
		SupportLang::Tsx => "tsx",
		SupportLang::TypeScript => "ts",
		SupportLang::Yaml => "yaml",
		_ => language.canonical_name(),
	}
}

// ── Inferred / catch-all candidates ──────────────────────────────────────

/// Derive a semantic name from a node's kind and/or identifier.
pub fn infer_named_candidate<'tree>(node: Node<'tree>, source: &str) -> RawChunkCandidate<'tree> {
	let kind_name = sanitize_node_kind(node.kind());
	let kind = ChunkKind::from_sanitized_kind(kind_name);
	auto_classify(node, kind, source)
}

pub fn auto_classify<'tree>(
	node: Node<'tree>,
	kind: ChunkKind,
	source: &str,
) -> RawChunkCandidate<'tree> {
	make_kind_chunk(
		node,
		kind,
		extract_identifier(node, source),
		source,
		auto_recurse_for_kind(node, kind),
	)
}

// ── Tree navigation helpers ──────────────────────────────────────────────

pub fn named_children(node: Node<'_>) -> Vec<Node<'_>> {
	let mut children = Vec::new();
	for index in 0..node.child_count() {
		if let Some(child) = node.child(index)
			&& (child.is_named() || child.is_error() || child.kind() == "ERROR")
		{
			children.push(child);
		}
	}
	children
}

pub fn child_by_kind<'tree>(node: Node<'tree>, kinds: &[&str]) -> Option<Node<'tree>> {
	named_children(node)
		.into_iter()
		.find(|child| kinds.iter().any(|kind| child.kind() == *kind))
}

pub fn child_by_field_or_kind<'tree>(
	node: Node<'tree>,
	fields: &[&str],
	kinds: &[&str],
) -> Option<Node<'tree>> {
	for field in fields {
		if let Some(child) = node.child_by_field_name(field) {
			return Some(child);
		}
	}
	child_by_kind(node, kinds)
}

pub fn resolve_recurse(node: Node<'_>, context: ChunkContext) -> Option<RecurseSpec<'_>> {
	shape::recurse_target(node).map(|child| RecurseSpec { node: child, context })
}

pub fn resolve_value_container(node: Node<'_>) -> Option<RecurseSpec<'_>> {
	shape::value_container_target(node)
		.map(|child| RecurseSpec { node: child, context: ChunkContext::ClassBody })
}

fn auto_recurse_for_kind(node: Node<'_>, kind: ChunkKind) -> Option<RecurseSpec<'_>> {
	let context = match kind {
		ChunkKind::Constructor
		| ChunkKind::Function
		| ChunkKind::Macro
		| ChunkKind::Method
		| ChunkKind::Proc
		| ChunkKind::Recipe => ChunkContext::FunctionBody,
		_ if kind.traits().container => ChunkContext::ClassBody,
		_ => return None,
	};

	resolve_recurse(node, context)
}

pub fn compute_body_inner_boundaries(
	source: &str,
	body_start: usize,
	body_end: usize,
) -> (usize, usize) {
	let bounded_start = body_start.min(source.len());
	let bounded_end = body_end.min(source.len()).max(bounded_start);
	let slice = &source[bounded_start..bounded_end];

	let Some((first_non_ws_rel, first_non_ws)) = slice
		.char_indices()
		.find(|(_, ch)| !matches!(ch, ' ' | '\t' | '\n' | '\r'))
	else {
		return (bounded_start, bounded_end);
	};
	let Some((last_non_ws_rel, last_non_ws)) = slice
		.char_indices()
		.rev()
		.find(|(_, ch)| !matches!(ch, ' ' | '\t' | '\n' | '\r'))
	else {
		return (bounded_start, bounded_end);
	};

	let has_delimiters = matches!((first_non_ws, last_non_ws), ('{', '}') | ('(', ')') | ('[', ']'));
	if !has_delimiters {
		let line_start = source[..bounded_start].rfind('\n').map_or(0, |pos| pos + 1);
		let leading_indent = &source[line_start..bounded_start];
		if !leading_indent.is_empty() && leading_indent.chars().all(|ch| matches!(ch, ' ' | '\t')) {
			let mut inner_end = bounded_end;
			let trailing = &source[bounded_end..];
			if let Some(rel_newline) = trailing.find('\n') {
				if trailing[..rel_newline]
					.chars()
					.all(|ch| matches!(ch, ' ' | '\t' | '\r'))
				{
					inner_end = bounded_end + rel_newline + 1;
				}
			} else if trailing.chars().all(|ch| matches!(ch, ' ' | '\t' | '\r')) {
				inner_end = source.len();
			}
			return (line_start, inner_end);
		}
		return (bounded_start, bounded_end);
	}

	let mut inner_start = bounded_start + first_non_ws_rel + first_non_ws.len_utf8();
	if source[inner_start..].starts_with("\r\n") {
		inner_start += 2;
	} else if source[inner_start..].starts_with('\n') {
		inner_start += 1;
	}

	// Epilogue starts at the beginning of the line containing the closing
	// delimiter so that the closing line's indentation is part of the epilogue,
	// not the body.
	let close_abs = bounded_start + last_non_ws_rel;
	let inner_end = source[..close_abs]
		.rfind('\n')
		.map_or(close_abs, |nl| nl + 1);
	(inner_start.min(bounded_end), inner_end.max(inner_start).min(bounded_end))
}

// ── Recurse helpers ──────────────────────────────────────────────────────

pub fn recurse_into<'tree>(
	node: Node<'tree>,
	context: ChunkContext,
	fields: &[&str],
	kinds: &[&str],
) -> Option<RecurseSpec<'tree>> {
	child_by_field_or_kind(node, fields, kinds).map(|child| RecurseSpec { node: child, context })
}

pub const fn recurse_self(node: Node<'_>, context: ChunkContext) -> RecurseSpec<'_> {
	RecurseSpec { node, context }
}

pub fn recurse_body(node: Node<'_>, context: ChunkContext) -> Option<RecurseSpec<'_>> {
	resolve_recurse(node, context)
}

pub fn recurse_class(node: Node<'_>) -> Option<RecurseSpec<'_>> {
	resolve_recurse(node, ChunkContext::ClassBody)
}

pub fn recurse_enum(node: Node<'_>) -> Option<RecurseSpec<'_>> {
	resolve_recurse(node, ChunkContext::ClassBody)
}

pub fn recurse_value_container(node: Node<'_>) -> Option<RecurseSpec<'_>> {
	resolve_value_container(node)
}

/// Try to promote a node that wraps a call expression with a trailing
/// callback/block argument. Returns a named chunk candidate with `recurse`
/// pointing into the callback body.
///
/// This is language-agnostic: it uses structural shape detection to find
/// call-with-callback patterns in any language (JS `describe(...)`, Go
/// `t.Run(...)`, Rust `tokio::spawn(async { ... })`, etc.).
pub fn try_promote_call_with_callback<'tree>(
	node: Node<'tree>,
	source: &str,
) -> Option<RawChunkCandidate<'tree>> {
	let (func_node, body) = shape::trailing_callback_body(node)?;

	// Extract a name from the call target (e.g. `describe`, `describe.serial`,
	// `app.use`). Sanitize the raw source text (dots become underscores).
	let name = sanitize_identifier(node_text(source, func_node.start_byte(), func_node.end_byte()));

	let recurse = Some(RecurseSpec { node: body, context: ChunkContext::FunctionBody });

	Some(make_kind_chunk(node, ChunkKind::Expression, name, source, recurse))
}

// ── Identifier extraction ────────────────────────────────────────────────

pub fn extract_identifier(node: Node<'_>, source: &str) -> Option<String> {
	if node.kind() == "constructor" {
		return Some("constructor".to_string());
	}

	if let Some(name_node) = shape::identifier_node(node) {
		return sanitize_identifier(node_text(source, name_node.start_byte(), name_node.end_byte()));
	}

	None
}

/// Extract the name of a single-declarator binding like `const FOO = ...`.
pub fn extract_single_declarator_name(node: Node<'_>, source: &str) -> Option<String> {
	let declarators: Vec<Node<'_>> = named_children(node)
		.into_iter()
		.filter(|c| c.kind() == "variable_declarator")
		.collect();
	if declarators.len() != 1 {
		return None;
	}
	extract_identifier(declarators[0], source)
}

// ── Text helpers ─────────────────────────────────────────────────────────

pub fn node_text(source: &str, start_byte: usize, end_byte: usize) -> &str {
	source.get(start_byte..end_byte).unwrap_or("")
}

pub fn sanitize_identifier(text: &str) -> Option<String> {
	let mut out = String::new();
	let mut previous_was_underscore = false;

	for ch in text.chars() {
		if ch.is_alphanumeric() || ch == '_' || ch == '$' {
			out.push(ch);
			previous_was_underscore = false;
			continue;
		}

		if !previous_was_underscore {
			out.push('_');
			previous_was_underscore = true;
		}
	}

	let sanitized = out.trim_matches('_').to_string();
	if sanitized.is_empty() {
		None
	} else {
		Some(sanitized)
	}
}

pub fn unquote_text(text: &str) -> String {
	text.trim().trim_matches('"').trim_matches('\'').to_string()
}

pub fn sanitize_node_kind(kind: &str) -> &str {
	let mut kind_stripped = kind;
	for suffix in [
		"_instruction",
		"_statement",
		"_declaration",
		"_definition",
		"_item",
		"ession", // _expression -> _expr
	] {
		if let Some(stripped) = kind_stripped.strip_suffix(suffix) {
			kind_stripped = stripped;
		}
	}
	if kind_stripped.is_empty() {
		kind
	} else {
		kind_stripped
	}
}

pub fn normalized_header(source: &str, start_byte: usize, end_byte: usize) -> String {
	let slice = node_text(source, start_byte, end_byte);
	let mut header = String::new();

	for line in slice.lines().take(4) {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		if !header.is_empty() {
			header.push(' ');
		}
		header.push_str(trimmed);
		if trimmed.contains('{') || trimmed.ends_with(';') {
			break;
		}
	}

	collapse_whitespace(header.as_str())
}

pub fn collapse_whitespace(text: &str) -> String {
	let mut out = String::new();
	let mut pending_space = false;
	for ch in text.chars() {
		if ch.is_whitespace() {
			pending_space = true;
			continue;
		}
		if pending_space && !out.is_empty() {
			out.push(' ');
		}
		out.push(ch);
		pending_space = false;
	}
	out
}

// ── Signature helpers ────────────────────────────────────────────────────

pub fn signature_for_node(node: Node<'_>, source: &str) -> Option<String> {
	let raw = if let Some(end_byte) = shape::signature_end_byte(node) {
		node_text(source, node.start_byte(), end_byte)
	} else {
		node_text(source, node.start_byte(), node.end_byte())
	};

	let sig = collapse_whitespace(raw.trim());
	let sig = sig
		.trim_end_matches('{')
		.trim_end_matches(':')
		.trim_end_matches(';')
		.trim();
	if sig.is_empty() {
		None
	} else {
		Some(sig.to_string())
	}
}

// ── Summary / canonical naming ───────────────────────────────────────────

fn normalize_summary_text(summary: &str) -> Option<String> {
	let summary = collapse_whitespace(summary.trim())
		.trim_end_matches('{')
		.trim_end_matches(':')
		.trim_end_matches(';')
		.trim()
		.to_string();
	if summary.is_empty() {
		None
	} else {
		Some(summary)
	}
}

fn summarize_function_node(
	kind: ChunkKind,
	identifier: Option<&str>,
	raw_signature: &str,
) -> String {
	let name = identifier.unwrap_or_else(|| kind.prefix());
	let tail = function_signature(raw_signature)
		.or_else(|| python_function_signature(raw_signature))
		.or_else(|| rust_function_signature(raw_signature))
		.unwrap_or_else(|| raw_signature.to_string());
	let tail = tail.replacen("): ", ") → ", 1);
	format!("{} {name}{tail}", kind.prefix())
}

fn summarize_variable_node(
	node: Node<'_>,
	kind: ChunkKind,
	identifier: Option<&str>,
	source: &str,
) -> Option<String> {
	let header = normalized_header(source, node.start_byte(), node.end_byte());
	let keyword = header.split_whitespace().next()?;
	let name = identifier.unwrap_or_else(|| kind.prefix());
	Some(format!("{keyword} {name}"))
}

fn summarize_statement_node(node: Node<'_>, source: &str) -> Option<String> {
	normalize_summary_text(normalized_header(source, node.start_byte(), node.end_byte()).as_str())
}

pub fn summary_for_node(
	node: Node<'_>,
	kind: ChunkKind,
	identifier: Option<&str>,
	raw_signature: Option<&str>,
	source: &str,
) -> Option<String> {
	match kind.traits().summary {
		SummaryStyle::Imports => return Some("imports".to_string()),
		SummaryStyle::Function => {
			if let Some(signature) = raw_signature {
				return Some(summarize_function_node(kind, identifier, signature));
			}
		},
		SummaryStyle::Variable => {
			return summarize_variable_node(node, kind, identifier, source);
		},
		SummaryStyle::Default => {},
	}
	if matches!(
		node.kind(),
		"for_statement"
			| "for_in_statement"
			| "for_of_statement"
			| "if_statement"
			| "return_statement"
			| "expression_statement"
			| "call_expression"
			| "call"
			| "function_call"
	) {
		return summarize_statement_node(node, source);
	}
	raw_signature
		.and_then(normalize_summary_text)
		.or_else(|| summarize_statement_node(node, source))
}

fn function_signature(header: &str) -> Option<String> {
	let start = header.find('(')?;
	let end = header.rfind('{').unwrap_or(header.len());
	let signature = header.get(start..end)?.trim().trim_end_matches(';').trim();
	if signature.is_empty() {
		None
	} else {
		Some(signature.to_string())
	}
}

fn python_function_signature(header: &str) -> Option<String> {
	let start = header.find('(')?;
	let end = header.rfind(':').unwrap_or(header.len());
	let signature = header.get(start..end)?.trim();
	if signature.is_empty() {
		None
	} else {
		Some(signature.to_string())
	}
}

fn rust_function_signature(header: &str) -> Option<String> {
	let start = header.find('(')?;
	let end = header.rfind('{').unwrap_or(header.len());
	let mut sig = header.get(start..end)?.trim();
	if let Some(idx) = sig.find(" where ") {
		sig = sig.get(..idx)?.trim();
	}
	if sig.is_empty() {
		None
	} else {
		Some(sig.to_string())
	}
}

// ── Trivia and attribute detection ───────────────────────────────────────

pub fn is_trivia_node(node: Node<'_>) -> bool {
	shape::is_generic_trivia(node)
}

pub fn is_absorbable_attribute(kind: &str) -> bool {
	shape::is_generic_absorbable_attr(kind)
}

// ── Other helpers ────────────────────────────────────────────────────────

pub fn looks_like_python_statement(node: Node<'_>, source: &str) -> bool {
	let header = normalized_header(source, node.start_byte(), node.end_byte());
	header.contains(':') && !header.contains('{')
}

pub fn detect_indent(source: &str, start_byte: usize) -> (u32, String) {
	let line_start = source.as_bytes()[..start_byte]
		.iter()
		.rposition(|&b| b == b'\n')
		.map_or(0, |pos| pos + 1);
	let line_prefix = &source[line_start..start_byte];
	let mut cols = 0u32;
	let mut ch = String::new();
	for byte in line_prefix.bytes() {
		match byte {
			b'\t' => {
				cols += 1;
				if ch.is_empty() {
					ch = "\t".to_string();
				}
			},
			b' ' => {
				cols += 1;
				if ch.is_empty() {
					ch = " ".to_string();
				}
			},
			_ => break,
		}
	}
	(cols, ch)
}

pub fn is_root_wrapper_node(node: Node<'_>) -> bool {
	shape::is_root_wrapper_node(node)
}

pub const fn line_span(start_line: usize, end_line: usize) -> usize {
	end_line.saturating_sub(start_line) + 1
}

pub fn total_line_count(source: &str) -> usize {
	if source.is_empty() {
		0
	} else {
		source.bytes().filter(|byte| *byte == b'\n').count() + 1
	}
}

pub fn first_scalar_child(node: Node<'_>) -> Option<Node<'_>> {
	named_children(node).into_iter().find(|child| {
		!matches!(
			child.kind(),
			"block_node"
				| "flow_node"
				| "block_mapping"
				| "flow_mapping"
				| "block_sequence"
				| "flow_sequence"
		)
	})
}

#[cfg(test)]
mod tests {
	use super::compute_body_inner_boundaries;

	#[test]
	fn compute_body_inner_boundaries_handles_brace_and_indent_bodies() {
		let ts = "function main() {\n\treturn 1;\n}\n";
		let ts_start = ts.find('{').expect("open brace");
		let ts_end = ts.rfind('}').expect("close brace") + 1;
		let (ts_inner_start, ts_inner_end) = compute_body_inner_boundaries(ts, ts_start, ts_end);
		assert_eq!(&ts[ts_inner_start..ts_inner_end], "\treturn 1;\n");

		let rust = "fn main() {\n    println!(\"hi\");\n}\n";
		let rust_start = rust.find('{').expect("open brace");
		let rust_end = rust.rfind('}').expect("close brace") + 1;
		let (rust_inner_start, rust_inner_end) =
			compute_body_inner_boundaries(rust, rust_start, rust_end);
		assert_eq!(&rust[rust_inner_start..rust_inner_end], "    println!(\"hi\");\n");

		let go = "func main() {\n\treturn\n}\n";
		let go_start = go.find('{').expect("open brace");
		let go_end = go.rfind('}').expect("close brace") + 1;
		let (go_inner_start, go_inner_end) = compute_body_inner_boundaries(go, go_start, go_end);
		assert_eq!(&go[go_inner_start..go_inner_end], "\treturn\n");

		let py = "def main():\n    return 1\n";
		let py_body_start = py.find("    return 1").expect("body start");
		let py_body_end = py_body_start + "    return 1".len();
		let (py_inner_start, py_inner_end) =
			compute_body_inner_boundaries(py, py_body_start, py_body_end);
		assert_eq!(&py[py_inner_start..py_inner_end], "    return 1");
	}
}

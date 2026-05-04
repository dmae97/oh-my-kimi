//! Structural source summaries powered by tree-sitter.

use std::{collections::BTreeSet, path::Path};

use ast_grep_core::{Language, tree_sitter::LanguageExt};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tree_sitter::{Node, Parser};

use crate::language::SupportLang;

const DEFAULT_MIN_BODY_LINES: u32 = 4;
const DEFAULT_MIN_COMMENT_LINES: u32 = 6;

#[napi(object)]
pub struct SummaryOptions {
	/// Source code to summarize.
	pub code:              String,
	/// Language alias (e.g. "rust", "typescript") used before path inference.
	pub lang:              Option<String>,
	/// File path used to infer language by extension when `lang` is omitted.
	pub path:              Option<String>,
	/// Minimum total node lines before eliding a body/literal node.
	pub min_body_lines:    Option<u32>,
	/// Minimum total comment lines before eliding a multiline block comment.
	pub min_comment_lines: Option<u32>,
}

#[napi(object)]
pub struct SummarySegment {
	/// "kept" or "elided".
	pub kind:       String,
	/// 1-based inclusive start line.
	pub start_line: u32,
	/// 1-based inclusive end line.
	pub end_line:   u32,
	/// Verbatim text for kept segments; absent for elided segments.
	pub text:       Option<String>,
}

#[napi(object)]
pub struct SummaryResult {
	/// Canonical language name when parsing succeeded.
	pub language:    Option<String>,
	/// True when tree-sitter parsed the source without syntax errors.
	pub parsed:      bool,
	/// True when at least one elision span was emitted.
	pub elided:      bool,
	/// Total source lines.
	pub total_lines: u32,
	/// Kept/elided segments in source order.
	pub segments:    Vec<SummarySegment>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LineSpan {
	start: u32,
	end:   u32,
}

#[napi]
pub fn summarize_code(options: SummaryOptions) -> Result<SummaryResult> {
	let source = options.code;
	let total_lines = count_lines(&source);
	if source.is_empty() {
		return Ok(unparsed_result(source, total_lines));
	}

	let Some(language) = resolve_language(options.lang.as_deref(), options.path.as_deref()) else {
		return Ok(unparsed_result(source, total_lines));
	};

	let mut parser = Parser::new();
	parser
		.set_language(&language.get_ts_language())
		.map_err(|err| Error::from_reason(format!("Failed to load tree-sitter language: {err}")))?;
	let Some(tree) = parser.parse(&source, None) else {
		return Ok(unparsed_result(source, total_lines));
	};
	let root = tree.root_node();
	if root.has_error() {
		return Ok(unparsed_result(source, total_lines));
	}

	let min_body_lines = options
		.min_body_lines
		.unwrap_or(DEFAULT_MIN_BODY_LINES)
		.max(2);
	let min_comment_lines = options
		.min_comment_lines
		.unwrap_or(DEFAULT_MIN_COMMENT_LINES)
		.max(4);
	let mut spans = Vec::new();
	collect_elisions(root, language, min_body_lines, min_comment_lines, &mut spans);
	let spans = normalize_spans(spans, total_lines);
	let segments = build_segments(&source, total_lines, &spans);

	Ok(SummaryResult {
		language: Some(language.canonical_name().to_string()),
		parsed: true,
		elided: !spans.is_empty(),
		total_lines,
		segments,
	})
}

fn resolve_language(lang: Option<&str>, path: Option<&str>) -> Option<SupportLang> {
	if let Some(lang) = lang.map(str::trim).filter(|lang| !lang.is_empty()) {
		return SupportLang::from_alias(lang);
	}
	let path = path?.trim();
	if path.is_empty() {
		return None;
	}
	SupportLang::from_path(Path::new(path))
}

fn unparsed_result(source: String, total_lines: u32) -> SummaryResult {
	let segments = if source.is_empty() {
		Vec::new()
	} else {
		vec![SummarySegment {
			kind:       "kept".to_string(),
			start_line: 1,
			end_line:   total_lines,
			text:       Some(source),
		}]
	};
	SummaryResult { language: None, parsed: false, elided: false, total_lines, segments }
}

fn count_lines(source: &str) -> u32 {
	if source.is_empty() {
		0
	} else {
		source.lines().count().max(1).min(u32::MAX as usize) as u32
	}
}

fn collect_elisions(
	node: Node<'_>,
	language: SupportLang,
	min_body_lines: u32,
	min_comment_lines: u32,
	spans: &mut Vec<LineSpan>,
) {
	let total_lines = node_line_count(node);
	if is_comment_kind(language, node.kind()) {
		if total_lines >= min_comment_lines {
			let start_line = node_start_line(node) + 2;
			let end_line = node_end_line(node).saturating_sub(1);
			if start_line <= end_line {
				spans.push(LineSpan { start: start_line, end: end_line });
			}
		}
		return;
	}

	if is_elidable_kind(language, node.kind()) && total_lines >= min_body_lines {
		let start_line = node_start_line(node) + 1;
		let end_line = node_end_line(node).saturating_sub(1);
		if start_line <= end_line {
			spans.push(LineSpan { start: start_line, end: end_line });
			return;
		}
	}

	for index in 0..node.child_count() {
		if let Some(child) = node.child(index) {
			collect_elisions(child, language, min_body_lines, min_comment_lines, spans);
		}
	}
}

fn node_start_line(node: Node<'_>) -> u32 {
	node
		.start_position()
		.row
		.saturating_add(1)
		.min(u32::MAX as usize) as u32
}

fn node_end_line(node: Node<'_>) -> u32 {
	node
		.end_position()
		.row
		.saturating_add(1)
		.min(u32::MAX as usize) as u32
}

fn node_line_count(node: Node<'_>) -> u32 {
	node_end_line(node)
		.saturating_sub(node_start_line(node))
		.saturating_add(1)
}

fn is_comment_kind(language: SupportLang, kind: &str) -> bool {
	match language {
		SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript => kind == "comment",
		SupportLang::Rust => kind == "block_comment",
		SupportLang::Python => kind == "comment",
		SupportLang::Go => kind == "comment",
		SupportLang::Java => kind == "block_comment",
		SupportLang::C | SupportLang::Cpp | SupportLang::ObjC => kind == "comment",
		SupportLang::CSharp => kind == "comment",
		SupportLang::Ruby => kind == "comment",
		SupportLang::Php => kind == "comment",
		SupportLang::Swift => kind == "comment",
		SupportLang::Kotlin => kind == "block_comment",
		SupportLang::Scala => kind == "block_comment",
		SupportLang::Lua => kind == "comment",
		_ => false,
	}
}

fn is_elidable_kind(language: SupportLang, kind: &str) -> bool {
	match language {
		SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript => matches!(
			kind,
			"statement_block" | "function_body" | "object" | "array" | "template_string"
		),
		SupportLang::Rust => matches!(
			kind,
			"block"
				| "array_expression"
				| "tuple_expression"
				| "struct_expression"
				| "match_block"
				| "raw_string_literal"
		),
		SupportLang::Python => matches!(kind, "block" | "dictionary" | "list" | "set" | "string"),
		SupportLang::Go => matches!(
			kind,
			"block" | "composite_literal" | "interpreted_string_literal" | "raw_string_literal"
		),
		SupportLang::Java => matches!(kind, "block" | "array_initializer"),
		SupportLang::C | SupportLang::Cpp | SupportLang::ObjC => {
			matches!(kind, "compound_statement" | "initializer_list" | "string_literal")
		},
		SupportLang::CSharp => {
			matches!(kind, "block" | "initializer_expression" | "array_initializer_expression")
		},
		SupportLang::Ruby => {
			matches!(kind, "body_statement" | "method" | "do_block" | "array" | "hash")
		},
		SupportLang::Php => matches!(kind, "compound_statement" | "array_creation_expression"),
		SupportLang::Swift => matches!(
			kind,
			"function_body" | "array_literal" | "dictionary_literal" | "multi_line_string_literal"
		),
		SupportLang::Kotlin => {
			matches!(kind, "function_body" | "collection_literal" | "multi_line_string_literal")
		},
		SupportLang::Scala => matches!(kind, "block" | "collection_literal"),
		SupportLang::Lua => matches!(kind, "block" | "table_constructor" | "string"),
		_ => false,
	}
}

fn normalize_spans(mut spans: Vec<LineSpan>, total_lines: u32) -> Vec<LineSpan> {
	if total_lines == 0 {
		return Vec::new();
	}
	spans.retain(|span| span.start <= span.end && span.start <= total_lines);
	for span in &mut spans {
		span.end = span.end.min(total_lines);
	}
	spans.sort_by_key(|span| (span.start, span.end));
	let mut merged: Vec<LineSpan> = Vec::new();
	for span in spans {
		if let Some(last) = merged.last_mut()
			&& span.start <= last.end.saturating_add(1)
		{
			last.end = last.end.max(span.end);
			continue;
		}
		merged.push(span);
	}
	merged
}

fn build_segments(source: &str, total_lines: u32, spans: &[LineSpan]) -> Vec<SummarySegment> {
	if total_lines == 0 {
		return Vec::new();
	}
	let source_lines: Vec<&str> = source.lines().collect();
	let elided_lines = spans
		.iter()
		.flat_map(|span| span.start..=span.end)
		.collect::<BTreeSet<_>>();
	let mut segments = Vec::new();
	let mut current_kind: Option<&str> = None;
	let mut current_start = 1;
	let mut current_lines: Vec<&str> = Vec::new();

	for line_number in 1..=total_lines {
		let is_elided = elided_lines.contains(&line_number);
		let kind = if is_elided { "elided" } else { "kept" };
		if current_kind.is_some_and(|existing| existing != kind) {
			push_segment(
				&mut segments,
				current_kind.expect("kind set"),
				current_start,
				line_number - 1,
				&current_lines,
			);
			current_start = line_number;
			current_lines.clear();
		}
		current_kind = Some(kind);
		if !is_elided {
			let index = line_number.saturating_sub(1) as usize;
			current_lines.push(source_lines.get(index).copied().unwrap_or_default());
		}
	}

	if let Some(kind) = current_kind {
		push_segment(&mut segments, kind, current_start, total_lines, &current_lines);
	}
	segments
}

fn push_segment(
	segments: &mut Vec<SummarySegment>,
	kind: &str,
	start_line: u32,
	end_line: u32,
	lines: &[&str],
) {
	segments.push(SummarySegment {
		kind: kind.to_string(),
		start_line,
		end_line,
		text: (kind == "kept").then(|| lines.join("\n")),
	});
}

#[cfg(test)]
mod tests {
	use super::*;

	fn summarize(code: &str, path: &str) -> SummaryResult {
		summarize_code(SummaryOptions {
			code:              code.to_string(),
			lang:              None,
			path:              Some(path.to_string()),
			min_body_lines:    None,
			min_comment_lines: None,
		})
		.expect("summary succeeds")
	}

	fn segment_kinds(result: &SummaryResult) -> Vec<&str> {
		result
			.segments
			.iter()
			.map(|segment| segment.kind.as_str())
			.collect()
	}

	#[test]
	fn summarizes_typescript_function_body() {
		let result = summarize(
			"export function greet(name: string): string {\n\tconst clean = name.trim();\n\tconst \
			 label = clean || 'world';\n\treturn `hello ${label}`;\n}\n",
			"fixture.ts",
		);

		assert!(result.parsed);
		assert!(result.elided);
		assert_eq!(result.language.as_deref(), Some("typescript"));
		assert_eq!(segment_kinds(&result), vec!["kept", "elided", "kept"]);
		assert_eq!(
			result.segments[0].text.as_deref(),
			Some("export function greet(name: string): string {")
		);
		assert_eq!(result.segments[1].start_line, 2);
		assert_eq!(result.segments[1].end_line, 4);
		assert_eq!(result.segments[2].text.as_deref(), Some("}"));
	}

	#[test]
	fn summarizes_rust_method_body_but_keeps_impl_boundaries() {
		let result = summarize(
			"struct Greeter;\n\nimpl Greeter {\n\tfn greet(&self) -> String {\n\t\tlet name = \
			 \"world\";\n\t\tlet label = name.to_uppercase();\n\t\tformat!(\"hello \
			 {label}\")\n\t}\n}\n",
			"fixture.rs",
		);

		assert!(result.parsed);
		assert!(result.elided);
		let rendered = result
			.segments
			.iter()
			.map(|segment| segment.text.clone().unwrap_or_else(|| "...".to_string()))
			.collect::<Vec<_>>()
			.join("\n");
		assert!(rendered.contains("impl Greeter {\n\tfn greet(&self) -> String {\n...\n\t}\n}"));
	}

	#[test]
	fn summarizes_python_function_body() {
		let result =
			summarize(
				"class Greeter:\n    def greet(self, name: str) -> str:\n        clean = \
				 name.strip()\n        label = clean or 'world'\n        return f'hello {label}'\n",
				"fixture.py",
			);

		assert!(result.parsed);
		assert!(result.elided);
		assert_eq!(segment_kinds(&result), vec!["kept", "elided", "kept"]);
		assert!(
			result.segments[0]
				.text
				.as_deref()
				.unwrap_or_default()
				.contains("def greet")
		);
		assert!(
			result.segments[2]
				.text
				.as_deref()
				.unwrap_or_default()
				.contains("return")
		);
	}

	#[test]
	fn min_body_lines_controls_short_body_elision() {
		let code = "function small() {\n\treturn 1;\n}\n";
		let default_result = summarize(code, "fixture.ts");
		assert!(default_result.parsed);
		assert!(!default_result.elided);

		let override_result = summarize_code(SummaryOptions {
			code:              code.to_string(),
			lang:              Some("typescript".to_string()),
			path:              None,
			min_body_lines:    Some(3),
			min_comment_lines: None,
		})
		.expect("summary succeeds");
		assert!(override_result.elided);
	}

	#[test]
	fn parse_failure_falls_back_to_unparsed() {
		let result = summarize("export function broken( {\n", "fixture.ts");
		assert!(!result.parsed);
		assert!(!result.elided);
		assert_eq!(result.segments.len(), 1);
	}

	#[test]
	fn unsupported_language_is_unparsed() {
		let result = summarize("plain text\nwith lines\n", "fixture.txt");
		assert!(!result.parsed);
		assert_eq!(result.segments[0].text.as_deref(), Some("plain text\nwith lines\n"));
	}
}

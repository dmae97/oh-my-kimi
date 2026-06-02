//! Resolve the syntactic block that begins on a given source line.
//!
//! Powers the hashline `replace block N:` operator: given a 1-indexed line,
//! parse the source with tree-sitter and return the line span of the outermost
//! named node that *begins* on that line (excluding the whole-file root). Brace
//! languages anchor a construct's block to its opening line, so pointing at the
//! line that opens an `if` / `function` / `struct` resolves to that construct's
//! full span; pointing at a continuation line or a lone closing delimiter
//! resolves to nothing.

use anyhow::{Result, anyhow};
use ast_grep_core::tree_sitter::LanguageExt;
use serde::{Deserialize, Serialize};
use tree_sitter::{Parser, Point};

use crate::summary::{node_content_end_line, node_start_line, resolve_language};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockRangeOptions {
	/// Source code to inspect.
	pub code: String,
	/// Language alias (e.g. "rust", "typescript") used before path inference.
	pub lang: Option<String>,
	/// File path used to infer language by extension when `lang` is omitted.
	pub path: Option<String>,
	/// 1-indexed source line the block must begin on.
	pub line: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlockRange {
	/// 1-indexed inclusive first line of the resolved block.
	pub start_line: u32,
	/// 1-indexed inclusive last line of the resolved block.
	pub end_line:   u32,
}

/// Count of leading space/tab bytes on `row` (0-indexed), i.e. the byte column
/// of the first content character. Returns `None` when `row` is out of range
/// or the line is blank / whitespace-only — there is no block to resolve there.
fn first_content_column(code: &str, row: usize) -> Option<usize> {
	let line = code.split('\n').nth(row)?;
	for (col, byte) in line.bytes().enumerate() {
		if byte != b' ' && byte != b'\t' {
			return Some(col);
		}
	}
	None
}

/// Resolve the block beginning on `options.line`.
///
/// Returns `None` (a soft "no block here", surfaced as a hard error one layer
/// up) when the language is unrecognized, the line is out of range / blank, no
/// node begins on that line, or the resolved subtree contains a syntax error.
pub fn block_range_at(options: BlockRangeOptions) -> Result<Option<BlockRange>> {
	let BlockRangeOptions { code, lang, path, line } = options;
	if line == 0 || code.is_empty() {
		return Ok(None);
	}
	let Some(language) = resolve_language(lang.as_deref(), path.as_deref()) else {
		return Ok(None);
	};
	let row = (line - 1) as usize;
	let Some(col) = first_content_column(&code, row) else {
		return Ok(None);
	};

	let mut parser = Parser::new();
	parser
		.set_language(&language.get_ts_language())
		.map_err(|err| anyhow!("Failed to load tree-sitter language: {err}"))?;
	let Some(tree) = parser.parse(&code, None) else {
		return Ok(None);
	};
	let root = tree.root_node();

	let point = Point::new(row, col);
	let Some(leaf) = root.named_descendant_for_point_range(point, point) else {
		return Ok(None);
	};
	// A leaf whose own start row is earlier than `row` means `point` landed on
	// a continuation line or a closing delimiter of a block that opened earlier
	// — there is no block *beginning* on line N.
	if leaf.start_position().row != row {
		return Ok(None);
	}
	// Climb to the outermost named ancestor that still begins on `row`,
	// excluding the whole-file root. Ancestors can only begin on an earlier
	// row, so the first parent that starts before `row` stops the climb.
	let mut node = leaf;
	while let Some(parent) = node.parent() {
		if parent.id() == root.id() {
			break;
		}
		if parent.start_position().row != row {
			break;
		}
		node = parent;
	}
	// Refuse degenerate error-recovery spans: a missing brace can make
	// tree-sitter wrap a huge region in an ERROR node. Checking only the
	// resolved node's subtree (not the whole file) keeps an unrelated syntax
	// error elsewhere from disabling the feature.
	if node.has_error() {
		return Ok(None);
	}
	Ok(Some(BlockRange {
		start_line: node_start_line(node),
		end_line:   node_content_end_line(node),
	}))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn resolve(code: &str, path: &str, line: u32) -> Option<BlockRange> {
		block_range_at(BlockRangeOptions {
			code: code.to_string(),
			lang: None,
			path: Some(path.to_string()),
			line,
		})
		.expect("block resolution succeeds")
	}

	const TS_EXAMPLE: &str = "function x() {\n  if (y) {\n  }\n}\n";

	#[test]
	fn resolves_inner_if_block() {
		assert_eq!(resolve(TS_EXAMPLE, "x.ts", 2), Some(BlockRange { start_line: 2, end_line: 3 }));
	}

	#[test]
	fn resolves_enclosing_function_block() {
		assert_eq!(resolve(TS_EXAMPLE, "x.ts", 1), Some(BlockRange { start_line: 1, end_line: 4 }));
	}

	#[test]
	fn lone_closing_brace_resolves_to_nothing() {
		// Line 3 is `  }` — the closing delimiter of a block that opened on an
		// earlier line, so no block *begins* there.
		assert_eq!(resolve(TS_EXAMPLE, "x.ts", 3), None);
	}

	#[test]
	fn blank_line_resolves_to_nothing() {
		let code = "function x() {\n\n  return 1;\n}\n";
		assert_eq!(resolve(code, "x.ts", 2), None);
	}

	#[test]
	fn out_of_range_line_resolves_to_nothing() {
		assert_eq!(resolve(TS_EXAMPLE, "x.ts", 99), None);
		assert_eq!(resolve(TS_EXAMPLE, "x.ts", 0), None);
	}

	#[test]
	fn unrecognized_extension_resolves_to_nothing() {
		assert_eq!(resolve(TS_EXAMPLE, "x.unknownext", 2), None);
	}

	#[test]
	fn resolves_top_level_python_def() {
		let code = "x = 1\ndef greet():\n    return 1\n";
		assert_eq!(resolve(code, "g.py", 2), Some(BlockRange { start_line: 2, end_line: 3 }));
	}

	#[test]
	fn resolves_inner_python_block() {
		// Point at the `for` loop inside the function body. The suite's first
		// statement is `total = 0` (line 2), so the `for` at line 3 is not the
		// suite's first child and climbs only to the `for_statement`, not the
		// whole function suite.
		let code =
			"def f(xs):\n    total = 0\n    for x in xs:\n        total += x\n    return total\n";
		assert_eq!(resolve(code, "f.py", 3), Some(BlockRange { start_line: 3, end_line: 4 }));
	}

	#[test]
	fn resolves_nested_block_to_outermost_on_line() {
		// Point at the inner `if` line; it resolves the whole `if` block
		// (header through its closing brace), not just the call inside it.
		let code = "function f() {\n  if (a) {\n    g();\n  }\n}\n";
		assert_eq!(resolve(code, "f.ts", 2), Some(BlockRange { start_line: 2, end_line: 4 }));
	}

	#[test]
	fn multi_statement_line_resolves_first_statement_node() {
		// `let a = 1; let b = 2;` — pointing at the line resolves the first
		// statement that begins at the line's first content column.
		let code = "let a = 1; let b = 2;\n";
		let range = resolve(code, "m.ts", 1);
		assert!(range.is_some(), "expected a block on a single-statement-bearing line");
		assert_eq!(range.unwrap().start_line, 1);
	}

	#[test]
	fn continuation_line_resolves_to_nothing() {
		// A bare argument-continuation line whose first content does not open a
		// new named node beginning on that row.
		let code = "foo(\n  a,\n  b,\n);\n";
		// Line 2 (`  a,`) is an argument — `a` is an identifier beginning on the
		// row, so it DOES resolve. Use the closing `);` line instead, which is
		// a continuation/closer of the call begun earlier.
		assert_eq!(resolve(code, "c.ts", 4), None);
	}

	#[test]
	fn error_subtree_resolves_to_nothing() {
		// Missing closing brace: the function's subtree carries an ERROR, so we
		// refuse to resolve a degenerate recovery span.
		let code = "function broken() {\n  if (y) {\n}\n";
		assert_eq!(resolve(code, "b.ts", 1), None);
	}

	#[test]
	fn resolves_rust_struct_block() {
		let code = "struct A;\nstruct B {\n    x: u32,\n}\n";
		assert_eq!(resolve(code, "r.rs", 2), Some(BlockRange { start_line: 2, end_line: 4 }));
	}
}

//! Type-checker and linter output filters.

use std::collections::BTreeMap;

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn supports(subcommand: Option<&str>) -> bool {
	supports_program("", subcommand)
}

pub fn supports_program(program: &str, subcommand: Option<&str>) -> bool {
	// Program-claim the JS type-checker/linters too: without this, a path-arg
	// invocation (`tsc --project x`, `eslint src/`, `biome ci app/`,
	// `oxlint src/`) resolves its subcommand to the path token, which is not in
	// the subcommand allowlist below, so the invocation would route UNFILTERED.
	// detect.rs yields these exact program tokens (see its
	// `detects_direct_lint_tools` test). Claiming the program makes the engine
	// pick the Rust path first; the residual defs/biome.toml & defs/oxlint.toml
	// remain as fallback for any unclaimed subcommand only.
	matches!(
		program,
		"ruff"
			| "mypy"
			| "rubocop"
			| "pyright"
			| "basedpyright"
			| "tsc"
			| "eslint"
			| "biome"
			| "oxlint"
	) || matches!(subcommand, None | Some("check" | "lint" | "run" | "format" | "fmt" | "typecheck"))
}

/// JS type-checker/linter programs whose human (non-JSON) output carries
/// code-frame body lines, underline rows, and tool-specific success/progress
/// chatter. The frame/noise strips below are gated to these programs so the
/// shared ruff/mypy/rubocop/pyright paths keep their existing behavior.
fn is_js_lint_program(program: &str) -> bool {
	matches!(program, "tsc" | "eslint" | "biome" | "oxlint")
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if preserves_machine_readable_output(ctx) {
		return MinimizerOutput::passthrough(input);
	}

	let text = condense_lint_output(ctx.program, input, exit_code);
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

pub fn condense_lint_output(program: &str, input: &str, exit_code: i32) -> String {
	let cleaned = primitives::strip_ansi(input);
	let stripped = strip_lint_noise(program, &cleaned, exit_code);
	let grouped = group_diagnostics(&stripped);
	primitives::head_tail_lines(&grouped, 180, 100)
}

fn strip_lint_noise(program: &str, input: &str, exit_code: i32) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_lint_noise(program, trimmed, exit_code) {
			continue;
		}
		out.push_str(line.trim_end());
		out.push('\n');
	}
	out
}

fn preserves_machine_readable_output(ctx: &MinimizerCtx<'_>) -> bool {
	matches!(ctx.program, "pyright" | "basedpyright")
		&& ctx
			.command
			.split_whitespace()
			.any(|part| part == "--outputjson" || part.starts_with("--outputjson="))
}

fn is_lint_noise(program: &str, line: &str, exit_code: i32) -> bool {
	// Code-frame / underline / box-drawing / progress chatter is stripped even at
	// exit!=0: these rows carry no diagnostic of their own, and oxlint's
	// `Found N warning…` / biome's `Fixed N file…` summaries match the
	// diagnostic-signal guard below only incidentally (the word "warning"). The
	// `× message` diagnostic rows are never matched here, so they survive.
	if is_js_lint_program(program) && is_js_frame_noise(program, line) {
		return true;
	}
	if exit_code != 0 && contains_diagnostic_signal(line) {
		return false;
	}
	let lower = line.to_ascii_lowercase();
	lower.starts_with("checked ")
		|| lower.starts_with("found 0")
		|| lower.starts_with("success:")
		|| lower.starts_with("all matched files")
		|| lower.starts_with("done in ")
		|| matches!(program, "eslint" | "biome") && lower.starts_with("warning: react version")
		|| matches!(program, "ruff") && lower.starts_with("all checks passed")
		|| matches!(program, "mypy") && lower.starts_with("success: no issues found")
		|| matches!(program, "pyright" | "basedpyright") && lower.starts_with("0 errors, 0 warnings")
		|| matches!(program, "rubocop")
			&& (lower.starts_with("inspecting ")
				|| lower == "offenses:"
				|| lower.ends_with(" files inspected, no offenses detected"))
}

/// Code-frame / underline / tool-chatter noise specific to the JS lint family.
///
/// `line` arrives already trimmed (see `strip_lint_noise`), so leading-column
/// whitespace is gone; patterns are matched against the trimmed form. These
/// strips are deliberately gated to `tsc`/`eslint`/`biome`/`oxlint` so the
/// shared ruff/mypy/rubocop/pyright paths are unaffected.
fn is_js_frame_noise(program: &str, trimmed: &str) -> bool {
	// tsc pretty + biome/oxlint share the same caret/tilde underline rows and
	// gutter-numbered code-frame bodies; handle them for every JS lint program.
	//
	// Underline rows: only `~` (tsc) or `^` (biome/oxlint carets), optionally
	// with interior spaces, e.g. `~~~`, `^^^`, `~ ~`.
	if !trimmed.is_empty()
		&& trimmed
			.chars()
			.all(|ch| ch == '~' || ch == '^' || ch == ' ')
		&& trimmed.chars().any(|ch| ch == '~' || ch == '^')
	{
		return true;
	}
	// Code-frame body line: a leading line-number gutter followed by source.
	// biome/oxlint emit `3 │ interface Props {`; tsc pretty emits `3 foo = 1;`.
	//
	// The biome/oxlint `│`-bar gutter is unambiguous (no real summary line carries
	// a leading number then a box-drawing bar), so strip it unconditionally. The
	// tsc-pretty BARE form (`N source`, no bar) collides with genuine summary /
	// content lines that legitimately begin with a number — `7 errors and 2
	// warnings found`, `5 warnings`, `2 problems (2 errors)`, `3 files checked` —
	// so only strip the bare form when the line carries NO diagnostic signal. This
	// guards the exact information the exit!=0 diagnostic-signal gate was written
	// to protect (is_js_frame_noise runs ahead of that gate in is_lint_noise).
	if is_gutter_bar_line(trimmed) {
		return true;
	}
	if is_bare_gutter_numbered_line(trimmed) && !contains_diagnostic_signal(trimmed) {
		return true;
	}
	match program {
		"biome" => {
			// `│ ...` continuation rows (no leading number) and the post-fix
			// success summary. `Checked N files` is already covered by the
			// lowercase `checked ` rule in is_lint_noise.
			trimmed.starts_with('│') || trimmed.to_ascii_lowercase().starts_with("fixed ")
		},
		"oxlint" => {
			// Box-drawing closers and progress/summary chatter that carries no
			// diagnostic. `× rule: message` and `╭─[file:line]` are KEPT.
			trimmed.starts_with('╰')
				|| trimmed.starts_with("Finished in")
				|| trimmed.starts_with("Found ") && trimmed.contains("warning")
		},
		_ => false,
	}
}

/// True when `trimmed` is a biome/oxlint `│`-bar code-frame gutter row: a run
/// of ASCII digits, optional spaces, then the box-drawing bar `│` (`3 │
/// interface`, `12 │ items.forEach(...)`). The bar makes this form unambiguous,
/// so it is stripped unconditionally — no genuine summary line matches it.
fn is_gutter_bar_line(trimmed: &str) -> bool {
	let mut rest = trimmed;
	let digits = rest
		.find(|ch: char| !ch.is_ascii_digit())
		.unwrap_or(rest.len());
	if digits == 0 {
		return false;
	}
	rest = rest[digits..].trim_start_matches(' ');
	rest.starts_with('│')
}

/// True when `trimmed` begins with a tsc-pretty BARE line-number gutter: a run
/// of ASCII digits immediately followed by an ASCII space/tab then source
/// (`3 foo = 1;`, `10   const x: number = "hello";`). This form overlaps with
/// real summary lines that start with a number, so callers MUST additionally
/// exclude lines carrying a diagnostic signal before stripping.
fn is_bare_gutter_numbered_line(trimmed: &str) -> bool {
	let mut chars = trimmed.char_indices();
	let mut saw_digit = false;
	for (idx, ch) in chars.by_ref() {
		if ch.is_ascii_digit() {
			saw_digit = true;
			continue;
		}
		return saw_digit && idx > 0 && (ch == ' ' || ch == '\t');
	}
	false
}

pub fn group_diagnostics(input: &str) -> String {
	let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
	let mut ungrouped = Vec::new();
	let mut code_counts: BTreeMap<String, usize> = BTreeMap::new();

	for line in input.lines() {
		if let Some((file, rest)) = split_diagnostic(line) {
			if let Some(code) = extract_code(rest) {
				*code_counts.entry(code).or_default() += 1;
			}
			grouped
				.entry(file.to_string())
				.or_default()
				.push(rest.to_string());
		} else {
			ungrouped.push(line.to_string());
		}
	}

	if grouped.is_empty() {
		return primitives::dedup_consecutive_lines(input);
	}

	let mut files: Vec<_> = grouped.into_iter().collect();
	files.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));

	let mut out = String::new();
	let diag_count: usize = files.iter().map(|(_, entries)| entries.len()).sum();
	out.push_str(&diag_count.to_string());
	out.push_str(" diagnostics in ");
	out.push_str(&files.len().to_string());
	out.push_str(" files\n");

	let code_summary = format_code_summary(&code_counts);
	if !code_summary.is_empty() {
		out.push_str("Top codes: ");
		out.push_str(&code_summary);
		out.push('\n');
	}

	for (file, entries) in files {
		out.push_str(&file);
		out.push_str(" (");
		out.push_str(&entries.len().to_string());
		out.push_str(" diagnostics)\n");
		for entry in entries.iter().take(12) {
			out.push_str("  ");
			out.push_str(&truncate_line(entry, 180));
			out.push('\n');
		}
		if entries.len() > 12 {
			out.push_str("  … ");
			out.push_str(&(entries.len() - 12).to_string());
			out.push_str(" more\n");
		}
	}

	for line in ungrouped.iter().take(40) {
		out.push_str(line);
		out.push('\n');
	}
	if ungrouped.len() > 40 {
		out.push_str("… ");
		out.push_str(&(ungrouped.len() - 40).to_string());
		out.push_str(" ungrouped lines omitted\n");
	}
	out
}

fn split_diagnostic(line: &str) -> Option<(&str, &str)> {
	if let Some((file, rest)) = split_tsc_diagnostic(line) {
		return Some((file, rest));
	}
	let (file, rest) = line.split_once(':')?;
	if !looks_like_path(file) || !starts_with_line_number(rest) {
		return None;
	}
	Some((file, rest))
}

fn split_tsc_diagnostic(line: &str) -> Option<(&str, &str)> {
	let paren = line.find('(')?;
	let close = line[paren..].find(')')? + paren;
	let file = &line[..paren];
	let loc = &line[paren + 1..close];
	if !looks_like_path(file)
		|| !loc
			.split(',')
			.all(|part| part.chars().all(|ch| ch.is_ascii_digit()))
	{
		return None;
	}
	let rest = line.get(close + 1..)?.trim_start_matches(':').trim_start();
	Some((file, rest))
}

fn looks_like_path(value: &str) -> bool {
	!value.is_empty()
		&& !value.starts_with(' ')
		&& (value.contains('/') || value.contains('.') || value.ends_with(')'))
}

fn starts_with_line_number(rest: &str) -> bool {
	let rest = rest.trim_start();
	let mut chars = rest.chars();
	let Some(first) = chars.next() else {
		return false;
	};
	first.is_ascii_digit()
}

fn extract_code(text: &str) -> Option<String> {
	for token in text.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-') {
		if token.len() >= 3
			&& token.chars().any(|ch| ch.is_ascii_digit())
			&& token.chars().any(|ch| ch.is_ascii_alphabetic())
		{
			return Some(token.to_string());
		}
	}
	None
}

fn format_code_summary(counts: &BTreeMap<String, usize>) -> String {
	let mut counts: Vec<_> = counts.iter().collect();
	counts.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
	counts
		.iter()
		.take(5)
		.map(|(code, count)| format!("{code} ({count}x)"))
		.collect::<Vec<_>>()
		.join(", ")
}

fn truncate_line(line: &str, max_chars: usize) -> String {
	if line.chars().count() <= max_chars {
		return line.to_string();
	}
	let mut out: String = line.chars().take(max_chars.saturating_sub(1)).collect();
	out.push('…');
	out
}

fn contains_diagnostic_signal(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("error")
		|| lower.contains("warning")
		|| lower.contains("failed")
		|| lower.contains("panic")
		|| lower.contains("exception")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	#[test]
	fn pyright_outputjson_passes_through_untouched() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let json = "{\"version\": \"1.1.0\", \"generalDiagnostics\": []}\n";
		for command in ["pyright --outputjson src", "basedpyright --outputjson=true src"] {
			let ctx = MinimizerCtx {
				program: command.split_whitespace().next().unwrap(),
				subcommand: None,
				command,
				config: &cfg,
			};
			let out = filter(&ctx, json, 1);
			assert!(!out.changed, "{command} output must not be rewritten");
			assert_eq!(out.text, json);
		}
		// Plain (non-JSON) runs still condense.
		let ctx = MinimizerCtx {
			program:    "pyright",
			subcommand: None,
			command:    "pyright src",
			config:     &cfg,
		};
		let plain = "src/app.py:4:7 - error: bad\nsrc/app.py:9:3 - error: worse\n";
		assert!(filter(&ctx, plain, 1).changed);
	}

	#[test]
	fn supports_common_lint_subcommands_for_future_dispatch() {
		for subcommand in ["check", "lint", "run", "format", "typecheck"] {
			assert!(supports(Some(subcommand)), "{subcommand} should be supported");
		}
	}

	#[test]
	fn groups_tsc_and_colon_diagnostics_by_file() {
		let input = "src/a.ts(1,2): error TS2322: bad\nsrc/a.ts(2,1): error TS2322: \
		             bad\nlib/b.py:4: error: no attr [attr-defined]\n";
		let out = group_diagnostics(input);
		assert!(out.contains("3 diagnostics in 2 files"));
		assert!(out.contains("src/a.ts (2 diagnostics)"));
		assert!(out.contains("Top codes:"));
	}

	#[test]
	fn truncates_many_diagnostics_per_file() {
		let mut input = String::new();
		for i in 0..20 {
			input.push_str("src/main.rs:");
			input.push_str(&(i + 1).to_string());
			input.push_str(":1: warning: issue W");
			input.push_str(&i.to_string());
			input.push('\n');
		}
		let out = group_diagnostics(&input);
		assert!(out.contains("src/main.rs (20 diagnostics)"));
		assert!(out.contains("… 8 more"));
	}

	#[test]
	fn direct_pyright_support_and_grouping_work() {
		assert!(supports_program("pyright", None));
		let input = "0 errors, 0 warnings, 0 informations\nsrc/app.ts:4:7 - error TS2322: Type \
		             'string' is not assignable to type 'number'.\nsrc/app.ts:9:3 - error TS7006: \
		             Parameter 'x' implicitly has an 'any' type.\n";
		let out = condense_lint_output("pyright", input, 1);
		assert!(out.contains("2 diagnostics in 1 files"));
		assert!(out.contains("src/app.ts (2 diagnostics)"));
		assert!(out.contains("TS2322"));
		assert!(out.contains("TS7006"));
	}

	#[test]
	fn direct_basedpyright_success_noise_is_stripped() {
		assert!(supports_program("basedpyright", None));
		let out = condense_lint_output("basedpyright", "0 errors, 0 warnings, 0 notes\n", 0);
		assert_eq!(out, "");
	}

	// -----------------------------------------------------------------
	// CONCERN 1: tsc program-claim + code-frame strips
	// (ported from snip/filters/tsc.yaml inline tests, re-rendered through
	// the minimizer's grouped per-file + Top-codes output instead of snip's
	// flat keep_lines)
	// -----------------------------------------------------------------

	#[test]
	fn tsc_eslint_biome_oxlint_are_program_claimed() {
		// Path-arg invocations resolve the subcommand to a path token that is not
		// in the subcommand allowlist; the program claim is what routes them.
		for program in ["tsc", "eslint", "biome", "oxlint"] {
			assert!(
				supports_program(program, Some("src/foo.ts")),
				"{program} path-arg invocation must be program-claimed"
			);
			assert!(supports_program(program, None), "{program} bare invocation must be claimed");
		}
	}

	#[test]
	fn tsc_pretty_strips_code_frames_and_groups_by_file() {
		// snip's "pretty format errors with context" fixture.
		let input = "src/index.ts:3:1 - error TS2304: Cannot find name 'foo'.\n\n3 foo = 1;\n  \
		             ~~~\n\nsrc/utils.ts:10:5 - error TS2322: Type 'string' is not assignable to \
		             type 'number'.\n\n10   const x: number = \"hello\";\n     ~\n\nFound 2 errors \
		             in 2 files.\n";
		let out = condense_lint_output("tsc", input, 2);
		assert!(out.contains("2 diagnostics in 2 files"), "got: {out}");
		assert!(out.contains("TS2304"));
		assert!(out.contains("TS2322"));
		assert!(out.contains("Top codes:"));
		// Code-frame body lines and underline rows are stripped.
		assert!(!out.contains("foo = 1;"), "code-frame body must be stripped: {out}");
		assert!(!out.contains("const x: number"), "code-frame body must be stripped: {out}");
		assert!(!out.contains('~'), "underline rows must be stripped: {out}");
	}

	#[test]
	fn tsc_classic_groups_by_file() {
		// snip's "classic format errors" fixture (no code frames).
		let input = "src/index.ts(3,1): error TS2304: Cannot find name 'foo'.\nsrc/utils.ts(10,5): \
		             error TS2322: Type 'string' is not assignable to type 'number'.\nFound 2 \
		             errors in 2 files.\n";
		let out = condense_lint_output("tsc", input, 2);
		assert!(out.contains("2 diagnostics in 2 files"), "got: {out}");
		assert!(out.contains("src/index.ts"));
		assert!(out.contains("src/utils.ts"));
		assert!(out.contains("TS2304"));
		assert!(out.contains("TS2322"));
	}

	#[test]
	fn tsc_empty_input_condenses_to_clean() {
		// snip emits "ok (no type errors)"; the minimizer renders empty input as
		// empty (its own clean-build signal), so assert that behavior.
		assert_eq!(condense_lint_output("tsc", "", 0), "");
	}

	// -----------------------------------------------------------------
	// Regression: blocking-issue fixes
	// -----------------------------------------------------------------

	#[test]
	fn js_lint_numeric_summary_line_is_not_gutter_stripped() {
		// BLOCKING 1 regression: a JS-lint summary/content line that BEGINS with a
		// number (`7 errors and 2 warnings found`) must survive — the bare-gutter
		// strip only applies to code-frame body rows that carry no diagnostic
		// signal, so this line (it contains "error"/"warning") is preserved.
		let input = "/app/x.js\n  1:1  error  bad  no-var\n\n7 errors and 2 warnings \
		             found\n\u{2716} 9 problems (9 errors, 0 warnings)\n";
		let out = condense_lint_output("eslint", input, 1);
		assert!(
			out.contains("7 errors and 2 warnings found"),
			"numeric summary line must survive the gutter strip: {out}"
		);
		assert!(out.contains("\u{2716} 9 problems (9 errors, 0 warnings)"), "got: {out}");

		// Helper-level pins: the BARE tsc form only strips when no diagnostic signal
		// is present, while the biome/oxlint `│`-bar form always strips.
		assert!(is_bare_gutter_numbered_line("3 foo = 1;"));
		assert!(contains_diagnostic_signal("7 errors and 2 warnings found"));
		assert!(contains_diagnostic_signal("5 warnings"));
		assert!(contains_diagnostic_signal("2 problems (2 errors)"));
		assert!(!is_gutter_bar_line("10 errors found"), "bare numeric is not a bar gutter");
		assert!(is_gutter_bar_line("3 \u{2502} interface Props {"), "biome bar gutter strips");
		assert!(is_gutter_bar_line("12 \u{2502} items.forEach(...)"), "oxlint bar gutter strips");
	}
}

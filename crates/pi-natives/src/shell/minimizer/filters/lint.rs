//! Type-checker and linter output filters.

use std::collections::BTreeMap;

use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn supports(subcommand: Option<&str>) -> bool {
	supports_program("", subcommand)
}

pub fn supports_program(program: &str, subcommand: Option<&str>) -> bool {
	matches!(program, "ruff" | "mypy" | "rubocop")
		|| matches!(
			subcommand,
			None | Some("check" | "lint" | "run" | "format" | "fmt" | "typecheck")
		)
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let text = condense_lint_output(ctx.program, input, exit_code);
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text)
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

fn is_lint_noise(program: &str, line: &str, exit_code: i32) -> bool {
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
		|| matches!(program, "rubocop")
			&& (lower.starts_with("inspecting ")
				|| lower == "offenses:"
				|| lower.ends_with(" files inspected, no offenses detected"))
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
}

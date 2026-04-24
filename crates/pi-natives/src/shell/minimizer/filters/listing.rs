//! Filesystem listing and search filters.

use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, _exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.program {
		"grep" | "rg" => primitives::group_by_file(&cleaned, 12),
		"ls" | "tree" | "find" => compact_listing_output(&cleaned),
		"cat" | "read" => compact_content_output(&cleaned),
		"stat" | "du" | "df" | "wc" => compact_summary_output(&cleaned),
		"jq" | "json" => compact_jsonish_output(&cleaned),
		_ => cleaned,
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text)
	}
}

fn compact_listing_output(input: &str) -> String {
	primitives::compact_listing(input, 80)
}

fn compact_content_output(input: &str) -> String {
	if input.lines().count() <= 120 {
		input.to_string()
	} else {
		primitives::head_tail_lines(input, 60, 40)
	}
}

fn compact_jsonish_output(input: &str) -> String {
	if input.lines().count() <= 120 {
		input.to_string()
	} else {
		primitives::head_tail_lines(input, 60, 40)
	}
}

fn compact_summary_output(input: &str) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= 30 {
		return input.to_string();
	}

	let windowed = primitives::head_tail_lines(input, 12, 12);
	let mut out = String::new();
	for line in lines.iter().copied().filter(|line| is_summary_line(line)) {
		if !windowed.lines().any(|existing| existing == line)
			&& !out.lines().any(|existing| existing == line)
		{
			out.push_str(line);
			out.push('\n');
		}
	}
	out.push_str(&windowed);
	out
}

fn is_summary_line(line: &str) -> bool {
	let trimmed = line.trim();
	let lower = trimmed.to_ascii_lowercase();
	trimmed == "total"
		|| lower.starts_with("total ")
		|| lower.ends_with(" total")
		|| lower.starts_with("filesystem")
		|| lower.contains(" mounted on")
		|| lower.contains(" files ")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::shell::minimizer::MinimizerConfig;

	fn ctx<'a>(program: &'a str, cfg: &'a MinimizerConfig) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand: None, command: program, config: cfg }
	}

	#[test]
	fn groups_grep_by_file() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("rg", &cfg);
		let out = filter(&ctx, "a.rs:1:foo\na.rs:2:bar\n", 0);
		assert_eq!(out.text, "a.rs:\n  1:foo\n  2:bar\n");
	}

	#[test]
	fn compacts_long_cat_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("cat", &cfg);
		let input = numbered_lines(130);
		let out = filter(&ctx, &input, 0);
		assert!(out.text.contains("… 30 lines omitted …"));
		assert!(out.text.contains("line 001"));
		assert!(out.text.contains("line 130"));
	}

	#[test]
	fn preserves_short_read_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("read", &cfg);
		let input = "alpha\nbravo\ncharlie\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, input);
	}

	#[test]
	fn compacts_df_output_without_losing_filesystem_header() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("df", &cfg);
		let mut input = String::from("Filesystem 1K-blocks Used Available Use% Mounted on\n");
		for idx in 0..36 {
			input.push_str("/dev/disk");
			input.push_str(&idx.to_string());
			input.push_str(" 100 50 50 50% /mnt/");
			input.push_str(&idx.to_string());
			input.push('\n');
		}
		let out = filter(&ctx, &input, 0);
		assert!(
			out.text
				.contains("Filesystem 1K-blocks Used Available Use% Mounted on")
		);
		assert!(out.text.contains("… 13 lines omitted …"));
		assert!(out.text.contains("/dev/disk35"));
	}

	#[test]
	fn json_only_strips_ansi_when_short() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("jq", &cfg);
		let out = filter(&ctx, "\u{1b}[32m{\"ok\":true}\u{1b}[0m\n", 0);
		assert_eq!(out.text, "{\"ok\":true}\n");
	}

	fn numbered_lines(count: usize) -> String {
		let mut out = String::new();
		for idx in 1..=count {
			out.push_str("line ");
			if idx < 10 {
				out.push_str("00");
			} else if idx < 100 {
				out.push('0');
			}
			out.push_str(&idx.to_string());
			out.push('\n');
		}
		out
	}
}

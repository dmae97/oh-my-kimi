//! GitHub CLI output filters.

use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"pr"
				| "issue"
				| "run" | "workflow"
				| "repo" | "api"
				| "search"
				| "release"
				| "codespace"
				| "gist"
		)
	)
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if preserves_raw_mode(ctx) {
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.subcommand {
		Some("pr" | "issue") => filter_pr_issue(&cleaned, exit_code),
		Some("run" | "workflow") => filter_run(&cleaned, exit_code),
		_ => head_tail_dedup(&cleaned),
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text)
	}
}

fn preserves_raw_mode(ctx: &MinimizerCtx<'_>) -> bool {
	match ctx.subcommand {
		Some("api") => true,
		Some("run") => {
			command_has_ordered_tokens(ctx.command, "run", "view")
				&& command_has_any_token(ctx.command, &["--log", "--log-failed", "--json"])
		},
		Some("pr") if command_has_ordered_tokens(ctx.command, "pr", "diff") => true,
		Some("pr") if command_has_ordered_tokens(ctx.command, "pr", "status") => {
			command_has_any_token(ctx.command, &["--web", "--jq", "--template"])
		},
		Some(subcommand @ ("pr" | "issue")) => {
			command_has_ordered_tokens(ctx.command, subcommand, "view")
				&& command_has_any_token(ctx.command, &["--json", "--jq", "--comments"])
		},
		_ => false,
	}
}

fn command_has_ordered_tokens(command: &str, first: &str, second: &str) -> bool {
	let mut saw_first = false;
	for part in command.split_whitespace() {
		if saw_first && part == second {
			return true;
		}
		if part == first {
			saw_first = true;
		}
	}
	false
}

fn command_has_any_token(command: &str, tokens: &[&str]) -> bool {
	command.split_whitespace().any(|part| {
		tokens.iter().any(|token| {
			part == *token
				|| part
					.strip_prefix(*token)
					.is_some_and(|suffix| suffix.starts_with('='))
		})
	})
}

fn filter_pr_issue(input: &str, exit_code: i32) -> String {
	if exit_code != 0 {
		return head_tail_dedup(input);
	}
	let markdown_filtered = filter_markdown_noise(input);
	head_tail_dedup(&markdown_filtered)
}

fn filter_run(input: &str, exit_code: i32) -> String {
	let deduped = primitives::dedup_consecutive_lines(input);
	if exit_code != 0 || contains_failure_signal(input) {
		return primitives::head_tail_lines(&deduped, 160, 120);
	}
	primitives::head_tail_lines(&deduped, 120, 80)
}

fn filter_markdown_noise(input: &str) -> String {
	let mut out = String::new();
	let mut in_html_comment = false;
	let mut previous_blank = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if in_html_comment {
			if trimmed.contains("-->") {
				in_html_comment = false;
			}
			continue;
		}
		if trimmed.starts_with("<!--") {
			if !trimmed.contains("-->") {
				in_html_comment = true;
			}
			continue;
		}
		if is_markdown_badge_or_image(trimmed) || is_horizontal_rule(trimmed) {
			continue;
		}
		if trimmed.is_empty() {
			if !previous_blank {
				out.push('\n');
			}
			previous_blank = true;
			continue;
		}
		previous_blank = false;
		out.push_str(line.trim_end());
		out.push('\n');
	}
	out
}

fn is_markdown_badge_or_image(line: &str) -> bool {
	line.starts_with("![") || line.starts_with("[![") || line.contains("img.shields.io")
}

fn is_horizontal_rule(line: &str) -> bool {
	line.len() >= 3 && line.chars().all(|ch| matches!(ch, '-' | '*' | '_' | ' '))
}

fn contains_failure_signal(input: &str) -> bool {
	input.lines().any(|line| {
		let lower = line.to_ascii_lowercase();
		lower.contains("error")
			|| lower.contains("failed")
			|| lower.contains("failure")
			|| lower.contains("cancelled")
	})
}

fn head_tail_dedup(input: &str) -> String {
	primitives::head_tail_lines(&primitives::dedup_consecutive_lines(input), 120, 80)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::shell::minimizer::MinimizerConfig;

	fn test_ctx<'a>(
		subcommand: Option<&'a str>,
		command: &'a str,
		config: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program: "gh", subcommand, command, config }
	}

	#[test]
	fn pr_issue_filter_removes_markdown_template_noise() {
		let input =
			"<!-- template -->\n# Title\n[![CI](https://img.shields.io/badge.svg)](url)\nBody\n---\n";
		let out = filter_pr_issue(input, 0);
		assert!(!out.contains("template"));
		assert!(!out.contains("shields.io"));
		assert!(out.contains("# Title"));
		assert!(out.contains("Body"));
	}

	#[test]
	fn run_filter_preserves_failure_tail_and_dedups() {
		let input = "step ok\nstep ok\nError: failed job\n";
		let out = filter_run(input, 1);
		assert!(out.contains("step ok (×2)"));
		assert!(out.contains("Error: failed job"));
	}

	#[test]
	fn api_json_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("api"), "gh api repos/owner/repo", &cfg);
		let input = "{\n  \"full_name\": \"owner/repo\",\n  \"private\": false\n}\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn pr_diff_preserves_diff() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("pr"), "gh pr diff 123", &cfg);
		let input = "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1 @@\n-old\n+new\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}
}

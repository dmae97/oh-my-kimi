//! Git output filters.

use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"status"
				| "diff" | "show"
				| "log" | "add"
				| "commit"
				| "push" | "pull"
				| "branch"
				| "fetch"
				| "stash"
				| "worktree"
				| "merge"
				| "rebase"
				| "checkout"
				| "switch"
				| "restore"
				| "clean"
				| "reset"
				| "tag",
		),
	)
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, _exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.subcommand {
		Some("status") => condense_status(&cleaned),
		Some("diff" | "show") => primitives::head_tail_lines(&cleaned, 80, 40),
		Some("log") => condense_log(&cleaned, 32, 16),
		Some("branch" | "stash" | "worktree" | "tag") => primitives::compact_listing(&cleaned, 40),
		Some(
			"push" | "pull" | "fetch" | "merge" | "rebase" | "checkout" | "switch" | "restore"
			| "clean" | "reset" | "add" | "commit",
		) => condense_noisy_output(&cleaned),
		_ => cleaned,
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text)
	}
}

fn condense_status(input: &str) -> String {
	if input
		.lines()
		.any(|line| line.starts_with("## ") || is_short_status(line))
	{
		return summarize_short_status(input);
	}
	let mut branch = None;
	let mut staged = 0usize;
	let mut unstaged = 0usize;
	let mut untracked = 0usize;
	let mut conflicts = 0usize;
	let mut current: Option<&str> = None;
	for line in input.lines() {
		let trimmed = line.trim();
		if let Some(name) = trimmed.strip_prefix("On branch ") {
			branch = Some(name);
			continue;
		}
		if trimmed.starts_with("Changes to be committed") {
			current = Some("staged");
			continue;
		}
		if trimmed.starts_with("Changes not staged") {
			current = Some("unstaged");
			continue;
		}
		if trimmed.starts_with("Untracked files") {
			current = Some("untracked");
			continue;
		}
		if trimmed.starts_with("Unmerged paths") {
			current = Some("conflicts");
			continue;
		}
		if trimmed.starts_with("modified:")
			|| trimmed.starts_with("new file:")
			|| trimmed.starts_with("deleted:")
			|| trimmed.starts_with("renamed:")
		{
			match current {
				Some("staged") => staged += 1,
				Some("unstaged") => unstaged += 1,
				Some("conflicts") => conflicts += 1,
				_ => {},
			}
		} else if current == Some("untracked") && !trimmed.is_empty() && !trimmed.starts_with('(') {
			untracked += 1;
		}
	}
	if staged + unstaged + untracked + conflicts == 0 {
		return input.to_string();
	}
	let mut out = String::from("git status summary");
	if let Some(branch) = branch {
		out.push_str(" on ");
		out.push_str(branch);
	}
	out.push('\n');
	push_count(&mut out, "staged", staged);
	push_count(&mut out, "unstaged", unstaged);
	push_count(&mut out, "untracked", untracked);
	push_count(&mut out, "conflicts", conflicts);
	out
}

fn summarize_short_status(input: &str) -> String {
	let mut branch = None;
	let mut staged = 0usize;
	let mut unstaged = 0usize;
	let mut untracked = 0usize;
	let mut conflicts = 0usize;
	for line in input.lines() {
		if let Some(value) = line.strip_prefix("## ") {
			branch = Some(value);
			continue;
		}
		if line.starts_with("??") {
			untracked += 1;
			continue;
		}
		let mut chars = line.chars();
		let x = chars.next();
		let y = chars.next();
		if matches!(x, Some('U' | 'A' | 'D')) && matches!(y, Some('U' | 'A' | 'D')) {
			conflicts += 1;
			continue;
		}
		if matches!(x, Some('M' | 'A' | 'D' | 'R' | 'C')) {
			staged += 1;
		}
		if matches!(y, Some('M' | 'D')) {
			unstaged += 1;
		}
	}
	let mut out = String::from("git status summary");
	if let Some(branch) = branch {
		out.push_str(" on ");
		out.push_str(branch);
	}
	out.push('\n');
	push_count(&mut out, "staged", staged);
	push_count(&mut out, "unstaged", unstaged);
	push_count(&mut out, "untracked", untracked);
	push_count(&mut out, "conflicts", conflicts);
	out
}

fn is_short_status(line: &str) -> bool {
	line.starts_with("??") || line.len() > 2 && line.as_bytes().get(2) == Some(&b' ')
}

fn push_count(out: &mut String, label: &str, count: usize) {
	if count == 0 {
		return;
	}
	out.push_str(label);
	out.push_str(": ");
	out.push_str(&count.to_string());
	out.push('\n');
}

fn condense_log(input: &str, head: usize, tail: usize) -> String {
	let mut out = String::new();
	for line in input.lines() {
		if let Some(commit) = line.strip_prefix("commit ") {
			out.push_str("commit ");
			if let Some(short) = commit.get(..12) {
				out.push_str(short);
			} else {
				out.push_str(commit);
			}
			out.push('\n');
		} else if !(line.trim_start().starts_with("Author:")
			|| line.trim_start().starts_with("Date:"))
		{
			out.push_str(line.trim_end());
			out.push('\n');
		}
	}
	primitives::head_tail_lines(&out, head, tail)
}

fn condense_noisy_output(input: &str) -> String {
	let deduped = primitives::dedup_consecutive_lines(input);
	primitives::head_tail_lines(&deduped, 80, 40)
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
		MinimizerCtx { program: "git", subcommand, command, config }
	}

	#[test]
	fn condenses_short_status() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status", &cfg);
		let out = filter(&ctx, "## main\n M a.rs\n?? b.rs\n", 0);
		assert!(out.text.contains("unstaged: 1"));
		assert!(out.text.contains("untracked: 1"));
	}

	#[test]
	fn supports_git_coverage_subcommands() {
		for subcommand in ["show", "branch", "fetch", "stash", "worktree"] {
			assert!(supports(Some(subcommand)), "{subcommand} should be buffered");
		}
	}

	#[test]
	fn branch_listing_is_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("branch"), "git branch -a", &cfg);
		let mut input = String::new();
		for idx in 0..60 {
			input.push_str("  feature/");
			input.push_str(&idx.to_string());
			input.push('\n');
		}
		let out = filter(&ctx, &input, 0);
		assert!(out.text.starts_with("60 entries\n"));
		assert!(out.text.contains("feature/0"));
		assert!(out.text.contains("feature/59"));
		assert!(out.text.contains("…"));
	}

	#[test]
	fn fetch_output_strips_ansi_and_dedups_progress() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("fetch"), "git fetch", &cfg);
		let out = filter(
			&ctx,
			"\x1b[32mremote: Counting objects: 1\x1b[0m\nremote: Counting objects: 1\nerror: failed\n",
			1,
		);
		assert_eq!(out.text, "remote: Counting objects: 1 (×2)\nerror: failed\n");
	}

	#[test]
	fn log_is_head_tail_truncated_after_metadata_removal() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("log"), "git log", &cfg);
		let mut input = String::new();
		for idx in 0..70 {
			input.push_str("commit abcdef1234567890");
			input.push_str(&idx.to_string());
			input.push('\n');
			input.push_str("Author: Somebody <s@example.com>\nDate: today\n");
			input.push_str("    message ");
			input.push_str(&idx.to_string());
			input.push('\n');
		}
		let out = filter(&ctx, &input, 0);
		assert!(out.text.contains("… "));
		assert!(out.text.contains("message 0"));
		assert!(out.text.contains("message 69"));
		assert!(!out.text.contains("Author:"));
		assert!(!out.text.contains("Date:"));
	}
}

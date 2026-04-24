//! Git output filters.

use std::collections::{BTreeMap, btree_map::Entry};

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
	if is_show_path_content(ctx.command) || is_stash_patch(ctx.command) {
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.subcommand {
		Some("status") => condense_status(&cleaned),
		Some("diff") => cleaned,
		Some("show") => primitives::head_tail_lines(&cleaned, 80, 40),
		Some("log") => condense_log(&cleaned, 32, 16),
		Some("branch" | "stash" | "tag") => primitives::compact_listing(&cleaned, 40),
		Some("worktree") => cleaned,
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

#[derive(Default)]
struct StatusTreeNode {
	children: BTreeMap<String, Self>,
	leaves:   Vec<StatusLeaf>,
}

struct StatusLeaf {
	status: String,
	name:   String,
}

struct StatusEntry {
	status: String,
	path:   String,
}

#[derive(Default)]
struct StatusCounts {
	staged:    usize,
	unstaged:  usize,
	untracked: usize,
	conflicts: usize,
}

fn condense_status(input: &str) -> String {
	let mut branch = None;
	let mut entries = Vec::new();
	let mut current_section: Option<&str> = None;

	for line in input.lines() {
		if let Some(value) = line.strip_prefix("## ") {
			branch = Some(value.trim());
			continue;
		}
		if let Some(entry) = parse_short_status_line(line) {
			entries.push(entry);
			continue;
		}

		let trimmed = line.trim();
		if let Some(name) = trimmed.strip_prefix("On branch ") {
			branch = Some(name.trim());
			continue;
		}
		if trimmed.starts_with("Changes to be committed") {
			current_section = Some("staged");
			continue;
		}
		if trimmed.starts_with("Changes not staged") {
			current_section = Some("unstaged");
			continue;
		}
		if trimmed.starts_with("Untracked files") {
			current_section = Some("untracked");
			continue;
		}
		if trimmed.starts_with("Unmerged paths") {
			current_section = Some("conflicts");
			continue;
		}
		if let Some(entry) = parse_long_status_line(trimmed, current_section) {
			entries.push(entry);
		}
	}

	if entries.is_empty() {
		return input.to_string();
	}

	let mut counts = StatusCounts::default();
	let mut tree = StatusTreeNode::default();
	for entry in &entries {
		count_status(&entry.status, &mut counts);
		insert_status_path(&mut tree, &entry.status, &entry.path);
	}

	let mut out = String::from("git status summary");
	if let Some(branch) = branch {
		out.push_str(" on ");
		out.push_str(branch);
	}
	out.push('\n');
	push_count(&mut out, "staged", counts.staged);
	push_count(&mut out, "unstaged", counts.unstaged);
	push_count(&mut out, "untracked", counts.untracked);
	push_count(&mut out, "conflicts", counts.conflicts);
	out.push_str("paths:\n");
	render_status_tree(&tree, &mut out, 0);
	out
}

fn parse_short_status_line(line: &str) -> Option<StatusEntry> {
	let status = line.get(..2)?;
	let path = line.get(3..)?.trim();
	let mut chars = status.chars();
	let x = chars.next()?;
	let y = chars.next()?;
	if line.chars().nth(2) != Some(' ')
		|| path.is_empty()
		|| !is_status_char(x)
		|| !is_status_char(y)
	{
		return None;
	}
	Some(StatusEntry { status: status.to_string(), path: path.to_string() })
}

fn parse_long_status_line(trimmed: &str, current_section: Option<&str>) -> Option<StatusEntry> {
	let (kind, path) = trimmed.split_once(':')?;
	let path = path.trim();
	if path.is_empty() {
		return None;
	}
	let status = match current_section {
		Some("staged") => match kind {
			"new file" => "A ",
			"deleted" => "D ",
			"renamed" => "R ",
			_ => "M ",
		},
		Some("unstaged") => match kind {
			"deleted" => " D",
			_ => " M",
		},
		Some("untracked") => "??",
		Some("conflicts") => "UU",
		_ => return None,
	};
	Some(StatusEntry { status: status.to_string(), path: path.to_string() })
}

const fn is_status_char(ch: char) -> bool {
	matches!(ch, ' ' | 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | '!')
}

fn count_status(status: &str, counts: &mut StatusCounts) {
	if status == "??" {
		counts.untracked += 1;
		return;
	}
	if status.contains('U') {
		counts.conflicts += 1;
		return;
	}
	let mut chars = status.chars();
	if matches!(chars.next(), Some('M' | 'A' | 'D' | 'R' | 'C')) {
		counts.staged += 1;
	}
	if matches!(chars.next(), Some('M' | 'D')) {
		counts.unstaged += 1;
	}
}

fn insert_status_path(root: &mut StatusTreeNode, status: &str, path: &str) {
	let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
	insert_status_parts(root, status, &parts);
}

fn insert_status_parts(node: &mut StatusTreeNode, status: &str, parts: &[&str]) {
	if parts.is_empty() {
		return;
	}
	if parts.len() == 1 {
		node
			.leaves
			.push(StatusLeaf { status: status.to_string(), name: parts[0].to_string() });
		return;
	}
	let child = match node.children.entry(parts[0].to_string()) {
		Entry::Occupied(entry) => entry.into_mut(),
		Entry::Vacant(entry) => entry.insert(StatusTreeNode::default()),
	};
	insert_status_parts(child, status, &parts[1..]);
}

fn render_status_tree(node: &StatusTreeNode, out: &mut String, depth: usize) {
	for (name, child) in &node.children {
		push_status_indent(out, depth);
		out.push_str(name);
		out.push_str("/\n");
		render_status_tree(child, out, depth + 1);
	}
	for leaf in &node.leaves {
		push_status_indent(out, depth);
		out.push('[');
		out.push_str(&leaf.status);
		out.push_str("] ");
		out.push_str(&leaf.name);
		out.push('\n');
	}
}

fn push_status_indent(out: &mut String, depth: usize) {
	for _ in 0..depth {
		out.push_str("  ");
	}
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

fn is_show_path_content(command: &str) -> bool {
	let mut saw_show = false;
	for part in command.split_whitespace() {
		if saw_show && !part.starts_with('-') && part.contains(':') {
			return true;
		}
		if part == "show" {
			saw_show = true;
		}
	}
	false
}

fn is_stash_patch(command: &str) -> bool {
	has_ordered_tokens(command, "stash", "show")
		&& (has_token(command, "-p") || has_token(command, "--patch"))
}

fn has_ordered_tokens(command: &str, first: &str, second: &str) -> bool {
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

fn has_token(command: &str, token: &str) -> bool {
	command.split_whitespace().any(|part| part == token)
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
	fn status_compacts_paths_into_tree() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status --short", &cfg);
		let input = "## main\n M packages/agent/lib/agent.ts\n M \
		             packages/agent/tests/session-restore.test.ts\n?? \
		             crates/pi-natives/src/shell/minimizer/filters/git.rs\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.contains("git status summary on main"));
		assert!(out.text.contains("unstaged: 2"));
		assert!(out.text.contains("untracked: 1"));
		assert!(out.text.contains("packages/\n  agent/\n"));
		assert!(out.text.contains("    lib/\n      [ M] agent.ts\n"));
		assert!(
			out.text
				.contains("    tests/\n      [ M] session-restore.test.ts\n")
		);
		assert!(out.text.contains("crates/\n  pi-natives/\n"));
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
	fn show_path_content_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("show"), "git show HEAD:path/to/file.json", &cfg);
		let input = "{\n  \"items\": [1, 2, 3]\n}\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn stash_show_patch_preserves_diff() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash show -p", &cfg);
		let input = "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1 @@\n-old\n+new\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
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

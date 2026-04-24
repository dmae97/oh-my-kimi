//! Graphite (`gt`) output filters.

use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

const GT_SUBCOMMANDS: &[&str] = &["log", "submit", "sync", "restack", "create", "branch"];

pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	program == "gt" && subcommand.is_some_and(|subcommand| GT_SUBCOMMANDS.contains(&subcommand))
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.subcommand {
		Some("log") => compact_log(&cleaned),
		Some("branch") => primitives::compact_listing(&cleaned, 40),
		Some("submit" | "sync" | "restack" | "create") => compact_noisy_command(&cleaned, exit_code),
		_ => cleaned,
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text)
	}
}

fn compact_log(input: &str) -> String {
	let mut out = String::new();
	let mut entries = 0usize;
	let mut omitted_entries = 0usize;
	let max_entries = 24usize;

	for line in input.lines() {
		if is_graph_node(line) {
			entries += 1;
			if entries > max_entries {
				omitted_entries += 1;
				continue;
			}
		} else if entries > max_entries {
			continue;
		}

		let trimmed = remove_email_fragments(line.trim_end());
		if !trimmed.trim().is_empty() || !out.ends_with("\n\n") {
			out.push_str(&trim_line(&trimmed, 140));
			out.push('\n');
		}
	}

	if omitted_entries > 0 {
		out.push_str("… ");
		out.push_str(&omitted_entries.to_string());
		out.push_str(" entries omitted …\n");
	}

	primitives::head_tail_lines(&out, 80, 24)
}

fn compact_noisy_command(input: &str, exit_code: i32) -> String {
	let deduped = primitives::dedup_consecutive_lines(input);
	let mut kept = String::new();

	for line in deduped.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_progress_noise(trimmed) {
			continue;
		}
		if exit_code == 0 && is_low_value_status(trimmed) {
			continue;
		}
		kept.push_str(trimmed);
		kept.push('\n');
	}

	let candidate = if kept.trim().is_empty() {
		deduped
	} else {
		kept
	};

	primitives::head_tail_lines(&candidate, 80, 40)
}

fn is_graph_node(line: &str) -> bool {
	let stripped = line
		.trim_start_matches('│')
		.trim_start_matches('|')
		.trim_start();
	matches!(stripped.chars().next(), Some('◉' | '○' | '◯' | '◆' | '●' | '@' | '*'))
}

fn remove_email_fragments(line: &str) -> String {
	let mut words = Vec::new();
	for word in line.split_whitespace() {
		let stripped = word.trim_matches(|ch: char| matches!(ch, '<' | '>' | '(' | ')' | ','));
		if stripped.contains('@') && stripped.contains('.') {
			continue;
		}
		words.push(word);
	}
	words.join(" ")
}

fn trim_line(line: &str, max_chars: usize) -> String {
	let mut out = String::new();
	for (idx, ch) in line.chars().enumerate() {
		if idx >= max_chars {
			out.push('…');
			return out;
		}
		out.push(ch);
	}
	out
}

fn is_progress_noise(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.starts_with("enumerating objects:")
		|| lower.starts_with("counting objects:")
		|| lower.starts_with("compressing objects:")
		|| lower.starts_with("writing objects:")
		|| lower.starts_with("remote: counting objects:")
		|| lower.starts_with("remote: compressing objects:")
		|| lower.starts_with("remote: total")
		|| lower.starts_with("resolving deltas:")
		|| lower.starts_with("delta compression")
		|| lower.starts_with("total ")
}

fn is_low_value_status(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.starts_with("pushing to remote")
		|| lower.starts_with("syncing with remote")
		|| lower.starts_with("creating new branch")
		|| lower.starts_with("restacking branches")
		|| lower.starts_with("checking out from ")
		|| lower.starts_with("tracking branch set up")
		|| lower.starts_with("creating pull request for ")
		|| lower.starts_with("updating pull request for ")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::shell::minimizer::MinimizerConfig;

	fn test_ctx<'a>(subcommand: Option<&'a str>, config: &'a MinimizerConfig) -> MinimizerCtx<'a> {
		MinimizerCtx { program: "gt", subcommand, command: "gt", config }
	}

	#[test]
	fn supports_only_known_gt_subcommands() {
		assert!(supports("gt", Some("log")));
		assert!(supports("gt", Some("submit")));
		assert!(!supports("gt", Some("status")));
		assert!(!supports("git", Some("log")));
	}

	#[test]
	fn log_listing_is_compacted_and_sanitized() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("log"), &cfg);
		let mut input = String::new();
		for idx in 0..30 {
			input.push_str("◉  abc123");
			input.push_str(&idx.to_string());
			input.push_str(" feat/branch ");
			input.push_str(&idx.to_string());
			input.push_str("d ago user@example.com\n│  commit message\n│\n");
		}

		let out = filter(&ctx, &input, 0);

		assert!(out.changed);
		assert!(out.text.contains("abc1230"));
		assert!(out.text.contains("entries omitted"));
		assert!(!out.text.contains("user@example.com"));
	}

	#[test]
	fn branch_listing_is_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("branch"), &cfg);
		let mut input = String::new();
		for idx in 0..60 {
			input.push_str("  feat/");
			input.push_str(&idx.to_string());
			input.push('\n');
		}

		let out = filter(&ctx, &input, 0);

		assert!(out.text.starts_with("60 entries\n"));
		assert!(out.text.contains("feat/0"));
		assert!(out.text.contains("feat/59"));
		assert!(out.text.contains("…"));
	}

	#[test]
	fn submit_noise_is_stripped_and_summaries_remain() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("submit"), &cfg);
		let input = "\x1b[32mCounting objects: 100% (2/2), done.\x1b[0m\rCounting objects: 100% (2/2), done.\nPushed branch feat/a to origin\nCreated pull request #42 for feat/a: https://example.test/pr/42\nAll branches submitted successfully!\n";

		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert!(!out.text.contains("Counting objects"));
		assert!(out.text.contains("Pushed branch feat/a to origin"));
		assert!(out.text.contains("Created pull request #42"));
		assert!(out.text.contains("All branches submitted successfully!"));
		assert!(!out.text.contains('\x1b'));
	}

	#[test]
	fn sync_noise_is_stripped_and_errors_remain() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("sync"), &cfg);
		let input = "remote: Counting objects: 1\nremote: Counting objects: 1\nSynced branch feat/a \
		             with remote\nerror: failed to rebase feat/b\n";

		let out = filter(&ctx, input, 1);

		assert!(!out.text.contains("Counting objects"));
		assert!(out.text.contains("Synced branch feat/a with remote"));
		assert!(out.text.contains("error: failed to rebase feat/b"));
	}
}

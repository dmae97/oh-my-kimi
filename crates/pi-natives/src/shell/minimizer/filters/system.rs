//! Conservative text filters for system-style commands.

use std::collections::HashMap;

use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn supports(program: &str) -> bool {
	matches!(
		program,
		"env"
			| "log"
			| "deps"
			| "summary"
			| "err"
			| "test"
			| "diff"
			| "format"
			| "pipe"
			| "ps" | "ping"
			| "ssh"
			| "sops"
	)
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let command = ctx.program;
	let text = match command {
		"env" => compact_env(&cleaned),
		"log" => compact_log(&cleaned),
		"deps" => compact_dependency_output(&cleaned),
		"summary" => compact_summary_output(&cleaned, exit_code),
		"err" => compact_error_output(&cleaned),
		"test" => compact_test_output(&cleaned),
		"diff" => compact_diff_output(&cleaned),
		"format" => compact_format_output(&cleaned),
		"pipe" => compact_pipe_like_output(&cleaned, exit_code),
		"ps" => compact_ps_output(&cleaned),
		"ping" => compact_ping_output(&cleaned),
		"ssh" => compact_ssh_output(&cleaned),
		"sops" => compact_sops_output(&cleaned),
		_ => cleaned,
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text)
	}
}

fn compact_env(input: &str) -> String {
	let mut out = String::new();
	let mut transformed = false;
	let mut lines = 0usize;

	for line in input.lines() {
		lines += 1;
		let rendered_line = if let Some((prefix, key, value)) = split_env_assignment(line) {
			let rendered = render_env_value(key, value);
			if rendered != value {
				transformed = true;
			}
			let mut line = String::new();
			line.push_str(prefix);
			line.push_str(key);
			line.push('=');
			line.push_str(&rendered);
			line
		} else {
			line.to_string()
		};
		out.push_str(&rendered_line);
		out.push('\n');
	}

	if lines > 80 {
		let compacted = primitives::head_tail_lines(&out, 40, 25);
		let mut with_header = format!("env output: {lines} lines\n");
		with_header.push_str(&compacted);
		return with_header;
	}

	if transformed { out } else { input.to_string() }
}

fn split_env_assignment(line: &str) -> Option<(&str, &str, &str)> {
	let trimmed = line.trim_start();
	let prefix = &line[..line.len().saturating_sub(trimmed.len())];
	let rest = trimmed
		.strip_prefix("export ")
		.map_or(trimmed, |value| value);
	let export_prefix = if rest.len() == trimmed.len() {
		""
	} else {
		"export "
	};
	let (key, value) = rest.split_once('=')?;
	if key.is_empty()
		|| !key
			.chars()
			.all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
	{
		return None;
	}
	Some((
		if export_prefix.is_empty() {
			prefix
		} else {
			"export "
		},
		key,
		value,
	))
}

fn render_env_value(key: &str, value: &str) -> String {
	if is_sensitive_key(key) {
		return mask_env_value(value);
	}
	let char_count = value.chars().count();
	if char_count > 160 {
		let preview: String = value.chars().take(80).collect();
		format!("{preview}… ({char_count} chars)")
	} else {
		value.to_string()
	}
}

fn is_sensitive_key(key: &str) -> bool {
	let lower = key.to_ascii_lowercase();
	[
		"token",
		"secret",
		"password",
		"passwd",
		"credential",
		"apikey",
		"api_key",
		"access_key",
		"private_key",
		"jwt",
		"auth",
	]
	.iter()
	.any(|needle| lower.contains(needle))
}

fn mask_env_value(value: &str) -> String {
	let chars: Vec<char> = value.chars().collect();
	if chars.len() <= 4 {
		"[redacted]".to_string()
	} else {
		let prefix: String = chars.iter().take(2).collect();
		let suffix_start = chars.len().saturating_sub(2);
		let suffix: String = chars.iter().skip(suffix_start).collect();
		format!("{prefix}[redacted]{suffix}")
	}
}

fn compact_log(input: &str) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.is_empty() {
		return input.to_string();
	}

	let mut unique: Vec<LogLine> = Vec::new();
	let mut by_normalized: HashMap<String, usize> = HashMap::new();
	let mut errors = 0usize;
	let mut warnings = 0usize;
	let mut info = 0usize;

	for line in &lines {
		let lower = line.to_ascii_lowercase();
		if lower.contains("error") || lower.contains("fatal") || lower.contains("panic") {
			errors += 1;
		} else if lower.contains("warn") {
			warnings += 1;
		} else if lower.contains("info") {
			info += 1;
		}

		let normalized = normalize_log_line(line);
		if let Some(index) = by_normalized.get(&normalized).copied() {
			if let Some(entry) = unique.get_mut(index) {
				entry.count += 1;
			}
		} else {
			by_normalized.insert(normalized, unique.len());
			unique.push(LogLine { original: (*line).to_string(), count: 1 });
		}
	}

	if unique.len() == lines.len() && lines.len() <= 80 {
		return primitives::dedup_consecutive_lines(input);
	}

	let mut out = format!(
		"log summary: {} lines, {} unique, {} errors, {} warnings, {} info\n",
		lines.len(),
		unique.len(),
		errors,
		warnings,
		info
	);
	let rendered = render_counted_lines(&unique, 60, 20);
	out.push_str(&rendered);
	out
}

struct LogLine {
	original: String,
	count:    usize,
}

fn normalize_log_line(line: &str) -> String {
	let without_timestamp = strip_leading_timestamp(line.trim());
	let mut out = String::new();
	let mut digits = String::new();
	for ch in without_timestamp.chars() {
		if ch.is_ascii_digit() {
			digits.push(ch);
			continue;
		}
		flush_digits(&mut out, &mut digits);
		out.push(ch);
	}
	flush_digits(&mut out, &mut digits);
	out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_leading_timestamp(line: &str) -> &str {
	let bytes = line.as_bytes();
	if bytes.len() >= 19
		&& bytes.get(4) == Some(&b'-')
		&& bytes.get(7) == Some(&b'-')
		&& matches!(bytes.get(10).copied(), Some(b'T' | b' '))
	{
		if let Some(rest) = line.get(19..) {
			return rest.trim_start();
		}
		return "";
	}
	line
}

fn flush_digits(out: &mut String, digits: &mut String) {
	if digits.is_empty() {
		return;
	}
	if digits.len() >= 4 {
		out.push_str("<n>");
	} else {
		out.push_str(digits);
	}
	digits.clear();
}

fn render_counted_lines(lines: &[LogLine], head: usize, tail: usize) -> String {
	let mut out = String::new();
	if lines.len() <= head + tail {
		for line in lines {
			push_counted_line(&mut out, &line.original, line.count);
		}
		return out;
	}
	for line in lines.iter().take(head) {
		push_counted_line(&mut out, &line.original, line.count);
	}
	out.push_str("… ");
	out.push_str(&(lines.len() - head - tail).to_string());
	out.push_str(" unique lines omitted …\n");
	for line in lines.iter().skip(lines.len() - tail) {
		push_counted_line(&mut out, &line.original, line.count);
	}
	out
}

fn push_counted_line(out: &mut String, line: &str, count: usize) {
	out.push_str(line);
	if count > 1 {
		out.push_str(" (×");
		out.push_str(&count.to_string());
		out.push(')');
	}
	out.push('\n');
}

fn compact_dependency_output(input: &str) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= 80 {
		return input.to_string();
	}
	let mut out = String::from("dependency output summary\n");
	for line in lines
		.iter()
		.copied()
		.filter(|line| is_dependency_heading(line))
	{
		out.push_str(line);
		out.push('\n');
	}
	out.push_str(&primitives::head_tail_lines(input, 35, 25));
	out
}

fn is_dependency_heading(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("dependencies")
		|| lower.contains("packages")
		|| lower.ends_with("package.json:")
		|| lower.ends_with("cargo.toml:")
		|| lower.ends_with("go.mod:")
		|| lower.ends_with("requirements.txt:")
}

fn compact_summary_output(input: &str, exit_code: i32) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= 100 {
		return input.to_string();
	}
	let mut out = format!("summary output: {} lines, exit {exit_code}\n", lines.len());
	push_important_lines(&mut out, input, 30);
	out.push_str(&primitives::head_tail_lines(input, 35, 25));
	out
}

fn compact_error_output(input: &str) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= 80 {
		return primitives::dedup_consecutive_lines(input);
	}
	let mut out = format!("error output: {} lines\n", lines.len());
	push_important_lines(&mut out, input, 80);
	out.push_str(&primitives::head_tail_lines(input, 30, 30));
	out
}

fn compact_test_output(input: &str) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= 120 {
		return primitives::dedup_consecutive_lines(input);
	}
	let mut out = format!("test output: {} lines\n", lines.len());
	push_important_lines(&mut out, input, 80);
	out.push_str(&primitives::head_tail_lines(input, 35, 35));
	out
}

fn push_important_lines(out: &mut String, input: &str, max: usize) {
	let mut pushed = 0usize;
	for line in input.lines() {
		if pushed >= max {
			break;
		}
		if is_important_line(line) && !out.lines().any(|existing| existing == line) {
			out.push_str(line);
			out.push('\n');
			pushed += 1;
		}
	}
}

fn is_important_line(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("error")
		|| lower.contains("failed")
		|| lower.contains("failure")
		|| lower.contains("fatal")
		|| lower.contains("panic")
		|| lower.contains("warning")
		|| lower.contains("warn")
		|| lower.contains("passed")
		|| lower.contains("summary")
}

fn compact_diff_output(input: &str) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= 120 {
		return input.to_string();
	}

	let mut out = format!("diff output: {} lines\n", lines.len());
	let mut hunk_body: Vec<&str> = Vec::new();
	let mut saw_hunk = false;
	for line in &lines {
		if is_diff_file_header(line) {
			flush_hunk_body(&mut out, &hunk_body);
			hunk_body.clear();
			out.push_str(line);
			out.push('\n');
		} else if line.starts_with("@@") {
			flush_hunk_body(&mut out, &hunk_body);
			hunk_body.clear();
			saw_hunk = true;
			out.push_str(line);
			out.push('\n');
		} else if saw_hunk {
			hunk_body.push(line);
		}
	}
	flush_hunk_body(&mut out, &hunk_body);

	if saw_hunk {
		out
	} else {
		primitives::head_tail_lines(input, 80, 40)
	}
}

fn is_diff_file_header(line: &str) -> bool {
	line.starts_with("diff --git ")
		|| line.starts_with("--- ")
		|| line.starts_with("+++ ")
		|| line.starts_with("Index: ")
}

fn flush_hunk_body(out: &mut String, lines: &[&str]) {
	if lines.is_empty() {
		return;
	}
	let changed: Vec<&str> = lines
		.iter()
		.copied()
		.filter(|line| line.starts_with('+') || line.starts_with('-'))
		.collect();
	let source = if changed.is_empty() { lines } else { &changed };
	if source.len() <= 36 {
		for line in source {
			out.push_str(line);
			out.push('\n');
		}
		return;
	}
	for line in source.iter().take(24) {
		out.push_str(line);
		out.push('\n');
	}
	out.push_str("… ");
	out.push_str(&(source.len() - 36).to_string());
	out.push_str(" changed lines omitted in hunk …\n");
	for line in source.iter().skip(source.len() - 12) {
		out.push_str(line);
		out.push('\n');
	}
}

fn compact_format_output(input: &str) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= 80 {
		return input.to_string();
	}

	let mut errors = Vec::new();
	let mut files = Vec::new();
	let mut summary = Vec::new();
	for line in &lines {
		let lower = line.to_ascii_lowercase();
		if lower.contains("error") || lower.contains("failed") || lower.contains("oh no") {
			errors.push(*line);
		} else if is_format_file_line(line) {
			files.push(*line);
		} else if lower.contains("formatted")
			|| lower.contains("reformatted")
			|| lower.contains("unchanged")
			|| lower.contains("checked")
		{
			summary.push(*line);
		}
	}

	let mut out = format!("format output: {} lines\n", lines.len());
	if !errors.is_empty() {
		out.push_str("errors:\n");
		for line in errors.iter().take(40) {
			out.push_str(line);
			out.push('\n');
		}
	}
	if !summary.is_empty() {
		out.push_str("summary:\n");
		for line in summary.iter().take(20) {
			out.push_str(line);
			out.push('\n');
		}
	}
	if !files.is_empty() {
		out.push_str("files:\n");
		for line in files.iter().take(50) {
			out.push_str(line);
			out.push('\n');
		}
		if files.len() > 50 {
			out.push_str("… ");
			out.push_str(&(files.len() - 50).to_string());
			out.push_str(" more files\n");
		}
	}
	if errors.is_empty() && summary.is_empty() && files.is_empty() {
		out.push_str(&primitives::head_tail_lines(input, 40, 30));
	}
	out
}

fn is_format_file_line(line: &str) -> bool {
	let trimmed = line.trim();
	let lower = trimmed.to_ascii_lowercase();
	let source_extensions = ["rs", "py", "js", "jsx", "ts", "tsx", "json", "css", "md"];
	let has_source_extension = std::path::Path::new(trimmed)
		.extension()
		.and_then(|ext| ext.to_str())
		.is_some_and(|ext| {
			source_extensions
				.iter()
				.any(|candidate| ext.eq_ignore_ascii_case(candidate))
		});
	has_source_extension || lower.contains("would reformat") || lower.contains("reformatted")
}

fn compact_pipe_like_output(input: &str, exit_code: i32) -> String {
	if looks_like_diff(input) {
		return compact_diff_output(input);
	}
	if looks_like_file_diagnostics(input) {
		return primitives::group_by_file(input, 12);
	}
	if looks_like_path_listing(input) {
		return primitives::compact_listing(input, 80);
	}
	if exit_code != 0 || input.lines().any(is_important_line) {
		return compact_error_output(input);
	}
	let deduped = primitives::dedup_consecutive_lines(input);
	if deduped.lines().count() > 120 {
		primitives::head_tail_lines(&deduped, 60, 40)
	} else {
		deduped
	}
}

fn looks_like_diff(input: &str) -> bool {
	input
		.lines()
		.take(20)
		.any(|line| line.starts_with("@@") || line.starts_with("diff --git "))
}

fn looks_like_file_diagnostics(input: &str) -> bool {
	input.lines().take(10).any(|line| {
		let mut parts = line.splitn(3, ':');
		let file = parts.next();
		let line_no = parts.next();
		file.is_some_and(|value| !value.is_empty())
			&& line_no.is_some_and(|value| value.parse::<usize>().is_ok())
			&& parts.next().is_some()
	})
}

fn looks_like_path_listing(input: &str) -> bool {
	let non_empty: Vec<&str> = input
		.lines()
		.filter(|line| !line.trim().is_empty())
		.take(20)
		.collect();
	!non_empty.is_empty()
		&& non_empty.iter().all(|line| {
			let trimmed = line.trim();
			!trimmed.contains(':')
				&& (trimmed.starts_with('.') || trimmed.starts_with('/') || trimmed.contains('/'))
		})
}

fn compact_ps_output(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		out.push_str(&truncate_chars(line, 120));
		out.push('\n');
	}
	if out.lines().count() > 30 {
		primitives::head_tail_lines(&out, 15, 15)
	} else {
		out
	}
}

fn truncate_chars(line: &str, max: usize) -> String {
	if line.chars().count() <= max {
		return line.to_string();
	}
	let mut out: String = line.chars().take(max.saturating_sub(1)).collect();
	out.push('…');
	out
}

fn compact_ping_output(input: &str) -> String {
	let mut kept = String::new();
	for line in input.lines() {
		if is_ping_noise(line) {
			continue;
		}
		if line.trim().is_empty() && kept.is_empty() {
			continue;
		}
		kept.push_str(line);
		kept.push('\n');
	}
	if kept.is_empty() {
		input.to_string()
	} else {
		kept
	}
}

fn is_ping_noise(line: &str) -> bool {
	let trimmed = line.trim();
	trimmed.starts_with("PING ")
		|| trimmed.starts_with("Pinging ")
		|| (trimmed.contains(" bytes from ") && trimmed.contains("icmp_seq"))
		|| trimmed.starts_with("Reply from ")
}

fn compact_ssh_output(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		if is_ssh_noise(line) {
			continue;
		}
		out.push_str(&truncate_chars(line, 120));
		out.push('\n');
	}
	if out.lines().count() > 200 {
		primitives::head_tail_lines(&out, 100, 80)
	} else if out.is_empty() {
		input.to_string()
	} else {
		out
	}
}

fn is_ssh_noise(line: &str) -> bool {
	let trimmed = line.trim();
	trimmed.is_empty()
		|| trimmed.starts_with("Warning: Permanently added")
		|| trimmed.starts_with("Connection to ") && trimmed.ends_with(" closed.")
		|| trimmed.starts_with("Authenticated to ")
		|| trimmed.starts_with("debug1:")
		|| trimmed.starts_with("OpenSSH_")
		|| trimmed.starts_with("Pseudo-terminal")
}

fn compact_sops_output(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		if !line.trim().is_empty() {
			out.push_str(line);
			out.push('\n');
		}
	}
	if out.lines().count() > 40 {
		primitives::head_tail_lines(&out, 20, 20)
	} else if out.is_empty() && !input.is_empty() {
		input.to_string()
	} else {
		out
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::shell::minimizer::MinimizerConfig;

	fn ctx<'a>(program: &'a str, cfg: &'a MinimizerConfig) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand: None, command: program, config: cfg }
	}

	#[test]
	fn log_dedups_repeated_normalized_lines() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("log", &cfg);
		let input = "2026-01-01 10:00:00 ERROR worker 12345 failed\n2026-01-01 10:00:01 ERROR \
		             worker 67890 failed\nINFO ready\n";
		let out = filter(&ctx, input, 1);
		assert!(out.text.contains("3 lines, 2 unique"));
		assert!(out.text.contains("(×2)"));
	}

	#[test]
	fn env_masks_secrets_and_compacts_long_values() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("env", &cfg);
		let input = format!("API_TOKEN=supersecrettoken\nPATH={}\n", "a".repeat(170));
		let out = filter(&ctx, &input, 0);
		assert!(out.text.contains("API_TOKEN=su[redacted]en"));
		assert!(out.text.contains("(170 chars)"));
		assert!(!out.text.contains("supersecrettoken"));
	}

	#[test]
	fn diff_compaction_preserves_hunk_headers() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("diff", &cfg);
		let mut input =
			String::from("diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1,140 +1,140 @@\n");
		for idx in 0..140 {
			input.push_str("-old ");
			input.push_str(&idx.to_string());
			input.push_str("\n+new ");
			input.push_str(&idx.to_string());
			input.push('\n');
		}
		let out = filter(&ctx, &input, 0);
		assert!(out.text.contains("@@ -1,140 +1,140 @@"));
		assert!(out.text.contains("changed lines omitted in hunk"));
		assert!(out.text.contains("+new 139"));
	}

	#[test]
	fn format_compaction_preserves_errors_and_files() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("format", &cfg);
		let mut input = String::from("error: failed to parse src/bad.py\n");
		for idx in 0..100 {
			input.push_str("would reformat src/file_");
			input.push_str(&idx.to_string());
			input.push_str(".py\n");
		}
		let out = filter(&ctx, &input, 1);
		assert!(out.text.contains("errors:"));
		assert!(out.text.contains("failed to parse src/bad.py"));
		assert!(out.text.contains("files:"));
		assert!(out.text.contains("more files"));
	}
}

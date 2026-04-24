//! Cloud and data command output filters.

use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

const MAX_PSQL_ROWS: usize = 30;
const MAX_LINE_CHARS: usize = 500;

pub fn supports(program: &str, _subcommand: Option<&str>) -> bool {
	matches!(program, "aws" | "curl" | "wget" | "psql")
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.program {
		"aws" => filter_aws(&cleaned, exit_code),
		"curl" | "wget" => filter_http_transfer(&cleaned, exit_code),
		"psql" => filter_psql(&cleaned, exit_code),
		_ => head_tail_dedup(&cleaned, 80, 40),
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn filter_aws(input: &str, _exit_code: i32) -> String {
	let without_progress = strip_transfer_progress(input);
	if looks_like_table(&without_progress) {
		compact_delimited_table(&without_progress, 40)
	} else {
		without_progress
	}
}

fn filter_http_transfer(input: &str, _exit_code: i32) -> String {
	strip_transfer_progress(input)
}

fn filter_psql(input: &str, exit_code: i32) -> String {
	if input.trim().is_empty() {
		return String::new();
	}

	let compacted = if looks_like_psql_table(input) {
		compact_psql_table(input)
	} else if looks_like_psql_expanded(input) {
		compact_psql_expanded(input)
	} else {
		compact_jsonish_or_text(input, 120, 80, 40)
	};

	if exit_code == 0 {
		preserve_important_lines(input, &compacted)
	} else {
		preserve_important_lines(input, &head_tail_dedup(&compacted, 80, 40))
	}
}

fn strip_transfer_progress(input: &str) -> String {
	let mut out = String::new();
	for segment in input.split_inclusive('\n') {
		let line = if let Some(line) = segment.strip_suffix('\n') {
			line
		} else {
			segment
		};
		let line = if let Some(line) = line.strip_suffix('\r') {
			line
		} else {
			line
		};
		if is_transfer_progress_line(line) {
			continue;
		}
		out.push_str(segment);
	}
	out
}

fn is_transfer_progress_line(line: &str) -> bool {
	let trimmed = line.trim();
	if trimmed.is_empty() {
		return false;
	}
	if trimmed.starts_with("% Total") || trimmed.contains(" Dload ") && trimmed.contains(" Upload ")
	{
		return true;
	}
	if trimmed.starts_with("--") && trimmed.contains("://") {
		return true;
	}
	if trimmed.starts_with("Resolving ")
		|| trimmed.starts_with("Connecting to ")
		|| trimmed.starts_with("HTTP request sent")
		|| trimmed.starts_with("Length: ")
		|| trimmed.starts_with("Saving to:")
		|| trimmed.starts_with("Downloaded:")
	{
		return true;
	}
	if trimmed.contains("--:--:--") || trimmed.contains("100%[") {
		return true;
	}
	if trimmed.contains('%') && trimmed.contains('[') && trimmed.contains(']') {
		return true;
	}
	if trimmed.contains('%') && (trimmed.contains("K/s") || trimmed.contains("M/s")) {
		return true;
	}
	looks_like_wget_transfer_progress(trimmed)
}

fn looks_like_wget_transfer_progress(line: &str) -> bool {
	let mut parts = line.split_whitespace();
	let Some(offset) = parts.next() else {
		return false;
	};
	let has_offset = offset
		.strip_suffix('K')
		.or_else(|| offset.strip_suffix('M'))
		.is_some_and(|value| !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit()));
	if !has_offset {
		return false;
	}
	let mut saw_meter = false;
	let mut saw_percent = false;
	for part in parts {
		if part.chars().all(|ch| ch == '.') {
			saw_meter = true;
		}
		if part.ends_with('%') {
			let number = part.trim_end_matches('%');
			saw_percent = !number.is_empty() && number.chars().all(|ch| ch.is_ascii_digit());
		}
	}
	saw_meter && saw_percent
}

fn compact_jsonish_or_text(input: &str, max_lines: usize, head: usize, tail: usize) -> String {
	let line_compacted = compact_long_lines(input);
	if line_compacted.lines().count() <= max_lines {
		line_compacted
	} else {
		primitives::head_tail_lines(&line_compacted, head, tail)
	}
}

fn compact_long_lines(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let compacted = compact_line(line, MAX_LINE_CHARS);
		out.push_str(&compacted);
		out.push('\n');
	}
	out
}

fn compact_line(line: &str, max_chars: usize) -> String {
	let chars: Vec<char> = line.chars().collect();
	if chars.len() <= max_chars {
		return line.to_string();
	}
	let edge = max_chars / 2;
	let start: String = chars.iter().take(edge).collect();
	let end: String = chars.iter().skip(chars.len() - edge).collect();
	format!("{start} … {} chars omitted … {end}", chars.len() - edge * 2)
}

fn looks_like_table(input: &str) -> bool {
	input.lines().any(|line| {
		let trimmed = line.trim();
		trimmed.starts_with('+') && trimmed.ends_with('+') && trimmed.contains('-')
	}) || input
		.lines()
		.any(|line| line.contains("---+---") || line.contains("-+-"))
}

fn looks_like_psql_table(input: &str) -> bool {
	input
		.lines()
		.any(|line| line.contains("---+---") || line.contains("-+-"))
		|| input.lines().any(|line| {
			let trimmed = line.trim();
			trimmed.starts_with('+') && trimmed.ends_with('+') && trimmed.contains('-')
		})
}

fn looks_like_psql_expanded(input: &str) -> bool {
	input
		.lines()
		.any(|line| is_psql_expanded_header(line.trim()))
}

fn is_psql_expanded_header(line: &str) -> bool {
	if !line.starts_with("-[ RECORD ") {
		return false;
	}
	let Some((_, suffix)) = line.split_once(" ]") else {
		return false;
	};
	!suffix.is_empty() && suffix.chars().all(|ch| ch == '-')
}

fn compact_delimited_table(input: &str, max_rows: usize) -> String {
	let mut out = Vec::new();
	let mut data_rows = 0usize;
	let mut saw_header = false;
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_border_line(trimmed) {
			continue;
		}
		let normalized = if trimmed.contains('|') {
			normalize_pipe_row(trimmed)
		} else {
			trimmed.to_string()
		};
		if !saw_header {
			saw_header = true;
			out.push(normalized);
			continue;
		}
		data_rows += 1;
		if data_rows <= max_rows || is_important_line(trimmed) {
			out.push(normalized);
		}
	}
	if data_rows > max_rows {
		out.push(format!("… {} more rows", data_rows - max_rows));
	}
	join_lines(out)
}

fn compact_psql_table(input: &str) -> String {
	let mut out = Vec::new();
	let mut row_count_lines = Vec::new();
	let mut data_rows = 0usize;
	let mut saw_header = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_border_line(trimmed) {
			continue;
		}
		if is_psql_row_count(trimmed) {
			row_count_lines.push(trimmed.to_string());
			continue;
		}
		if is_important_line(trimmed) {
			out.push(trimmed.to_string());
			continue;
		}
		if trimmed.contains('|') {
			let normalized = normalize_pipe_row(trimmed);
			if !saw_header {
				saw_header = true;
				out.push(normalized);
				continue;
			}
			data_rows += 1;
			if data_rows <= MAX_PSQL_ROWS {
				out.push(normalized);
			}
		} else {
			out.push(trimmed.to_string());
		}
	}

	if data_rows > MAX_PSQL_ROWS {
		out.push(format!("... +{} more rows", data_rows - MAX_PSQL_ROWS));
	}
	out.extend(row_count_lines);
	join_lines(out)
}

fn compact_psql_expanded(input: &str) -> String {
	let mut out = Vec::new();
	let mut current = Vec::new();
	let mut row_count_lines = Vec::new();
	let mut records = 0usize;
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		if is_psql_row_count(trimmed) {
			row_count_lines.push(trimmed.to_string());
			continue;
		}
		if is_psql_expanded_header(trimmed) {
			flush_record(&mut out, &mut current, records);
			records += 1;
			current.push(trimmed.to_string());
			continue;
		}
		if is_important_line(trimmed) && current.is_empty() {
			out.push(trimmed.to_string());
			continue;
		}
		if let Some((key, value)) = trimmed.split_once('|') {
			current.push(format!("{}={}", key.trim(), value.trim()));
		} else if current.is_empty() {
			out.push(trimmed.to_string());
		}
	}
	flush_record(&mut out, &mut current, records);
	if records > MAX_PSQL_ROWS {
		out.push(format!("... +{} more records", records - MAX_PSQL_ROWS));
	}
	out.extend(row_count_lines);
	join_lines(out)
}

fn flush_record(out: &mut Vec<String>, current: &mut Vec<String>, records: usize) {
	if current.is_empty() {
		return;
	}
	if records <= MAX_PSQL_ROWS {
		out.push(current.join(" "));
	}
	current.clear();
}

fn normalize_pipe_row(line: &str) -> String {
	line
		.trim_matches('|')
		.split('|')
		.map(str::trim)
		.collect::<Vec<&str>>()
		.join("\t")
}

fn is_border_line(line: &str) -> bool {
	let trimmed = line.trim();
	!trimmed.is_empty()
		&& trimmed
			.chars()
			.all(|ch| matches!(ch, '+' | '-' | '=' | '|' | ' '))
		&& (trimmed.contains('-') || trimmed.contains('='))
}

fn is_psql_row_count(line: &str) -> bool {
	let trimmed = line.trim();
	trimmed.starts_with('(')
		&& trimmed.ends_with(')')
		&& trimmed.contains(" row")
		&& trimmed.chars().any(|ch| ch.is_ascii_digit())
}

fn preserve_important_lines(original: &str, compacted: &str) -> String {
	let mut out = Vec::new();
	for line in original.lines() {
		let trimmed = line.trim();
		if is_important_line(trimmed)
			&& !contains_line(&out, trimmed)
			&& !compacted.lines().any(|existing| existing.trim() == trimmed)
		{
			out.push(trimmed.to_string());
		}
	}
	if out.is_empty() {
		return compacted.to_string();
	}
	out.push(compacted.trim_end().to_string());
	join_lines(out)
}

fn is_important_line(line: &str) -> bool {
	let upper = line.trim_start().to_ascii_uppercase();
	upper.starts_with("ERROR")
		|| upper.starts_with("FATAL")
		|| upper.starts_with("PANIC")
		|| upper.starts_with("DETAIL")
		|| upper.starts_with("HINT")
		|| upper.starts_with("LINE ")
		|| upper.starts_with("SQLSTATE")
		|| upper.starts_with("AN ERROR OCCURRED")
		|| upper.contains("EXCEPTION")
}

fn contains_line(lines: &[String], needle: &str) -> bool {
	lines.iter().any(|line| line == needle)
}

fn head_tail_dedup(input: &str, head: usize, tail: usize) -> String {
	primitives::head_tail_lines(&primitives::dedup_consecutive_lines(input), head, tail)
}

fn join_lines(lines: Vec<String>) -> String {
	if lines.is_empty() {
		String::new()
	} else {
		let mut out = lines.join("\n");
		out.push('\n');
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
	fn strips_curl_progress_and_preserves_long_multiline_body() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("curl", &cfg);
		let long_line = format!("{{\"payload\":\"{}\"}}", "x".repeat(620));
		let mut body = String::new();
		for idx in 0..130 {
			body.push_str("{\"idx\":");
			body.push_str(&idx.to_string());
			body.push_str(",\"ok\":true}\n");
		}
		body.push_str(&long_line);
		body.push('\n');
		let input = format!(
			"  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n100  \
			 1234  100  1234    0     0  9999      0 --:--:-- --:--:-- --:--:-- 9999\n{body}"
		);
		let out = filter(&ctx, &input, 0);
		assert!(!out.text.contains("% Total"));
		assert!(!out.text.contains("--:--:--"));
		assert_eq!(out.text, body);
	}

	#[test]
	fn strips_wget_progress_and_preserves_body_percent_line() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("wget", &cfg);
		let input = "--2026-04-24--  https://example.test/data.json\nResolving example.test... \
		             127.0.0.1\n     0K .......... .......... 50% 1.2M 0s\n    20K .......... \
		             .......... 100% 2.0M=0.1s\n100% real body\n[{\"id\":1}]\n";
		let expected = "100% real body\n[{\"id\":1}]\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, expected);
	}

	#[test]
	fn preserves_psql_table_row_count_and_errors() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("psql", &cfg);
		let input = " id | name\n----+------\n 1  | alice\n 2  | bob\nERROR: duplicate key value \
		             violates unique constraint\n(2 rows)\n";
		let out = filter(&ctx, input, 1);
		assert!(out.text.contains("id\tname"));
		assert!(out.text.contains("1\talice"));
		assert!(
			out.text
				.contains("ERROR: duplicate key value violates unique constraint")
		);
		assert!(out.text.contains("(2 rows)"));
	}

	#[test]
	fn compacts_psql_expanded_dashed_records_and_preserves_footer() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("psql", &cfg);
		let input = "-[ RECORD 1 ]-----\nid | 1\nname | alice\n-[ RECORD 2 ]-----\nid | 2\nname | \
		             bob\n(2 rows)\n";
		let out = filter(&ctx, input, 0);
		assert!(out.text.contains("-[ RECORD 1 ]----- id=1 name=alice"));
		assert!(out.text.contains("-[ RECORD 2 ]----- id=2 name=bob"));
		assert!(out.text.contains("(2 rows)"));
	}

	#[test]
	fn preserves_long_aws_json_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("aws", &cfg);
		let mut input = String::new();
		for idx in 0..160 {
			input.push_str("{\"InstanceId\":\"i-");
			let id = idx.to_string();
			for _ in id.len()..4 {
				input.push('0');
			}
			input.push_str(&id);
			input.push_str("\"}\n");
		}
		let out = filter(&ctx, &input, 0);
		assert_eq!(out.text, input);
	}
}

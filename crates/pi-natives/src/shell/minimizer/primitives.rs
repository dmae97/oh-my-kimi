//! Reusable text transforms shared by minimizer filters.

use std::collections::BTreeMap;

/// Remove ANSI CSI escape sequences and carriage-return progress frames.
pub fn strip_ansi(input: &str) -> String {
	let mut out = String::with_capacity(input.len());
	let mut chars = input.chars().peekable();
	while let Some(ch) = chars.next() {
		if ch == '\x1b' && chars.peek().is_some_and(|next| *next == '[') {
			let _ = chars.next();
			for c in chars.by_ref() {
				if ('@'..='~').contains(&c) {
					break;
				}
			}
			continue;
		}
		if ch == '\r' {
			out.push('\n');
			continue;
		}
		out.push(ch);
	}
	out
}

/// Collapse consecutive identical lines as `line (×N)`.
pub fn dedup_consecutive_lines(input: &str) -> String {
	let mut out = String::new();
	let mut previous: Option<&str> = None;
	let mut count = 0usize;
	for line in input.lines() {
		if previous == Some(line) {
			count += 1;
			continue;
		}
		flush_repeated(&mut out, previous, count);
		previous = Some(line);
		count = 1;
	}
	flush_repeated(&mut out, previous, count);
	out
}

fn flush_repeated(out: &mut String, line: Option<&str>, count: usize) {
	let Some(line) = line else {
		return;
	};
	out.push_str(line);
	if count > 1 {
		out.push_str(" (×");
		out.push_str(&count.to_string());
		out.push(')');
	}
	out.push('\n');
}

/// Keep the first `head` and last `tail` lines with an omission marker.
pub fn head_tail_lines(input: &str, head: usize, tail: usize) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= head + tail {
		return input.to_string();
	}
	let omitted = lines.len() - head - tail;
	let mut out = String::new();
	for line in lines.iter().take(head) {
		out.push_str(line);
		out.push('\n');
	}
	out.push_str("… ");
	out.push_str(&omitted.to_string());
	out.push_str(" lines omitted …\n");
	for line in lines.iter().skip(lines.len() - tail) {
		out.push_str(line);
		out.push('\n');
	}
	out
}

/// Drop lines matching any of the supplied predicates.
pub fn strip_lines(input: &str, predicates: &[fn(&str) -> bool]) -> String {
	let mut out = String::new();
	for line in input.lines() {
		if predicates.iter().any(|predicate| predicate(line)) {
			continue;
		}
		out.push_str(line);
		out.push('\n');
	}
	out
}

/// Group `file:line:message` style diagnostics by file.
pub fn group_by_file(input: &str, max_per_file: usize) -> String {
	let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
	let mut ungrouped = Vec::new();
	for line in input.lines() {
		if let Some((file, rest)) = split_file_line(line) {
			grouped
				.entry(file.to_string())
				.or_default()
				.push(rest.to_string());
		} else {
			ungrouped.push(line.to_string());
		}
	}
	if grouped.is_empty() {
		return input.to_string();
	}
	let mut out = String::new();
	for (file, entries) in grouped {
		out.push_str(&file);
		out.push_str(":\n");
		for entry in entries.iter().take(max_per_file) {
			out.push_str("  ");
			out.push_str(entry);
			out.push('\n');
		}
		if entries.len() > max_per_file {
			out.push_str("  … ");
			out.push_str(&(entries.len() - max_per_file).to_string());
			out.push_str(" more\n");
		}
	}
	for line in ungrouped {
		out.push_str(&line);
		out.push('\n');
	}
	out
}

fn split_file_line(line: &str) -> Option<(&str, &str)> {
	let (file, rest) = line.split_once(':')?;
	if file.is_empty()
		|| file.starts_with(' ')
		|| !rest.chars().next().is_some_and(|c| c.is_ascii_digit())
	{
		return None;
	}
	Some((file, rest))
}

/// Compact a long plain listing to head/tail form.
pub fn compact_listing(input: &str, max_lines: usize) -> String {
	let lines: Vec<&str> = input
		.lines()
		.filter(|line| !line.trim().is_empty())
		.collect();
	if lines.len() <= max_lines {
		return input.to_string();
	}
	let mut out = String::new();
	out.push_str(&lines.len().to_string());
	out.push_str(" entries\n");
	for line in lines.iter().take(max_lines / 2) {
		out.push_str(line);
		out.push('\n');
	}
	out.push_str("…\n");
	for line in lines.iter().skip(lines.len() - max_lines / 2) {
		out.push_str(line);
		out.push('\n');
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn strips_ansi_sequences() {
		assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
	}

	#[test]
	fn dedups_consecutive_lines() {
		assert_eq!(dedup_consecutive_lines("a\na\nb\n"), "a (×2)\nb\n");
	}

	#[test]
	fn head_tail_marks_omitted_lines() {
		let out = head_tail_lines("1\n2\n3\n4\n5\n", 2, 1);
		assert_eq!(out, "1\n2\n… 2 lines omitted …\n5\n");
	}

	#[test]
	fn groups_file_diagnostics() {
		let out = group_by_file("src/a.ts:1:2 error one\nsrc/a.ts:2:3 error two\n", 10);
		assert_eq!(out, "src/a.ts:\n  1:2 error one\n  2:3 error two\n");
	}
}

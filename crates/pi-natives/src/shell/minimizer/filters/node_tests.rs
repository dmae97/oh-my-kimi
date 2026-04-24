//! Jest, Vitest, and Playwright output filters.

use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn filter(_ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = if exit_code == 0 {
		drop_passed_lines(&cleaned)
	} else {
		failures_only(&cleaned)
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text)
	}
}

fn drop_passed_lines(input: &str) -> String {
	let mut out = String::new();
	let mut summary = String::new();

	for line in input.lines() {
		let trimmed = line.trim_start();
		if is_summary_line(trimmed) {
			push_line(&mut summary, line);
			push_line(&mut out, line);
			continue;
		}
		if is_pass_noise(trimmed) {
			continue;
		}
		push_line(&mut out, line);
	}

	if has_content(&out) {
		out
	} else if has_content(&summary) {
		summary
	} else {
		primitives::head_tail_lines(input, 0, 20)
	}
}

fn failures_only(input: &str) -> String {
	let mut out = String::new();
	let mut keeping_block = false;
	let mut trailing_context = 0usize;

	for line in input.lines() {
		let trimmed = line.trim_start();

		if is_summary_line(trimmed) {
			keeping_block = false;
			trailing_context = 0;
			push_line(&mut out, line);
			continue;
		}

		if starts_failure_block(trimmed) {
			keeping_block = true;
			trailing_context = 10;
			push_line(&mut out, line);
			continue;
		}

		if keeping_block {
			if is_pass_noise(trimmed) && !is_error_context_line(trimmed) {
				keeping_block = false;
				trailing_context = 0;
				continue;
			}
			push_line(&mut out, line);
			if trimmed.is_empty() {
				continue;
			}
			if is_error_context_line(trimmed) {
				trailing_context = 10;
			} else if trailing_context > 0 {
				trailing_context -= 1;
			} else {
				keeping_block = false;
			}
		}
	}

	if has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

fn push_line(out: &mut String, line: &str) {
	out.push_str(line);
	out.push('\n');
}

fn has_content(text: &str) -> bool {
	text.lines().any(|line| !line.trim().is_empty())
}

fn is_summary_line(trimmed: &str) -> bool {
	trimmed.starts_with("Test Suites:")
		|| trimmed.starts_with("Tests:")
		|| trimmed.starts_with("Snapshots:")
		|| trimmed.starts_with("Time:")
		|| trimmed.starts_with("Ran all test suites")
		|| trimmed.starts_with("Test Files")
		|| trimmed.starts_with("Duration")
		|| trimmed.starts_with("Start at")
		|| trimmed.starts_with("% ")
		|| trimmed.starts_with("Failed Tests")
		|| trimmed.starts_with("Playwright Test Report")
		|| starts_count_summary(trimmed)
}

fn starts_count_summary(trimmed: &str) -> bool {
	let mut parts = trimmed.split_whitespace();
	let Some(count) = parts.next() else {
		return false;
	};
	if !count.chars().all(|ch| ch.is_ascii_digit()) {
		return false;
	}
	matches!(parts.next(), Some("failed" | "passed" | "skipped" | "flaky"))
}

fn is_pass_noise(trimmed: &str) -> bool {
	trimmed.starts_with("PASS ")
		|| trimmed.starts_with("✓")
		|| trimmed.starts_with("✔")
		|| trimmed.starts_with("√")
		|| trimmed.starts_with("○")
		|| trimmed.starts_with(" RUN ")
		|| trimmed.starts_with("DEV ")
}

fn starts_failure_block(trimmed: &str) -> bool {
	trimmed.starts_with("FAIL ")
		|| trimmed.starts_with("FAILURES")
		|| trimmed.starts_with("Failed Tests")
		|| trimmed.starts_with("● ")
		|| trimmed.starts_with("✕")
		|| trimmed.starts_with("×")
		|| trimmed.starts_with("✗")
		|| trimmed.starts_with("❯")
		|| trimmed.starts_with("Error:")
		|| trimmed.starts_with("AssertionError")
		|| trimmed.starts_with("TimeoutError")
		|| is_playwright_numbered_failure(trimmed)
}

fn is_error_context_line(trimmed: &str) -> bool {
	trimmed.is_empty()
		|| trimmed.starts_with("at ")
		|| trimmed.starts_with("→")
		|| trimmed.starts_with('>')
		|| trimmed.starts_with('|')
		|| trimmed.starts_with("Expected")
		|| trimmed.starts_with("Received")
		|| trimmed.starts_with("Error:")
		|| trimmed.starts_with("AssertionError")
		|| trimmed.starts_with("TimeoutError")
		|| trimmed.contains(" › ")
		|| trimmed.contains(".spec.")
		|| trimmed.contains(".test.")
}

fn is_playwright_numbered_failure(trimmed: &str) -> bool {
	let mut chars = trimmed.chars();
	let mut saw_digit = false;
	while let Some(ch) = chars.next() {
		if ch.is_ascii_digit() {
			saw_digit = true;
			continue;
		}
		return saw_digit && ch == ')' && chars.next().is_some_and(|next| next.is_whitespace());
	}
	false
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn drops_passed_lines() {
		assert_eq!(drop_passed_lines("PASS a.test.ts\n✓ ok\nTests 1 passed\n"), "Tests 1 passed\n");
	}

	#[test]
	fn keeps_jest_failure_context_and_summary() {
		let input = "PASS src/ok.test.ts\nFAIL src/bad.test.ts\n  suite\n    ✕ breaks (5 ms)\n\n  ● \
		             suite › breaks\n\n    Expected: 1\n    Received: 2\n\nTest Suites: 1 failed, 1 \
		             passed, 2 total\nTests:       1 failed, 1 passed, 2 total\n";
		let filtered = failures_only(input);

		assert!(!filtered.contains("PASS src/ok.test.ts"));
		assert!(filtered.contains("FAIL src/bad.test.ts"));
		assert!(filtered.contains("● suite › breaks"));
		assert!(filtered.contains("Expected: 1"));
		assert!(filtered.contains("Test Suites: 1 failed"));
	}

	#[test]
	fn keeps_vitest_failure_and_drops_success_checks() {
		let input = "✓ src/passing.test.ts (1)\n× src/failing.test.ts > thing > fails\n  → expected \
		             true to be false\n ❯ src/failing.test.ts:4:10\n\nTest Files  1 failed | 1 \
		             passed (2)\nTests  1 failed | 1 passed (2)\n";
		let filtered = failures_only(input);

		assert!(!filtered.contains("src/passing.test.ts"));
		assert!(filtered.contains("× src/failing.test.ts"));
		assert!(filtered.contains("expected true to be false"));
		assert!(filtered.contains("Test Files  1 failed"));
	}

	#[test]
	fn keeps_playwright_numbered_failure_and_summary() {
		let input = "  ✓ 1 [chromium] › tests/ok.spec.ts:3:1 › ok (120ms)\n  1) [chromium] › \
		             tests/login.spec.ts:7:1 › login\n\n    Error: expect(locator).toBeVisible() \
		             failed\n      at tests/login.spec.ts:9:11\n\n  1 failed\n    [chromium] › \
		             tests/login.spec.ts:7:1 › login\n  1 passed (2.3s)\n";
		let filtered = failures_only(input);

		assert!(!filtered.contains("tests/ok.spec.ts"));
		assert!(filtered.contains("1) [chromium]"));
		assert!(filtered.contains("toBeVisible"));
		assert!(filtered.contains("1 failed"));
	}

	#[test]
	fn success_keeps_summary_when_everything_else_is_pass_noise() {
		let filtered = drop_passed_lines("✓ one passed\n✓ two passed\n3 passed (1.2s)\n");
		assert_eq!(filtered, "3 passed (1.2s)\n");
	}
}

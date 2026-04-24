//! Cargo build/test output filters.

use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"build"
				| "check"
				| "test" | "clippy"
				| "nextest"
				| "fmt" | "doc"
				| "bench"
				| "run" | "metadata"
				| "tree" | "update"
				| "install"
				| "publish"
		)
	)
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.subcommand {
		Some("test" | "bench") => failures_only(&cleaned, exit_code),
		Some("nextest") => filter_nextest(&cleaned),
		Some("build" | "check" | "clippy" | "doc" | "run") => condense_build(&cleaned),
		Some("fmt") => condense_fmt(&cleaned),
		Some("metadata" | "tree" | "update" | "install" | "publish") => compact_general(&cleaned),
		_ => cleaned,
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text)
	}
}

fn condense_build(input: &str) -> String {
	let stripped = primitives::strip_lines(input, &[is_compiling_noise]);
	let grouped = primitives::group_by_file(&stripped, 20);
	let deduped = primitives::dedup_consecutive_lines(&grouped);
	primitives::head_tail_lines(&deduped, 120, 60)
}

fn is_compiling_noise(line: &str) -> bool {
	let trimmed = line.trim_start();
	trimmed.starts_with("Compiling ")
		|| trimmed.starts_with("Checking ")
		|| trimmed.starts_with("Fresh ")
		|| trimmed.starts_with("Finished ")
		|| trimmed.starts_with("Documenting ")
		|| trimmed.starts_with("Running ")
		|| trimmed.starts_with("Downloading ")
		|| trimmed.starts_with("Downloaded ")
		|| trimmed.starts_with("Locking ")
		|| trimmed.starts_with("Updating ")
}

fn failures_only(input: &str, exit_code: i32) -> String {
	if exit_code == 0 {
		return strip_passing_tests(input);
	}
	let mut out = String::new();
	let mut keep = false;
	for line in input.lines() {
		let trimmed = line.trim_start();
		if trimmed.starts_with("failures:")
			|| trimmed.starts_with("---- ")
			|| trimmed.starts_with("error:")
			|| trimmed.starts_with("error[")
			|| trimmed.starts_with("thread '")
			|| trimmed.starts_with("test result: FAILED")
			|| trimmed.starts_with("test result: FAILED.")
		{
			keep = true;
		}
		if keep || trimmed.starts_with("running ") {
			out.push_str(line);
			out.push('\n');
		}
	}
	if out.is_empty() {
		condense_build(input)
	} else {
		out
	}
}

fn strip_passing_tests(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim_start();
		if is_passing_test_line(trimmed) {
			continue;
		}
		out.push_str(line);
		out.push('\n');
	}
	out
}

fn is_passing_test_line(trimmed: &str) -> bool {
	trimmed.starts_with("test ") && (trimmed.ends_with(" ... ok") || trimmed.ends_with("... ok"))
}

fn filter_nextest(input: &str) -> String {
	let mut out = String::new();
	let mut in_failure = false;
	let mut summary = None;
	let mut canceled = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if is_compiling_noise(trimmed)
			|| trimmed.starts_with("PASS ")
			|| trimmed.starts_with("────")
			|| trimmed.starts_with("Starting ")
		{
			continue;
		}
		if trimmed.starts_with("Summary [") {
			summary = Some(trimmed.to_string());
			in_failure = false;
			continue;
		}
		if trimmed.starts_with("Cancelling") {
			canceled = true;
			continue;
		}
		if trimmed.starts_with("FAIL ") {
			in_failure = true;
			out.push_str(trimmed);
			out.push('\n');
			continue;
		}
		if in_failure && !trimmed.starts_with("error: test run failed") {
			out.push_str(line);
			out.push('\n');
		}
	}

	if canceled {
		out.push_str("Cancelling due to test failure\n");
	}
	if let Some(line) = summary {
		out.push_str(&line);
		out.push('\n');
	}
	if out.is_empty() {
		compact_general(input)
	} else {
		out
	}
}

fn condense_fmt(input: &str) -> String {
	let deduped = primitives::dedup_consecutive_lines(input);
	let grouped = primitives::group_by_file(&deduped, 20);
	primitives::head_tail_lines(&grouped, 80, 40)
}

fn compact_general(input: &str) -> String {
	let stripped = primitives::strip_lines(input, &[is_general_cargo_noise]);
	let deduped = primitives::dedup_consecutive_lines(&stripped);
	primitives::head_tail_lines(&deduped, 80, 40)
}

fn is_general_cargo_noise(line: &str) -> bool {
	let trimmed = line.trim_start();
	trimmed.starts_with("Downloaded ")
		|| trimmed.starts_with("Downloading ")
		|| trimmed.starts_with("Compiling ")
		|| trimmed.starts_with("Checking ")
		|| trimmed.starts_with("Fresh ")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::shell::minimizer::MinimizerConfig;

	#[test]
	fn strips_compiling_noise() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "cargo",
			subcommand: Some("build"),
			command:    "cargo build",
			config:     &cfg,
		};
		let out = filter(&ctx, "   Compiling foo v0.1.0\nerror: nope\nsrc/lib.rs:1:1 bad\n", 1);
		assert!(!out.text.contains("Compiling"));
		assert!(out.text.contains("error: nope"));
	}

	#[test]
	fn drops_passing_test_lines_on_success() {
		let out =
			strip_passing_tests("running 2 tests\ntest a ... ok\ntest b ... ok\ntest result: ok\n");
		assert_eq!(out, "running 2 tests\ntest result: ok\n");
	}

	#[test]
	fn supports_nextest_and_keeps_failures_with_summary() {
		assert!(supports(Some("nextest")));
		let out = filter_nextest(
			"Starting 3 tests across 1 binary\nPASS crate::ok\nFAIL crate::bad\nstdout text\nSummary \
			 [0.2s] 2 tests run: 1 passed, 1 failed\nerror: test run failed\n",
		);
		assert!(!out.contains("PASS crate::ok"));
		assert!(out.contains("FAIL crate::bad"));
		assert!(out.contains("stdout text"));
		assert!(out.contains("Summary [0.2s] 2 tests run: 1 passed, 1 failed"));
	}

	#[test]
	fn install_uses_general_head_tail_dedup_strategy() {
		assert!(supports(Some("install")));
		let mut input = "Downloading crate\n".repeat(2);
		input.push_str("Installed package `tool v1.0.0`\n");
		for i in 0..130 {
			input.push_str("line ");
			input.push_str(&i.to_string());
			input.push('\n');
		}
		let out = compact_general(&input);
		assert!(!out.contains("Downloading crate"));
		assert!(out.contains("Installed package `tool v1.0.0`"));
		assert!(out.contains("lines omitted"));
	}
}

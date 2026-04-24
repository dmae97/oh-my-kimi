//! Python test, type-check, and lint output filters.

use super::lint;
use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	matches!(program, "pytest" | "ruff" | "mypy")
		|| matches!(
			(program, subcommand),
			("python" | "python3" | "py", Some("pytest" | "ruff" | "mypy"))
		)
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let tool = python_tool(ctx.program, ctx.subcommand);
	let cleaned = primitives::strip_ansi(input);
	let text = match tool {
		Some("pytest") => filter_pytest(&cleaned, exit_code),
		Some("ruff") if is_ruff_format(ctx) => filter_ruff_format(&cleaned),
		Some("ruff") => lint::condense_lint_output("ruff", &cleaned, exit_code),
		Some("mypy") => lint::condense_lint_output("mypy", &cleaned, exit_code),
		_ => cleaned,
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn python_tool<'a>(program: &'a str, subcommand: Option<&'a str>) -> Option<&'a str> {
	match program {
		"pytest" | "ruff" | "mypy" => Some(program),
		"python" | "python3" | "py" => match subcommand {
			Some("pytest" | "ruff" | "mypy") => subcommand,
			_ => None,
		},
		_ => None,
	}
}

fn filter_pytest(input: &str, exit_code: i32) -> String {
	if exit_code == 0 {
		return pytest_success(input);
	}

	let mut out = String::new();
	let mut in_failure = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if is_pytest_summary_header(trimmed) || is_pytest_summary_line(trimmed) {
			in_failure = false;
			push_line(&mut out, line);
			continue;
		}

		if starts_pytest_failure(trimmed) {
			in_failure = true;
			push_line(&mut out, line);
			continue;
		}

		if in_failure {
			if is_pytest_section_delimiter(trimmed) && !starts_pytest_failure(trimmed) {
				in_failure = false;
				continue;
			}
			if !is_pytest_pass_noise(trimmed) {
				push_line(&mut out, line);
			}
			continue;
		}

		if trimmed.starts_with("FAILED ") || trimmed.starts_with("ERROR ") {
			push_line(&mut out, line);
		}
	}

	if has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

fn pytest_success(input: &str) -> String {
	let mut out = String::new();
	let mut summary = String::new();

	for line in input.lines() {
		let trimmed = line.trim();
		if is_pytest_summary_line(trimmed) || is_pytest_summary_header(trimmed) {
			push_line(&mut summary, line);
			push_line(&mut out, line);
			continue;
		}
		if is_pytest_pass_noise(trimmed) {
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

fn starts_pytest_failure(trimmed: &str) -> bool {
	(trimmed.starts_with('_') && trimmed.ends_with('_') && trimmed.contains("test"))
		|| trimmed.starts_with("E   ")
		|| trimmed.starts_with("ERROR at ")
		|| trimmed.starts_with("FAILED ")
}

fn is_pytest_summary_header(trimmed: &str) -> bool {
	trimmed.contains("short test summary info") || trimmed.contains("warnings summary")
}

fn is_pytest_summary_line(trimmed: &str) -> bool {
	let has_status = trimmed.contains("passed")
		|| trimmed.contains("failed")
		|| trimmed.contains("error")
		|| trimmed.contains("skipped")
		|| trimmed.contains("warnings")
		|| trimmed.contains("no tests ran");

	if trimmed.starts_with('=') {
		return has_status;
	}

	has_status
		&& trimmed.contains(" in ")
		&& trimmed
			.split(',')
			.all(|part| looks_like_pytest_summary_part(part.trim()))
}

fn looks_like_pytest_summary_part(part: &str) -> bool {
	if part == "no tests ran" {
		return true;
	}

	if let Some((count, rest)) = part.split_once(' ') {
		return count.parse::<u64>().is_ok()
			&& (rest.starts_with("passed")
				|| rest.starts_with("failed")
				|| rest.starts_with("errors")
				|| rest.starts_with("error")
				|| rest.starts_with("skipped")
				|| rest.starts_with("warnings")
				|| rest.starts_with("warning")
				|| rest.starts_with("xfailed")
				|| rest.starts_with("xpassed"));
	}

	false
}

fn is_pytest_section_delimiter(trimmed: &str) -> bool {
	trimmed.len() >= 6
		&& trimmed
			.chars()
			.all(|ch| ch == '_' || ch == '=' || ch == '-')
}

fn is_pytest_pass_noise(trimmed: &str) -> bool {
	trimmed.is_empty()
		|| trimmed.contains("test session starts")
		|| trimmed.starts_with("collecting ")
		|| trimmed.starts_with("collected ")
		|| trimmed.starts_with("rootdir:")
		|| trimmed.starts_with("configfile:")
		|| trimmed.starts_with("plugins:")
		|| trimmed.starts_with("platform ")
		|| trimmed.starts_with("cachedir:")
		|| is_pytest_verbose_pass_line(trimmed)
		|| trimmed
			.chars()
			.all(|ch| matches!(ch, '.' | 's' | 'S' | 'x' | 'X' | 'f' | 'F' | 'E'))
}

fn is_pytest_verbose_pass_line(trimmed: &str) -> bool {
	if !trimmed.contains("::") {
		return false;
	}
	let mut parts = trimmed.split_whitespace();
	parts.any(|part| matches!(part, "PASSED" | "SKIPPED" | "XPASS" | "XFAIL"))
}

fn is_ruff_format(ctx: &MinimizerCtx<'_>) -> bool {
	ctx.subcommand == Some("format") || ctx.command.split_whitespace().any(|part| part == "format")
}

fn filter_ruff_format(input: &str) -> String {
	let mut out = String::new();

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		if is_ruff_format_line(trimmed) {
			push_line(&mut out, line);
		}
	}

	if has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

fn is_ruff_format_line(trimmed: &str) -> bool {
	trimmed.starts_with("Would reformat:")
		|| trimmed.starts_with("Would format:")
		|| trimmed.starts_with("Reformatted:")
		|| trimmed.contains(" file would be reformatted")
		|| trimmed.contains(" files would be reformatted")
		|| trimmed.contains(" file reformatted")
		|| trimmed.contains(" files reformatted")
		|| trimmed.contains(" file left unchanged")
		|| trimmed.contains(" files left unchanged")
		|| trimmed.contains(" file already formatted")
		|| trimmed.contains(" files already formatted")
}

fn push_line(out: &mut String, line: &str) {
	out.push_str(line);
	out.push('\n');
}

fn has_content(text: &str) -> bool {
	text.lines().any(|line| !line.trim().is_empty())
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::shell::minimizer::MinimizerConfig;

	#[test]
	fn supports_direct_and_python_module_tools() {
		assert!(supports("pytest", None));
		assert!(supports("python3", Some("mypy")));
		assert!(!supports("python3", Some("pip")));
	}

	#[test]
	fn pytest_failure_keeps_failure_and_summary() {
		let input = "============================= test session starts \
		             =============================\ncollected 2 items\ntests/test_math.py \
		             .F\n\n______________________________ test_adds_badly \
		             ______________________________\n\ndef test_adds_badly():\n>       assert 1 + 1 \
		             == 3\nE       assert (1 + 1) == 3\n\ntests/test_math.py:4: \
		             AssertionError\n=========================== short test summary info \
		             ===========================\nFAILED tests/test_math.py::test_adds_badly - \
		             assert (1 + 1) == 3\n========================= 1 failed, 1 passed in 0.02s \
		             =========================\n";

		let out = filter_pytest(input, 1);

		assert!(!out.contains("test session starts"));
		assert!(out.contains("test_adds_badly"));
		assert!(out.contains("AssertionError"));
		assert!(out.contains("1 failed, 1 passed"));
	}

	#[test]
	fn ruff_check_routes_to_lint_grouping() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = MinimizerCtx {
			program:    "ruff",
			subcommand: Some("check"),
			command:    "ruff check",
			config:     &cfg,
		};
		let out = filter(
			&context,
			"src/a.py:1:1: F401 unused import\nsrc/a.py:2:1: E501 line too long\n",
			1,
		);

		assert!(out.text.contains("2 diagnostics in 1 files"));
		assert!(out.text.contains("src/a.py (2 diagnostics)"));
	}

	#[test]
	fn pytest_quiet_summary_survives_without_framing() {
		let input = "................................................................\n5 failed, \
		             1698 passed, 2 skipped in 108.89s\n";
		let out = filter_pytest(input, 1);

		assert!(!out.contains("................................................................"));
		assert!(out.contains("5 failed, 1698 passed, 2 skipped in 108.89s"));
	}

	#[test]
	fn pytest_verbose_success_collapses_to_summary() {
		let input = "===== test session starts ======\nplatform darwin -- Python 3.14.3, \
		             pytest-9.0.2\ncachedir: .pytest_cache\nrootdir: /app\nplugins: \
		             anyio-4.12.1\ncollected 33 items\n\ntest_utils.py::TestStringUtils::test_strip \
		             PASSED    [  3%]\ntest_utils.py::TestListOps::test_flatten PASSED      \
		             [100%]\n\n====== 33 passed in 0.05s ======\n";
		let out = filter_pytest(input, 0);
		assert_eq!(out, "====== 33 passed in 0.05s ======\n");
	}

	#[test]
	fn ruff_format_preserves_changed_files_and_summaries() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = MinimizerCtx {
			program:    "ruff",
			subcommand: Some("format"),
			command:    "ruff format --check .",
			config:     &cfg,
		};
		let out = filter(
			&context,
			"Would reformat: src/a.py\nWould reformat: tests/test_a.py\n2 files would be \
			 reformatted, 5 files left unchanged\n",
			1,
		);

		assert!(out.text.contains("Would reformat: src/a.py"));
		assert!(out.text.contains("Would reformat: tests/test_a.py"));
		assert!(
			out.text
				.contains("2 files would be reformatted, 5 files left unchanged")
		);
		assert!(!out.text.contains("diagnostics"));
	}

	#[test]
	fn ruff_format_preserves_all_formatted_summary() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = MinimizerCtx {
			program:    "ruff",
			subcommand: Some("format"),
			command:    "ruff format .",
			config:     &cfg,
		};
		let out = filter(&context, "3 files left unchanged\n", 0);

		assert!(out.text.contains("3 files left unchanged"));
		assert!(!out.text.contains("diagnostics"));
	}
}

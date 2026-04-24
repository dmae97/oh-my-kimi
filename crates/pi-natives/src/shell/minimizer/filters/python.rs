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
		Some("ruff") => lint::condense_lint_output("ruff", &cleaned, exit_code),
		Some("mypy") => lint::condense_lint_output("mypy", &cleaned, exit_code),
		_ => cleaned,
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text)
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
	let mut saw_failure = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if is_pytest_summary_header(trimmed) || is_pytest_summary_line(trimmed) {
			in_failure = false;
			push_line(&mut out, line);
			continue;
		}

		if starts_pytest_failure(trimmed) {
			in_failure = true;
			saw_failure = true;
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
			saw_failure = true;
			push_line(&mut out, line);
		}
	}

	if saw_failure && has_content(&out) {
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
	trimmed.starts_with('=')
		&& (trimmed.contains("passed")
			|| trimmed.contains("failed")
			|| trimmed.contains("error")
			|| trimmed.contains("skipped")
			|| trimmed.contains("warnings")
			|| trimmed.contains("no tests ran"))
}

fn is_pytest_section_delimiter(trimmed: &str) -> bool {
	trimmed.len() >= 6
		&& trimmed
			.chars()
			.all(|ch| ch == '_' || ch == '=' || ch == '-')
}

fn is_pytest_pass_noise(trimmed: &str) -> bool {
	trimmed.is_empty()
		|| trimmed.starts_with("collecting ")
		|| trimmed.starts_with("collected ")
		|| trimmed.starts_with("rootdir:")
		|| trimmed.starts_with("configfile:")
		|| trimmed.starts_with("plugins:")
		|| trimmed.starts_with("platform ")
		|| trimmed.starts_with("cachedir:")
		|| trimmed
			.chars()
			.all(|ch| matches!(ch, '.' | 's' | 'S' | 'x' | 'X' | 'f' | 'F' | 'E'))
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
	fn ruff_routes_to_lint_grouping() {
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
}

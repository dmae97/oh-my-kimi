//! Ruby test and lint output filters.

use super::lint;
use crate::shell::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	matches!(program, "rspec" | "rubocop")
		|| matches!((program, subcommand), ("rake" | "rails", Some("test")))
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ruby_tool(ctx.program, ctx.subcommand) {
		Some("rspec") => filter_rspec(&cleaned, exit_code),
		Some("minitest") => filter_minitest(&cleaned, exit_code),
		Some("rubocop") => lint::condense_lint_output("rubocop", &cleaned, exit_code),
		_ => cleaned,
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text)
	}
}

fn ruby_tool<'a>(program: &'a str, subcommand: Option<&'a str>) -> Option<&'a str> {
	match (program, subcommand) {
		("rspec", _) => Some("rspec"),
		("rubocop", _) => Some("rubocop"),
		("rake" | "rails", Some("test")) => Some("minitest"),
		_ => None,
	}
}

fn filter_rspec(input: &str, exit_code: i32) -> String {
	if exit_code == 0 {
		return ruby_test_success(input);
	}

	let mut out = String::new();
	let mut in_failure = false;
	let mut in_failed_examples = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed == "Failures:" {
			in_failure = true;
			in_failed_examples = false;
			push_line(&mut out, line);
			continue;
		}
		if trimmed == "Failed examples:" {
			in_failure = false;
			in_failed_examples = true;
			push_line(&mut out, line);
			continue;
		}
		if is_rspec_summary_line(trimmed) {
			in_failure = false;
			in_failed_examples = false;
			push_line(&mut out, line);
			continue;
		}
		if in_failure {
			if is_gem_backtrace(trimmed) || is_rspec_noise(trimmed) {
				continue;
			}
			push_line(&mut out, line);
			continue;
		}
		if in_failed_examples && !trimmed.is_empty() {
			push_line(&mut out, line);
		}
	}

	if has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

fn filter_minitest(input: &str, exit_code: i32) -> String {
	if exit_code == 0 {
		return ruby_test_success(input);
	}

	let mut out = String::new();
	let mut in_failure = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if starts_minitest_failure(trimmed) {
			in_failure = true;
			push_line(&mut out, line);
			continue;
		}
		if is_minitest_summary_line(trimmed) {
			in_failure = false;
			push_line(&mut out, line);
			continue;
		}
		if in_failure {
			if trimmed.starts_with("Finished in ") {
				in_failure = false;
				continue;
			}
			if !trimmed.is_empty() {
				push_line(&mut out, line);
			}
		}
	}

	if has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

fn ruby_test_success(input: &str) -> String {
	let mut out = String::new();
	let mut summary = String::new();

	for line in input.lines() {
		let trimmed = line.trim();
		if is_rspec_summary_line(trimmed) || is_minitest_summary_line(trimmed) {
			push_line(&mut summary, line);
			push_line(&mut out, line);
			continue;
		}
		if is_ruby_pass_noise(trimmed) {
			continue;
		}
		push_line(&mut out, line);
	}

	if has_content(&out) { out } else { summary }
}

fn starts_minitest_failure(trimmed: &str) -> bool {
	let mut parts = trimmed.split_whitespace();
	let Some(number) = parts.next() else {
		return false;
	};
	let Some(kind) = parts.next() else {
		return false;
	};
	number.ends_with(')') && matches!(kind, "Failure:" | "Error:")
}

fn is_rspec_summary_line(trimmed: &str) -> bool {
	trimmed.contains(" examples, ") && (trimmed.contains(" failure") || trimmed.contains(" pending"))
}

fn is_minitest_summary_line(trimmed: &str) -> bool {
	trimmed.contains(" runs, ")
		&& trimmed.contains(" assertions, ")
		&& trimmed.contains(" failures, ")
		&& trimmed.contains(" errors")
}

fn is_ruby_pass_noise(trimmed: &str) -> bool {
	trimmed.is_empty()
		|| trimmed == "."
		|| trimmed
			.chars()
			.all(|ch| matches!(ch, '.' | 'S' | 'F' | 'E'))
		|| trimmed.starts_with("Run options:")
		|| trimmed.starts_with("Running:")
		|| trimmed.starts_with("Randomized with seed")
		|| trimmed.starts_with("Finished in ")
}

fn is_rspec_noise(trimmed: &str) -> bool {
	trimmed.starts_with("# ") && is_gem_backtrace(trimmed)
}

fn is_gem_backtrace(trimmed: &str) -> bool {
	trimmed.contains("/gems/")
		|| trimmed.contains("lib/rspec")
		|| trimmed.contains("lib/ruby/")
		|| trimmed.contains("vendor/bundle")
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
	fn supports_rspec_minitest_and_rubocop() {
		assert!(supports("rspec", None));
		assert!(supports("rake", Some("test")));
		assert!(supports("rails", Some("test")));
		assert!(supports("rubocop", None));
		assert!(!supports("rake", Some("db:migrate")));
	}

	#[test]
	fn rspec_failure_keeps_failure_context_and_summary() {
		let input = "..F\n\nFailures:\n\n  1) User validates name\n     Failure/Error: \
		             expect(user).to be_valid\n       expected valid? to return true, got false\n     \
		             # ./spec/models/user_spec.rb:12:in `block'\n     # \
		             ./vendor/bundle/ruby/3.3.0/gems/rspec-core/lib/rspec/core.rb:1\n\nFailed \
		             examples:\n\nrspec ./spec/models/user_spec.rb:12 # User validates name\n\n3 \
		             examples, 1 failure\n";
		let out = filter_rspec(input, 1);

		assert!(!out.contains("..F"));
		assert!(out.contains("User validates name"));
		assert!(out.contains("expected valid?"));
		assert!(out.contains("spec/models/user_spec.rb:12"));
		assert!(!out.contains("vendor/bundle"));
		assert!(out.contains("3 examples, 1 failure"));
	}

	#[test]
	fn minitest_failure_keeps_failure_and_summary() {
		let input = "Run options: --seed 1\n\n# Running:\n\n.F\n\nFinished in 0.001s, 2000 \
		             runs/s\n\n  1) Failure:\nUserTest#test_name \
		             [test/models/user_test.rb:8]:\nExpected false to be truthy.\n\n2 runs, 2 \
		             assertions, 1 failures, 0 errors, 0 skips\n";
		let out = filter_minitest(input, 1);

		assert!(!out.contains("Run options"));
		assert!(out.contains("1) Failure"));
		assert!(out.contains("test/models/user_test.rb:8"));
		assert!(out.contains("2 runs, 2 assertions, 1 failures"));
	}

	#[test]
	fn rubocop_routes_to_lint_grouping() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = MinimizerCtx {
			program:    "rubocop",
			subcommand: None,
			command:    "rubocop",
			config:     &cfg,
		};
		let out = filter(
			&context,
			"app/models/user.rb:1:1: C: Style/FrozenStringLiteralComment: Missing frozen string \
			 literal comment.\napp/models/user.rb:2:7: W: Lint/UselessAssignment: Useless \
			 assignment.\n",
			1,
		);

		assert!(out.text.contains("2 diagnostics in 1 files"));
		assert!(out.text.contains("app/models/user.rb (2 diagnostics)"));
	}
}

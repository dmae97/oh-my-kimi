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
	if let Some(text) = compact_rspec_json(input) {
		return text;
	}

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

fn compact_rspec_json(input: &str) -> Option<String> {
	let value: serde_json::Value = serde_json::from_str(input).ok()?;
	let map = value.as_object()?;
	let mut out = String::new();

	if let Some(summary_line) = first_json_string(map, &["summary_line"]) {
		push_line(&mut out, summary_line);
	} else if let Some(summary) = map.get("summary").and_then(|value| value.as_object()) {
		push_line(&mut out, &rspec_summary_from_json(summary));
	}

	if let Some(examples) = map.get("examples").and_then(|value| value.as_array()) {
		for example in examples {
			let Some(example_map) = example.as_object() else {
				continue;
			};
			let status = first_json_string(example_map, &["status"]);
			if status == Some("failed") {
				push_rspec_json_example(&mut out, "FAILED", example_map);
			} else if status == Some("pending") {
				push_rspec_json_example(&mut out, "PENDING", example_map);
			}
		}
	}

	if let Some(errors) = map
		.get("errors_outside_of_examples")
		.and_then(|value| value.as_array())
	{
		for error in errors {
			if let Some(error_map) = error.as_object() {
				push_rspec_json_error(&mut out, error_map);
			}
		}
	}

	if has_content(&out) { Some(out) } else { None }
}

fn rspec_summary_from_json(map: &serde_json::Map<String, serde_json::Value>) -> String {
	let examples = first_json_u64(map, &["example_count"]);
	let failures = first_json_u64(map, &["failure_count"]);
	let pending = first_json_u64(map, &["pending_count"]);
	let errors = first_json_u64(map, &["errors_outside_of_examples_count"]);

	let mut parts = Vec::new();
	if let Some(examples) = examples {
		parts.push(format!("{examples} examples"));
	}
	if let Some(failures) = failures {
		parts.push(format!("{failures} failures"));
	}
	if let Some(pending) = pending {
		parts.push(format!("{pending} pending"));
	}
	if let Some(errors) = errors {
		parts.push(format!("{errors} errors outside examples"));
	}

	if parts.is_empty() {
		"RSpec JSON summary".to_string()
	} else {
		parts.join(", ")
	}
}

fn push_rspec_json_example(
	out: &mut String,
	label: &str,
	map: &serde_json::Map<String, serde_json::Value>,
) {
	let description = first_json_string(map, &["full_description", "description", "id"])
		.unwrap_or("<unknown example>");
	push_line(out, &format!("{label}: {description}"));
	push_json_location(out, map);

	if let Some(exception) = map.get("exception").and_then(|value| value.as_object()) {
		push_json_exception(out, exception);
	}
	if let Some(message) = first_json_string(map, &["pending_message", "message"]) {
		push_line(out, message);
	}
}

fn push_rspec_json_error(out: &mut String, map: &serde_json::Map<String, serde_json::Value>) {
	push_line(out, "ERROR outside examples");
	push_json_exception(out, map);
}

fn push_json_location(out: &mut String, map: &serde_json::Map<String, serde_json::Value>) {
	if let Some(path) = first_json_string(map, &["file_path", "file", "path"]) {
		let mut location = path.to_string();
		if let Some(line) = first_json_u64(map, &["line_number", "line"]) {
			location.push(':');
			location.push_str(&line.to_string());
		}
		push_line(out, &location);
	}
}

fn push_json_exception(out: &mut String, map: &serde_json::Map<String, serde_json::Value>) {
	if let Some(class_name) = first_json_string(map, &["class", "class_name", "type"]) {
		push_line(out, class_name);
	}
	if let Some(message) = first_json_string(map, &["message", "description"]) {
		push_line(out, message);
	}
	if let Some(backtrace) = map.get("backtrace").and_then(|value| value.as_array()) {
		for frame in backtrace {
			if let Some(frame) = frame.as_str()
				&& !is_gem_backtrace(frame)
			{
				push_line(out, frame);
				break;
			}
		}
	}
}

fn first_json_string<'a>(
	map: &'a serde_json::Map<String, serde_json::Value>,
	keys: &[&str],
) -> Option<&'a str> {
	keys
		.iter()
		.find_map(|key| map.get(*key).and_then(|value| value.as_str()))
}

fn first_json_u64(map: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<u64> {
	keys
		.iter()
		.find_map(|key| map.get(*key).and_then(|value| value.as_u64()))
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
	fn rspec_json_all_pass_preserves_summary() {
		let input = r#"{
	  "examples": [
		{"id":"./spec/user_spec.rb[1:1]","full_description":"User is valid","status":"passed","file_path":"./spec/user_spec.rb","line_number":3}
	  ],
	  "summary": {"example_count":1,"failure_count":0,"pending_count":0,"errors_outside_of_examples_count":0},
	  "summary_line":"1 example, 0 failures"
	}"#;
		let out = filter_rspec(input, 0);

		assert!(out.contains("1 example, 0 failures"));
		assert!(!out.contains("User is valid"));
	}

	#[test]
	fn rspec_json_failure_preserves_example_context() {
		let input = r#"{
	  "examples": [
		{"id":"./spec/user_spec.rb[1:1]","full_description":"User validates name","status":"failed","file_path":"./spec/user_spec.rb","line_number":12,"exception":{"class":"RSpec::Expectations::ExpectationNotMetError","message":"expected valid? to return true, got false","backtrace":["./spec/user_spec.rb:12:in `block'","./vendor/bundle/ruby/3.3.0/gems/rspec-core/lib/rspec/core.rb:1"]}}
	  ],
	  "summary": {"example_count":1,"failure_count":1,"pending_count":0,"errors_outside_of_examples_count":0},
	  "summary_line":"1 example, 1 failure"
	}"#;
		let out = filter_rspec(input, 1);

		assert!(out.contains("1 example, 1 failure"));
		assert!(out.contains("FAILED: User validates name"));
		assert!(out.contains("./spec/user_spec.rb:12"));
		assert!(out.contains("expected valid? to return true"));
		assert!(!out.contains("vendor/bundle"));
	}

	#[test]
	fn rspec_json_pending_preserves_pending_context() {
		let input = r#"{
	  "examples": [
		{"id":"./spec/user_spec.rb[1:2]","full_description":"User syncs later","status":"pending","file_path":"./spec/user_spec.rb","line_number":20,"pending_message":"Temporarily skipped"}
	  ],
	  "summary": {"example_count":1,"failure_count":0,"pending_count":1,"errors_outside_of_examples_count":0},
	  "summary_line":"1 example, 0 failures, 1 pending"
	}"#;
		let out = filter_rspec(input, 0);

		assert!(out.contains("1 example, 0 failures, 1 pending"));
		assert!(out.contains("PENDING: User syncs later"));
		assert!(out.contains("./spec/user_spec.rb:20"));
		assert!(out.contains("Temporarily skipped"));
	}

	#[test]
	fn rspec_json_errors_outside_examples_preserves_error_context() {
		let input = r#"{
	  "examples": [],
	  "errors_outside_of_examples": [
		{"class":"LoadError","message":"cannot load such file -- missing_helper","backtrace":["./spec/spec_helper.rb:4:in `require'","./vendor/bundle/ruby/3.3.0/gems/rspec-core/lib/rspec/core.rb:1"]}
	  ],
	  "summary": {"example_count":0,"failure_count":0,"pending_count":0,"errors_outside_of_examples_count":1},
	  "summary_line":"0 examples, 0 failures, 1 error occurred outside of examples"
	}"#;
		let out = filter_rspec(input, 1);

		assert!(out.contains("0 examples, 0 failures, 1 error occurred outside of examples"));
		assert!(out.contains("ERROR outside examples"));
		assert!(out.contains("LoadError"));
		assert!(out.contains("cannot load such file"));
		assert!(out.contains("./spec/spec_helper.rb:4"));
		assert!(!out.contains("vendor/bundle"));
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

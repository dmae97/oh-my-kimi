//! Declarative filter pipelines loaded from TOML.
//!
//! Companion to the Rust-native filters in [`filters`](super::filters). A
//! pipeline is a small, data-driven transform compiled from a TOML definition
//! that ships either as a built-in (concatenated at build time) or supplied
//! through a user-provided settings file via [`MinimizerConfig`].
//!
//! ## Pipeline stages (applied in order)
//!
//! 1. `strip_ansi`           — remove ANSI CSI escape codes
//! 2. `replace`              — ordered regex substitutions, line-by-line
//! 3. `match_output`         — short-circuit to a one-line summary when the
//!    full output blob matches, honoring an optional `unless` anti-pattern
//! 4. `strip_lines_matching` / `keep_lines_matching` (mutually exclusive)
//! 5. `truncate_lines_at`    — per-line Unicode-safe char cap
//! 6. `head_lines` / `tail_lines` — keep first/last N lines with a marker
//! 7. `max_lines`            — hard cap after head/tail
//! 8. `on_empty`             — replace an empty result with a sentinel
//!
//! Pipelines never panic for the caller: regex compilation errors are
//! surfaced when the pipeline is loaded, and runtime application is total.

use std::borrow::Cow;

use regex::{Regex, RegexSet};
use serde::Deserialize;

use crate::shell::minimizer::primitives;

/// Raw TOML shape for a single filter definition.
#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct PipelineDef {
	/// Human-readable one-liner. Not consumed at runtime.
	#[serde(default)]
	pub description:          Option<String>,
	/// Regex that selects which commands this pipeline claims. Matched against
	/// the first token of the command (post-wrapper stripping).
	pub match_command:        String,
	/// Optional regex matched against the detected subcommand. When absent,
	/// any subcommand is accepted.
	#[serde(default)]
	pub match_subcommand:     Option<String>,
	#[serde(default)]
	pub strip_ansi:           bool,
	#[serde(default)]
	pub replace:              Vec<ReplaceDef>,
	#[serde(default)]
	pub match_output:         Vec<MatchOutputDef>,
	#[serde(default)]
	pub strip_lines_matching: Vec<String>,
	#[serde(default)]
	pub keep_lines_matching:  Vec<String>,
	pub truncate_lines_at:    Option<usize>,
	pub head_lines:           Option<usize>,
	pub tail_lines:           Option<usize>,
	pub max_lines:            Option<usize>,
	pub on_empty:             Option<String>,
	/// Apply only when the command exit code is in this list. Empty = always.
	#[serde(default)]
	pub only_on_exit:         Vec<i32>,
	/// Apply only when the command exit code is NOT in this list. Empty =
	/// always.
	#[serde(default)]
	pub except_on_exit:       Vec<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplaceDef {
	pub pattern:     String,
	pub replacement: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatchOutputDef {
	pub pattern: String,
	pub message: String,
	#[serde(default)]
	pub unless:  Option<String>,
}

/// Inline filter test embedded next to pipeline definitions via
/// `[[tests.NAME]]`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code, reason = "test-only API surface")]
pub struct PipelineTest {
	pub name:     String,
	pub input:    String,
	pub expected: String,
	#[serde(default)]
	pub exit:     Option<i32>,
}

/// On-disk schema for the builtin / user settings TOML.
#[derive(Debug, Deserialize, Default)]
pub struct PipelineFile {
	pub schema_version: Option<u32>,
	#[serde(default)]
	pub filters:        std::collections::BTreeMap<String, PipelineDef>,
	#[serde(default)]
	pub tests:          std::collections::BTreeMap<String, Vec<PipelineTest>>,
}

pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;

#[derive(Debug)]
pub struct CompiledReplace {
	pattern:     Regex,
	replacement: String,
}

#[derive(Debug)]
pub struct CompiledMatchOutput {
	pattern: Regex,
	message: String,
	unless:  Option<Regex>,
}

#[derive(Debug)]
pub enum CompiledLineFilter {
	None,
	Strip(RegexSet),
	Keep(RegexSet),
}

/// A pipeline with every regex pre-compiled.
#[derive(Debug)]
pub struct CompiledPipeline {
	#[allow(dead_code, reason = "test-only API surface")]
	pub name:              String,
	#[allow(dead_code, reason = "test-only API surface")]
	pub description:       Option<String>,
	pub match_command:     Regex,
	pub match_subcommand:  Option<Regex>,
	pub strip_ansi:        bool,
	pub replace:           Vec<CompiledReplace>,
	pub match_output:      Vec<CompiledMatchOutput>,
	pub line_filter:       CompiledLineFilter,
	pub truncate_lines_at: Option<usize>,
	pub head_lines:        Option<usize>,
	pub tail_lines:        Option<usize>,
	pub max_lines:         Option<usize>,
	pub on_empty:          Option<String>,
	pub only_on_exit:      Vec<i32>,
	pub except_on_exit:    Vec<i32>,
}

/// Compile a raw TOML definition. Returns a descriptive error on regex
/// issues or mutually-exclusive-field conflicts.
pub fn compile(name: String, def: PipelineDef) -> Result<CompiledPipeline, String> {
	if !def.strip_lines_matching.is_empty() && !def.keep_lines_matching.is_empty() {
		return Err("strip_lines_matching and keep_lines_matching are mutually exclusive".into());
	}

	let match_command =
		Regex::new(&def.match_command).map_err(|e| format!("invalid match_command: {e}"))?;
	let match_subcommand = def
		.match_subcommand
		.as_deref()
		.map(|p| Regex::new(p).map_err(|e| format!("invalid match_subcommand: {e}")))
		.transpose()?;

	let replace = def
		.replace
		.into_iter()
		.map(|rule| {
			let pattern = Regex::new(&rule.pattern)
				.map_err(|e| format!("invalid replace pattern '{}': {e}", rule.pattern))?;
			Ok(CompiledReplace { pattern, replacement: rule.replacement })
		})
		.collect::<Result<Vec<_>, String>>()?;

	let match_output = def
		.match_output
		.into_iter()
		.map(|rule| {
			let pattern = Regex::new(&rule.pattern)
				.map_err(|e| format!("invalid match_output pattern '{}': {e}", rule.pattern))?;
			let unless = rule
				.unless
				.as_deref()
				.map(|u| Regex::new(u).map_err(|e| format!("invalid match_output unless: {e}")))
				.transpose()?;
			Ok(CompiledMatchOutput { pattern, message: rule.message, unless })
		})
		.collect::<Result<Vec<_>, String>>()?;

	let line_filter = if !def.strip_lines_matching.is_empty() {
		let set = RegexSet::new(&def.strip_lines_matching)
			.map_err(|e| format!("invalid strip_lines_matching: {e}"))?;
		CompiledLineFilter::Strip(set)
	} else if !def.keep_lines_matching.is_empty() {
		let set = RegexSet::new(&def.keep_lines_matching)
			.map_err(|e| format!("invalid keep_lines_matching: {e}"))?;
		CompiledLineFilter::Keep(set)
	} else {
		CompiledLineFilter::None
	};

	Ok(CompiledPipeline {
		name,
		description: def.description,
		match_command,
		match_subcommand,
		strip_ansi: def.strip_ansi,
		replace,
		match_output,
		line_filter,
		truncate_lines_at: def.truncate_lines_at,
		head_lines: def.head_lines,
		tail_lines: def.tail_lines,
		max_lines: def.max_lines,
		on_empty: def.on_empty,
		only_on_exit: def.only_on_exit,
		except_on_exit: def.except_on_exit,
	})
}

impl CompiledPipeline {
	/// Whether this pipeline claims the given `(program, subcommand)` pair.
	pub fn matches(&self, program: &str, subcommand: Option<&str>) -> bool {
		if !self.match_command.is_match(program) {
			return false;
		}
		if let Some(sub_rx) = self.match_subcommand.as_ref() {
			let sub = subcommand.unwrap_or("");
			if !sub_rx.is_match(sub) {
				return false;
			}
		}
		true
	}

	/// Whether this pipeline is gated off for the supplied exit code.
	pub fn skipped_by_exit(&self, exit_code: i32) -> bool {
		if !self.only_on_exit.is_empty() && !self.only_on_exit.contains(&exit_code) {
			return true;
		}
		if self.except_on_exit.contains(&exit_code) {
			return true;
		}
		false
	}

	/// Apply the full 8-stage pipeline to `input`.
	pub fn apply<'a>(&self, input: &'a str) -> Cow<'a, str> {
		// Stage 1: strip_ansi
		let stage1: Cow<'_, str> = if self.strip_ansi {
			Cow::Owned(primitives::strip_ansi(input))
		} else {
			Cow::Borrowed(input)
		};

		// Stage 2: replace (ordered, line-by-line)
		let stage2: Cow<'_, str> = if self.replace.is_empty() {
			stage1
		} else {
			let mut out = String::with_capacity(stage1.len());
			for line in stage1.lines() {
				let mut current = Cow::Borrowed(line);
				for rule in &self.replace {
					let replaced = rule
						.pattern
						.replace_all(&current, rule.replacement.as_str());
					if let Cow::Owned(s) = replaced {
						current = Cow::Owned(s);
					}
				}
				out.push_str(&current);
				out.push('\n');
			}
			Cow::Owned(out)
		};

		// Stage 3: match_output short-circuit
		if !self.match_output.is_empty() {
			for rule in &self.match_output {
				if !rule.pattern.is_match(&stage2) {
					continue;
				}
				if let Some(anti) = rule.unless.as_ref()
					&& anti.is_match(&stage2)
				{
					continue;
				}
				return Cow::Owned(rule.message.clone());
			}
		}

		// Stage 4: strip/keep lines
		let stage4: Cow<'_, str> = match &self.line_filter {
			CompiledLineFilter::None => stage2,
			CompiledLineFilter::Strip(set) => Cow::Owned(primitives::strip_lines_regex(&stage2, set)),
			CompiledLineFilter::Keep(set) => Cow::Owned(primitives::keep_lines_regex(&stage2, set)),
		};

		// Stage 5: truncate each line
		let stage5: Cow<'_, str> = if let Some(n) = self.truncate_lines_at {
			let mut out = String::with_capacity(stage4.len());
			for line in stage4.lines() {
				out.push_str(&primitives::truncate_line(line, n));
				out.push('\n');
			}
			Cow::Owned(out)
		} else {
			stage4
		};

		// Stage 6: head + tail
		let stage6: Cow<'_, str> = match (self.head_lines, self.tail_lines) {
			(Some(h), Some(t)) => Cow::Owned(primitives::head_tail_lines(&stage5, h, t)),
			(Some(h), None) => Cow::Owned(primitives::head_lines_only(&stage5, h)),
			(None, Some(t)) => Cow::Owned(primitives::tail_lines_only(&stage5, t)),
			(None, None) => stage5,
		};

		// Stage 7: max_lines
		let stage7: Cow<'_, str> = if let Some(m) = self.max_lines {
			Cow::Owned(primitives::max_lines(&stage6, m))
		} else {
			stage6
		};

		// Stage 8: on_empty
		if let Some(msg) = self.on_empty.as_deref()
			&& stage7.trim().is_empty()
		{
			return Cow::Owned(msg.to_string());
		}

		stage7
	}
}

/// Return type of [`parse_file`]: the compiled pipelines alongside their
/// inline tests grouped by pipeline name.
pub type ParsedPipelineFile = (Vec<CompiledPipeline>, Vec<(String, Vec<PipelineTest>)>);

/// Compiled registry of all known pipelines, listed in priority order
/// (builtin last — user definitions win). Also carries the inline tests so
/// `verify()` can exercise them.
#[derive(Debug, Default)]
pub struct PipelineRegistry {
	pub pipelines: Vec<CompiledPipeline>,
	#[allow(dead_code, reason = "test-only API surface")]
	pub tests:     Vec<(String, Vec<PipelineTest>)>,
}

impl PipelineRegistry {
	/// Find the first pipeline that claims this `(program, subcommand)` pair.
	pub fn find(&self, program: &str, subcommand: Option<&str>) -> Option<&CompiledPipeline> {
		self
			.pipelines
			.iter()
			.find(|p| p.matches(program, subcommand))
	}
}

/// Parse and compile a full TOML file. Emits one `Err(String)` with all
/// parse/compile errors joined; a well-formed file with N filters returns
/// `Ok((Vec<CompiledPipeline>, tests))`.
pub fn parse_file(contents: &str, source_label: &str) -> Result<ParsedPipelineFile, String> {
	let file: PipelineFile =
		toml::from_str(contents).map_err(|e| format!("[{source_label}] TOML parse error: {e}"))?;

	if let Some(v) = file.schema_version
		&& v != SUPPORTED_SCHEMA_VERSION
	{
		return Err(format!(
			"[{source_label}] unsupported schema_version {v} (expected {SUPPORTED_SCHEMA_VERSION})"
		));
	}

	let mut compiled = Vec::with_capacity(file.filters.len());
	let mut errors = Vec::new();
	for (name, def) in file.filters {
		match compile(name.clone(), def) {
			Ok(pipeline) => compiled.push(pipeline),
			Err(e) => errors.push(format!("[{source_label}] filter '{name}': {e}")),
		}
	}
	if !errors.is_empty() {
		return Err(errors.join("\n"));
	}

	let tests = file.tests.into_iter().collect();
	Ok((compiled, tests))
}

/// Outcome for a single inline test.
#[derive(Debug, Clone)]
#[allow(dead_code, reason = "test-only API surface")]
pub struct TestOutcome {
	pub filter_name: String,
	pub test_name:   String,
	pub passed:      bool,
	pub actual:      String,
	pub expected:    String,
}

/// Run every inline test in `registry` and return the outcomes.
#[allow(dead_code, reason = "test-only API surface")]
pub fn run_tests(registry: &PipelineRegistry) -> Vec<TestOutcome> {
	let mut out = Vec::new();
	for (filter_name, tests) in &registry.tests {
		let Some(pipeline) = registry.pipelines.iter().find(|p| &p.name == filter_name) else {
			for test in tests {
				out.push(TestOutcome {
					filter_name: filter_name.clone(),
					test_name:   test.name.clone(),
					passed:      false,
					actual:      format!("pipeline '{filter_name}' not found"),
					expected:    test.expected.clone(),
				});
			}
			continue;
		};
		for test in tests {
			if let Some(exit) = test.exit
				&& pipeline.skipped_by_exit(exit)
			{
				// Explicit exit gate — pipeline is disabled for this exit;
				// expected output should be the raw input unchanged.
				let passed = test.input == test.expected;
				out.push(TestOutcome {
					filter_name: filter_name.clone(),
					test_name: test.name.clone(),
					passed,
					actual: test.input.clone(),
					expected: test.expected.clone(),
				});
				continue;
			}
			let actual = pipeline.apply(&test.input).to_string();
			let passed = actual == test.expected;
			out.push(TestOutcome {
				filter_name: filter_name.clone(),
				test_name: test.name.clone(),
				passed,
				actual,
				expected: test.expected.clone(),
			});
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	fn compile_one(toml_src: &str) -> CompiledPipeline {
		let (mut pipelines, _) = parse_file(toml_src, "test").expect("parse + compile");
		pipelines.pop().expect("one pipeline")
	}

	#[test]
	fn pipeline_runs_all_stages() {
		let src = r#"
schema_version = 1
[filters.demo]
match_command = "^demo$"
strip_ansi = true
strip_lines_matching = ["^Downloading"]
truncate_lines_at = 10
max_lines = 5
on_empty = "demo: ok"

[[tests.demo]]
name = "basic"
input = "\u001b[31mfirst\u001b[0m\nDownloading foo\nA_really_long_line_indeed\n"
expected = "first\nA_really_l\u2026\n"
"#;
		let pipeline = compile_one(src);
		let out =
			pipeline.apply("\u{1b}[31mfirst\u{1b}[0m\nDownloading foo\nA_really_long_line_indeed\n");
		assert_eq!(out.as_ref(), "first\nA_really_l\u{2026}\n");
	}

	#[test]
	fn short_circuit_wins_over_later_stages() {
		let src = r#"
schema_version = 1
[filters.ok]
match_command = "^ok$"
[[filters.ok.match_output]]
pattern = "BUILD SUCCESSFUL"
message = "build: ok"
"#;
		let pipeline = compile_one(src);
		let out = pipeline.apply("noise\nBUILD SUCCESSFUL in 5s\n");
		assert_eq!(out.as_ref(), "build: ok");
	}

	#[test]
	fn unless_prevents_swallowing_errors() {
		let src = r#"
schema_version = 1
[filters.ok]
match_command = "^ok$"
[[filters.ok.match_output]]
pattern = "BUILD SUCCESSFUL"
message = "build: ok"
unless = "(?i)error|fail"
"#;
		let pipeline = compile_one(src);
		let out = pipeline.apply("BUILD SUCCESSFUL but later ERROR: oops\n");
		assert!(out.as_ref().contains("ERROR"));
	}

	#[test]
	fn on_empty_fires_when_output_is_blank() {
		let src = r#"
schema_version = 1
[filters.silent]
match_command = "^silent$"
strip_lines_matching = [".*"]
on_empty = "silent: ok"
"#;
		let pipeline = compile_one(src);
		let out = pipeline.apply("noise\nmore noise\n");
		assert_eq!(out.as_ref(), "silent: ok");
	}

	#[test]
	fn exit_gates_respected() {
		let src = r#"
schema_version = 1
[filters.okonly]
match_command = "^okonly$"
only_on_exit = [0]
"#;
		let pipeline = compile_one(src);
		assert!(!pipeline.skipped_by_exit(0));
		assert!(pipeline.skipped_by_exit(1));

		let src2 = r#"
schema_version = 1
[filters.notfail]
match_command = "^notfail$"
except_on_exit = [1, 2]
"#;
		let pipeline2 = compile_one(src2);
		assert!(!pipeline2.skipped_by_exit(0));
		assert!(pipeline2.skipped_by_exit(1));
	}

	#[test]
	fn unsupported_schema_errors() {
		let src = "schema_version = 99\n[filters.foo]\nmatch_command = \"^foo$\"\n";
		let err = parse_file(src, "bad").unwrap_err();
		assert!(err.contains("schema_version"));
	}

	#[test]
	fn inline_tests_run_and_pass() {
		let src = r#"
schema_version = 1
[filters.gradle]
match_command = "^gradle$"
strip_lines_matching = ["^> Task :.*UP-TO-DATE$"]
on_empty = "gradle: ok"

[[tests.gradle]]
name = "strip UP-TO-DATE"
input = "> Task :a UP-TO-DATE\n> Task :b\n"
expected = "> Task :b\n"

[[tests.gradle]]
name = "empty becomes sentinel"
input = "> Task :a UP-TO-DATE\n"
expected = "gradle: ok"
"#;
		let (pipelines, tests) = parse_file(src, "test").expect("ok");
		let registry = PipelineRegistry { pipelines, tests };
		let outcomes = run_tests(&registry);
		assert_eq!(outcomes.len(), 2);
		for outcome in outcomes {
			assert!(
				outcome.passed,
				"test {} failed: actual={:?} expected={:?}",
				outcome.test_name, outcome.actual, outcome.expected
			);
		}
	}
}

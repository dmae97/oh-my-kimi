//! Minimizer pipeline: detect, dispatch, and fail-safe filter execution.

use std::{
	panic::{AssertUnwindSafe, catch_unwind},
	sync::{
		LazyLock,
		atomic::{AtomicU64, Ordering},
	},
};

use crate::shell::minimizer::{
	MinimizerConfig, MinimizerCtx, MinimizerOutput, detect, filters,
	markers::{CommandMarkerState, MarkerKind, ParsedMarker},
	pipeline::{self, CompiledPipeline, PipelineRegistry},
	plan,
};

/// Minimization strategy for a shell command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MinimizerMode {
	/// Stream output unchanged.
	None,
	/// Capture the whole command and apply one filter to the whole buffer.
	WholeCommand,
	/// Capture the whole command and filter marked external-command segments.
	MarkedCommands,
}

/// Return the minimization mode for a command.
pub fn mode_for(command: &str, config: &MinimizerConfig) -> MinimizerMode {
	match plan::analyze(command) {
		plan::CommandPlan::Single { .. } => {
			let Some(identity) = detect::detect(command) else {
				return MinimizerMode::None;
			};
			if identity_has_filter(&identity, config) {
				MinimizerMode::WholeCommand
			} else {
				MinimizerMode::None
			}
		},
		plan::CommandPlan::Compound => {
			if config.enabled {
				MinimizerMode::MarkedCommands
			} else {
				MinimizerMode::None
			}
		},
		plan::CommandPlan::Piped | plan::CommandPlan::Unsupported => MinimizerMode::None,
	}
}

/// Return true when the command should be captured for minimization.
#[allow(dead_code, reason = "test-only API surface")]
pub fn should_minimize(command: &str, config: &MinimizerConfig) -> bool {
	!matches!(mode_for(command, config), MinimizerMode::None)
}

/// Apply a matching filter to captured output.
///
/// Panics inside filters are caught and converted to pass-through output so
/// minimization can never be the reason a shell command loses output.
///
/// When a filter actually rewrites the text, the returned
/// [`MinimizerOutput`] carries the original buffer in `original_text` so the
/// JS session layer can persist it via its `ArtifactManager` and splice an
/// `artifact://<id>` reference back into the visible text before showing it
/// to the agent. The minimizer itself never formats the reference — ids are
/// assigned by the session store, not content-addressed.
pub fn apply(
	command: &str,
	captured: &str,
	exit_code: i32,
	config: &MinimizerConfig,
) -> MinimizerOutput {
	let input_bytes = captured.len();

	if input_bytes > config.max_capture_bytes as usize {
		return MinimizerOutput::passthrough(captured).labeled("too-large");
	}

	// Structural guard: this whole-buffer path only handles single simple
	// commands. Compound commands are handled by launch-scoped markers.
	// Pipes almost always feed a downstream parser (awk, jq, rg, …) and
	// rewriting their input is a correctness bug.
	match plan::analyze(command) {
		plan::CommandPlan::Single { .. } => {},
		plan::CommandPlan::Piped => {
			return MinimizerOutput::passthrough(captured).labeled("piped");
		},
		plan::CommandPlan::Compound => {
			return MinimizerOutput::passthrough(captured).labeled("compound");
		},
		plan::CommandPlan::Unsupported => {
			return MinimizerOutput::passthrough(captured).labeled("parse-error");
		},
	}

	let Some(identity) = detect::detect(command) else {
		record_unknown_command(command);
		return MinimizerOutput::passthrough(captured).labeled("unknown");
	};
	apply_identity(&identity, command, captured, exit_code, config)
}

/// Apply filters to output marked around individual external command launches.
pub fn apply_marked(
	captured: &str,
	config: &MinimizerConfig,
	markers: &CommandMarkerState,
) -> MinimizerOutput {
	let mut text = String::with_capacity(captured.len());
	let mut original = String::with_capacity(captured.len());
	let mut cursor = 0;
	let mut changed = false;

	while let Some(marker) = markers.find_marker(captured, cursor) {
		text.push_str(&captured[cursor..marker.start]);
		original.push_str(&captured[cursor..marker.start]);

		match marker.kind {
			MarkerKind::Start { id } => {
				let Some(end_marker) = find_matching_end(captured, markers, marker.end, id) else {
					cursor = marker.end;
					continue;
				};
				let MarkerKind::End { exit_code, .. } = end_marker.kind else {
					cursor = marker.end;
					continue;
				};
				let segment = &captured[marker.end..end_marker.start];
				original.push_str(segment);
				if let Some(command) = markers.command(id) {
					let minimized =
						apply_identity(&command.identity, &command.command, segment, exit_code, config);
					if minimized.changed {
						changed = true;
					}
					text.push_str(&minimized.text);
				} else {
					text.push_str(segment);
				}
				cursor = end_marker.end;
			},
			MarkerKind::End { .. } => {
				cursor = marker.end;
			},
		}
	}

	text.push_str(&captured[cursor..]);
	original.push_str(&captured[cursor..]);

	if changed {
		let output_bytes = text.len();
		return MinimizerOutput {
			text,
			changed: true,
			input_bytes: original.len(),
			output_bytes,
			filter: "compound",
			original_text: Some(original),
		};
	}

	MinimizerOutput::passthrough(original).labeled("compound-noop")
}

/// Remove command-boundary markers without applying filters.
pub fn strip_markers(captured: &str, markers: &CommandMarkerState) -> String {
	let mut text = String::with_capacity(captured.len());
	let mut cursor = 0;
	while let Some(marker) = markers.find_marker(captured, cursor) {
		text.push_str(&captured[cursor..marker.start]);
		cursor = marker.end;
	}
	text.push_str(&captured[cursor..]);
	text
}

fn find_matching_end(
	captured: &str,
	markers: &CommandMarkerState,
	from: usize,
	id: u64,
) -> Option<ParsedMarker> {
	let mut cursor = from;
	while let Some(marker) = markers.find_marker(captured, cursor) {
		if matches!(marker.kind, MarkerKind::End { id: end_id, .. } if end_id == id) {
			return Some(marker);
		}
		cursor = marker.end;
	}
	None
}

fn identity_has_filter(identity: &detect::CommandIdentity, config: &MinimizerConfig) -> bool {
	if !config.is_program_enabled(&identity.program) {
		return false;
	}

	let subcommand = identity.subcommand.as_deref();
	filters::supports(&identity.program, subcommand)
		|| resolve_pipeline(config, &identity.program, subcommand).is_some()
}

fn apply_identity(
	identity: &detect::CommandIdentity,
	command: &str,
	captured: &str,
	exit_code: i32,
	config: &MinimizerConfig,
) -> MinimizerOutput {
	if !config.is_program_enabled(&identity.program) {
		return MinimizerOutput::passthrough(captured).labeled("disabled");
	}

	let subcommand = identity.subcommand.as_deref();

	if filters::supports(&identity.program, subcommand) {
		let ctx = MinimizerCtx { program: &identity.program, subcommand, command, config };
		let rust_output =
			match catch_unwind(AssertUnwindSafe(|| filters::filter(&ctx, captured, exit_code))) {
				Ok(out) => out,
				Err(_) => MinimizerOutput::passthrough(captured),
			};
		let label = program_label(&identity.program);
		let overlaid = apply_pipeline_overlay(config, &identity.program, rust_output, label);
		return overlaid.with_original(captured);
	}

	if let Some(pipeline) = resolve_pipeline(config, &identity.program, subcommand) {
		if pipeline.skipped_by_exit(exit_code) {
			return MinimizerOutput::passthrough(captured).labeled("exit-skip");
		}
		let text = catch_unwind(AssertUnwindSafe(|| pipeline.apply(captured).into_owned()))
			.unwrap_or_else(|_| captured.to_string());
		if text == captured {
			return MinimizerOutput::passthrough(captured).labeled("pipeline-noop");
		}
		return MinimizerOutput::transformed(text, captured.len())
			.labeled("pipeline")
			.with_original(captured);
	}

	record_unknown_command(command);
	MinimizerOutput::passthrough(captured).labeled("unsupported")
}

/// Per-program label for telemetry. Returns one of a fixed static set so the
/// N-API boundary can carry it as `&'static str` without allocation.
fn program_label(program: &str) -> &'static str {
	match program {
		"git" => "git",
		"yadm" => "yadm",
		"gt" => "gt",
		"bun" => "bun",
		"bunx" => "bunx",
		"cargo" => "cargo",
		"go" => "go",
		"golangci-lint" => "golangci-lint",
		"dotnet" => "dotnet",
		"docker" => "docker",
		"kubectl" => "kubectl",
		"helm" => "helm",
		"gh" => "gh",
		"pytest" => "pytest",
		"ruff" => "ruff",
		"mypy" => "mypy",
		"python" => "python",
		"python3" => "python3",
		"rspec" => "rspec",
		"rake" => "rake",
		"rails" => "rails",
		"rubocop" => "rubocop",
		"tsc" => "tsc",
		"eslint" => "eslint",
		"biome" => "biome",
		"jest" => "jest",
		"vitest" => "vitest",
		"playwright" => "playwright",
		"npm" => "npm",
		"pnpm" => "pnpm",
		"yarn" => "yarn",
		"pip" => "pip",
		"pip3" => "pip3",
		"bundle" => "bundle",
		"brew" => "brew",
		"composer" => "composer",
		"uv" => "uv",
		"poetry" => "poetry",
		"aws" => "aws",
		"curl" => "curl",
		"wget" => "wget",
		"psql" => "psql",
		"ls" => "ls",
		"tree" => "tree",
		"find" => "find",
		"grep" => "grep",
		"rg" => "rg",
		"wc" => "wc",
		"cat" => "cat",
		"read" => "read",
		"stat" => "stat",
		"du" => "du",
		"df" => "df",
		"jq" => "jq",
		_ => "builtin",
	}
}

/// If a pipeline matches this program, re-apply it as an *overlay* on top of
/// the Rust filter's output. This lets users tune built-in filter results via
/// their settings TOML without replacing the underlying Rust logic.
fn apply_pipeline_overlay(
	config: &MinimizerConfig,
	program: &str,
	inner: MinimizerOutput,
	primary_label: &'static str,
) -> MinimizerOutput {
	let Some(pipeline) = resolve_pipeline(config, program, None) else {
		return inner.labeled(primary_label);
	};
	let text = catch_unwind(AssertUnwindSafe(|| pipeline.apply(&inner.text).into_owned()))
		.unwrap_or_else(|_| inner.text.clone());
	if text == inner.text {
		return inner.labeled(primary_label);
	}
	let output_bytes = text.len();
	MinimizerOutput {
		text,
		changed: true,
		input_bytes: inner.input_bytes,
		output_bytes,
		filter: "pipeline+builtin",
		original_text: inner.original_text,
	}
}

/// Find the first matching pipeline across user-defined + built-in registries.
fn resolve_pipeline<'a>(
	config: &'a MinimizerConfig,
	program: &str,
	subcommand: Option<&str>,
) -> Option<&'a CompiledPipeline> {
	if let Some(user) = config.user_pipelines.as_deref()
		&& let Some(pipeline) = user.find(program, subcommand)
	{
		return Some(pipeline);
	}
	builtin_pipelines().find(program, subcommand)
}

// Atomic counter for commands that reached `apply` without a matching filter.
static UNKNOWN_COMMAND_COUNT: AtomicU64 = AtomicU64::new(0);

fn record_unknown_command(_command: &str) {
	UNKNOWN_COMMAND_COUNT.fetch_add(1, Ordering::Relaxed);
}

/// Total number of commands that fell through `apply` without any matching
/// filter. Useful for a "coverage gap" indicator in telemetry dashboards.
#[allow(dead_code, reason = "test-only API surface")]
pub fn unknown_command_count() -> u64 {
	UNKNOWN_COMMAND_COUNT.load(Ordering::Relaxed)
}

/// Reset the unknown-command counter (intended for tests).
#[doc(hidden)]
#[allow(dead_code, reason = "test-only API surface")]
pub fn reset_unknown_command_count() {
	UNKNOWN_COMMAND_COUNT.store(0, Ordering::Relaxed);
}

const BUILTIN_FILTERS_TOML: &str = include_str!(concat!(env!("OUT_DIR"), "/builtin_filters.toml"));

static BUILTIN_PIPELINES: LazyLock<PipelineRegistry> =
	LazyLock::new(|| match pipeline::parse_file(BUILTIN_FILTERS_TOML, "builtin") {
		Ok((pipelines, tests)) => PipelineRegistry { pipelines, tests },
		Err(err) => {
			eprintln!("[pi-natives minimizer] failed to load built-in filters: {err}");
			PipelineRegistry::default()
		},
	});

fn builtin_pipelines() -> &'static PipelineRegistry {
	&BUILTIN_PIPELINES
}

/// Expose the built-in registry's inline tests for the verify CLI surface.
#[allow(dead_code, reason = "test-only API surface")]
pub fn verify_builtin_filters() -> Vec<pipeline::TestOutcome> {
	pipeline::run_tests(builtin_pipelines())
}

#[cfg(test)]
mod tests {
	use brush_core::{ExternalCommandInfo, ExternalCommandOutputMarker};

	use super::*;
	use crate::shell::minimizer::markers::CommandMarkerState;

	#[test]
	fn disabled_config_does_not_minimize() {
		let cfg = MinimizerConfig::default();
		assert!(!should_minimize("git status", &cfg));
		let out = apply("git status", "## main\n", 0, &cfg);
		assert!(!out.changed);
	}

	#[test]
	fn enabled_known_filter_minimizes() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		assert!(should_minimize("git status", &cfg));
		let out = apply("git status", "## main\n M file.rs\n", 0, &cfg);
		assert!(out.changed);
		assert!(out.text.contains("modified: 1"));
	}

	#[test]
	fn unknown_command_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		assert!(!should_minimize("echo hello", &cfg));
		let out = apply("echo hello", "hello\n", 0, &cfg);
		assert_eq!(out.text, "hello\n");
		assert!(!out.changed);
	}

	#[test]
	fn compound_commands_use_marked_mode() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		assert_eq!(mode_for("echo start ; git status", &cfg), MinimizerMode::MarkedCommands);
		assert_eq!(mode_for("false && git status", &cfg), MinimizerMode::MarkedCommands);
		assert_eq!(mode_for("git status | cat", &cfg), MinimizerMode::None);
	}

	#[test]
	fn marked_output_filters_segment_and_preserves_original() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let markers = CommandMarkerState::new();
		let command_markers = markers
			.markers_for_external_command(ExternalCommandInfo {
				command_name:    "git",
				executable_path: "/usr/bin/git",
				args:            vec!["status"],
			})
			.expect("git marker should be created");
		let captured = format!(
			"before\n{}## main\n M file.rs\n{}0{}after\n",
			command_markers.start_marker,
			command_markers.end_marker_prefix,
			command_markers.end_marker_suffix,
		);

		let out = apply_marked(&captured, &cfg, &markers);

		assert!(out.changed);
		assert_eq!(out.filter, "compound");
		assert_eq!(out.original_text.as_deref(), Some("before\n## main\n M file.rs\nafter\n"));
		assert!(out.text.contains("before\n"));
		assert!(out.text.contains("modified: 1"));
		assert!(out.text.contains("after\n"));
	}

	#[test]
	fn marked_output_strips_markers_without_supported_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let markers = CommandMarkerState::new();
		let command_markers = markers
			.markers_for_external_command(ExternalCommandInfo {
				command_name:    "unknown-tool",
				executable_path: "/tmp/unknown-tool",
				args:            vec!["hello"],
			})
			.expect("unknown marker should still be created");
		let captured = format!(
			"{}raw\n{}0{}",
			command_markers.start_marker,
			command_markers.end_marker_prefix,
			command_markers.end_marker_suffix,
		);

		let out = apply_marked(&captured, &cfg, &markers);

		assert!(!out.changed);
		assert_eq!(out.text, "raw\n");
		assert_eq!(strip_markers(&captured, &markers), "raw\n");
	}
}

#[cfg(test)]
mod pipeline_integration_tests {
	use super::*;
	use crate::shell::minimizer::MinimizerOptions;

	#[test]
	fn builtin_filters_parse_and_pass_inline_tests() {
		let outcomes = verify_builtin_filters();
		let failures: Vec<_> = outcomes.iter().filter(|o| !o.passed).collect();
		assert!(
			failures.is_empty(),
			"{} built-in inline tests failed:\n{}",
			failures.len(),
			failures
				.iter()
				.map(|f| format!(
					" - [{}/{}] expected {:?}, got {:?}",
					f.filter_name, f.test_name, f.expected, f.actual
				))
				.collect::<Vec<_>>()
				.join("\n")
		);
		assert!(!outcomes.is_empty(), "expected built-in inline tests");
	}

	#[test]
	fn pipeline_matches_gradle_via_apply() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			..Default::default()
		});
		let out = apply(
			"gradle build",
			"> Task :app:compileJava UP-TO-DATE\n> Task :app:test\nBUILD SUCCESSFUL in 8s\n",
			0,
			&cfg,
		);
		assert!(out.changed, "gradle pipeline should transform");
		assert!(!out.text.contains("UP-TO-DATE"));
		assert!(out.text.contains("BUILD SUCCESSFUL"));
		assert_eq!(out.filter, "pipeline");
		assert!(out.bytes_saved() > 0);
	}

	#[test]
	fn too_large_input_is_passthrough() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			max_capture_bytes: Some(1024),
			..Default::default()
		});
		let big = "x".repeat(2048);
		let out = apply("git status", &big, 0, &cfg);
		assert!(!out.changed);
		assert_eq!(out.filter, "too-large");
	}

	#[test]
	fn unknown_command_counter_increments() {
		reset_unknown_command_count();
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			..Default::default()
		});
		let before = unknown_command_count();
		let _ = apply("zzzobscurecmd foo", "hi\n", 0, &cfg);
		let after = unknown_command_count();
		assert!(after > before, "counter should advance for unknown commands");
	}
}

//! Minimizer pipeline: detect, dispatch, and fail-safe filter execution.

use std::panic::{AssertUnwindSafe, catch_unwind};

use crate::shell::minimizer::{MinimizerConfig, MinimizerCtx, MinimizerOutput, detect, filters};

/// Return true when the command has an enabled built-in filter.
pub fn should_minimize(command: &str, config: &MinimizerConfig) -> bool {
	let Some(identity) = detect::detect(command) else {
		return false;
	};
	config.is_program_enabled(&identity.program)
		&& filters::supports(&identity.program, identity.subcommand.as_deref())
}

/// Apply a matching filter to captured output.
///
/// Panics inside filters are caught and converted to pass-through output so
/// minimization can never be the reason a shell command loses output.
pub fn apply(
	command: &str,
	captured: &str,
	exit_code: i32,
	config: &MinimizerConfig,
) -> MinimizerOutput {
	let Some(identity) = detect::detect(command) else {
		return MinimizerOutput::passthrough(captured);
	};
	if !config.is_program_enabled(&identity.program)
		|| !filters::supports(&identity.program, identity.subcommand.as_deref())
	{
		return MinimizerOutput::passthrough(captured);
	}
	let ctx = MinimizerCtx {
		program: &identity.program,
		subcommand: identity.subcommand.as_deref(),
		command,
		config,
	};
	match catch_unwind(AssertUnwindSafe(|| filters::filter(&ctx, captured, exit_code))) {
		Ok(output) => output,
		Err(_) => MinimizerOutput::passthrough(captured),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

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
		assert!(out.text.contains("unstaged: 1"));
	}

	#[test]
	fn unknown_command_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		assert!(!should_minimize("echo hello", &cfg));
		let out = apply("echo hello", "hello\n", 0, &cfg);
		assert_eq!(out.text, "hello\n");
		assert!(!out.changed);
	}
}

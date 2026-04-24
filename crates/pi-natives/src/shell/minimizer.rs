//! Opt-in output minimizer for `Shell::run` / `execute_shell`.
//!
//! Compresses a shell command's stdout/stderr before it reaches the JS
//! caller.
//!
//! The engine is inert unless a [`MinimizerConfig`] explicitly opts in.

pub mod config;
pub mod detect;
pub mod engine;
pub mod filters;
pub mod primitives;

use std::borrow::Cow;

pub use config::{MinimizerConfig, MinimizerOptions};

/// Per-invocation context passed to every filter.
#[derive(Debug, Clone)]
pub struct MinimizerCtx<'a> {
	/// Resolved program name (lowercased, e.g. `"git"`).
	pub program:    &'a str,
	/// Detected subcommand (lowercased, e.g. `"status"`), if any.
	pub subcommand: Option<&'a str>,
	/// Raw command string as the caller supplied it.
	pub command:    &'a str,
	/// Effective configuration.
	pub config:     &'a MinimizerConfig,
}

/// Output produced by a filter.
#[derive(Debug, Clone)]
pub struct MinimizerOutput {
	/// Rewritten output.
	pub text:    String,
	/// Whether the filter modified the input at all.
	pub changed: bool,
}

impl MinimizerOutput {
	/// Pass-through constructor — the filter emits the original text unchanged.
	pub fn passthrough<'a>(text: impl Into<Cow<'a, str>>) -> Self {
		Self { text: text.into().into_owned(), changed: false }
	}

	/// Transformed output.
	pub const fn transformed(text: String) -> Self {
		Self { text, changed: true }
	}
}

/// Apply the configured filter pipeline to a captured buffer.
///
/// Returns the original text unchanged when minimization is disabled, no
/// filter matches, or a filter panics.
pub fn apply(
	command: &str,
	captured: &str,
	exit_code: i32,
	config: &MinimizerConfig,
) -> MinimizerOutput {
	engine::apply(command, captured, exit_code, config)
}

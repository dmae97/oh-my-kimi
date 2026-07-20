// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::ffi::OsString;

use clap::{Arg, ArgAction, Command, builder::PossibleValue};

pub mod options {
	pub const APPEND: &str = "append";
	pub const IGNORE_INTERRUPTS: &str = "ignore-interrupts";
	pub const FILE: &str = "file";
	pub const IGNORE_PIPE_ERRORS: &str = "ignore-pipe-errors";
	pub const OUTPUT_ERROR: &str = "output-error";
}

#[derive(Clone, Debug)]
pub enum OutputErrorMode {
	Warn,
	WarnNoPipe,
	Exit,
	ExitNoPipe,
}

pub struct Options {
	pub append:       bool,
	pub files:        Vec<OsString>,
	pub output_error: Option<OutputErrorMode>,
}

pub fn uu_app() -> Command {
	Command::new("tee")
		.version(env!("CARGO_PKG_VERSION"))
		.about("Copy standard input to each FILE, and also to standard output.")
		.override_usage("tee [OPTION]... [FILE]...")
		.after_help("If a FILE is -, copy again to standard output.")
		.infer_long_args(true)
		.disable_help_flag(true)
		.arg(
			Arg::new("--help")
				.short('h')
				.long("help")
				.help("Print help")
				.action(ArgAction::HelpLong),
		)
		.arg(
			Arg::new(options::APPEND)
				.long(options::APPEND)
				.short('a')
				.help("append to the given FILEs, do not overwrite")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::IGNORE_INTERRUPTS)
				.long(options::IGNORE_INTERRUPTS)
				.short('i')
				.help("ignore interrupt signals (accepted without installing a process-global handler)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::FILE)
				.action(ArgAction::Append)
				.value_hint(clap::ValueHint::FilePath)
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(options::IGNORE_PIPE_ERRORS)
				.short('p')
				.help("diagnose errors writing to non pipes")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::OUTPUT_ERROR)
				.long(options::OUTPUT_ERROR)
				.require_equals(true)
				.num_args(0..=1)
				.default_missing_value("warn-nopipe")
				.value_parser([
					PossibleValue::new("warn").help("diagnose errors writing to any output"),
					PossibleValue::new("warn-nopipe")
						.help("diagnose errors writing to any output not a pipe"),
					PossibleValue::new("exit").help("exit on error writing to any output"),
					PossibleValue::new("exit-nopipe")
						.help("exit on error writing to any output not a pipe"),
				])
				.help("set behavior on write error"),
		)
}

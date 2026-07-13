// Program entry point and CLI processing
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

pub mod command;
pub mod compiler;
pub mod delimited_parser;
pub mod error_handling;
pub mod fast_io;
pub mod fast_regex;
pub mod in_place;
pub mod named_writer;
pub mod processor;
pub mod script_char_provider;
pub mod script_line_provider;

use std::{collections::HashMap, ffi::OsString, path::PathBuf};

use clap::{Arg, ArgMatches, Command, arg, crate_version};
use pi_uutils_ctx::format_usage;
use uucore::error::{UResult, UUsageError};

use crate::sed::{
	command::{ProcessingContext, StringSpace},
	compiler::compile,
	processor::process_all_files,
	script_line_provider::ScriptValue,
};

const ABOUT: &str = "Stream editor for filtering and transforming text";
const USAGE: &str = "sed [OPTION]... [script] [file]...";

// Patched for pi-uutils-ctx embedding: upstream's `#[uucore::main] uumain`
// (which printed help to the process stdout and called `std::process::exit`)
// is replaced by this plain function; argument parsing, the no-args help
// path, and exit-code mapping live in the crate-level `run` wrapper.
pub fn sed_main(matches: &ArgMatches) -> UResult<()> {
	let (scripts, files) = get_scripts_files(matches)?;
	let mut context = build_context(matches);

	let executable = compile(scripts, &mut context)?;
	process_all_files(executable, files, &mut context)?;
	Ok(())
}

// pi-uutils: normalize the BSD/macOS `sed -i ''` idiom before clap parsing,
// following uu-stat's `rewrite_bsd_invocation` precedent.
/// Normalize GNU's attached `-i` backup suffixes and BSD's empty backup
/// suffix. GNU sed's `-i` takes its optional suffix only when directly
/// attached, so a separate non-empty token must stay a script/file operand;
/// scanning stops at `--`.
pub fn normalize_args(argv: Vec<OsString>) -> Vec<OsString> {
	let mut out = Vec::with_capacity(argv.len());
	let mut iter = argv.into_iter().peekable();
	// argv[0] is the command name; never rewritten.
	if let Some(first) = iter.next() {
		out.push(first);
	}
	let mut past_separator = false;
	while let Some(arg) = iter.next() {
		if !past_separator {
			if arg == "--" {
				past_separator = true;
			} else if is_in_place_flag(&arg) && iter.peek().is_some_and(|next| next.is_empty()) {
				// BSD `-i ''` means in-place without a backup, matching GNU
				// bare `-i`; the empty token would otherwise become SCRIPT.
				out.push(arg);
				iter.next();
				continue;
			} else if let Some(s) = arg.to_str()
				&& let Some(suffix) = s.strip_prefix("-i")
				&& !suffix.is_empty()
				&& !suffix.starts_with('=')
			{
				out.push(format!("-i={suffix}").into());
				continue;
			}
		}
		out.push(arg);
	}
	out
}

/// Whether `arg` is a clap-supported short-flag cluster ending in `-i`.
fn is_in_place_flag(arg: &OsString) -> bool {
	let Some(cluster) = arg.to_str().and_then(|arg| arg.strip_prefix('-')) else {
		return false;
	};
	let Some(prefix) = cluster.strip_suffix('i') else {
		return false;
	};

	!cluster.is_empty()
		&& !cluster.starts_with('-')
		&& prefix
			.chars()
			.all(|flag| matches!(flag, 'a' | 'E' | 'r' | 'n' | 's' | 'u' | 'z'))
}

#[allow(clippy::cognitive_complexity)]
pub fn uu_app() -> Command {
	let util_name = "sed";

	Command::new(util_name)
		.version(crate_version!())
		.about(ABOUT)
		.override_usage(format_usage(USAGE))
		.args_override_self(true)
		.infer_long_args(true)
		.args([
			arg!([script] "Script to execute if not otherwise provided."),
			Arg::new("file")
				.help("Input files")
				.value_parser(clap::value_parser!(PathBuf))
				.num_args(0..),
			Arg::new("all-output-files")
				.long("all-output-files")
				.short('a')
				.help("Create or truncate all output files before processing.")
				.action(clap::ArgAction::SetTrue),
			arg!(--debug "Annotate program execution."),
			Arg::new("regexp-extended")
				.short('E')
				.long("regexp-extended")
				.short_alias('r')
				.help("Use extended regular expressions.")
				.action(clap::ArgAction::SetTrue),
			arg!(-e --expression <SCRIPT> "Add script to executed commands.")
				.action(clap::ArgAction::Append),
			// Access with .get_many::<PathBuf>("file")
			Arg::new("script-file")
				.short('f')
				.long("script-file")
				.help("Specify script file.")
				.value_parser(clap::value_parser!(PathBuf))
				.action(clap::ArgAction::Append),
			Arg::new("follow-symlinks")
				.long("follow-symlinks")
				.help("Follow symlinks when processing in place.")
				.action(clap::ArgAction::SetTrue),
			// Access with .get_one::<String>("in-place")
			Arg::new("in-place")
				.short('i')
				.long("in-place")
				.help("Edit files in place, making a backup if SUFFIX is supplied.")
				.num_args(0..=1)
				// Patched: GNU sed only accepts the backup suffix attached
				// (`-i.bak`, `--in-place=.bak`); without this clap would eat
				// the following script/file operand as the suffix.
				.require_equals(true)
				.default_missing_value(""),
			// Access with .get_one::<u32>("line-length")
			arg!(-l --length <NUM> "Specify the 'l' command line-wrap length.")
				.value_parser(clap::value_parser!(u32)),
			arg!(-n --quiet "Suppress automatic printing of pattern space.").aliases(["silent"]),
			arg!(--posix "Disable non-POSIX extensions."),
			arg!(-s --separate "Consider files as separate rather than as a long stream."),
			arg!(--sandbox "Operate in a sandbox by disabling e/r/w commands."),
			arg!(-u --unbuffered "Load minimal input data and flush output buffers regularly."),
			Arg::new("null-data")
				.short('z')
				.long("null-data")
				.help("Separate lines by NUL characters.")
				.action(clap::ArgAction::SetTrue),
		])
}

// Iterate through script and file arguments specified in matches and
// return vectors of all scripts and input files in the specified order.
// If no script is specified fail with "missing script" error.
fn get_scripts_files(matches: &ArgMatches) -> UResult<(Vec<ScriptValue>, Vec<PathBuf>)> {
	let mut indexed_scripts: Vec<(usize, ScriptValue)> = Vec::new();
	let mut files: Vec<PathBuf> = Vec::new();

	let script_through_options =
        // The specification of a script: through a string or a file.
        matches.contains_id("expression") || matches.contains_id("script-file");

	if script_through_options {
		// Second and third POSIX usage cases; clap script arg is actually an input file
		// sed [-En] -e script [-e script]... [-f script_file]... [file...]
		// sed [-En] [-e script]... -f script_file [-f script_file]... [file...]
		if let Some(val) = matches.get_one::<String>("script") {
			files.push(PathBuf::from(val.to_owned()));
		}
	} else {
		// First POSIX spec usage case; script is the first arg.
		// sed [-En] script [file...]
		if let Some(val) = matches.get_one::<String>("script") {
			indexed_scripts.push((0, ScriptValue::StringVal(val.to_owned())));
		} else {
			return Err(UUsageError::new(1, "missing script"));
		}
	}

	// Capture -e occurrences (STRING)
	if let Some(indices) = matches.indices_of("expression") {
		for (idx, val) in indices.zip(matches.get_many::<String>("expression").unwrap_or_default()) {
			indexed_scripts.push((idx, ScriptValue::StringVal(val.to_owned())));
		}
	}

	// Capture -f occurrences (FILE)
	if let Some(indices) = matches.indices_of("script-file") {
		for (idx, val) in indices.zip(
			matches
				.get_many::<PathBuf>("script-file")
				.unwrap_or_default(),
		) {
			indexed_scripts.push((idx, ScriptValue::PathVal(val.to_owned())));
		}
	}

	// Sort by index to preserve argument order.
	indexed_scripts.sort_by_key(|k| k.0);
	// Keep only the values.
	let scripts = indexed_scripts
		.into_iter()
		.map(|(_, value)| value)
		.collect();

	let rest_files: Vec<PathBuf> = matches
		.get_many::<PathBuf>("file")
		.unwrap_or_default()
		.cloned()
		.collect();
	if !rest_files.is_empty() {
		files.extend(rest_files);
	}

	// Read from stdin if no file has been specified.
	if files.is_empty() {
		files.push(PathBuf::from("-"));
	}

	Ok((scripts, files))
}

// Parse CLI flag arguments and return a ProcessingContext struct based on them
fn build_context(matches: &ArgMatches) -> ProcessingContext {
	ProcessingContext {
		all_output_files: matches.get_flag("all-output-files"),
		debug:            matches.get_flag("debug"),
		regex_extended:   matches.get_flag("regexp-extended"),
		follow_symlinks:  matches.get_flag("follow-symlinks"),
		in_place:         matches.contains_id("in-place"),
		in_place_suffix:  matches
			.get_one::<String>("in-place")
			.and_then(|s| if s.is_empty() { None } else { Some(s.clone()) }),
		length:           matches.get_one::<u32>("length").map_or(70, |v| *v as usize),
		quiet:            matches.get_flag("quiet"),
		posix:            matches.get_flag("posix"),
		separate:         matches.get_flag("separate"),
		sandbox:          matches.get_flag("sandbox"),
		unbuffered:       matches.get_flag("unbuffered"),
		null_data:        matches.get_flag("null-data"),

		// Other context
		input_name:           "<stdin>".to_string(),
		line_number:          0,
		last_address:         false,
		last_line:            false,
		last_file:            false,
		stop_processing:      false,
		saved_regex:          None,
		input_action:         None,
		hold:                 StringSpace { content: String::new(), has_newline: true },
		parsed_block_nesting: 0,
		label_to_command_map: HashMap::new(),
		range_commands:       Vec::new(),
		substitution_made:    false,
		append_elements:      Vec::new(),
	}
}

#[cfg(test)]
mod tests {
	use super::*; // Allows access to private functions/items in this module

	// get_scripts_files

	// Helper function for supplying arguments
	fn get_test_matches(args: &[&str]) -> ArgMatches {
		uu_app()
			.try_get_matches_from(["myapp"].iter().chain(args.iter()))
			.expect("test args parse")
	}

	#[test]
	fn test_script_as_first_argument() {
		let matches = get_test_matches(&["1d", "file1.txt"]);
		let (scripts, files) = get_scripts_files(&matches).expect("Should succeed");

		assert_eq!(scripts, vec![ScriptValue::StringVal("1d".to_string())]);
		assert_eq!(files, vec![PathBuf::from("file1.txt")]);
	}

	#[test]
	fn test_expression_argument() {
		let matches = get_test_matches(&["-e", "s/foo/bar/", "file1.txt"]);
		let (scripts, files) = get_scripts_files(&matches).expect("Should succeed");

		assert_eq!(scripts, vec![ScriptValue::StringVal("s/foo/bar/".to_string())]);
		assert_eq!(files, vec![PathBuf::from("file1.txt")]);
	}

	#[test]
	fn test_script_file_argument() {
		let matches = get_test_matches(&["-f", "script.sed", "file1.txt"]);
		let (scripts, files) = get_scripts_files(&matches).expect("Should succeed");

		assert_eq!(scripts, vec![ScriptValue::PathVal(PathBuf::from("script.sed"))]);
		assert_eq!(files, vec![PathBuf::from("file1.txt")]);
	}

	#[test]
	fn test_multiple_files() {
		let matches = get_test_matches(&["-e", "s/foo/bar/", "file1.txt", "file2.txt"]);
		let (scripts, files) = get_scripts_files(&matches).expect("Should succeed");

		assert_eq!(scripts, vec![ScriptValue::StringVal("s/foo/bar/".to_string())]);
		assert_eq!(files, vec![PathBuf::from("file1.txt"), PathBuf::from("file2.txt")]);
	}

	#[test]
	fn test_multiple_files_script() {
		let matches = get_test_matches(&["s/foo/bar/", "file1.txt", "file2.txt"]);
		let (scripts, files) = get_scripts_files(&matches).expect("Should succeed");

		assert_eq!(scripts, vec![ScriptValue::StringVal("s/foo/bar/".to_string())]);
		assert_eq!(files, vec![PathBuf::from("file1.txt"), PathBuf::from("file2.txt")]);
	}

	#[test]
	fn test_stdin_when_no_files() {
		let matches = get_test_matches(&["-e", "s/foo/bar/"]);
		let (scripts, files) = get_scripts_files(&matches).expect("Should succeed");

		assert_eq!(scripts, vec![ScriptValue::StringVal("s/foo/bar/".to_string())]);
		assert_eq!(files, vec![PathBuf::from("-")]); // Stdin should be used
	}

	#[test]
	fn test_stdin_when_no_files_script() {
		let matches = get_test_matches(&["s/foo/bar/"]);
		let (scripts, files) = get_scripts_files(&matches).expect("Should succeed");

		assert_eq!(scripts, vec![ScriptValue::StringVal("s/foo/bar/".to_string())]);
		assert_eq!(files, vec![PathBuf::from("-")]); // Stdin should be used
	}

	// build_context
	fn test_matches(args: &[&str]) -> ArgMatches {
		let argv = normalize_args(
			["sed"]
				.into_iter()
				.chain(args.iter().copied())
				.map(std::ffi::OsString::from)
				.collect(),
		);
		uu_app()
			.try_get_matches_from(argv)
			.expect("test args parse")
	}

	#[test]
	fn test_defaults() {
		let matches = test_matches(&[]);
		let ctx = build_context(&matches);

		assert!(!ctx.all_output_files);
		assert!(!ctx.debug);
		assert!(!ctx.regex_extended);
		assert!(!ctx.follow_symlinks);
		assert!(!ctx.in_place);
		assert_eq!(ctx.in_place_suffix, None);
		assert_eq!(ctx.length, 70);
		assert!(!ctx.quiet);
		assert!(!ctx.posix);
		assert!(!ctx.separate);
		assert!(!ctx.sandbox);
		assert!(!ctx.unbuffered);
		assert!(!ctx.null_data);
	}

	#[test]
	fn test_all_flags() {
		let matches = test_matches(&[
			"--all-output-files",
			"--debug",
			"-E",
			"--follow-symlinks",
			"-i",
			"-l",
			"80",
			"-n",
			"--posix",
			"-s",
			"--sandbox",
			"-u",
			"-z",
		]);

		let ctx = build_context(&matches);

		assert!(ctx.all_output_files);
		assert!(ctx.debug);
		assert!(ctx.regex_extended);
		assert!(ctx.follow_symlinks);
		assert!(ctx.in_place);
		assert!(ctx.in_place_suffix.is_none());
		assert_eq!(ctx.length, 80);
		assert!(ctx.quiet);
		assert!(ctx.posix);
		assert!(ctx.separate);
		assert!(ctx.sandbox);
		assert!(ctx.unbuffered);
		assert!(ctx.null_data);
	}

	#[test]
	fn test_multiple_same_arguments() {
		let matches = test_matches(&["-E", "-r"]);
		let ctx = build_context(&matches);

		assert!(ctx.regex_extended);
	}

	#[test]
	fn test_in_place_with_suffix() {
		let matches = test_matches(&["-i.bak"]);
		let ctx = build_context(&matches);

		assert!(ctx.in_place);
		assert_eq!(ctx.in_place_suffix, Some(".bak".to_string()));
	}

	#[test]
	fn test_bsd_empty_in_place_suffix_with_short_flag_cluster() {
		// clap accepts `-Ei` as `-E -i`, so the BSD empty suffix must be
		// removed from this valid GNU flag cluster as well.
		let matches = test_matches(&["-Ei", "", "s/x/y/", "file.txt"]);
		let ctx = build_context(&matches);

		assert!(ctx.regex_extended);
		assert!(ctx.in_place);
		assert_eq!(ctx.in_place_suffix, None);
		let (scripts, files) = get_scripts_files(&matches).expect("BSD invocation parses");
		assert_eq!(scripts, vec![ScriptValue::StringVal("s/x/y/".to_string())]);
		assert_eq!(files, vec![PathBuf::from("file.txt")]);
	}

	#[test]
	fn test_nonempty_token_after_in_place_is_not_consumed() {
		let argv = ["sed", "-i", ".bak", "s/x/y/", "file.txt"]
			.into_iter()
			.map(std::ffi::OsString::from)
			.collect();
		let actual = normalize_args(argv);
		let expected = ["sed", "-i", ".bak", "s/x/y/", "file.txt"]
			.into_iter()
			.map(std::ffi::OsString::from)
			.collect::<Vec<_>>();

		assert_eq!(actual, expected);
	}

	#[test]
	fn test_length_default_and_custom() {
		let matches_default = test_matches(&[]);
		let matches_custom = test_matches(&["-l", "120"]);

		let ctx_default = build_context(&matches_default);
		let ctx_custom = build_context(&matches_custom);

		assert_eq!(ctx_default.length, 70);
		assert_eq!(ctx_custom.length, 120);
	}
}

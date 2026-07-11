// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) fullname

// pi-uutils: Patched for in-process embedding in the shell.
// All I/O is routed through thread-local stream buffers provided by
// `pi-uutils-ctx`. Command-line arguments are parsed and errors are mapped
// without process-global termination or stdout/stderr pollution.

use std::{ffi::OsString, io::Write, path::PathBuf};

use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};
use pi_uutils_ctx::format_usage;
use uucore::{
	display::Quotable,
	error::{UResult, UUsageError},
	line_ending::LineEnding,
};

pub mod options {
	pub static MULTIPLE: &str = "multiple";
	pub static NAME: &str = "name";
	pub static SUFFIX: &str = "suffix";
	pub static ZERO: &str = "zero";
}

/// In-process builtin entry point. Unlike upstream's `uumain`, this parses the
/// arguments directly (without the uucore clap-localization helper that would
/// terminate the process), renders clap help/usage/version to the context
/// streams, and maps the `UResult` to an exit code, so it is safe to run inside
/// the host shell process.
pub fn run(argv: Vec<OsString>) -> i32 {
	let matches = match uu_app().try_get_matches_from(argv) {
		Ok(matches) => matches,
		Err(err) => {
			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(pi_uutils_ctx::stderr(), "{rendered}");
				return 1;
			}
			let _ = write!(pi_uutils_ctx::stdout(), "{rendered}");
			return 0;
		},
	};
	match basename_main(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let _ = writeln!(pi_uutils_ctx::stderr(), "basename: {err}");
			if code == 0 { 1 } else { code }
		},
	}
}

fn basename_main(matches: &ArgMatches) -> UResult<()> {
	let line_ending = LineEnding::from_zero_flag(matches.get_flag(options::ZERO));

	let mut name_args = matches
		.get_many::<OsString>(options::NAME)
		.unwrap_or_default()
		.collect::<Vec<_>>();
	if name_args.is_empty() {
		return Err(UUsageError::new(1, "missing operand".to_string()));
	}
	let multiple_paths =
		matches.get_one::<OsString>(options::SUFFIX).is_some() || matches.get_flag(options::MULTIPLE);
	let suffix = if multiple_paths {
		matches
			.get_one::<OsString>(options::SUFFIX)
			.cloned()
			.unwrap_or_default()
	} else {
		// "simple format"
		match name_args.len() {
			0 => panic!("already checked"),
			1 => OsString::default(),
			2 => name_args.pop().unwrap().clone(),
			_ => {
				return Err(UUsageError::new(1, format!("extra operand {}", name_args[2].quote())));
			},
		}
	};

	//
	// Main Program Processing
	//
	let mut out = pi_uutils_ctx::stdout();
	for path in name_args {
		out.write_all(&basename(path, &suffix)?)?;
		write!(out, "{line_ending}")?;
	}

	Ok(())
}

pub fn uu_app() -> Command {
	Command::new("basename")
		.version(uucore::crate_version!())
		.about(
			"Print NAME with any leading directory components removed\nIf specified, also remove a \
			 trailing SUFFIX",
		)
		.override_usage(format_usage("basename [-z] NAME [SUFFIX]\n  basename OPTION... NAME..."))
		.infer_long_args(true)
		.arg(
			Arg::new(options::MULTIPLE)
				.short('a')
				.long(options::MULTIPLE)
				.help("support multiple arguments and treat each as a NAME")
				.action(ArgAction::SetTrue)
				.overrides_with(options::MULTIPLE),
		)
		.arg(
			Arg::new(options::NAME)
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::AnyPath)
				.hide(true)
				.trailing_var_arg(true),
		)
		.arg(
			Arg::new(options::SUFFIX)
				.short('s')
				.long(options::SUFFIX)
				.value_name("SUFFIX")
				.value_parser(ValueParser::os_string())
				.help("remove a trailing SUFFIX; implies -a")
				.overrides_with(options::SUFFIX),
		)
		.arg(
			Arg::new(options::ZERO)
				.short('z')
				.long(options::ZERO)
				.help("end each output line with NUL, not newline")
				.action(ArgAction::SetTrue)
				.overrides_with(options::ZERO),
		)
}

// We return a Vec<u8>. Returning a seemingly more proper `OsString` would
// require back and forth conversions as we need a &[u8] for printing anyway.
fn basename(fullname: &OsString, suffix: &OsString) -> UResult<Vec<u8>> {
	let fullname_bytes = uucore::os_str_as_bytes(fullname)?;

	// Handle special case where path ends with /.
	if fullname_bytes.ends_with(b"/.") {
		return Ok(b".".into());
	}

	// Convert to path buffer and get last path component
	let pb = PathBuf::from(fullname);

	pb.components().next_back().map_or(Ok([].into()), |c| {
		let name = c.as_os_str();
		let name_bytes = uucore::os_str_as_bytes(name)?;
		if name == suffix {
			Ok(name_bytes.into())
		} else {
			let suffix_bytes = uucore::os_str_as_bytes(suffix)?;
			Ok(name_bytes
				.strip_suffix(suffix_bytes)
				.unwrap_or(name_bytes)
				.into())
		}
	})
}

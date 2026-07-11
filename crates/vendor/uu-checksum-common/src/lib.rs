// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.
//
// pi-uutils: vendored from uutils/coreutils 0.8.0 checksum_common and patched
// to use invocation-scoped I/O and cwd resolution for in-process builtins.

use std::{borrow::Borrow, cell::RefCell, ffi::OsString, io::Write};

use clap::{Arg, ArgAction, ArgMatches, Command, ValueHint, builder::ValueParser};
use uucore::{
	checksum::{AlgoKind, ChecksumError, SizedAlgoKind},
	error::{UError, UResult},
	line_ending::LineEnding,
};

mod cli;
mod compute;
mod validate;
pub use cli::{ChecksumCommand, options};
pub use compute::{ChecksumComputeOptions, DigestFormat, OutputFormat};
pub use validate::{ChecksumValidateOptions, ChecksumVerbose};

thread_local! {
	 static COMMAND_NAME: RefCell<&'static str> = const { RefCell::new("checksum") };
}

pub(crate) fn command_name() -> &'static str {
	COMMAND_NAME.with(|name| *name.borrow())
}

pub(crate) fn report_error(error: &dyn std::fmt::Display) {
	let _ = writeln!(pi_uutils_ctx::stderr(), "{}: {error}", command_name());
	pi_uutils_ctx::set_exit_code(1);
}

pub(crate) fn report_warning(message: &str) {
	let _ = writeln!(pi_uutils_ctx::stderr(), "{}: {message}", command_name());
}

/// Generate a context-safe standalone checksum wrapper.
#[macro_export]
macro_rules! declare_standalone {
	($bin:literal, $kind:expr) => {
		pub fn run(argv: Vec<::std::ffi::OsString>) -> i32 {
			::uu_checksum_common::run_standalone($bin, $kind, uu_app(), argv)
		}

		#[inline]
		pub fn uu_app() -> ::clap::Command {
			let (about, usage) = ::uu_checksum_common::standalone_strings($bin);
			::uu_checksum_common::standalone_checksum_app(about, usage).name($bin)
		}
	};
}

/// English descriptions used by standalone wrappers (localization is
/// intentionally literalized because embedded commands have no global locale).
pub fn standalone_strings(bin: &str) -> (&'static str, &'static str) {
	match bin {
		"md5sum" => ("Print or check the MD5 checksums", "md5sum [OPTIONS] [FILE]..."),
		"sha1sum" => ("Print or check SHA1 (160-bit) checksums", "sha1sum [OPTION]... [FILE]..."),
		"sha224sum" => {
			("Print or check SHA224 (224-bit) checksums", "sha224sum [OPTION]... [FILE]...")
		},
		"sha256sum" => {
			("Print or check SHA256 (256-bit) checksums", "sha256sum [OPTION]... [FILE]...")
		},
		"sha384sum" => {
			("Print or check SHA384 (384-bit) checksums", "sha384sum [OPTION]... [FILE]...")
		},
		"sha512sum" => {
			("Print or check SHA512 (512-bit) checksums", "sha512sum [OPTION]... [FILE]...")
		},
		"b2sum" => ("Print or check BLAKE2b (512-bit) checksums", "b2sum [OPTION]... [FILE]..."),
		_ => ("Print or check checksums", "checksum [OPTION]... [FILE]..."),
	}
}

pub fn run_standalone(bin: &'static str, algo: AlgoKind, cmd: Command, argv: Vec<OsString>) -> i32 {
	run_with_optional_length(bin, algo, cmd, argv, None)
}

/// Context-safe entrypoint for b2sum and other standalone hashes supporting
/// `--length`. The validator is applied only when that option is present.
pub fn run_standalone_with_length(
	bin: &'static str,
	algo: AlgoKind,
	cmd: Command,
	argv: Vec<OsString>,
	validate_len: fn(&str) -> UResult<usize>,
) -> i32 {
	run_with_optional_length(bin, algo, cmd, argv, Some(validate_len))
}

fn run_with_optional_length(
	bin: &'static str,
	algo: AlgoKind,
	cmd: Command,
	argv: Vec<OsString>,
	validate_len: Option<fn(&str) -> UResult<usize>>,
) -> i32 {
	COMMAND_NAME.with(|name| *name.borrow_mut() = bin);
	let matches = match cmd.try_get_matches_from(argv) {
		Ok(matches) => matches,
		Err(err) => {
			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(pi_uutils_ctx::stderr(), "{rendered}");
				return 2;
			}
			let _ = write!(pi_uutils_ctx::stdout(), "{rendered}");
			return 0;
		},
	};
	let length = match validate_len {
		Some(validate_len) => match matches
			.get_one::<String>(options::LENGTH)
			.map(String::as_str)
			.map(validate_len)
			.transpose()
		{
			Ok(length) => length,
			Err(err) => return finish_error(bin, err),
		},
		None => None,
	};
	let text = !matches.get_flag(options::BINARY);
	let tag = matches.get_flag(options::TAG);
	let format = OutputFormat::from_standalone(text, tag);
	match checksum_main(Some(algo), length, matches, format) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => finish_error(bin, err),
	}
}

fn finish_error(bin: &str, err: Box<dyn UError>) -> i32 {
	let code = err.code();
	let message = err.to_string();
	if !message.is_empty() {
		let _ = writeln!(pi_uutils_ctx::stderr(), "{bin}: {message}");
	}
	if code == 0 { 1 } else { code }
}

pub fn default_checksum_app(about: impl Into<String>, usage: impl Into<String>) -> Command {
	Command::new("")
		.version("0.8.0")
		.about(about.into())
		.override_usage(usage.into())
		.infer_long_args(true)
		.args_override_self(true)
		.after_help("With no FILE or when FILE is -, read standard input")
		.arg(
			Arg::new(options::FILE)
				.hide(true)
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string())
				.default_value("-")
				.hide_default_value(true)
				.value_hint(ValueHint::FilePath),
		)
}

pub fn standalone_checksum_app_with_length(
	about: impl Into<String>,
	usage: impl Into<String>,
) -> Command {
	default_checksum_app(about, usage)
		.with_binary()
		.with_check_and_opts()
		.with_length()
		.with_tag(false)
		.with_text(true)
		.with_zero()
}

pub fn standalone_checksum_app(about: impl Into<String>, usage: impl Into<String>) -> Command {
	default_checksum_app(about, usage)
		.with_binary()
		.with_check_and_opts()
		.with_tag(false)
		.with_text(true)
		.with_zero()
}

pub fn checksum_main(
	algo: Option<AlgoKind>,
	length: Option<usize>,
	matches: ArgMatches,
	output_format: OutputFormat,
) -> UResult<()> {
	let check = matches.get_flag(options::CHECK);
	let check_flag = |flag| match (check, matches.get_flag(flag)) {
		(_, false) => Ok(false),
		(true, true) => Ok(true),
		(false, true) => Err(ChecksumError::CheckOnlyFlag(flag.into())),
	};
	let ignore_missing = check_flag(options::IGNORE_MISSING)?;
	let warn = check_flag(options::WARN)?;
	let quiet = check_flag(options::QUIET)?;
	let strict = check_flag(options::STRICT)?;
	let status = check_flag(options::STATUS)?;
	let text_flag = matches.get_flag(options::TEXT);
	let binary_flag = matches.get_flag(options::BINARY);
	let tag = matches.get_flag(options::TAG);
	let files = matches
		.get_many::<OsString>(options::FILE)
		.unwrap()
		.map(Borrow::borrow);

	if text_flag && tag {
		return Err(ChecksumError::TextAfterTag.into());
	}
	if check {
		if algo.is_some_and(AlgoKind::is_legacy) {
			return Err(ChecksumError::AlgorithmNotSupportedWithCheck.into());
		}
		if tag {
			return Err(ChecksumError::TagCheck.into());
		}
		if binary_flag || text_flag {
			return Err(ChecksumError::BinaryTextConflict.into());
		}
		let opts = ChecksumValidateOptions {
			ignore_missing,
			strict,
			verbose: ChecksumVerbose::new(status, quiet, warn),
		};
		return validate::perform_checksum_validation(files, algo, length, opts);
	}

	let algo = SizedAlgoKind::from_unsized(algo.unwrap_or(AlgoKind::Crc), length)?;
	let opts = ChecksumComputeOptions {
		algo_kind: algo,
		output_format,
		line_ending: LineEnding::from_zero_flag(matches.get_flag(options::ZERO)),
	};
	compute::perform_checksum_computation(opts, files)
}

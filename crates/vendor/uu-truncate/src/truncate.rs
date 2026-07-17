// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) RFILE refsize rfilename fsize tsize

// pi-uutils: vendored from uutils/coreutils 0.8.0 and patched to run in-process
// as a shell builtin. Every filesystem syscall resolves its path operand
// against the shell working directory via `pi_uutils_ctx::resolve` AT THE CALL
// SITE, while the original operands are kept for display/error messages (GNU
// prints operands as typed). All process-global stdio is routed through
// `pi_uutils_ctx`, `translate!` strings are literalized, per-file errors are
// reported through the context stderr with `set_exit_code` (continue-on-error
// like GNU truncate), and the entry point no longer calls `std::process::exit`.

#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;
use std::{
	ffi::OsString,
	fs::{OpenOptions, metadata},
	io::{ErrorKind, Write},
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use pi_uutils_ctx::format_usage;
use uucore::{
	display::Quotable,
	error::{FromIo, UResult, USimpleError, UUsageError},
	parser::parse_size::{ParseSizeError, Parser, allow_list_with_all_suffixes},
};

#[derive(Debug, Eq, PartialEq)]
enum TruncateMode {
	Absolute(u64),
	Extend(u64),
	Reduce(u64),
	AtMost(u64),
	AtLeast(u64),
	RoundDown(u64),
	RoundUp(u64),
}

impl TruncateMode {
	/// Compute a target size in bytes for this truncate mode.
	///
	/// `fsize` is the size of the reference file, in bytes.
	///
	/// If the mode is [`TruncateMode::Reduce`] and the value to
	/// reduce by is greater than `fsize`, then this function returns
	/// 0 (since it cannot return a negative number).
	///
	/// # Returns
	///
	/// `None` if rounding by 0, else the target size.
	fn to_size(&self, fsize: u64) -> Option<u64> {
		match self {
			Self::Absolute(size) => Some(*size),
			Self::Extend(size) => Some(fsize + size),
			Self::Reduce(size) => Some(fsize.saturating_sub(*size)),
			Self::AtMost(size) => Some(fsize.min(*size)),
			Self::AtLeast(size) => Some(fsize.max(*size)),
			Self::RoundDown(size) => fsize.checked_rem(*size).map(|remainder| fsize - remainder),
			Self::RoundUp(size) => fsize.checked_next_multiple_of(*size),
		}
	}

	/// Determine if mode is absolute
	///
	/// # Returns
	///
	/// `true` is self matches Self::Absolute(_), `false` otherwise.
	fn is_absolute(&self) -> bool {
		matches!(self, Self::Absolute(_))
	}
}

pub mod options {
	pub static IO_BLOCKS: &str = "io-blocks";
	pub static NO_CREATE: &str = "no-create";
	pub static REFERENCE: &str = "reference";
	pub static SIZE: &str = "size";
	pub static ARG_FILES: &str = "files";
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
	match truncate_main(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			// pi-uutils: don't emit a dangling "truncate: " prefix when the
			// error renders to an empty message.
			let msg = err.to_string();
			if !msg.is_empty() {
				let _ = writeln!(pi_uutils_ctx::stderr(), "truncate: {msg}");
			}
			if code == 0 { 1 } else { code }
		},
	}
}

fn truncate_main(matches: &ArgMatches) -> UResult<()> {
	let files: Vec<OsString> = matches
		.get_many::<OsString>(options::ARG_FILES)
		.map(|v| v.cloned().collect())
		.unwrap_or_default();

	if files.is_empty() {
		Err(UUsageError::new(1, "missing file operand".to_string()))
	} else {
		let io_blocks = matches.get_flag(options::IO_BLOCKS);
		let no_create = matches.get_flag(options::NO_CREATE);
		let reference = matches
			.get_one::<String>(options::REFERENCE)
			.map(String::from);
		let size = matches.get_one::<String>(options::SIZE).map(String::from);
		truncate(no_create, io_blocks, reference, size, &files)
	}
}

pub fn uu_app() -> Command {
	Command::new("truncate")
		.version(uucore::crate_version!())
		.about("Shrink or extend the size of each file to the specified size.")
		.override_usage(format_usage("truncate [OPTION]... [FILE]..."))
		.after_help(
			"SIZE is an integer with an optional prefix and optional unit.\nThe available units (K, \
			 M, G, T, P, E, Z, and Y) use the following format:\n    'KB' => 1000 (kilobytes)\n    \
			 'K' => 1024 (kibibytes)\n    'MB' => 1000*1000 (megabytes)\n    'M' => 1024*1024 \
			 (mebibytes)\n    'GB' => 1000*1000*1000 (gigabytes)\n    'G' => 1024*1024*1024 \
			 (gibibytes)\nSIZE may also be prefixed by one of the following to adjust the size of \
			 each\nfile based on its current size:\n    '+' => extend by\n    '-' => reduce by\n    \
			 '<' => at most\n    '>' => at least\n    '/' => round down to multiple of\n    '%' => \
			 round up to multiple of",
		)
		.infer_long_args(true)
		.arg(
			Arg::new(options::IO_BLOCKS)
				.short('o')
				.long(options::IO_BLOCKS)
				.help(
					"treat SIZE as the number of I/O blocks of the file rather than bytes (NOT \
					 IMPLEMENTED)",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_CREATE)
				.short('c')
				.long(options::NO_CREATE)
				.help("do not create files that do not exist")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::REFERENCE)
				.short('r')
				.long(options::REFERENCE)
				.required_unless_present(options::SIZE)
				.help("base the size of each file on the size of RFILE")
				.value_name("RFILE")
				.value_hint(clap::ValueHint::FilePath),
		)
		.arg(
			Arg::new(options::SIZE)
				.short('s')
				.long(options::SIZE)
				.required_unless_present(options::REFERENCE)
				.help(
					"set or adjust the size of each file according to SIZE, which is in bytes unless \
					 --io-blocks is specified",
				)
				.allow_hyphen_values(true)
				.value_name("SIZE"),
		)
		.arg(
			Arg::new(options::ARG_FILES)
				.value_name("FILE")
				.action(ArgAction::Append)
				.required(true)
				.value_hint(clap::ValueHint::FilePath)
				.value_parser(clap::value_parser!(OsString)),
		)
}

/// Truncate the named file to the specified size.
///
/// If `create` is true, then the file will be created if it does not
/// already exist. If `size` is larger than the number of bytes in the
/// file, then the file will be padded with zeros. If `size` is smaller
/// than the number of bytes in the file, then the file will be
/// truncated and any bytes beyond `size` will be lost.
///
/// # Errors
///
/// If the file could not be opened, or there was a problem setting the
/// size of the file.
fn do_file_truncate(filename: &OsString, create: bool, size: u64) -> UResult<()> {
	// pi-uutils: resolve the operand against the shell working directory at
	// the open site; `filename` is kept for the error message.
	let resolved = pi_uutils_ctx::resolve(filename);

	match OpenOptions::new()
		.write(true)
		.create(create)
		.open(&resolved)
	{
		Ok(file) => file.set_len(size),
		Err(e) if e.kind() == ErrorKind::NotFound && !create => Ok(()),
		Err(e) => Err(e),
	}
	.map_err_context(|| format!("cannot open {} for writing", filename.quote()))
}

fn file_truncate(
	no_create: bool,
	reference_size: Option<u64>,
	mode: &TruncateMode,
	filename: &OsString,
) -> UResult<()> {
	// pi-uutils: resolve the operand against the shell working directory at
	// the metadata site; `filename` is kept for the error message.
	let resolved = pi_uutils_ctx::resolve(filename);

	// Get the length of the file.
	let file_size = match metadata(&resolved) {
		Ok(metadata) => {
			// A pipe has no length. Do this check here to avoid duplicate `stat()` syscall.
			#[cfg(unix)]
			if metadata.file_type().is_fifo() {
				return Err(USimpleError::new(
					1,
					format!(
						"cannot open {} for writing: No such device or address",
						filename.to_string_lossy().quote()
					),
				));
			}
			metadata.len()
		},
		Err(_) => 0,
	};

	// The reference size can be either:
	//
	// 1. The size of a given file
	// 2. The size of the file to be truncated if no reference has been provided.
	let actual_reference_size = reference_size.unwrap_or(file_size);

	let Some(truncate_size) = mode.to_size(actual_reference_size) else {
		return Err(USimpleError::new(1, "division by zero".to_string()));
	};

	do_file_truncate(filename, !no_create, truncate_size)
}

fn truncate(
	no_create: bool,
	_: bool,
	reference: Option<String>,
	size: Option<String>,
	filenames: &[OsString],
) -> UResult<()> {
	let reference_size = match reference {
		Some(reference_path) => {
			// pi-uutils: resolve the reference operand against the shell
			// working directory; `reference_path` is kept for the message.
			let reference_metadata =
				metadata(pi_uutils_ctx::resolve(&reference_path)).map_err(|error| {
					match error.kind() {
						ErrorKind::NotFound => USimpleError::new(
							1,
							format!("cannot stat {}: No such file or directory", reference_path.quote()),
						),
						_ => error.map_err_context(String::new),
					}
				})?;

			Some(reference_metadata.len())
		},
		None => None,
	};

	let size_string = size.as_deref();

	// Omitting the mode is equivalent to extending a file by 0 bytes.
	let mode = match size_string {
		Some(string) => match parse_mode_and_size(string) {
			Err(error) => {
				return Err(USimpleError::new(1, format!("Invalid number: {error}")));
			},
			Ok(mode) => mode,
		},
		None => TruncateMode::Extend(0),
	};

	// If a reference file has been given, the truncate mode cannot be absolute.
	if reference_size.is_some() && mode.is_absolute() {
		return Err(USimpleError::new(
			1,
			"you must specify a relative '--size' with '--reference'".to_string(),
		));
	}

	for filename in filenames {
		// pi-uutils: upstream aborts on the first failing file; report the
		// error through the context stderr and continue with the remaining
		// operands (GNU behavior), accumulating the exit code.
		if let Err(err) = file_truncate(no_create, reference_size, &mode, filename) {
			let msg = err.to_string();
			if !msg.is_empty() {
				let _ = writeln!(pi_uutils_ctx::stderr(), "truncate: {msg}");
			}
			pi_uutils_ctx::set_exit_code(if err.code() == 0 { 1 } else { err.code() });
		}
	}

	Ok(())
}

/// Decide whether a character is one of the size modifiers, like '+' or '<'.
fn is_modifier(c: char) -> bool {
	c == '+' || c == '-' || c == '<' || c == '>' || c == '/' || c == '%'
}

/// Parse a size string with optional modifier symbol as its first character.
///
/// A size string is as described in [`Parser::parse_u64`]. The first character
/// of `size_string` might be a modifier symbol, like `'+'` or
/// `'<'`. The first element of the pair returned by this function
/// indicates which modifier symbol was present, or
/// [`TruncateMode::Absolute`] if none.
fn parse_mode_and_size(size_string: &str) -> Result<TruncateMode, ParseSizeError> {
	// Trim any whitespace.
	let mut size_string = size_string.trim();

	// Get the modifier character from the size string, if any. For
	// example, if the argument is "+123", then the modifier is '+'.
	if let Some(c) = size_string.chars().next() {
		if is_modifier(c) {
			size_string = &size_string[1..];
		}
		let allow_list = allow_list_with_all_suffixes("EgGkKmMPQRtTYZ");
		let allow_list_ref = allow_list.iter().map(AsRef::as_ref).collect::<Vec<&str>>();
		Parser::default()
			.with_allow_list(&allow_list_ref)
			.parse_u64(size_string)
			.map(match c {
				'+' => TruncateMode::Extend,
				'-' => TruncateMode::Reduce,
				'<' => TruncateMode::AtMost,
				'>' => TruncateMode::AtLeast,
				'/' => TruncateMode::RoundDown,
				'%' => TruncateMode::RoundUp,
				_ => TruncateMode::Absolute,
			})
	} else {
		Err(ParseSizeError::ParseFailure(size_string.to_string()))
	}
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};

	use parking_lot::Mutex;
	use pi_uutils_ctx::ScopeIo;

	use super::*;

	fn run_in(cwd: PathBuf, args: Vec<&str>) -> (i32, String, String) {
		let stdout_buf = Arc::new(Mutex::new(Vec::new()));
		let stderr_buf = Arc::new(Mutex::new(Vec::new()));

		#[derive(Clone)]
		struct SharedWriter {
			buf: Arc<Mutex<Vec<u8>>>,
		}
		impl Write for SharedWriter {
			fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
				self.buf.lock().write(buf)
			}

			fn flush(&mut self) -> std::io::Result<()> {
				self.buf.lock().flush()
			}
		}

		let io = ScopeIo {
			stdin: Box::new(std::io::empty()),
			stdin_fd: None,
			stdin_is_search_input: false,
			stdout: Box::new(SharedWriter { buf: stdout_buf.clone() }),
			stderr: Box::new(SharedWriter { buf: stderr_buf.clone() }),
			cwd,
			env: HashMap::new(),
			cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
		};

		let argv: Vec<OsString> = std::iter::once("truncate")
			.chain(args)
			.map(OsString::from)
			.collect();

		let code = pi_uutils_ctx::scope(io, || run(argv));

		let out_str = String::from_utf8(stdout_buf.lock().clone()).unwrap();
		let err_str = String::from_utf8(stderr_buf.lock().clone()).unwrap();

		(code, out_str, err_str)
	}

	/// Canonicalized temp dir (macOS tempdirs live behind /var -> /private/var).
	fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let canon = fs::canonicalize(dir.path()).unwrap();
		(dir, canon)
	}

	fn len(path: &PathBuf) -> u64 {
		fs::metadata(path).unwrap().len()
	}

	#[test]
	fn resolves_relative_operand_against_scope_cwd() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("f"), b"12345678").unwrap();

		// Relative operand + scope cwd differing from the process cwd: only the
		// call-site `pi_uutils_ctx::resolve` patch makes this find the file.
		let (code, stdout, stderr) = run_in(root.clone(), vec!["-s", "5", "f"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert_eq!(len(&root.join("f")), 5);
	}

	#[test]
	fn extend_grows_by_relative_amount() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("f"), b"1234").unwrap();

		let (code, _, stderr) = run_in(root.clone(), vec!["-s", "+3", "f"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(len(&root.join("f")), 7);
	}

	#[test]
	fn at_most_caps_only_larger_files() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("big"), vec![0u8; 20]).unwrap();
		fs::write(root.join("small"), b"abc").unwrap();

		let (code, _, stderr) = run_in(root.clone(), vec!["-s", "<10", "big", "small"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(len(&root.join("big")), 10);
		assert_eq!(len(&root.join("small")), 3);
	}

	#[test]
	fn no_create_skips_missing_file() {
		let (_dir, root) = canonical_tempdir();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["-c", "-s", "5", "missing"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert!(!root.join("missing").exists());
	}

	#[test]
	fn missing_file_without_no_create_is_created_at_size() {
		let (_dir, root) = canonical_tempdir();

		let (code, _, stderr) = run_in(root.clone(), vec!["-s", "9", "fresh"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(len(&root.join("fresh")), 9);
	}

	#[test]
	fn reference_copies_size_of_rfile() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("ref"), b"123456").unwrap();
		fs::write(root.join("f"), b"x").unwrap();

		let (code, _, stderr) = run_in(root.clone(), vec!["-r", "ref", "f"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(len(&root.join("f")), 6);
	}

	#[test]
	fn missing_reference_file_fails_with_stat_error() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("f"), b"x").unwrap();

		let (code, _, stderr) = run_in(root.clone(), vec!["-r", "nope", "f"]);
		assert_eq!(code, 1);
		assert!(stderr.contains("cannot stat 'nope': No such file or directory"));
		assert_eq!(len(&root.join("f")), 1, "operand must be untouched");
	}

	#[test]
	fn invalid_size_reports_error_and_exit_1() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("f"), b"x").unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["-s", "bogus", "f"]);
		assert_eq!((code, stdout.as_str()), (1, ""));
		assert!(stderr.contains("truncate: Invalid number:"));
		assert_eq!(len(&root.join("f")), 1, "operand must be untouched");
	}

	#[test]
	fn reference_with_absolute_size_is_rejected() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("ref"), b"123").unwrap();
		fs::write(root.join("f"), b"x").unwrap();

		let (code, _, stderr) = run_in(root.clone(), vec!["-r", "ref", "-s", "5", "f"]);
		assert_eq!(code, 1);
		assert!(stderr.contains("you must specify a relative '--size' with '--reference'"));
	}

	#[test]
	fn parse_mode_and_size_prefixes() {
		assert_eq!(parse_mode_and_size("10"), Ok(TruncateMode::Absolute(10)));
		assert_eq!(parse_mode_and_size("+10"), Ok(TruncateMode::Extend(10)));
		assert_eq!(parse_mode_and_size("-10"), Ok(TruncateMode::Reduce(10)));
		assert_eq!(parse_mode_and_size("<10"), Ok(TruncateMode::AtMost(10)));
		assert_eq!(parse_mode_and_size(">10"), Ok(TruncateMode::AtLeast(10)));
		assert_eq!(parse_mode_and_size("/10"), Ok(TruncateMode::RoundDown(10)));
		assert_eq!(parse_mode_and_size("%10"), Ok(TruncateMode::RoundUp(10)));
		assert_eq!(parse_mode_and_size("1kB"), Ok(TruncateMode::Absolute(1000)));
		assert!(parse_mode_and_size("1b").is_err());
	}

	#[test]
	fn help_renders_to_scope_stdout() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec!["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("round up to multiple of"));
		assert_eq!(stderr, "");
	}
}

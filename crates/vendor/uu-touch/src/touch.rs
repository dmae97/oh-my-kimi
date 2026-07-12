// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) datelike datetime filetime lpszfilepath mktime
// strtime timelike utime DATETIME UTIME futimens spell-checker:ignore (FORMATS)
// MMDDhhmm YYYYMMDDHHMM YYMMDDHHMM YYYYMMDDHHMMS

// pi-uutils: vendored from uutils/coreutils 0.8.0 and patched to run in-process
// as a shell builtin. Every filesystem syscall resolves its path operand
// against the shell working directory via `pi_uutils_ctx::resolve` AT THE CALL
// SITE, while the original operands are kept for display/error messages (GNU
// prints operands as typed). All process-global stdio is routed through
// `pi_uutils_ctx`, `translate!` strings are literalized, `_POSIX2_VERSION` is
// read from the scope environment, `show!` accumulation goes through
// `pi_uutils_ctx::set_exit_code`, and the entry point no longer calls
// `std::process::exit`. Upstream's `src/error.rs` is inlined below as
// `pub mod error`. jiff's `TimeZone::system()` (and thus `TZ`) intentionally
// stays process-global.

#[cfg(unix)]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
	borrow::Cow,
	ffi::{OsStr, OsString},
	fs::{self, File},
	io::{Error, ErrorKind, Write},
	path::{Path, PathBuf},
	time::SystemTime,
};

use clap::{
	Arg, ArgAction, ArgGroup, ArgMatches, Command,
	builder::{PossibleValue, ValueParser},
};
use filetime::{FileTime, set_file_times, set_symlink_file_times};
use jiff::{Timestamp, ToSpan, Zoned, civil::Time, fmt::strtime, tz::TimeZone};
#[cfg(unix)]
use libc::O_NONBLOCK;
use pi_uutils_ctx::format_usage;
#[cfg(unix)]
use rustix::fs::Timestamps;
#[cfg(unix)]
use rustix::fs::futimens;
#[cfg(target_os = "linux")]
use uucore::libc;
use uucore::{
	display::Quotable,
	error::{FromIo, UError, UResult, USimpleError},
	parser::shortcut_value_parser::ShortcutValueParser,
};

use crate::error::TouchError;

// pi-uutils: upstream `src/error.rs`, inlined so the vendored crate is a
// single source file. `translate!` message templates are literalized with the
// en-US strings.
pub mod error {
	use std::path::PathBuf;

	use filetime::FileTime;
	use thiserror::Error;
	use uucore::{
		display::Quotable,
		error::{UError, UIoError},
	};

	#[derive(Debug, Error)]
	pub enum TouchError {
		#[error("Unable to parse date: {0}")]
		InvalidDateFormat(String),

		/// The source time couldn't be converted to a [`jiff::Zoned`]
		#[error("Source has invalid access or modification time: {0}")]
		InvalidFiletime(FileTime),

		/// The reference file's attributes could not be found or read
		#[error("failed to get attributes of {}: {}", .0.quote(), to_uioerror(.1))]
		ReferenceFileInaccessible(PathBuf, std::io::Error),

		/// An error getting a path to stdout on Windows
		#[error("GetFinalPathNameByHandleW failed with code {0}")]
		WindowsStdoutPathError(String),

		/// An error encountered on a specific file
		#[error("{error}")]
		TouchFileError { path: PathBuf, index: usize, error: Box<dyn UError> },
	}

	fn to_uioerror(err: &std::io::Error) -> UIoError {
		let copy = if let Some(code) = err.raw_os_error() {
			std::io::Error::from_raw_os_error(code)
		} else {
			std::io::Error::from(err.kind())
		};
		UIoError::from(copy)
	}

	impl UError for TouchError {}
}

/// Options contains all the possible behaviors and flags for touch.
///
/// All options are public so that the options can be programmatically
/// constructed by other crates, such as nushell. That means that this struct is
/// part of our public API. It should therefore not be changed without good
/// reason.
///
/// The fields are documented with the arguments that determine their value.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct Options {
	/// Do not create any files. Set by `-c`/`--no-create`.
	pub no_create: bool,

	/// Affect each symbolic link instead of any referenced file. Set by
	/// `-h`/`--no-dereference`.
	pub no_deref: bool,

	/// Where to get access and modification times from
	pub source: Source,

	/// If given, uses time from `source` but on given date
	pub date: Option<String>,

	/// Whether to change access time only, modification time only, or both
	pub change_times: ChangeTimes,

	/// When true, error when file doesn't exist and either `--no-dereference`
	/// was passed or the file couldn't be created
	pub strict: bool,
}

pub enum InputFile {
	/// A regular file
	Path(PathBuf),
	/// Touch stdout. `--no-dereference` will be ignored in this case.
	Stdout,
}

/// Whether to set access time only, modification time only, or both
#[derive(Debug, Clone, Eq, PartialEq)]
pub enum ChangeTimes {
	/// Change only access time
	AtimeOnly,
	/// Change only modification time
	MtimeOnly,
	/// Change both access and modification times
	Both,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum Source {
	/// Use access/modification times of given file
	Reference(PathBuf),
	Timestamp(FileTime),
	/// Use current time
	Now,
}

pub mod options {
	// Both SOURCES and sources are needed as we need to be able to refer to the
	// ArgGroup.
	pub static SOURCES: &str = "sources";
	pub mod sources {
		pub static DATE: &str = "date";
		pub static REFERENCE: &str = "reference";
		pub static TIMESTAMP: &str = "timestamp";
	}
	pub static HELP: &str = "help";
	pub static ACCESS: &str = "access";
	pub static MODIFICATION: &str = "modification";
	pub static NO_CREATE: &str = "no-create";
	pub static NO_DEREF: &str = "no-dereference";
	pub static TIME: &str = "time";
	pub static FORCE: &str = "force";
}

static ARG_FILES: &str = "files";

mod format {
	pub(crate) const POSIX_LOCALE: &str = "%a %b %e %H:%M:%S %Y";
	pub(crate) const ISO_8601: &str = "%Y-%m-%d";
	// "%Y%m%d%H%M.%S" 15 chars
	pub(crate) const YYYYMMDDHHMM_DOT_SS: &str = "%Y%m%d%H%M.%S";
	// "%Y-%m-%d %H:%M:%S.%SS" 12 chars
	pub(crate) const YYYYMMDDHHMMSS: &str = "%Y-%m-%d %H:%M:%S.%f";
	// "%Y-%m-%d %H:%M:%S" 12 chars
	pub(crate) const YYYYMMDDHHMMS: &str = "%Y-%m-%d %H:%M:%S";
	// "%Y-%m-%d %H:%M" 12 chars
	// Used for example in tests/touch/no-rights.sh
	pub(crate) const YYYY_MM_DD_HH_MM: &str = "%Y-%m-%d %H:%M";
	// "%Y%m%d%H%M" 12 chars
	pub(crate) const YYYYMMDDHHMM: &str = "%Y%m%d%H%M";
	// "%Y-%m-%d %H:%M +offset"
	// Used for example in tests/touch/relative.sh
	pub(crate) const YYYYMMDDHHMM_OFFSET: &str = "%Y-%m-%d %H:%M %z";
}

fn timestamp_to_filetime(ts: Timestamp) -> FileTime {
	FileTime::from_system_time(SystemTime::from(ts))
}

fn filetime_to_zoned(ft: &FileTime) -> Option<Zoned> {
	let ts = Timestamp::new(ft.unix_seconds(), ft.nanoseconds() as i32).ok()?;
	Some(Zoned::new(ts, TimeZone::system()))
}

/// Whether all characters in the string are digits.
fn all_digits(s: &str) -> bool {
	s.as_bytes().iter().all(u8::is_ascii_digit)
}

/// Convert a two-digit year string to the corresponding number.
///
/// `s` must be of length two or more. The last two bytes of `s` are
/// assumed to be the two digits of the year.
fn get_year(s: &str) -> u8 {
	let bytes = s.as_bytes();
	let n = bytes.len();
	let y1 = bytes[n - 2] - b'0';
	let y2 = bytes[n - 1] - b'0';
	10 * y1 + y2
}

/// Whether the first filename should be interpreted as a timestamp.
fn is_first_filename_timestamp(
	reference: Option<&OsString>,
	date: Option<&str>,
	timestamp: Option<&str>,
	files: &[&OsString],
) -> bool {
	timestamp.is_none()
		&& reference.is_none()
		&& date.is_none()
		&& files.len() >= 2
		// pi-uutils: `_POSIX2_VERSION` comes from the scope environment (the
		// shell's exported variables), not the host process environment.
		// env check is last as the slowest op
		&& pi_uutils_ctx::var("_POSIX2_VERSION").as_deref() == Some("199209")
		&& files[0].to_str().is_some_and(is_timestamp)
}

// Check if string is a valid POSIX timestamp (8 digits or 10 digits with valid
// year range)
fn is_timestamp(s: &str) -> bool {
	all_digits(s) && (s.len() == 8 || (s.len() == 10 && (69..=99).contains(&get_year(s))))
}

/// Cycle the last two characters to the beginning of the string.
///
/// `s` must have length at least two.
fn shr2(s: &str) -> String {
	let n = s.len();
	let (a, b) = s.split_at(n - 2);
	let mut result = String::with_capacity(n);
	result.push_str(b);
	result.push_str(a);
	result
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
	match touch_main(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let msg = err.to_string();
			if !msg.is_empty() {
				let _ = writeln!(pi_uutils_ctx::stderr(), "touch: {msg}");
			}
			if code == 0 { 1 } else { code }
		},
	}
}

fn touch_main(matches: &ArgMatches) -> UResult<()> {
	let mut filenames: Vec<&OsString> = matches
		.get_many::<OsString>(ARG_FILES)
		.ok_or_else(|| {
			// pi-uutils: literalized; `uucore::execution_phrase()` is "touch"
			// when running as a builtin.
			USimpleError::new(1, "missing file operand\nTry 'touch --help' for more information.")
		})?
		.collect();

	let no_deref = matches.get_flag(options::NO_DEREF);

	let reference = matches.get_one::<OsString>(options::sources::REFERENCE);
	let date = matches
		.get_one::<String>(options::sources::DATE)
		.map(ToOwned::to_owned);

	let mut timestamp = matches
		.get_one::<String>(options::sources::TIMESTAMP)
		.map(ToOwned::to_owned);

	if is_first_filename_timestamp(reference, date.as_deref(), timestamp.as_deref(), &filenames) {
		let first_file = filenames[0].to_str().unwrap();
		timestamp = if first_file.len() == 10 {
			Some(shr2(first_file))
		} else {
			Some(first_file.to_string())
		};
		filenames = filenames[1..].to_vec();
	}

	let source = if let Some(reference) = reference {
		Source::Reference(PathBuf::from(reference))
	} else if let Some(ts) = timestamp {
		Source::Timestamp(parse_timestamp(&ts)?)
	} else {
		Source::Now
	};

	let files: Vec<InputFile> = filenames
		.into_iter()
		.map(|filename| {
			if filename == "-" {
				InputFile::Stdout
			} else {
				InputFile::Path(PathBuf::from(filename))
			}
		})
		.collect();

	let opts = Options {
		no_create: matches.get_flag(options::NO_CREATE),
		no_deref,
		source,
		date,
		change_times: determine_atime_mtime_change(matches),
		strict: false,
	};

	touch(&files, &opts)?;

	Ok(())
}

pub fn uu_app() -> Command {
	Command::new("touch")
		.version(uucore::crate_version!())
		.about("Update the access and modification times of each FILE to the current time.")
		.override_usage(format_usage("touch [OPTION]... [FILE]..."))
		.infer_long_args(true)
		.disable_help_flag(true)
		.arg(
			Arg::new(options::HELP)
				.long(options::HELP)
				.help("Print help information.")
				.action(ArgAction::Help),
		)
		.arg(
			Arg::new(options::ACCESS)
				.short('a')
				.help("change only the access time")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::sources::TIMESTAMP)
				.short('t')
				.help("use [[CC]YY]MMDDhhmm[.ss] instead of the current time")
				.value_name("STAMP"),
		)
		.arg(
			Arg::new(options::sources::DATE)
				.short('d')
				.long(options::sources::DATE)
				.allow_hyphen_values(true)
				.help("parse argument and use it instead of current time")
				.value_name("STRING")
				.conflicts_with(options::sources::TIMESTAMP),
		)
		.arg(
			Arg::new(options::FORCE)
				.short('f')
				.help("(ignored)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::MODIFICATION)
				.short('m')
				.help("change only the modification time")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_CREATE)
				.short('c')
				.long(options::NO_CREATE)
				.help("do not create any files")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_DEREF)
				.short('h')
				.long(options::NO_DEREF)
				.help(
					"affect each symbolic link instead of any referenced file (only for systems that \
					 can change the timestamps of a symlink)",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::sources::REFERENCE)
				.short('r')
				.long(options::sources::REFERENCE)
				.help("use this file's times instead of the current time")
				.value_name("FILE")
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::AnyPath)
				.conflicts_with(options::sources::TIMESTAMP),
		)
		.arg(
			Arg::new(options::TIME)
				.long(options::TIME)
				.help(
					"change only the specified time: \"access\", \"atime\", or \"use\" are equivalent \
					 to -a; \"modify\" or \"mtime\" are equivalent to -m",
				)
				.value_name("WORD")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("atime").alias("access").alias("use"),
					PossibleValue::new("mtime").alias("modify"),
				])),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.num_args(1..)
				.value_parser(clap::value_parser!(OsString))
				.value_hint(clap::ValueHint::AnyPath),
		)
		.group(
			ArgGroup::new(options::SOURCES)
				.args([
					options::sources::TIMESTAMP,
					options::sources::DATE,
					options::sources::REFERENCE,
				])
				.multiple(true),
		)
}

/// Execute the touch command.
///
/// # Errors
///
/// Possible causes:
/// - The user doesn't have permission to access the file
/// - One of the directory components of the file path doesn't exist.
/// - Dangling symlink is given and -r/--reference is used.
///
/// It will return an `Err` on the first error. However, for any of the files,
/// if all of the following are true, it will print the error and continue
/// touching the rest of the files.
/// - `opts.strict` is `false`
/// - The file doesn't already exist
/// - `-c`/`--no-create` was passed (`opts.no_create`)
/// - Either `-h`/`--no-dereference` was passed (`opts.no_deref`) or the file
///   couldn't be created
pub fn touch(files: &[InputFile], opts: &Options) -> Result<(), TouchError> {
	let (atime, mtime) = match &opts.source {
		Source::Reference(reference) => {
			// pi-uutils: resolve the reference operand against the shell
			// working directory at the syscall site; the original operand is
			// kept for the error message.
			let (atime, mtime) = stat(&pi_uutils_ctx::resolve(reference), !opts.no_deref)
				.map_err(|e| TouchError::ReferenceFileInaccessible(reference.to_owned(), e))?;

			(atime, mtime)
		},
		Source::Now => {
			let now: FileTime;
			#[cfg(target_os = "linux")]
			{
				if opts.date.is_none() {
					now = FileTime::from_unix_time(0, libc::UTIME_NOW as u32);
				} else {
					now = timestamp_to_filetime(Timestamp::now());
				}
			}
			#[cfg(not(target_os = "linux"))]
			{
				now = timestamp_to_filetime(Timestamp::now());
			}
			(now, now)
		},
		&Source::Timestamp(ts) => (ts, ts),
	};

	let (atime, mtime) = if let Some(date) = &opts.date {
		(
			parse_date(
				filetime_to_zoned(&atime).ok_or_else(|| TouchError::InvalidFiletime(atime))?,
				date,
			)?,
			parse_date(
				filetime_to_zoned(&mtime).ok_or_else(|| TouchError::InvalidFiletime(mtime))?,
				date,
			)?,
		)
	} else {
		(atime, mtime)
	};

	for (ind, file) in files.iter().enumerate() {
		let (path, is_stdout) = match file {
			InputFile::Stdout => (Cow::Owned(pathbuf_from_stdout()?), true),
			InputFile::Path(path) => (Cow::Borrowed(path), false),
		};
		touch_file(&path, is_stdout, opts, atime, mtime).map_err(|e| TouchError::TouchFileError {
			path:  path.into_owned(),
			index: ind,
			error: e,
		})?;
	}

	Ok(())
}

/// Create or update the timestamp for a single file.
///
/// # Arguments
///
/// - `path` - The path to the file to create/update timestamp for
/// - `is_stdout` - Stdout is handled specially, see [`update_times`] for more
///   info
/// - `atime` - Access time to set for the file
/// - `mtime` - Modification time to set for the file
fn touch_file(
	path: &Path,
	is_stdout: bool,
	opts: &Options,
	atime: FileTime,
	mtime: FileTime,
) -> UResult<()> {
	let filename = if is_stdout {
		OsStr::new("-")
	} else {
		path.as_os_str()
	};

	// pi-uutils: resolve the operand against the shell working directory for
	// every syscall below; `path`/`filename` keep the operand as typed for
	// error messages.
	let resolved = pi_uutils_ctx::resolve(path);

	let metadata_result = if opts.no_deref {
		resolved.symlink_metadata()
	} else {
		resolved.metadata()
	};

	if let Err(e) = metadata_result {
		if e.kind() != ErrorKind::NotFound {
			return Err(e.map_err_context(|| format!("setting times of {}", filename.quote())));
		}

		if opts.no_create {
			return Ok(());
		}

		if opts.no_deref {
			let e = USimpleError::new(
				1,
				format!("setting times of {}: No such file or directory", filename.quote()),
			);
			if opts.strict {
				return Err(e);
			}
			// pi-uutils: upstream `show!` — print the error and accumulate the
			// exit code in the scope instead of process-global state.
			let _ = writeln!(pi_uutils_ctx::stderr(), "touch: {e}");
			pi_uutils_ctx::set_exit_code(e.code());
			return Ok(());
		}

		if let Err(e) = File::create(&resolved) {
			// we need to check if the path is the path to a directory (ends with a
			// separator) we can't use File::create to create a directory
			// we cannot use path.is_dir() because it calls fs::metadata which we already
			// called when stable, we can change to use e.kind() ==
			// std::io::ErrorKind::IsADirectory
			let is_directory = if let Some(last_char) = path.to_string_lossy().chars().last() {
				last_char == std::path::MAIN_SEPARATOR
			} else {
				false
			};
			if is_directory {
				let custom_err = Error::other("No such file or directory");
				return Err(
					custom_err.map_err_context(|| format!("cannot touch {}", filename.quote())),
				);
			}
			let e = e.map_err_context(|| format!("cannot touch {}", path.quote()));
			if opts.strict {
				return Err(e);
			}
			// pi-uutils: upstream `show!` — see above.
			let _ = writeln!(pi_uutils_ctx::stderr(), "touch: {e}");
			pi_uutils_ctx::set_exit_code(e.code());
			return Ok(());
		}

		// Minor optimization: if no reference time, timestamp, or date was specified,
		// we're done.
		if opts.source == Source::Now && opts.date.is_none() {
			return Ok(());
		}
	}

	update_times(path, is_stdout, opts, atime, mtime)
}

/// Returns which of the times (access, modification) are to be changed.
///
/// Note that "-a" and "-m" may be passed together; this is not an xor.
/// - If `-a` is passed but not `-m`, only access time is changed
/// - If `-m` is passed but not `-a`, only modification time is changed
/// - If neither or both are passed, both times are changed
fn determine_atime_mtime_change(matches: &ArgMatches) -> ChangeTimes {
	// If `--time` is given, Some(true) if equivalent to `-a`, Some(false) if
	// equivalent to `-m` If `--time` not given, None
	let time_access_only = if matches.contains_id(options::TIME) {
		matches
			.get_one::<String>(options::TIME)
			.map(|time| time.contains("access") || time.contains("atime") || time.contains("use"))
	} else {
		None
	};

	let atime_only = matches.get_flag(options::ACCESS) || time_access_only.unwrap_or_default();
	let mtime_only = matches.get_flag(options::MODIFICATION) || !time_access_only.unwrap_or(true);

	if atime_only && !mtime_only {
		ChangeTimes::AtimeOnly
	} else if mtime_only && !atime_only {
		ChangeTimes::MtimeOnly
	} else {
		ChangeTimes::Both
	}
}

/// Updating file access and modification times based on user-specified options
///
/// If the file is not stdout (`!is_stdout`) and `-h`/`--no-dereference` was
/// passed, then, if the given file is a symlink, its own times will be updated,
/// rather than the file it points to.
fn update_times(
	path: &Path,
	is_stdout: bool,
	opts: &Options,
	atime: FileTime,
	mtime: FileTime,
) -> UResult<()> {
	// pi-uutils: resolve the operand against the shell working directory for
	// every syscall below; `path` keeps the operand as typed for error
	// messages.
	let resolved = pi_uutils_ctx::resolve(path);

	// If changing "only" atime or mtime, grab the existing value of the other.
	let (atime, mtime) = match opts.change_times {
		ChangeTimes::AtimeOnly => (
			atime,
			stat(&resolved, !opts.no_deref)
				.map_err_context(|| format!("failed to get attributes of {}", path.quote()))?
				.1,
		),
		ChangeTimes::MtimeOnly => (
			stat(&resolved, !opts.no_deref)
				.map_err_context(|| format!("failed to get attributes of {}", path.quote()))?
				.0,
			mtime,
		),
		ChangeTimes::Both => (atime, mtime),
	};

	// sets the file access and modification times for a file or a symbolic link.
	// The filename, access time (atime), and modification time (mtime) are provided
	// as inputs.

	if opts.no_deref && !is_stdout {
		return set_symlink_file_times(&resolved, atime, mtime)
			.map_err_context(|| format!("setting times of {}", path.quote()));
	}

	#[cfg(unix)]
	{
		// Open write-only and use futimens to trigger IN_CLOSE_WRITE on Linux.
		if !is_stdout && try_futimens_via_write_fd(&resolved, atime, mtime).is_ok() {
			return Ok(());
		}
	}

	set_file_times(&resolved, atime, mtime)
		.map_err_context(|| format!("setting times of {}", path.quote()))
}

#[cfg(unix)]
/// Set file times via file descriptor using `futimens`.
///
/// This opens the file write-only and uses the POSIX `futimens` call to set
/// access and modification times on the open FD (not by path), which also
/// triggers `IN_CLOSE_WRITE` on Linux when the FD is closed.
fn try_futimens_via_write_fd(path: &Path, atime: FileTime, mtime: FileTime) -> std::io::Result<()> {
	let file = OpenOptions::new()
		.write(true)
		// Avoid blocking on special files (e.g. FIFOs) before we can inspect metadata.
		.custom_flags(O_NONBLOCK)
		.open(path)?;

	let timestamps = Timestamps {
		last_access:       rustix::fs::Timespec {
			tv_sec:  atime.unix_seconds(),
			tv_nsec: atime.nanoseconds() as _,
		},
		last_modification: rustix::fs::Timespec {
			tv_sec:  mtime.unix_seconds(),
			tv_nsec: mtime.nanoseconds() as _,
		},
	};

	futimens(&file, &timestamps).map_err(|e| Error::from_raw_os_error(e.raw_os_error()))
}

/// Get metadata of the provided path
/// If `follow` is `true`, the function will try to follow symlinks. Errors if
/// the symlink is dangling, otherwise defaults to symlink metadata. If `follow`
/// is `false`, the function will return metadata of the symlink itself
fn stat(path: &Path, follow: bool) -> std::io::Result<(FileTime, FileTime)> {
	let metadata = if follow {
		match fs::metadata(path) {
			// Successfully followed symlink
			Ok(meta) => meta,
			// Dangling symlink
			Err(e) if e.kind() == ErrorKind::NotFound => return Err(e),
			// Other error (?), try to get the symlink metadata
			Err(_) => fs::symlink_metadata(path)?,
		}
	} else {
		fs::symlink_metadata(path)?
	};

	Ok((
		FileTime::from_last_access_time(&metadata),
		FileTime::from_last_modification_time(&metadata),
	))
}

fn parse_date(ref_zoned: Zoned, s: &str) -> Result<FileTime, TouchError> {
	// This isn't actually compatible with GNU touch, but there doesn't seem to
	// be any simple specification for what format this parameter allows and I'm
	// not about to implement GNU parse_datetime.
	// http://git.savannah.gnu.org/gitweb/?p=gnulib.git;a=blob_plain;f=lib/parse-datetime.y

	// TODO: match on char count?

	// "The preferred date and time representation for the current locale."
	// "(In the POSIX locale this is equivalent to %a %b %e %H:%M:%S %Y.)"
	// time 0.1.43 parsed this as 'a b e T Y'
	// which is equivalent to the POSIX locale: %a %b %e %H:%M:%S %Y
	// Tue Dec  3 ...
	// ("%c", POSIX_LOCALE_FORMAT),
	//
	if let Ok(parsed) = strtime::parse(format::POSIX_LOCALE, s)
		.and_then(|tm| tm.to_datetime())
		.and_then(|dt| TimeZone::UTC.to_zoned(dt))
	{
		return Ok(timestamp_to_filetime(parsed.timestamp()));
	}

	// Also support other formats found in the GNU tests like
	// in tests/misc/stat-nanoseconds.sh
	// or tests/touch/no-rights.sh
	for fmt in [
		format::YYYYMMDDHHMMS,
		format::YYYYMMDDHHMMSS,
		format::YYYY_MM_DD_HH_MM,
		format::YYYYMMDDHHMM_OFFSET,
	] {
		if let Ok(parsed) = strtime::parse(fmt, s)
			.and_then(|tm| tm.to_datetime())
			.and_then(|dt| TimeZone::UTC.to_zoned(dt))
		{
			return Ok(timestamp_to_filetime(parsed.timestamp()));
		}
	}

	// "Equivalent to %Y-%m-%d (the ISO 8601 date format). (C99)"
	// ("%F", ISO_8601_FORMAT),
	// pi-uutils: `TimeZone::system()` (and the `TZ` variable it consults)
	// intentionally stays process-global; jiff reads it internally.
	if let Ok(filetime) = strtime::parse(format::ISO_8601, s)
		.and_then(|tm| tm.to_date())
		.and_then(|date| {
			TimeZone::system()
				.to_ambiguous_zoned(date.to_datetime(Time::midnight()))
				.unambiguous()
		})
		.map(|zdt| timestamp_to_filetime(zdt.timestamp()))
	{
		return Ok(filetime);
	}

	// "@%s" is "The number of seconds since the Epoch, 1970-01-01 00:00:00 +0000
	// (UTC). (TZ) (Calculated from mktime(tm).)"
	if s.bytes().next() == Some(b'@')
		&& let Ok(ts) = &s[1..].parse::<i64>()
	{
		return Ok(FileTime::from_unix_time(*ts, 0));
	}

	if let Ok(zoned) = parse_datetime::parse_datetime_at_date(ref_zoned, s) {
		return Ok(timestamp_to_filetime(zoned.timestamp()));
	}

	Err(TouchError::InvalidDateFormat(s.to_owned()))
}

/// Prepends 19 or 20 to the year if it is a 2 digit year
///
/// GNU `touch` behavior:
///
/// - 68 and before is interpreted as 20xx
/// - 69 and after is interpreted as 19xx
fn prepend_century(s: &str) -> UResult<String> {
	let first_two_digits = s[..2]
		.parse::<u32>()
		.map_err(|_| USimpleError::new(1, format!("invalid date ts format {}", s.quote())))?;
	Ok(format!("{}{s}", if first_two_digits > 68 { 19 } else { 20 }))
}

/// Parses a timestamp string into a [`FileTime`].
///
/// This function attempts to parse a string into a [`FileTime`]
/// As expected by gnu touch -t : `[[cc]yy]mmddhhmm[.ss]`
///
/// Note that  If the year is specified with only two digits,
/// then cc is 20 for years in the range 0 … 68, and 19 for years in 69 … 99.
/// in order to be compatible with GNU `touch`.
fn parse_timestamp(s: &str) -> UResult<FileTime> {
	use format::{YYYYMMDDHHMM, YYYYMMDDHHMM_DOT_SS};

	// pi-uutils: `TimeZone::system()` intentionally stays process-global.
	let current_year = || Timestamp::now().to_zoned(TimeZone::system()).year();

	let (format, ts) = match s.chars().count() {
		15 => (YYYYMMDDHHMM_DOT_SS, s.to_owned()),
		12 => (YYYYMMDDHHMM, s.to_owned()),
		// If we don't add "19" or "20", we have insufficient information to parse
		13 => (YYYYMMDDHHMM_DOT_SS, prepend_century(s)?),
		10 => (YYYYMMDDHHMM, prepend_century(s)?),
		11 => (YYYYMMDDHHMM_DOT_SS, format!("{}{s}", current_year())),
		8 => (YYYYMMDDHHMM, format!("{}{s}", current_year())),
		_ => {
			return Err(USimpleError::new(1, format!("invalid date format {}", s.quote())));
		},
	};

	let mut dt = strtime::parse(format, &ts)
		.and_then(|parsed| parsed.to_datetime())
		.map_err(|_| USimpleError::new(1, format!("invalid date ts format {}", ts.quote())))?;

	// Jiff caps seconds at 59, but 60 is valid. It might be a leap second
	// or wrap to the next minute. But that doesn't really matter, because we
	// only care about the timestamp anyway.
	// Tested in gnu/tests/touch/60-seconds
	if dt.second() == 59 && ts.ends_with(".60") {
		dt += 1.second();
	}

	// Due to daylight saving time switch, local time can jump from 1:59 AM to
	// 3:00 AM, in which case any time between 2:00 AM and 2:59 AM is not valid.
	// Jiff's `to_ambiguous_zoned(...).unambiguous()` handles this case.
	let local = TimeZone::system()
		.to_ambiguous_zoned(dt)
		.unambiguous()
		.map_err(|_| USimpleError::new(1, format!("invalid date ts format {}", ts.quote())))?;

	Ok(timestamp_to_filetime(local.timestamp()))
}

// TODO: this may be a good candidate to put in fsext.rs
/// Returns a [`PathBuf`] to stdout.
///
/// On Windows, uses `GetFinalPathNameByHandleW` to attempt to get the path
/// from the stdout handle.
#[cfg_attr(not(windows), expect(clippy::unnecessary_wraps))]
fn pathbuf_from_stdout() -> Result<PathBuf, TouchError> {
	#[cfg(all(unix, not(target_os = "android")))]
	{
		Ok(PathBuf::from("/dev/stdout"))
	}
	#[cfg(target_os = "android")]
	{
		Ok(PathBuf::from("/proc/self/fd/1"))
	}
	#[cfg(windows)]
	{
		use std::os::windows::prelude::AsRawHandle;

		use windows_sys::Win32::{
			Foundation::{
				ERROR_INVALID_PARAMETER, ERROR_NOT_ENOUGH_MEMORY, ERROR_PATH_NOT_FOUND, GetLastError,
				HANDLE, MAX_PATH,
			},
			Storage::FileSystem::{FILE_NAME_OPENED, GetFinalPathNameByHandleW},
		};

		let handle = std::io::stdout().lock().as_raw_handle() as HANDLE;
		let mut file_path_buffer: [u16; MAX_PATH as usize] = [0; MAX_PATH as usize];

		// https://docs.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlea#examples
		// SAFETY: We transmute the handle to be able to cast *mut c_void into a
		// HANDLE (i32) so rustc will let us call GetFinalPathNameByHandleW. The
		// reference example code for GetFinalPathNameByHandleW implies that
		// it is safe for us to leave lpszfilepath uninitialized, so long as
		// the buffer size is correct. We know the buffer size (MAX_PATH) at
		// compile time. MAX_PATH is a small number (260) so we can cast it
		// to a u32.
		let ret = unsafe {
			GetFinalPathNameByHandleW(
				handle,
				file_path_buffer.as_mut_ptr(),
				file_path_buffer.len() as u32,
				FILE_NAME_OPENED,
			)
		};

		// pi-uutils: literalized error strings; the variant's Display supplies
		// the "GetFinalPathNameByHandleW failed with code" prefix, so only the
		// code payload is stored.
		let buffer_size = match ret {
			ERROR_PATH_NOT_FOUND | ERROR_NOT_ENOUGH_MEMORY | ERROR_INVALID_PARAMETER => {
				return Err(TouchError::WindowsStdoutPathError(ret.to_string()));
			},
			0 => {
				return Err(TouchError::WindowsStdoutPathError(format!(
					"{}",
					// SAFETY: GetLastError is thread-safe and has no documented memory unsafety.
					unsafe { GetLastError() }
				)));
			},
			e => e as usize,
		};

		// Don't include the null terminator
		Ok(String::from_utf16(&file_path_buffer[0..buffer_size])
			.map_err(|e| TouchError::WindowsStdoutPathError(e.to_string()))?
			.into())
	}
	#[cfg(target_os = "wasi")]
	{
		Ok(PathBuf::from("/dev/stdout"))
	}
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, io::Write, path::PathBuf, sync::Arc};

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

		let argv: Vec<OsString> = std::iter::once("touch")
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

	fn times_of(path: &Path) -> (FileTime, FileTime) {
		let metadata = fs::metadata(path).unwrap();
		(FileTime::from_last_access_time(&metadata), FileTime::from_last_modification_time(&metadata))
	}

	#[test]
	fn relative_operand_creates_file_in_scope_cwd() {
		let (_dir, root) = canonical_tempdir();

		// Relative operand + scope cwd differing from the process cwd: only
		// the call-site `pi_uutils_ctx::resolve` patch makes the file land in
		// the scope cwd instead of the process cwd.
		let (code, stdout, stderr) = run_in(root.clone(), vec!["created.txt"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "");
		assert!(root.join("created.txt").is_file());
		assert!(
			!std::env::current_dir()
				.unwrap()
				.join("created.txt")
				.exists()
		);
	}

	#[test]
	fn no_create_on_missing_file_is_silent_success() {
		let (_dir, root) = canonical_tempdir();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["-c", "missing.txt"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "");
		assert!(!root.join("missing.txt").exists());
	}

	#[test]
	fn reference_copies_times_from_relative_reference() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("ref"), b"x").unwrap();
		let ref_atime = FileTime::from_unix_time(1_000_000, 0);
		let ref_mtime = FileTime::from_unix_time(2_000_000, 0);
		set_file_times(root.join("ref"), ref_atime, ref_mtime).unwrap();

		// Both the `-r` reference and the FILE operand are relative: each is
		// resolved against the scope cwd at its own syscall site.
		let (code, stdout, stderr) = run_in(root.clone(), vec!["-r", "ref", "new"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "");
		let (atime, mtime) = times_of(&root.join("new"));
		assert_eq!(atime, ref_atime);
		assert_eq!(mtime, ref_mtime);
	}

	#[test]
	fn date_sets_mtime_to_fixed_utc_instant() {
		let (_dir, root) = canonical_tempdir();

		// "%Y-%m-%d %H:%M:%S" dates are interpreted in UTC, so the expected
		// epoch is timezone-independent: 2001-02-03T04:05:06Z.
		let (code, stdout, stderr) = run_in(root.clone(), vec!["-d", "2001-02-03 04:05:06", "f"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "");
		let (atime, mtime) = times_of(&root.join("f"));
		assert_eq!(mtime.unix_seconds(), 981_173_106);
		assert_eq!(atime.unix_seconds(), 981_173_106);
	}

	#[test]
	fn modification_only_preserves_existing_atime() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("f"), b"x").unwrap();
		let old_atime = FileTime::from_unix_time(1_111, 0);
		let old_mtime = FileTime::from_unix_time(2_222, 0);
		set_file_times(root.join("f"), old_atime, old_mtime).unwrap();

		let (code, _, stderr) = run_in(root.clone(), vec!["-m", "-d", "@981173106", "f"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let (atime, mtime) = times_of(&root.join("f"));
		assert_eq!(atime, old_atime, "-m must not change atime");
		assert_eq!(mtime, FileTime::from_unix_time(981_173_106, 0));
	}

	#[test]
	fn missing_operand_is_usage_error() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec![]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.contains("missing file operand"), "stderr: {stderr}");
		assert!(stderr.contains("Try 'touch --help'"), "stderr: {stderr}");
	}

	#[test]
	fn help_renders_to_scope_stdout() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec!["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("access and modification times"));
		assert_eq!(stderr, "");
	}

	#[test]
	fn time_word_and_flags_select_change_times() {
		assert_eq!(
			ChangeTimes::Both,
			determine_atime_mtime_change(&uu_app().try_get_matches_from(vec!["touch", "f"]).unwrap())
		);
		assert_eq!(
			ChangeTimes::Both,
			determine_atime_mtime_change(
				&uu_app()
					.try_get_matches_from(vec!["touch", "-a", "-m", "--time", "modify", "f"])
					.unwrap()
			)
		);
		assert_eq!(
			ChangeTimes::AtimeOnly,
			determine_atime_mtime_change(
				&uu_app()
					.try_get_matches_from(vec!["touch", "--time", "access", "f"])
					.unwrap()
			)
		);
		assert_eq!(
			ChangeTimes::MtimeOnly,
			determine_atime_mtime_change(
				&uu_app()
					.try_get_matches_from(vec!["touch", "-m", "f"])
					.unwrap()
			)
		);
	}
}

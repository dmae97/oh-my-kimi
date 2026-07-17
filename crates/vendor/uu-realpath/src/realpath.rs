// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) retcode

// pi-uutils: vendored from uutils/coreutils 0.8.0 and patched to run in-process
// as a shell builtin. Every filesystem syscall resolves its path operand
// against the shell working directory via `pi_uutils_ctx::resolve` AT THE CALL
// SITE (FILE operands and the --relative-to/--relative-base option paths),
// while the original operands are kept for display/error messages (GNU prints
// operands as typed). All process-global stdio is routed through
// `pi_uutils_ctx`, `translate!` strings are literalized, `show_if_err!` is
// replaced by a context-stderr write plus `pi_uutils_ctx::set_exit_code`, and
// the entry point no longer calls `std::process::exit`.

use std::{
	ffi::{OsStr, OsString},
	io::Write,
	path::{Path, PathBuf},
};

use clap::{
	Arg, ArgAction, ArgMatches, Command,
	builder::{TypedValueParser, ValueParserFactory},
};
use pi_uutils_ctx::format_usage;
use uucore::{
	display::Quotable,
	error::{FromIo, UResult},
	fs::{MissingHandling, ResolveMode, canonicalize, make_path_relative_to},
	line_ending::LineEnding,
};

const OPT_QUIET: &str = "quiet";
const OPT_STRIP: &str = "strip";
const OPT_ZERO: &str = "zero";
const OPT_PHYSICAL: &str = "physical";
const OPT_LOGICAL: &str = "logical";
const OPT_CANONICALIZE_MISSING: &str = "canonicalize-missing";
const OPT_CANONICALIZE: &str = "canonicalize";
const OPT_CANONICALIZE_EXISTING: &str = "canonicalize-existing";
const OPT_RELATIVE_TO: &str = "relative-to";
const OPT_RELATIVE_BASE: &str = "relative-base";

const ARG_FILES: &str = "files";

/// Custom parser that validates `OsString` is not empty
#[derive(Clone, Debug)]
struct NonEmptyOsStringParser;

impl TypedValueParser for NonEmptyOsStringParser {
	type Value = OsString;

	fn parse_ref(
		&self,
		_cmd: &Command,
		_arg: Option<&Arg>,
		value: &OsStr,
	) -> Result<Self::Value, clap::Error> {
		if value.is_empty() {
			let mut err = clap::Error::new(clap::error::ErrorKind::ValueValidation);
			err.insert(
				clap::error::ContextKind::Custom,
				// pi-uutils: literalized `translate!("realpath-invalid-empty-operand")`
				clap::error::ContextValue::String("invalid operand: empty string".to_string()),
			);
			return Err(err);
		}
		Ok(value.to_os_string())
	}
}

impl ValueParserFactory for NonEmptyOsStringParser {
	type Parser = Self;

	fn value_parser() -> Self::Parser {
		Self
	}
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
	match realpath_main(&matches) {
		// pi-uutils: per-file failures accumulate their exit code via
		// `pi_uutils_ctx::set_exit_code` (upstream's `show!` machinery).
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let msg = err.to_string();
			if !msg.is_empty() {
				let _ = writeln!(pi_uutils_ctx::stderr(), "realpath: {msg}");
			}
			if code == 0 { 1 } else { code }
		},
	}
}

fn realpath_main(matches: &ArgMatches) -> UResult<()> {
	/* the list of files */

	let paths: Vec<PathBuf> = matches
		.get_many::<OsString>(ARG_FILES)
		.unwrap()
		.map(PathBuf::from)
		.collect();

	let strip = matches.get_flag(OPT_STRIP);
	let line_ending = LineEnding::from_zero_flag(matches.get_flag(OPT_ZERO));
	let quiet = matches.get_flag(OPT_QUIET);
	let logical = matches.get_flag(OPT_LOGICAL);
	let can_mode = if matches.get_flag(OPT_CANONICALIZE_MISSING) {
		MissingHandling::Missing
	} else if matches.get_flag(OPT_CANONICALIZE_EXISTING) {
		// -e: all components must exist
		// Despite the name, MissingHandling::Existing requires all components to exist
		MissingHandling::Existing
	} else {
		// Default behavior (same as -E): all but last component must exist
		// MissingHandling::Normal allows the final component to not exist
		MissingHandling::Normal
	};
	let resolve_mode = if strip {
		ResolveMode::None
	} else if logical {
		ResolveMode::Logical
	} else {
		ResolveMode::Physical
	};
	let (relative_to, relative_base) = prepare_relative_options(matches, can_mode, resolve_mode)?;
	for path in &paths {
		let result = resolve_path(
			path,
			line_ending,
			resolve_mode,
			can_mode,
			relative_to.as_deref(),
			relative_base.as_deref(),
		);
		if !quiet {
			// pi-uutils: replacement for `show_if_err!` — report the error on
			// the context stderr and record the exit code, then keep
			// processing the remaining operands (upstream continue semantics).
			if let Err(err) = result.map_err_context(|| path.maybe_quote().to_string()) {
				let _ = writeln!(pi_uutils_ctx::stderr(), "realpath: {err}");
				pi_uutils_ctx::set_exit_code(err.code());
			}
		}
	}
	// Although we return `Ok`, it is possible that a call to
	// `show!()` above has set the exit code for the program to a
	// non-zero integer.
	Ok(())
}

pub fn uu_app() -> Command {
	Command::new("realpath")
		.version(uucore::crate_version!())
		.about("Print the resolved path")
		.override_usage(format_usage("realpath [OPTION]... FILE..."))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_QUIET)
				.short('q')
				.long(OPT_QUIET)
				.help("Do not print warnings for invalid paths")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_STRIP)
				.short('s')
				.long(OPT_STRIP)
				.visible_alias("no-symlinks")
				.help("Only strip '.' and '..' components, but don't resolve symbolic links")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_ZERO)
				.short('z')
				.long(OPT_ZERO)
				.help("Separate output filenames with \\0 rather than newline")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_LOGICAL)
				.short('L')
				.long(OPT_LOGICAL)
				.help("resolve '..' components before symlinks")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PHYSICAL)
				.short('P')
				.long(OPT_PHYSICAL)
				.overrides_with_all([OPT_STRIP, OPT_LOGICAL])
				.help("resolve symlinks as encountered (default)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_CANONICALIZE)
				.short('E')
				.long(OPT_CANONICALIZE)
				.overrides_with_all([OPT_CANONICALIZE_EXISTING, OPT_CANONICALIZE_MISSING])
				.help("all but the last component must exist (default)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_CANONICALIZE_EXISTING)
				.short('e')
				.long(OPT_CANONICALIZE_EXISTING)
				.overrides_with_all([OPT_CANONICALIZE, OPT_CANONICALIZE_MISSING])
				.help(
					"canonicalize by following every symlink in every component of the given name \
					 recursively, all components must exist",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_CANONICALIZE_MISSING)
				.short('m')
				.long(OPT_CANONICALIZE_MISSING)
				.overrides_with_all([OPT_CANONICALIZE, OPT_CANONICALIZE_EXISTING])
				.help(
					"canonicalize by following every symlink in every component of the given name \
					 recursively, without requirements on components existence",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_RELATIVE_TO)
				.long(OPT_RELATIVE_TO)
				.value_name("DIR")
				.value_parser(NonEmptyOsStringParser)
				.help("print the resolved path relative to DIR"),
		)
		.arg(
			Arg::new(OPT_RELATIVE_BASE)
				.long(OPT_RELATIVE_BASE)
				.value_name("DIR")
				.value_parser(NonEmptyOsStringParser)
				.help("print absolute paths unless paths below DIR"),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.required(true)
				.value_parser(NonEmptyOsStringParser)
				.value_hint(clap::ValueHint::AnyPath),
		)
}

/// Prepare `--relative-to` and `--relative-base` options.
/// Convert them to their absolute values.
/// Check if `--relative-to` is a descendant of `--relative-base`,
/// otherwise nullify their value.
fn prepare_relative_options(
	matches: &ArgMatches,
	can_mode: MissingHandling,
	resolve_mode: ResolveMode,
) -> UResult<(Option<PathBuf>, Option<PathBuf>)> {
	let relative_to = matches
		.get_one::<OsString>(OPT_RELATIVE_TO)
		.map(PathBuf::from);
	let relative_base = matches
		.get_one::<OsString>(OPT_RELATIVE_BASE)
		.map(PathBuf::from);
	let relative_to = canonicalize_relative_option(relative_to, can_mode, resolve_mode)?;
	let relative_base = canonicalize_relative_option(relative_base, can_mode, resolve_mode)?;
	if let (Some(base), Some(to)) = (relative_base.as_deref(), relative_to.as_deref())
		&& !to.starts_with(base)
	{
		return Ok((None, None));
	}
	Ok((relative_to, relative_base))
}

/// Prepare single `relative-*` option.
fn canonicalize_relative_option(
	relative: Option<PathBuf>,
	can_mode: MissingHandling,
	resolve_mode: ResolveMode,
) -> UResult<Option<PathBuf>> {
	Ok(match relative {
		None => None,
		Some(p) => Some(
			canonicalize_relative(&p, can_mode, resolve_mode)
				.map_err_context(|| p.maybe_quote().to_string())?,
		),
	})
}

/// Make `relative-to` or `relative-base` path values absolute.
///
/// # Errors
///
/// If the given path is not a directory the function returns an error.
/// If some parts of the file don't exist, or symlinks make loops, or
/// some other IO error happens, the function returns error, too.
fn canonicalize_relative(
	r: &Path,
	can_mode: MissingHandling,
	resolve: ResolveMode,
) -> std::io::Result<PathBuf> {
	// pi-uutils: resolve the option path against the shell working directory;
	// `r` is kept by the caller for display. Resolving before `canonicalize`
	// also keeps uucore's internal `env::current_dir()` fallback from being
	// consulted.
	let abs = canonicalize(pi_uutils_ctx::resolve(r), can_mode, resolve)?;
	if can_mode == MissingHandling::Existing && !abs.is_dir() {
		abs.read_dir()?; // raise not a directory error
	}
	Ok(abs)
}

/// Resolve a path to an absolute form and print it.
///
/// If `relative_to` and/or `relative_base` is given
/// the path is printed in a relative form to one of this options.
/// See the details in `process_relative` function.
/// If `zero` is `true`, then this function
/// prints the path followed by the null byte (`'\0'`) instead of a
/// newline character (`'\n'`).
///
/// # Errors
///
/// This function returns an error if there is a problem resolving
/// symbolic links.
fn resolve_path(
	p: &Path,
	line_ending: LineEnding,
	resolve: ResolveMode,
	can_mode: MissingHandling,
	relative_to: Option<&Path>,
	relative_base: Option<&Path>,
) -> std::io::Result<()> {
	// pi-uutils: resolve the operand against the shell working directory; `p`
	// is kept by the caller for display. Resolving before `canonicalize` also
	// keeps uucore's internal `env::current_dir()` fallback from being
	// consulted.
	let abs = canonicalize(pi_uutils_ctx::resolve(p), can_mode, resolve)?;

	let abs = process_relative(abs, relative_base, relative_to);

	// pi-uutils: replacement for `print_verbatim` + process stdout — writes
	// the resolved path bytes verbatim to the context stdout.
	let mut out = pi_uutils_ctx::stdout();
	out.write_all(
		uucore::os_str_as_bytes(abs.as_os_str()).map_err(|e| std::io::Error::other(e.to_string()))?,
	)?;
	out.write_all(&[line_ending.into()])?;
	out.flush()?;
	Ok(())
}

/// Conditionally converts an absolute path to a relative form,
/// according to the rules:
/// 1. if only `relative_to` is given, the result is relative to `relative_to`
/// 2. if only `relative_base` is given, it checks whether given `path` is a
///    descendant of `relative_base`, on success the result is relative to
///    `relative_base`, otherwise the result is the given `path`
/// 3. if both `relative_to` and `relative_base` are given, the result is
///    relative to `relative_to` if `path` is a descendant of `relative_base`,
///    otherwise the result is `path`
///
/// For more information see
/// <https://www.gnu.org/software/coreutils/manual/html_node/Realpath-usage-examples.html>
fn process_relative(
	path: PathBuf,
	relative_base: Option<&Path>,
	relative_to: Option<&Path>,
) -> PathBuf {
	if let Some(base) = relative_base {
		if path.starts_with(base) {
			make_path_relative_to(path, relative_to.unwrap_or(base))
		} else {
			path
		}
	} else if let Some(to) = relative_to {
		make_path_relative_to(path, to)
	} else {
		path
	}
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, fs, io::Write, path::PathBuf, sync::Arc};

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

		let argv: Vec<OsString> = std::iter::once("realpath")
			.chain(args)
			.map(OsString::from)
			.collect();

		let code = pi_uutils_ctx::scope(io, || run(argv));

		let out_str = String::from_utf8(stdout_buf.lock().clone()).unwrap();
		let err_str = String::from_utf8(stderr_buf.lock().clone()).unwrap();

		(code, out_str, err_str)
	}

	/// Canonicalized temp dir (macOS tempdirs live behind /var -> /private/var,
	/// which canonicalization would otherwise expand mid-assertion).
	fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let canon = fs::canonicalize(dir.path()).unwrap();
		(dir, canon)
	}

	#[cfg(unix)]
	#[test]
	fn resolves_relative_operand_against_scope_cwd() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("target"), b"x").unwrap();
		std::os::unix::fs::symlink("target", root.join("link")).unwrap();

		// Relative operand + scope cwd differing from the process cwd: only
		// the call-site `pi_uutils_ctx::resolve` patch makes this find the
		// symlink and print its canonical target.
		let (code, stdout, stderr) = run_in(root.clone(), vec!["link"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, format!("{}\n", root.join("target").display()));
		assert_eq!(stderr, "");
	}

	#[test]
	fn canonicalize_missing_builds_path_from_scope_cwd() {
		let (_dir, root) = canonical_tempdir();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["-m", "missing/sub"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, format!("{}\n", root.join("missing").join("sub").display()));
		assert_eq!(stderr, "");
	}

	#[test]
	fn relative_to_option_resolves_against_scope_cwd_and_relativizes_output() {
		let (_dir, root) = canonical_tempdir();
		fs::create_dir(root.join("sub")).unwrap();
		fs::write(root.join("sub").join("file"), b"x").unwrap();

		// Both the operand and the (relative) --relative-to directory resolve
		// against the scope cwd.
		let (code, stdout, stderr) = run_in(root, vec!["--relative-to", "sub", "sub/file"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "file\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn zero_flag_terminates_with_nul() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("f"), b"x").unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["-z", "f"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, format!("{}\0", root.join("f").display()));
		assert_eq!(stderr, "");
	}

	#[test]
	fn nonexistent_operand_errors_but_later_operands_still_process() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("f"), b"x").unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["missing/x", "f"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, format!("{}\n", root.join("f").display()));
		assert!(stderr.contains("realpath: missing/x"), "stderr: {stderr}");
		assert!(stderr.contains("No such file"), "stderr: {stderr}");
	}

	#[test]
	fn quiet_suppresses_error_messages() {
		let (_dir, root) = canonical_tempdir();

		// Upstream drops the per-file result entirely under -q (the error is
		// neither printed nor accumulated into the exit code).
		let (code, stdout, stderr) = run_in(root, vec!["-q", "missing/x"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "");
	}

	#[cfg(unix)]
	#[test]
	fn strip_keeps_symlinks_unresolved() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("target"), b"x").unwrap();
		std::os::unix::fs::symlink("target", root.join("link")).unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["-s", "link"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, format!("{}\n", root.join("link").display()));
		assert_eq!(stderr, "");
	}

	#[test]
	fn empty_operand_is_rejected() {
		// The NonEmptyOsStringParser turns "" into a clap parse error (rendered
		// by clap's default renderer since the uucore localization layer is
		// patched out) instead of a filesystem lookup.
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec![""]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.contains("invalid value"), "stderr: {stderr}");
	}

	#[test]
	fn help_renders_to_scope_stdout() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec!["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("Print the resolved path"));
		assert_eq!(stderr, "");
	}
}

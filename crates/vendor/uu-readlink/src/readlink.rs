// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) errno

// pi-uutils: vendored from uutils/coreutils 0.8.0 and patched to run in-process
// as a shell builtin. Every filesystem syscall resolves its path operand
// against the shell working directory via `pi_uutils_ctx::resolve` AT THE CALL
// SITE, while the original operands are kept for display/error messages (GNU
// prints operands as typed). All process-global stdio is routed through
// `pi_uutils_ctx`, `translate!` strings are literalized, POSIXLY_CORRECT is
// read from the scope environment, and the entry point no longer calls
// `std::process::exit`.

use std::{
	ffi::OsString,
	fs,
	io::Write,
	path::{Path, PathBuf},
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use pi_uutils_ctx::format_usage;
use uucore::{
	display::Quotable,
	error::{FromIo, UResult, UUsageError},
	fs::{MissingHandling, ResolveMode, canonicalize},
	libc::EINVAL,
	line_ending::LineEnding,
};

const OPT_CANONICALIZE: &str = "canonicalize";
const OPT_CANONICALIZE_MISSING: &str = "canonicalize-missing";
const OPT_CANONICALIZE_EXISTING: &str = "canonicalize-existing";
const OPT_NO_NEWLINE: &str = "no-newline";
const OPT_QUIET: &str = "quiet";
const OPT_SILENT: &str = "silent";
const OPT_VERBOSE: &str = "verbose";
const OPT_ZERO: &str = "zero";

const ARG_FILES: &str = "files";

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
	match readlink_main(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			// pi-uutils: silent failures surface as bare exit-code errors that
			// render to an empty message (upstream prints nothing for them);
			// don't emit a dangling "readlink: " prefix.
			let msg = err.to_string();
			if !msg.is_empty() {
				let _ = writeln!(pi_uutils_ctx::stderr(), "readlink: {msg}");
			}
			if code == 0 { 1 } else { code }
		},
	}
}

fn readlink_main(matches: &ArgMatches) -> UResult<()> {
	let mut no_trailing_delimiter = matches.get_flag(OPT_NO_NEWLINE);
	let use_zero = matches.get_flag(OPT_ZERO);
	// pi-uutils: POSIXLY_CORRECT comes from the scope environment (the shell's
	// exported variables), not the host process environment.
	let verbose = matches.get_flag(OPT_VERBOSE) || pi_uutils_ctx::var("POSIXLY_CORRECT").is_some();

	// GNU readlink -f/-e/-m follows symlinks first and then applies `..` (physical
	// resolution). ResolveMode::Logical collapses `..` before following links,
	// which yields the opposite order, so we choose Physical here for GNU
	// compatibility.
	let res_mode = if matches.get_flag(OPT_CANONICALIZE)
		|| matches.get_flag(OPT_CANONICALIZE_EXISTING)
		|| matches.get_flag(OPT_CANONICALIZE_MISSING)
	{
		ResolveMode::Physical
	} else {
		ResolveMode::None
	};

	let can_mode = if matches.get_flag(OPT_CANONICALIZE_EXISTING) {
		MissingHandling::Existing
	} else if matches.get_flag(OPT_CANONICALIZE_MISSING) {
		MissingHandling::Missing
	} else {
		MissingHandling::Normal
	};

	let files: Vec<PathBuf> = matches
		.get_many::<OsString>(ARG_FILES)
		.map(|v| v.map(PathBuf::from).collect())
		.unwrap_or_default();

	if files.is_empty() {
		return Err(UUsageError::new(1, "missing operand".to_string()));
	}

	if no_trailing_delimiter && files.len() > 1 {
		let _ = writeln!(
			pi_uutils_ctx::stderr(),
			"readlink: ignoring --no-newline with multiple arguments"
		);
		no_trailing_delimiter = false;
	}

	let line_ending = if no_trailing_delimiter {
		None
	} else {
		Some(LineEnding::from_zero_flag(use_zero))
	};

	for p in &files {
		// pi-uutils: resolve the operand against the shell working directory;
		// `p` is kept for display. Resolving before `canonicalize` also keeps
		// uucore's internal `env::current_dir()` fallback from being consulted.
		let resolved = pi_uutils_ctx::resolve(p);
		let path_result = if res_mode == ResolveMode::None {
			fs::read_link(&resolved)
		} else {
			canonicalize(&resolved, can_mode, res_mode)
		};

		match path_result {
			Ok(path) => {
				show(&path, line_ending)?;
			},
			Err(err) => {
				if !verbose {
					return Err(1.into());
				}

				let message = if err.raw_os_error() == Some(EINVAL) {
					format!("{}: Invalid argument", p.maybe_quote())
				} else {
					err.map_err_context(|| p.maybe_quote().to_string())
						.to_string()
				};
				let _ = writeln!(pi_uutils_ctx::stderr(), "readlink: {message}");
				return Err(1.into());
			},
		}
	}
	Ok(())
}

pub fn uu_app() -> Command {
	Command::new("readlink")
		.version(uucore::crate_version!())
		.about("Print value of a symbolic link or canonical file name.")
		.override_usage(format_usage("readlink [OPTION]... [FILE]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_CANONICALIZE)
				.short('f')
				.long(OPT_CANONICALIZE)
				.help(
					"canonicalize by following every symlink in every component of the given name \
					 recursively; all but the last component must exist",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_CANONICALIZE_EXISTING)
				.short('e')
				.long("canonicalize-existing")
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
				.help(
					"canonicalize by following every symlink in every component of the given name \
					 recursively, without requirements on components existence",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_NO_NEWLINE)
				.short('n')
				.long(OPT_NO_NEWLINE)
				.help("do not output the trailing delimiter")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_QUIET)
				.short('q')
				.long(OPT_QUIET)
				.help("suppress most error messages")
				.overrides_with_all([OPT_QUIET, OPT_SILENT, OPT_VERBOSE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SILENT)
				.short('s')
				.long(OPT_SILENT)
				.help("suppress most error messages")
				.overrides_with_all([OPT_QUIET, OPT_SILENT, OPT_VERBOSE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_VERBOSE)
				.short('v')
				.long(OPT_VERBOSE)
				.help("report error message")
				.overrides_with_all([OPT_QUIET, OPT_SILENT, OPT_VERBOSE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_ZERO)
				.short('z')
				.long(OPT_ZERO)
				.help("separate output with NUL rather than newline")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.value_parser(clap::value_parser!(OsString))
				.value_hint(clap::ValueHint::AnyPath),
		)
}

/// pi-uutils: replacement for upstream's `show` — writes the resolved path
/// bytes verbatim to the context stdout instead of the process stdout.
fn show(path: &Path, line_ending: Option<LineEnding>) -> UResult<()> {
	let mut out = pi_uutils_ctx::stdout();
	out.write_all(uucore::os_str_as_bytes(path.as_os_str())?)?;
	if let Some(line_ending) = line_ending {
		write!(out, "{line_ending}")?;
	}
	out.flush()?;
	Ok(())
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

		let argv: Vec<OsString> = std::iter::once("readlink")
			.chain(args)
			.map(OsString::from)
			.collect();

		let code = pi_uutils_ctx::scope(io, || run(argv));

		let out_str = String::from_utf8(stdout_buf.lock().clone()).unwrap();
		let err_str = String::from_utf8(stderr_buf.lock().clone()).unwrap();

		(code, out_str, err_str)
	}

	/// Canonicalized temp dir (macOS tempdirs live behind /var -> /private/var,
	/// which -f/-e/-m resolution would otherwise expand mid-assertion).
	fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let canon = fs::canonicalize(dir.path()).unwrap();
		(dir, canon)
	}

	#[cfg(unix)]
	#[test]
	fn resolves_relative_operand_against_scope_cwd() {
		let (_dir, root) = canonical_tempdir();
		std::os::unix::fs::symlink("target-file", root.join("link")).unwrap();

		// Relative operand + scope cwd differing from the process cwd: only the
		// call-site `pi_uutils_ctx::resolve` patch makes this find the link.
		let (code, stdout, stderr) = run_in(root, vec!["link"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "target-file\n");
		assert_eq!(stderr, "");
	}

	#[cfg(unix)]
	#[test]
	fn canonicalize_follows_symlink_to_absolute_path() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("target"), b"x").unwrap();
		std::os::unix::fs::symlink("target", root.join("link")).unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["-f", "link"]);
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

	#[cfg(unix)]
	#[test]
	fn canonicalize_existing_fails_silently_on_missing_final_component() {
		let (_dir, root) = canonical_tempdir();

		let (code, stdout, stderr) = run_in(root, vec!["-e", "missing"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "", "non-verbose failures print nothing");
	}

	#[cfg(unix)]
	#[test]
	fn non_symlink_is_silent_failure_by_default_and_einval_with_verbose() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("plain"), b"x").unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["plain"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (1, "", ""));

		let (code, stdout, stderr) = run_in(root, vec!["-v", "plain"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "readlink: plain: Invalid argument\n");
	}

	#[cfg(unix)]
	#[test]
	fn no_newline_with_multiple_args_warns_and_keeps_delimiter() {
		let (_dir, root) = canonical_tempdir();
		std::os::unix::fs::symlink("a", root.join("l1")).unwrap();
		std::os::unix::fs::symlink("b", root.join("l2")).unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["-n", "l1", "l2"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "a\nb\n");
		assert_eq!(stderr, "readlink: ignoring --no-newline with multiple arguments\n");
	}

	#[cfg(unix)]
	#[test]
	fn zero_terminates_with_nul_and_no_newline_drops_delimiter() {
		let (_dir, root) = canonical_tempdir();
		std::os::unix::fs::symlink("a", root.join("l1")).unwrap();

		let (code, stdout, _) = run_in(root.clone(), vec!["-z", "l1"]);
		assert_eq!((code, stdout.as_str()), (0, "a\0"));

		let (code, stdout, _) = run_in(root, vec!["-n", "l1"]);
		assert_eq!((code, stdout.as_str()), (0, "a"));
	}

	#[test]
	fn missing_operand_is_usage_error() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec![]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.contains("missing operand"));
	}

	#[test]
	fn help_renders_to_scope_stdout() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec!["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("canonical file name"));
		assert_eq!(stderr, "");
	}
}

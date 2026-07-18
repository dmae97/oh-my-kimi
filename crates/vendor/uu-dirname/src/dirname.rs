// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// pi-uutils: modified for in-process embedding using pi-uutils-ctx streams.

use std::{borrow::Cow, ffi::OsString, io::Write};

use clap::{Arg, ArgAction, ArgMatches, Command};
use pi_uutils_ctx::format_usage;
use uucore::error::{UResult, UUsageError};

mod options {
	pub const ZERO: &str = "zero";
	pub const DIR: &str = "dir";
}

/// Perform dirname as pure string manipulation per POSIX/GNU behavior.
///
/// dirname should NOT normalize paths. It does simple string manipulation:
/// 1. Strip trailing slashes (unless path is all slashes)
/// 2. If ends with `/.` (possibly `//.` or `///.`), strip the `/+.` pattern
/// 3. Otherwise, remove everything after the last `/`
/// 4. If no `/` found, return `.`
/// 5. Strip trailing slashes from result (unless result would be empty)
///
/// Examples:
/// - `foo/.` → `foo`
/// - `foo/./bar` → `foo/.`
/// - `foo/bar` → `foo`
/// - `a/b/c` → `a/b`
///
/// Per POSIX.1-2017 dirname specification and GNU coreutils manual:
/// - POSIX: <https://pubs.opengroup.org/onlinepubs/9699919799/utilities/dirname.html>
/// - GNU: <https://www.gnu.org/software/coreutils/manual/html_node/dirname-invocation.html>
///
/// See issue #8910 and similar fix in basename (#8373, commit c5268a897).
fn dirname_string_manipulation(path_bytes: &[u8]) -> Cow<'_, [u8]> {
	if path_bytes.is_empty() {
		return Cow::Borrowed(b".");
	}

	let mut bytes = path_bytes;

	// Step 1: Strip trailing slashes (but not if the entire path is slashes)
	let all_slashes = bytes.iter().all(|&b| b == b'/');
	if all_slashes {
		return Cow::Borrowed(b"/");
	}

	while bytes.len() > 1 && bytes.ends_with(b"/") {
		bytes = &bytes[..bytes.len() - 1];
	}

	// Step 2: Check if it ends with `/.` and strip the `/+.` pattern
	if bytes.ends_with(b".") && bytes.len() >= 2 {
		let dot_pos = bytes.len() - 1;
		if bytes[dot_pos - 1] == b'/' {
			// Find where the slashes before the dot start
			let mut slash_start = dot_pos - 1;
			while slash_start > 0 && bytes[slash_start - 1] == b'/' {
				slash_start -= 1;
			}
			// Return the stripped result
			if slash_start == 0 {
				// Result would be empty
				return if path_bytes.starts_with(b"/") {
					Cow::Borrowed(b"/")
				} else {
					Cow::Borrowed(b".")
				};
			}
			return Cow::Borrowed(&bytes[..slash_start]);
		}
	}

	// Step 3: Normal dirname - find last / and remove everything after it
	if let Some(last_slash_pos) = bytes.iter().rposition(|&b| b == b'/') {
		// Found a slash, remove everything after it
		let mut result = &bytes[..last_slash_pos];

		// Strip trailing slashes from result (but keep at least one if at the start)
		while result.len() > 1 && result.ends_with(b"/") {
			result = &result[..result.len() - 1];
		}

		if result.is_empty() {
			return Cow::Borrowed(b"/");
		}

		return Cow::Borrowed(result);
	}

	// No slash found, return "."
	Cow::Borrowed(b".")
}

/// In-process builtin entry point. Unlike upstream's `uumain`, this parses the
/// arguments directly, renders clap help/usage/version to the context
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
	match dirname_main(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let _ = writeln!(pi_uutils_ctx::stderr(), "dirname: {err}");
			if code == 0 { 1 } else { code }
		},
	}
}

fn dirname_main(matches: &ArgMatches) -> UResult<()> {
	let dirnames: Vec<OsString> = matches
		.get_many::<OsString>(options::DIR)
		.unwrap_or_default()
		.cloned()
		.collect();

	if dirnames.is_empty() {
		return Err(UUsageError::new(1, "missing operand".to_string()));
	}

	let line_ending = if matches.get_flag(options::ZERO) {
		b"\0" as &[u8]
	} else {
		b"\n" as &[u8]
	};

	let mut stdout = pi_uutils_ctx::stdout();

	for path in &dirnames {
		let path_bytes = uucore::os_str_as_bytes(path.as_os_str())?;
		let result = dirname_string_manipulation(path_bytes);

		stdout.write_all(&result)?;
		stdout.write_all(line_ending)?;
	}

	Ok(())
}

pub fn uu_app() -> Command {
	Command::new("dirname")
		.about("Strip last component from file name")
		.version(uucore::crate_version!())
		.override_usage(format_usage("dirname [OPTION] NAME..."))
		.args_override_self(true)
		.infer_long_args(true)
		.after_help(
			"Output each NAME with its last non-slash component and trailing slashes\n  removed; if \
			 NAME contains no /'s, output '.' (meaning the current directory).",
		)
		.arg(
			Arg::new(options::ZERO)
				.long(options::ZERO)
				.short('z')
				.help("separate output with NUL rather than newline")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DIR)
				.hide(true)
				.action(ArgAction::Append)
				.value_hint(clap::ValueHint::AnyPath)
				.value_parser(clap::value_parser!(OsString)),
		)
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, path::PathBuf, sync::Arc};

	use parking_lot::Mutex;
	use pi_uutils_ctx::ScopeIo;

	use super::*;

	fn run_test(args: Vec<&str>) -> (i32, String, String) {
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
			stdin:                 Box::new(std::io::empty()),
			stdin_fd:              None,
			stdin_is_search_input: false,
			stdout:                Box::new(SharedWriter { buf: stdout_buf.clone() }),
			stderr:                Box::new(SharedWriter { buf: stderr_buf.clone() }),
			cwd:                   PathBuf::from("."),
			env:                   HashMap::new(),
			cancel:                Arc::new(std::sync::atomic::AtomicBool::new(false)),
		};

		let argv: Vec<OsString> = std::iter::once("dirname")
			.chain(args)
			.map(OsString::from)
			.collect();

		let code = pi_uutils_ctx::scope(io, || run(argv));

		let out_str = String::from_utf8(stdout_buf.lock().clone()).unwrap();
		let err_str = String::from_utf8(stderr_buf.lock().clone()).unwrap();

		(code, out_str, err_str)
	}

	#[test]
	fn test_normal() {
		let (code, stdout, stderr) = run_test(vec!["foo/bar"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "foo\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn test_trailing_slash() {
		let (code, stdout, stderr) = run_test(vec!["foo/bar/"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "foo\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn test_root() {
		let (code, stdout, stderr) = run_test(vec!["/"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "/\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn test_multiple() {
		let (code, stdout, stderr) = run_test(vec!["a/b", "c/d/e"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "a\nc/d\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn test_zero_delimited() {
		let (code, stdout, stderr) = run_test(vec!["-z", "a/b", "c/d/e"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "a\0c/d\0");
		assert_eq!(stderr, "");
	}

	#[test]
	fn test_help() {
		let (code, stdout, stderr) = run_test(vec!["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("Strip last component"));
		assert_eq!(stderr, "");
	}

	#[test]
	fn test_invalid_arg() {
		let (code, stdout, stderr) = run_test(vec!["--invalid-flag"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.contains("unexpected argument"));
	}

	#[test]
	fn test_missing_operand() {
		let (code, stdout, stderr) = run_test(vec![]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.contains("missing operand"));
	}
}

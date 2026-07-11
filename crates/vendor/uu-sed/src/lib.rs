// This file is part of the uutils sed package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

//! Vendored, patched `sed` from uutils/sed, wired to run in-process as a
//! shell builtin via [`pi_uutils_ctx`].
//!
//! Upstream: <https://github.com/uutils/sed>
//! Pinned commit: `b37e23fa987888572e02e4e9b6906b3ede749bc6` (default-branch
//! HEAD, 2026-07-10, version 0.1.1).
//!
//! Patches applied for in-process embedding:
//! - all stdio goes through the `pi_uutils_ctx` streams,
//! - every path operand resolves against the shell working directory via
//!   `pi_uutils_ctx::resolve`,
//! - no `std::process::exit`: `q`/`Q` exit codes flow through
//!   `pi_uutils_ctx::set_exit_code`, clap errors are rendered manually,
//! - the `s///e` shell escape spawns with the shell's cwd and piped stdio,
//! - output is never assumed to be a terminal (no `-l` width auto-detect, no
//!   tty-triggered unbuffered mode).

pub mod sed;

use std::{ffi::OsString, io::Write};

/// In-process builtin entry point. The host installs a [`pi_uutils_ctx`]
/// scope (stdio + working directory + environment) on a dedicated blocking
/// thread, then calls this.
///
/// Unlike upstream's `main` (which `std::process::exit`s on the result of
/// `uumain`), this returns the exit code so it is safe to run inside the
/// long-lived host shell process.
pub fn run(argv: Vec<OsString>) -> i32 {
	// A reused blocking thread may still hold `w`/`s///w` writers registered
	// by a previous invocation that failed before flushing; drop them.
	sed::named_writer::reset();

	let matches = match sed::uu_app().try_get_matches_from(sed::normalize_args(argv)) {
		Ok(m) => m,
		Err(e) => {
			let rendered = e.to_string();
			if e.use_stderr() {
				let _ = write!(pi_uutils_ctx::stderr(), "{rendered}");
				return 1;
			}
			let _ = write!(pi_uutils_ctx::stdout(), "{rendered}");
			return 0;
		},
	};

	// Upstream prints help and exits 1 when invoked without any argument.
	if !matches.args_present() {
		let _ = write!(pi_uutils_ctx::stdout(), "{}", sed::uu_app().render_help());
		return 1;
	}

	match sed::sed_main(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(e) => {
			let code = e.code();
			let _ = writeln!(pi_uutils_ctx::stderr(), "sed: {e}");
			if code == 0 { 1 } else { code }
		},
	}
}

#[cfg(test)]
mod tests {
	use std::{
		collections::HashMap,
		ffi::OsString,
		io::{self, Write},
		path::PathBuf,
		sync::{Arc, atomic::AtomicBool},
	};

	use parking_lot::Mutex;

	use super::run;

	/// `Send` writer capturing everything a run writes to a scope stream.
	#[derive(Clone, Default)]
	struct SharedBuf(Arc<Mutex<Vec<u8>>>);

	impl Write for SharedBuf {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			self.0.lock().extend_from_slice(buf);
			Ok(buf.len())
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	impl SharedBuf {
		fn take(&self) -> String {
			String::from_utf8(self.0.lock().clone()).expect("utf8 stream")
		}
	}

	/// Drive `run()` under a pi-uutils-ctx scope with `cwd` as the shell
	/// working directory; returns (exit code, stdout, stderr).
	fn run_sed_in(cwd: PathBuf, stdin: &[u8], args: &[&str]) -> (i32, String, String) {
		let stdout = SharedBuf::default();
		let stderr = SharedBuf::default();
		let argv: Vec<OsString> = std::iter::once("sed")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = pi_uutils_ctx::scope(
			pi_uutils_ctx::ScopeIo {
				stdin: Box::new(io::Cursor::new(stdin.to_vec())),
				stdin_fd: None,
				stdin_is_search_input: false,
				stdout: Box::new(stdout.clone()),
				stderr: Box::new(stderr.clone()),
				cwd,
				env: HashMap::new(),
				cancel: Arc::new(AtomicBool::new(false)),
			},
			|| run(argv),
		);
		(code, stdout.take(), stderr.take())
	}

	fn run_sed(stdin: &[u8], args: &[&str]) -> (i32, String, String) {
		run_sed_in(PathBuf::from("."), stdin, args)
	}

	#[test]
	fn substitutes_basic_from_stdin() {
		let (code, out, err) = run_sed(b"hello\n", &["s/hello/world/"]);
		assert_eq!(code, 0);
		assert_eq!(out, "world\n");
		assert!(err.is_empty(), "unexpected stderr: {err}");
	}

	#[test]
	fn quiet_prints_address_range() {
		let (code, out, _) = run_sed(b"a\nb\nc\nd\n", &["-n", "2,3p"]);
		assert_eq!(code, 0);
		assert_eq!(out, "b\nc\n");
	}

	#[test]
	fn substitution_global_flag() {
		let (code, out, _) = run_sed(b"aaa\n", &["s/a/b/g"]);
		assert_eq!(code, 0);
		assert_eq!(out, "bbb\n");
	}

	#[test]
	fn substitution_numbered_occurrence() {
		let (code, out, _) = run_sed(b"aaa\n", &["s/a/b/2"]);
		assert_eq!(code, 0);
		assert_eq!(out, "aba\n");
	}

	#[test]
	fn ere_capture_groups_swap() {
		let (code, out, _) = run_sed(b"john smith\n", &["-E", r"s/([a-z]+) ([a-z]+)/\2 \1/"]);
		assert_eq!(code, 0);
		assert_eq!(out, "smith john\n");
	}

	#[test]
	fn bre_backreference_in_pattern() {
		let (code, out, _) = run_sed(b"abab\nabcd\n", &["-n", r"/\(ab\)\1/p"]);
		assert_eq!(code, 0);
		assert_eq!(out, "abab\n");
	}

	#[test]
	fn hold_space_tac() {
		let (code, out, _) = run_sed(b"1\n2\n3\n", &["1!G;h;$!d"]);
		assert_eq!(code, 0);
		assert_eq!(out, "3\n2\n1\n");
	}

	#[test]
	fn transliterates() {
		let (code, out, _) = run_sed(b"abcabc\n", &["y/abc/xyz/"]);
		assert_eq!(code, 0);
		assert_eq!(out, "xyzxyz\n");
	}

	#[test]
	fn multiple_expressions_compose_in_order() {
		let (code, out, _) = run_sed(b"a\n", &["-e", "s/a/b/", "-e", "s/b/c/"]);
		assert_eq!(code, 0);
		assert_eq!(out, "c\n");
	}

	#[test]
	fn q_with_operand_propagates_exit_code() {
		let (code, out, _) = run_sed(b"one\ntwo\nthree\n", &["2q42"]);
		assert_eq!(code, 42);
		assert_eq!(out, "one\ntwo\n");
	}

	#[test]
	fn q_stops_before_later_lines() {
		let (code, out, _) = run_sed(b"one\ntwo\n", &["1q"]);
		assert_eq!(code, 0);
		assert_eq!(out, "one\n");
	}

	#[test]
	fn in_place_edits_relative_path_against_scope_cwd() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("file.txt"), "x marks\n").unwrap();
		let (code, out, err) =
			run_sed_in(dir.path().to_path_buf(), b"", &["-i", "s/x/y/", "file.txt"]);
		assert_eq!(code, 0, "stderr: {err}");
		assert!(out.is_empty(), "in-place edit must not print: {out}");
		assert_eq!(std::fs::read_to_string(dir.path().join("file.txt")).unwrap(), "y marks\n");
	}

	#[test]
	fn in_place_backup_suffix_keeps_original() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("file.txt"), "x marks\n").unwrap();
		let (code, _, err) =
			run_sed_in(dir.path().to_path_buf(), b"", &["-i.bak", "s/x/y/", "file.txt"]);
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(std::fs::read_to_string(dir.path().join("file.txt")).unwrap(), "y marks\n");
		assert_eq!(std::fs::read_to_string(dir.path().join("file.txt.bak")).unwrap(), "x marks\n");
	}

	#[test]
	fn null_data_mode_substitutes_per_record() {
		let (code, out, _) = run_sed(b"a\0b\0", &["-z", "s/a/X/"]);
		assert_eq!(code, 0);
		assert_eq!(out, "X\0b\0");
	}

	#[test]
	fn unknown_option_diagnoses_on_stderr() {
		let (code, out, err) = run_sed(b"", &["--definitely-not-an-option", "p"]);
		assert_ne!(code, 0);
		assert!(out.is_empty(), "usage errors must not write stdout: {out}");
		assert!(!err.is_empty(), "expected a diagnostic on stderr");
	}
}

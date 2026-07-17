// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) getusername

// pi-uutils: vendored from uutils/coreutils 0.8.0 and patched to run in-process
// as a shell builtin. Output goes to the context stdout (upstream's
// `println_verbatim` writes to the process stdout), `translate!` strings are
// literalized, the `platform` module (upstream
// src/platform/{mod,unix,windows}.rs) is inlined, and the entry point no longer
// calls `std::process::exit`.

use std::{ffi::OsString, io::Write};

use clap::Command;
use uucore::error::{FromIo, UResult, USimpleError};

// pi-uutils: inlined from upstream src/platform/{mod,unix,windows}.rs (verbatim
// bodies); the platform user lookup itself is process-global state and needs no
// scope patching.
mod platform {
	#[cfg(unix)]
	pub use self::unix::get_username;
	#[cfg(windows)]
	pub use self::windows::get_username;

	#[cfg(unix)]
	mod unix {
		use std::{ffi::OsString, io};

		use uucore::{entries::uid2usr, process::geteuid};

		pub fn get_username() -> io::Result<OsString> {
			// uid2usr should arguably return an OsString but currently doesn't
			uid2usr(geteuid()).map(Into::into)
		}
	}

	#[cfg(windows)]
	mod windows {
		use std::{ffi::OsString, io, os::windows::ffi::OsStringExt};

		use windows_sys::Win32::{
			NetworkManagement::NetManagement::UNLEN, System::WindowsProgramming::GetUserNameW,
		};

		pub fn get_username() -> io::Result<OsString> {
			const BUF_LEN: u32 = UNLEN + 1;
			let mut buffer = [0_u16; BUF_LEN as usize];
			let mut len = BUF_LEN;
			// SAFETY: buffer.len() == len
			if unsafe { GetUserNameW(buffer.as_mut_ptr(), &raw mut len) } == 0 {
				return Err(io::Error::last_os_error());
			}
			Ok(OsString::from_wide(&buffer[..len as usize - 1]))
		}
	}
}

/// In-process builtin entry point. Unlike upstream's `uumain`, this parses the
/// arguments directly (without the uucore clap-localization helper that would
/// terminate the process), renders clap help/usage/version to the context
/// streams, and maps the `UResult` to an exit code, so it is safe to run inside
/// the host shell process.
pub fn run(argv: Vec<OsString>) -> i32 {
	match uu_app().try_get_matches_from(argv) {
		Ok(_matches) => {},
		Err(err) => {
			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(pi_uutils_ctx::stderr(), "{rendered}");
				return 1;
			}
			let _ = write!(pi_uutils_ctx::stdout(), "{rendered}");
			return 0;
		},
	}
	match whoami_main() {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let msg = err.to_string();
			if !msg.is_empty() {
				let _ = writeln!(pi_uutils_ctx::stderr(), "whoami: {msg}");
			}
			if code == 0 { 1 } else { code }
		},
	}
}

fn whoami_main() -> UResult<()> {
	let username = whoami()?;
	// pi-uutils: replacement for upstream's `println_verbatim` — writes the
	// username bytes verbatim to the context stdout instead of the process
	// stdout.
	let mut out = pi_uutils_ctx::stdout();
	out.write_all(uucore::os_str_as_bytes(&username)?)
		.and_then(|()| out.write_all(b"\n"))
		.and_then(|()| out.flush())
		.map_err(|e| USimpleError::new(1, format!("failed to print username: {e}")))?;
	Ok(())
}

/// Get the current username
pub fn whoami() -> UResult<OsString> {
	platform::get_username().map_err_context(|| "failed to get username".to_string())
}

pub fn uu_app() -> Command {
	Command::new("whoami")
		.version(uucore::crate_version!())
		.about("Print the current username.")
		.override_usage("whoami")
		.infer_long_args(true)
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, io::Write, path::PathBuf, sync::Arc};

	use parking_lot::Mutex;
	use pi_uutils_ctx::ScopeIo;

	use super::*;

	fn run_in(args: Vec<&str>) -> (i32, String, String) {
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

		let argv: Vec<OsString> = std::iter::once("whoami")
			.chain(args)
			.map(OsString::from)
			.collect();

		let code = pi_uutils_ctx::scope(io, || run(argv));

		let out_str = String::from_utf8(stdout_buf.lock().clone()).unwrap();
		let err_str = String::from_utf8(stderr_buf.lock().clone()).unwrap();

		(code, out_str, err_str)
	}

	#[test]
	fn prints_process_user_with_trailing_newline() {
		let (code, stdout, stderr) = run_in(vec![]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert!(stdout.ends_with('\n'));
		let name = stdout.trim_end();
		assert!(!name.is_empty());
		// When the host exports USER it names the same effective user the
		// platform lookup resolves.
		if let Ok(user) = std::env::var("USER") {
			assert_eq!(name, user);
		}
	}

	#[test]
	fn rejects_operands() {
		let (code, stdout, stderr) = run_in(vec!["extra"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(!stderr.is_empty(), "clap usage error must go to scope stderr");
	}

	#[test]
	fn help_renders_to_scope_stdout() {
		let (code, stdout, stderr) = run_in(vec!["--help"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert!(stdout.contains("Print the current username."));
	}
}

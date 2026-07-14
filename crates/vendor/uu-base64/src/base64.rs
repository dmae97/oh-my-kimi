// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{ffi::OsString, io::Write};

use clap::Command;
use uu_base32::base_common;
use uucore::encoding::Format;

/// pi-uutils: safe in-process entry point using invocation-scoped streams.
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
	let result = base_common::Config::from(&matches).and_then(|config| {
		let mut input = base_common::get_input(&config)?;
		base_common::handle_input(&mut input, Format::Base64, config)
	});
	match result {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let _ = writeln!(pi_uutils_ctx::stderr(), "base64: {err}");
			if code == 0 { 1 } else { code }
		},
	}
}

pub fn uu_app() -> Command {
	base_common::base_app(
		"encode/decode data and print to standard output\nWith no FILE, or when FILE is -, read \
		 standard input.\n\nThe data are encoded as described for the base64 alphabet in RFC \
		 3548.\nWhen decoding, the input may contain newlines in addition to the bytes of the \
		 formal base64 alphabet. Use --ignore-garbage to attempt to recover from any other \
		 non-alphabet bytes in the encoded stream."
			.into(),
		"base64 [OPTION]... [FILE]".into(),
	)
	.name("base64")
}

#[cfg(test)]
mod tests {
	use std::{
		collections::HashMap,
		ffi::OsString,
		io::{Cursor, Write},
		path::PathBuf,
		sync::Arc,
	};

	use parking_lot::Mutex;
	use pi_uutils_ctx::ScopeIo;

	use super::run;

	fn run_in(cwd: PathBuf, input: &[u8], args: Vec<&str>) -> (i32, String, String) {
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
			stdin: Box::new(Cursor::new(input.to_vec())),
			stdin_fd: None,
			stdin_is_search_input: false,
			stdout: Box::new(SharedWriter { buf: stdout_buf.clone() }),
			stderr: Box::new(SharedWriter { buf: stderr_buf.clone() }),
			cwd,
			env: HashMap::new(),
			cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
		};
		let argv: Vec<OsString> = std::iter::once("base64")
			.chain(args)
			.map(OsString::from)
			.collect();
		let code = pi_uutils_ctx::scope(io, || run(argv));

		(
			code,
			String::from_utf8(stdout_buf.lock().clone()).unwrap(),
			String::from_utf8(stderr_buf.lock().clone()).unwrap(),
		)
	}

	fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let canon = std::fs::canonicalize(dir.path()).unwrap();
		(dir, canon)
	}

	#[test]
	fn macos_decode_alias_round_trips_and_gnu_alias_still_works() {
		let (_dir, cwd) = canonical_tempdir();
		let (code, encoded, stderr) = run_in(cwd.clone(), b"hello", vec![]);
		assert_eq!(code, 0);
		assert_eq!(encoded, "aGVsbG8=\n");
		assert_eq!(stderr, "");

		let (code, decoded, stderr) = run_in(cwd.clone(), encoded.as_bytes(), vec!["-D"]);
		assert_eq!(code, 0);
		assert_eq!(decoded, "hello");
		assert_eq!(stderr, "");

		let (code, decoded, stderr) = run_in(cwd, encoded.as_bytes(), vec!["-d"]);
		assert_eq!(code, 0);
		assert_eq!(decoded, "hello");
		assert_eq!(stderr, "");
	}
}

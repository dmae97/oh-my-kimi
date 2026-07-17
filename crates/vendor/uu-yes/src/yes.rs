// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// cSpell:ignore strs

// pi-uutils: vendored from uutils/coreutils 0.8.0 and patched to run in-process
// as a shell builtin. All process-global stdio is routed through
// `pi_uutils_ctx`, `translate!` strings are literalized, and the entry point no
// longer calls `std::process::exit`. Because the utility runs inside the shell
// process there is no SIGPIPE to terminate it when the consumer closes, so a
// broken-pipe write error exits cleanly with code 0 (GNU behaviour) on every
// platform, and the output loop polls the scope cancel flag so shell
// abort/timeout stops it promptly.

use std::{
	error::Error,
	ffi::OsString,
	io::{self, Write},
};

use clap::{Arg, ArgAction, Command, builder::ValueParser};
use pi_uutils_ctx::format_usage;
use uucore::error::strip_errno;

// it's possible that using a smaller or larger buffer might provide better
// performance on some systems, but honestly this is good enough
const BUF_SIZE: usize = 16 * 1024;

/// In-process builtin entry point. Unlike upstream's `uumain`, this parses the
/// arguments directly (without the uucore clap-localization helper that would
/// terminate the process), renders clap help/usage/version to the context
/// streams, and maps the outcome to an exit code, so it is safe to run inside
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

	let mut buffer = Vec::with_capacity(BUF_SIZE);
	#[allow(clippy::unwrap_used, reason = "clap provides 'y' by default")]
	let _ = args_into_buffer(&mut buffer, matches.get_many::<OsString>("STRING").unwrap());
	prepare_buffer(&mut buffer);

	match exec(&buffer) {
		// pi-uutils: a broken pipe means the consumer closed its end; a
		// process `yes` would die from SIGPIPE (or handle EPIPE on Windows),
		// so the in-process builtin exits cleanly with 0 on every platform.
		ExecStop::Io(err) if err.kind() == io::ErrorKind::BrokenPipe => 0,
		ExecStop::Io(err) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "yes: standard output: {}", strip_errno(&err));
			1
		},
		// pi-uutils: the shell asked the scope to cancel (abort/timeout);
		// there is no signal-style exit status in-process, so return 1.
		ExecStop::Cancelled => 1,
	}
}

pub fn uu_app() -> Command {
	Command::new("yes")
		.version(uucore::crate_version!())
		.about("Repeatedly display a line with STRING (or 'y')")
		.override_usage(format_usage("yes [STRING]..."))
		.arg(
			Arg::new("STRING")
				.default_value("y")
				.value_parser(ValueParser::os_string())
				.action(ArgAction::Append),
		)
		.infer_long_args(true)
}

/// Copies words from `i` into `buf`, separated by spaces.
#[allow(clippy::unnecessary_wraps, reason = "needed on some platforms")]
fn args_into_buffer<'a>(
	buf: &mut Vec<u8>,
	i: impl Iterator<Item = &'a OsString>,
) -> Result<(), Box<dyn Error>> {
	// On Unix (and wasi), OsStrs are just &[u8]'s underneath...
	#[cfg(any(unix, target_os = "wasi"))]
	{
		#[cfg(unix)]
		use std::os::unix::ffi::OsStrExt;
		#[cfg(target_os = "wasi")]
		use std::os::wasi::ffi::OsStrExt;

		for part in itertools::intersperse(i.map(|a| a.as_bytes()), b" ") {
			buf.extend_from_slice(part);
		}
	}

	// But, on Windows, we must hop through a String.
	#[cfg(not(any(unix, target_os = "wasi")))]
	{
		for part in itertools::intersperse(i.map(|a| a.to_str()), Some(" ")) {
			let bytes = match part {
				Some(part) => part.as_bytes(),
				// pi-uutils: literalized `translate!("yes-error-invalid-utf8")`.
				None => return Err("arguments contain invalid UTF-8".into()),
			};
			buf.extend_from_slice(bytes);
		}
	}

	buf.push(b'\n');

	Ok(())
}

/// Assumes buf holds a single output line forged from the command line
/// arguments, copies it repeatedly until the buffer holds as many copies as it
/// can under [`BUF_SIZE`].
fn prepare_buffer(buf: &mut Vec<u8>) {
	let line_len = buf.len();
	debug_assert!(line_len > 0, "buffer is not empty since we have newline");
	let target_size = line_len * (BUF_SIZE / line_len); // 0 if line_len is already large enough

	while buf.len() < target_size {
		let to_copy = std::cmp::min(target_size - buf.len(), buf.len());
		debug_assert_eq!(to_copy % line_len, 0);
		buf.extend_from_within(..to_copy);
	}
}

/// pi-uutils: why the output loop stopped. Upstream's `exec` only ever returns
/// an I/O error (the loop is infinite); in-process we also stop on scope
/// cancellation.
enum ExecStop {
	Io(io::Error),
	Cancelled,
}

/// pi-uutils: replacement for upstream's `exec` — writes to the context stdout
/// instead of the process stdout and polls the scope cancel flag every
/// iteration (each iteration writes a full [`BUF_SIZE`]-ish batch, so polling
/// per iteration is cheap) so shell abort/timeout stops the loop promptly.
fn exec(bytes: &[u8]) -> ExecStop {
	let mut stdout = pi_uutils_ctx::stdout();

	loop {
		if pi_uutils_ctx::is_cancelled() {
			return ExecStop::Cancelled;
		}
		if let Err(err) = stdout.write_all(bytes) {
			return ExecStop::Io(err);
		}
	}
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, io::Write, path::PathBuf, sync::Arc};

	use parking_lot::Mutex;
	use pi_uutils_ctx::ScopeIo;

	use super::*;

	/// Writer that accepts up to `budget` bytes into a shared buffer, then
	/// fails every further write with `fail_kind` — models a consumer that
	/// closes the pipe after reading some output.
	struct FailingWriter {
		buf:       Arc<Mutex<Vec<u8>>>,
		budget:    usize,
		fail_kind: io::ErrorKind,
	}
	impl Write for FailingWriter {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			if self.budget == 0 {
				return Err(io::Error::new(self.fail_kind, "consumer gone"));
			}
			let n = buf.len().min(self.budget);
			self.budget -= n;
			self.buf.lock().extend_from_slice(&buf[..n]);
			Ok(n)
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	fn run_with(
		args: Vec<&str>,
		budget: usize,
		fail_kind: io::ErrorKind,
		cancelled: bool,
	) -> (i32, String, String) {
		let stdout_buf = Arc::new(Mutex::new(Vec::new()));
		let stderr_buf = Arc::new(Mutex::new(Vec::new()));

		#[derive(Clone)]
		struct SharedWriter {
			buf: Arc<Mutex<Vec<u8>>>,
		}
		impl Write for SharedWriter {
			fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
				self.buf.lock().write(buf)
			}

			fn flush(&mut self) -> io::Result<()> {
				self.buf.lock().flush()
			}
		}

		let io = ScopeIo {
			stdin:                 Box::new(std::io::empty()),
			stdin_fd:              None,
			stdin_is_search_input: false,
			stdout:                Box::new(FailingWriter {
				buf: stdout_buf.clone(),
				budget,
				fail_kind,
			}),
			stderr:                Box::new(SharedWriter { buf: stderr_buf.clone() }),
			cwd:                   PathBuf::from("."),
			env:                   HashMap::new(),
			cancel:                Arc::new(std::sync::atomic::AtomicBool::new(cancelled)),
		};

		let argv: Vec<OsString> = std::iter::once("yes")
			.chain(args)
			.map(OsString::from)
			.collect();

		let code = pi_uutils_ctx::scope(io, || run(argv));

		let out_str = String::from_utf8(stdout_buf.lock().clone()).unwrap();
		let err_str = String::from_utf8(stderr_buf.lock().clone()).unwrap();

		(code, out_str, err_str)
	}

	#[test]
	fn broken_pipe_is_clean_exit() {
		// Consumer takes 100 bytes then closes: exit 0, like GNU yes dying to
		// SIGPIPE without an error status visible to the shell.
		let (code, stdout, stderr) = run_with(vec![], 100, io::ErrorKind::BrokenPipe, false);
		assert_eq!(code, 0);
		assert!(stdout.starts_with("y\ny\n"), "expected default 'y' lines, got {stdout:?}");
		assert_eq!(stdout.len(), 100);
		assert_eq!(stderr, "");
	}

	#[test]
	fn custom_operands_join_with_spaces_and_repeat() {
		// Budget is a multiple of the line length ("hello world\n" = 12 bytes)
		// so the captured output is whole lines.
		let (code, stdout, stderr) =
			run_with(vec!["hello", "world"], 12 * 100, io::ErrorKind::BrokenPipe, false);
		assert_eq!(code, 0);
		assert_eq!(stdout.lines().count(), 100);
		for line in stdout.lines() {
			assert_eq!(line, "hello world");
		}
		assert_eq!(stderr, "");
	}

	#[test]
	fn cancellation_stops_loop_promptly() {
		// Pre-set cancel flag: the loop must observe it and return 1 before
		// writing anything. The finite write budget is a backstop so a broken
		// cancel path fails the test (as exit 0) instead of hanging forever.
		let (code, stdout, stderr) = run_with(vec![], 1 << 20, io::ErrorKind::BrokenPipe, true);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "");
	}

	#[test]
	fn non_pipe_write_error_reports_and_fails() {
		let (code, stdout, stderr) = run_with(vec![], 2, io::ErrorKind::Other, false);
		assert_eq!(code, 1);
		assert_eq!(stdout, "y\n");
		assert_eq!(stderr, "yes: standard output: consumer gone\n");
	}

	#[test]
	fn help_renders_to_scope_stdout() {
		let (code, stdout, stderr) = run_with(vec!["--help"], 1 << 20, io::ErrorKind::Other, false);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("Repeatedly display a line"));
		assert_eq!(stderr, "");
	}

	// Upstream unit tests (uutils/coreutils 0.8.0), kept verbatim apart from
	// indentation.

	#[test]
	fn test_prepare_buffer() {
		let tests = [
			(150, 16350),
			(1000, 16000),
			(4093, 16372),
			(4099, 12297),
			(4111, 12333),
			(2, 16384),
			(3, 16383),
			(4, 16384),
			(5, 16380),
			(8192, 16384),
			(8191, 16382),
			(8193, 8193),
			(10000, 10000),
			(15000, 15000),
			(25000, 25000),
		];

		for (line, final_len) in tests {
			let mut v = std::iter::repeat_n(b'a', line).collect::<Vec<_>>();
			prepare_buffer(&mut v);
			assert_eq!(v.len(), final_len);
		}
	}

	#[test]
	fn test_args_into_buf() {
		{
			let mut v = Vec::with_capacity(BUF_SIZE);
			let default_args = ["y".into()];
			args_into_buffer(&mut v, default_args.iter()).unwrap();
			assert_eq!(String::from_utf8(v).unwrap(), "y\n");
		}

		{
			let mut v = Vec::with_capacity(BUF_SIZE);
			let args = ["foo".into()];
			args_into_buffer(&mut v, args.iter()).unwrap();
			assert_eq!(String::from_utf8(v).unwrap(), "foo\n");
		}

		{
			let mut v = Vec::with_capacity(BUF_SIZE);
			let args = ["foo".into(), "bar    baz".into(), "qux".into()];
			args_into_buffer(&mut v, args.iter()).unwrap();
			assert_eq!(String::from_utf8(v).unwrap(), "foo bar    baz qux\n");
		}
	}
}

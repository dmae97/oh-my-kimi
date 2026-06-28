//! In-process shell builtins backed by vendored, patched uutils utilities.
//!
//! Each builtin installs a [`pi_uutils_ctx`] scope — the command's stdio file
//! descriptors, the shell working directory, and the shell's exported
//! environment — on a dedicated blocking thread, then invokes the patched
//! utility's `run` entry point. Running on a blocking thread keeps the
//! thread-local context isolated across concurrent pipeline stages and avoids
//! blocking the async runtime on synchronous utility I/O.

use std::{
	collections::HashMap,
	ffi::OsString,
	io::{self, Read, Write},
	panic::catch_unwind,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use brush_core::{
	Error,
	builtins::{BoxFuture, ContentOptions, ContentType, Registration},
	commands::{CommandArg, ExecutionContext},
	extensions::ShellExtensions,
	openfiles::{OpenFile, OpenFiles},
	results::ExecutionResult,
};

/// Signature of a patched uutils `run` entry point: consumes `argv` (with the
/// command name at index 0) and returns a process-style exit code.
type UutilRun = fn(Vec<OsString>) -> i32;

/// Drives a patched uutils utility to completion under a [`pi_uutils_ctx`]
/// scope derived from the command execution context.
async fn run_uutil<SE: ShellExtensions>(
	context: ExecutionContext<'_, SE>,
	args: Vec<CommandArg>,
	run: UutilRun,
) -> Result<ExecutionResult, Error> {
	// Capture everything owned *before* the first await so the returned future
	// stays `Send`: the borrowed `ExecutionContext` (and its `&mut Shell`) is
	// dropped before we await the blocking task.
	let stdin = context.try_fd(OpenFiles::STDIN_FD);
	let stdout = context.try_fd(OpenFiles::STDOUT_FD);
	let stderr = context.try_fd(OpenFiles::STDERR_FD);
	let cwd = context.shell.working_dir().to_path_buf();
	let cancel = context.cancel_token();

	let mut env = HashMap::new();
	for (key, var) in context.shell.env().iter_exported() {
		if var.value().is_set() {
			env.insert(key.clone(), var.value().to_cow_str(context.shell).into_owned());
		}
	}

	// On unix, capture the raw stdin fd so the context can poll it for
	// cancellation; the `OpenFile` is moved into (and kept alive by) the
	// blocking task below, so the fd stays valid for the poll loop.
	#[cfg(unix)]
	let stdin_fd: Option<i32> = {
		use std::os::fd::AsRawFd;
		stdin
			.as_ref()
			.and_then(|file| file.try_borrow_as_fd().ok())
			.map(|fd| fd.as_raw_fd())
	};
	#[cfg(not(unix))]
	let stdin_fd: Option<i32> = None;
	let stdin_is_search_input = stdin
		.as_ref()
		.is_some_and(|file| matches!(file, OpenFile::PipeReader(_) | OpenFile::Stream(_)));

	let cancel_flag = Arc::new(AtomicBool::new(false));
	let scope_flag = Arc::clone(&cancel_flag);

	// brush passes the command name as the first `CommandArg`, which is exactly
	// the argv[0] uutils' argument parsing expects.
	let argv: Vec<OsString> = args
		.iter()
		.map(|arg| OsString::from(arg.to_string()))
		.collect();

	drop(context);

	let mut handle = tokio::task::spawn_blocking(move || {
		let stdin: Box<dyn Read + Send> = match stdin {
			Some(file) => Box::new(file),
			None => Box::new(io::empty()),
		};
		let stdout: Box<dyn Write + Send> = match stdout {
			Some(file) => Box::new(file),
			None => Box::new(io::sink()),
		};
		let stderr: Box<dyn Write + Send> = match stderr {
			Some(file) => Box::new(file),
			None => Box::new(io::sink()),
		};
		pi_uutils_ctx::scope(
			pi_uutils_ctx::ScopeIo {
				stdin,
				stdin_fd,
				stdin_is_search_input,
				stdout,
				stderr,
				cwd,
				env,
				cancel: scope_flag,
			},
			|| run_caught(run, argv),
		)
	});

	// Respect bash abort/timeout. On cancel we set the context's cancel flag,
	// which makes a blocked `stdin` read return EOF; the utility unwinds
	// cleanly (flushing what it already produced) and the blocking task
	// completes. We await that completion before returning so no detached
	// thread keeps writing to the command's (possibly redirected) fds.
	let code = match cancel {
		Some(token) => {
			let token_check = token.clone();
			tokio::select! {
				biased;
				() = token.cancelled() => {
					cancel_flag.store(true, Ordering::Relaxed);
					let _ = (&mut handle).await;
					130
				},
				result = &mut handle => {
					// If the token already fired, the task only finished because
					// our cancel flag unblocked it — report interrupted.
					if token_check.is_cancelled() { 130 } else { result.unwrap_or(1) }
				},
			}
		},
		None => handle.await.unwrap_or(1),
	};

	Ok(ExecutionResult::new((code & 0xff) as u8))
}

/// Runs a uutils entry point, containing any panic at the in-process boundary.
///
/// A vendored utility that panics (e.g. an `unwrap` on a `BrokenPipe`, the
/// crash this guards — see uu-tail) must not take down the long-lived host.
/// With `panic = "unwind"` the panic unwinds to here, where it becomes a
/// non-zero exit plus a concise note on the command's own stderr. The native
/// crash hook recognizes the active uutils scope and keeps the recovered panic
/// out of the user-facing crash report (it is still logged to disk).
fn run_caught(run: UutilRun, argv: Vec<OsString>) -> i32 {
	let name = argv
		.first()
		.map_or_else(|| String::from("command"), |arg| arg.to_string_lossy().into_owned());
	if let Ok(code) = catch_unwind(|| run(argv)) {
		code
	} else {
		let _ = writeln!(pi_uutils_ctx::stderr(), "{name}: internal error");
		1
	}
}

/// Minimal help/usage content for a uutils-backed builtin. The full utility
/// renders its own `--help` through the context streams at runtime.
#[allow(
	clippy::unnecessary_wraps,
	reason = "signature must match brush's CommandContentFunc fn pointer (Result<String, _>)"
)]
fn uutil_content(
	name: &str,
	_content_type: ContentType,
	_options: &ContentOptions,
) -> Result<String, Error> {
	Ok(format!("{name}: {name} [uutils builtin]\n"))
}

/// Defines a `Registration` constructor that dispatches to a patched uutils
/// `run` entry point with raw (unparsed-by-brush) arguments.
macro_rules! uutil_builtin {
	($vis:vis fn $reg_fn:ident => $run:path) => {
		$vis fn $reg_fn<SE: ShellExtensions>() -> Registration<SE> {
			fn execute<SE: ShellExtensions>(
				context: ExecutionContext<'_, SE>,
				args: Vec<CommandArg>,
			) -> BoxFuture<'_, Result<ExecutionResult, Error>> {
				Box::pin(run_uutil(context, args, $run))
			}
			Registration {
				execute_func:                   execute::<SE>,
				content_func:                   uutil_content,
				disabled:                       false,
				special_builtin:                false,
				declaration_builtin:            false,
				transparent_background_wrapper: false,
			}
		}
	};
}

uutil_builtin!(pub fn mkdir_builtin => uu_mkdir::run);
uutil_builtin!(pub fn head_builtin => uu_head::run);
uutil_builtin!(pub fn sort_builtin => uu_sort::run);
uutil_builtin!(pub fn wc_builtin => uu_wc::run);
uutil_builtin!(pub fn tail_builtin => uu_tail::run);
uutil_builtin!(pub fn ls_builtin => uu_ls::run);
uutil_builtin!(pub fn find_builtin => uu_find::run);
uutil_builtin!(pub fn grep_builtin => pi_uu_grep::run);
uutil_builtin!(pub fn rg_builtin => pi_uu_grep::run_rg);
uutil_builtin!(pub fn rm_builtin => uu_rm::run);
uutil_builtin!(pub fn mv_builtin => uu_mv::run);
uutil_builtin!(pub fn cat_builtin => uu_cat::run);
uutil_builtin!(pub fn uniq_builtin => uu_uniq::run);

#[cfg(test)]
mod tests {
	use std::{
		collections::HashMap,
		ffi::OsString,
		io::{self, Write},
		path::PathBuf,
		sync::{Arc, atomic::AtomicBool, mpsc},
	};

	use super::{UutilRun, run_caught};

	/// `Send` writer that forwards every write onto a channel so a test can
	/// inspect what the utility wrote to the scope's stderr.
	struct ChanWriter(mpsc::Sender<Vec<u8>>);
	impl Write for ChanWriter {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			let _ = self.0.send(buf.to_vec());
			Ok(buf.len())
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	fn scope_io(stderr: Box<dyn Write + Send>) -> pi_uutils_ctx::ScopeIo {
		pi_uutils_ctx::ScopeIo {
			stdin: Box::new(io::empty()),
			stdin_fd: None,
			stdin_is_search_input: false,
			stdout: Box::new(io::sink()),
			stderr,
			cwd: PathBuf::from("."),
			env: HashMap::new(),
			cancel: Arc::new(AtomicBool::new(false)),
		}
	}

	fn run_in_scope(run: UutilRun, argv: Vec<OsString>) -> (i32, String) {
		let (tx, rx) = mpsc::channel();
		let code = pi_uutils_ctx::scope(scope_io(Box::new(ChanWriter(tx))), || run_caught(run, argv));
		let mut err = Vec::new();
		while let Ok(chunk) = rx.try_recv() {
			err.extend_from_slice(&chunk);
		}
		(code, String::from_utf8(err).expect("utf8 stderr"))
	}

	#[test]
	fn run_caught_passes_through_exit_code() {
		fn ok(_argv: Vec<OsString>) -> i32 {
			7
		}
		let (code, err) = run_in_scope(ok, vec![OsString::from("wc")]);
		assert_eq!(code, 7, "successful utility exit code is preserved");
		assert!(err.is_empty(), "no diagnostic on a clean run");
	}

	#[test]
	fn run_caught_maps_panic_to_failure() {
		fn boom(_argv: Vec<OsString>) -> i32 {
			panic!("kaboom");
		}
		let (code, err) = run_in_scope(boom, vec![OsString::from("tail")]);
		assert_eq!(code, 1, "a panic in the utility becomes a failed command");
		assert_eq!(err, "tail: internal error\n", "diagnostic names the command");
	}
}

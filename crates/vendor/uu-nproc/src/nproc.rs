// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) NPROCESSORS nprocs numstr sysconf

// pi-uutils: vendored from uutils/coreutils 0.8.0 and patched to run in-process
// as a shell builtin. The OMP_NUM_THREADS and OMP_THREAD_LIMIT environment
// variables are read from the scope environment via `pi_uutils_ctx::var` (the
// shell's exported variables), not the host process environment. All output is
// routed through the context stdout, `translate!` strings are literalized, and
// the entry point no longer calls `std::process::exit`.

use std::{ffi::OsString, io::Write, thread};

use clap::{Arg, ArgAction, ArgMatches, Command};
use pi_uutils_ctx::format_usage;
use uucore::{
	display::Quotable,
	error::{UResult, USimpleError},
};

static OPT_ALL: &str = "all";
static OPT_IGNORE: &str = "ignore";

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
	match nproc_main(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let msg = err.to_string();
			if !msg.is_empty() {
				let _ = writeln!(pi_uutils_ctx::stderr(), "nproc: {msg}");
			}
			if code == 0 { 1 } else { code }
		},
	}
}

fn nproc_main(matches: &ArgMatches) -> UResult<()> {
	let ignore = match matches.get_one::<String>(OPT_IGNORE) {
		Some(numstr) => match numstr.trim().parse::<usize>() {
			Ok(num) => num,
			Err(e) => {
				return Err(USimpleError::new(
					1,
					// pi-uutils: literalized translate!("nproc-error-invalid-number")
					format!("{} is not a valid number: {e}", numstr.quote()),
				));
			},
		},
		None => 0,
	};

	// pi-uutils: OMP_THREAD_LIMIT comes from the scope environment (the
	// shell's exported variables), not the host process environment.
	let limit = match pi_uutils_ctx::var("OMP_THREAD_LIMIT") {
		// Uses the OpenMP variable to limit the number of threads
		// If the parsing fails, returns the max size (so, no impact)
		// If OMP_THREAD_LIMIT=0, rejects the value
		Some(threads) => match threads.parse() {
			Ok(0) | Err(_) => usize::MAX,
			Ok(n) => n,
		},
		// the variable 'OMP_THREAD_LIMIT' doesn't exist
		// fallback to the max
		None => usize::MAX,
	};

	let mut cores = if matches.get_flag(OPT_ALL) {
		num_cpus_all()
	} else {
		// OMP_NUM_THREADS doesn't have an impact on --all
		// pi-uutils: OMP_NUM_THREADS comes from the scope environment.
		match pi_uutils_ctx::var("OMP_NUM_THREADS") {
			// Uses the OpenMP variable to force the number of threads
			// If the parsing fails, returns the number of CPU
			Some(threads) => {
				// In some cases, OMP_NUM_THREADS can be "x,y,z"
				// In this case, only take the first one (like GNU)
				// If OMP_NUM_THREADS=0, rejects the value
				match threads.split_terminator(',').next() {
					None => available_parallelism(),
					Some(s) => match s.trim().parse() {
						Ok(0) | Err(_) => available_parallelism(),
						Ok(n) => n,
					},
				}
			},
			// the variable 'OMP_NUM_THREADS' doesn't exist
			// fallback to the regular CPU detection
			None => available_parallelism(),
		}
	};

	cores = std::cmp::min(limit, cores);
	if cores <= ignore {
		cores = 1;
	} else {
		cores -= ignore;
	}
	// pi-uutils: write to the context stdout instead of the process stdout.
	pi_uutils_ctx::stdout()
		.write_all(format!("{cores}\n").as_bytes())
		.map_err(|e| USimpleError::new(1, e.to_string()))?;
	Ok(())
}

pub fn uu_app() -> Command {
	Command::new("nproc")
		.version(uucore::crate_version!())
		.about(
			"Print the number of cores available to the current process.\nIf the OMP_NUM_THREADS or \
			 OMP_THREAD_LIMIT environment variables are set, then\nthey will determine the minimum \
			 and maximum returned value respectively.",
		)
		.override_usage(format_usage("nproc [OPTIONS]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_ALL)
				.long(OPT_ALL)
				.help("print the number of cores available to the system")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_IGNORE)
				.long(OPT_IGNORE)
				.value_name("N")
				.help("ignore up to N cores"),
		)
}

#[cfg(unix)]
fn num_cpus_all() -> usize {
	// In some situation, /proc and /sys are not mounted, and sysconf returns 1.
	// However, we want to guarantee that `nproc --all` >= `nproc`.
	unsafe { libc::sysconf(libc::_SC_NPROCESSORS_CONF) }
		.try_into()
		.ok()
		.filter(|&n: &isize| n > 1)
		.map_or_else(available_parallelism, |n| n as usize)
}

// Other platforms (e.g., windows), available_parallelism() directly.
#[cfg(not(unix))]
fn num_cpus_all() -> usize {
	available_parallelism()
}

/// In some cases, [`thread::available_parallelism`]() may return an Err
/// In this case, we will return 1 (like GNU)
fn available_parallelism() -> usize {
	thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get)
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, io::Write, path::PathBuf, sync::Arc};

	use parking_lot::Mutex;
	use pi_uutils_ctx::ScopeIo;

	use super::*;

	fn run_in(env: HashMap<String, String>, args: Vec<&str>) -> (i32, String, String) {
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
			cwd: PathBuf::from("."),
			env,
			cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
		};

		let argv: Vec<OsString> = std::iter::once("nproc")
			.chain(args)
			.map(OsString::from)
			.collect();

		let code = pi_uutils_ctx::scope(io, || run(argv));

		let out_str = String::from_utf8(stdout_buf.lock().clone()).unwrap();
		let err_str = String::from_utf8(stderr_buf.lock().clone()).unwrap();

		(code, out_str, err_str)
	}

	#[test]
	fn scope_env_omp_num_threads_forces_count() {
		let env = HashMap::from([("OMP_NUM_THREADS".to_string(), "3".to_string())]);
		let (code, stdout, stderr) = run_in(env, vec![]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "3\n", ""));
	}

	#[test]
	fn omp_thread_limit_caps_omp_num_threads() {
		let env = HashMap::from([
			("OMP_NUM_THREADS".to_string(), "64".to_string()),
			("OMP_THREAD_LIMIT".to_string(), "2".to_string()),
		]);
		let (code, stdout, stderr) = run_in(env, vec![]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "2\n", ""));
	}

	#[test]
	fn all_prints_positive_integer_and_ignores_omp_num_threads() {
		// --all reports hardware CPUs; OMP_NUM_THREADS must not force it.
		let env = HashMap::from([("OMP_NUM_THREADS".to_string(), "0".to_string())]);
		let (code, stdout, stderr) = run_in(env, vec!["--all"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let n: usize = stdout
			.trim_end()
			.parse()
			.expect("--all output is an integer");
		assert!(n >= 1);
	}

	#[test]
	fn process_environment_is_not_consulted() {
		// The variable exists only in the host process environment, not the
		// scope map: only the un-patched `std::env::var` path would see it.
		unsafe { std::env::set_var("OMP_NUM_THREADS", "1234") };
		let (code, stdout, stderr) = run_in(HashMap::new(), vec![]);
		unsafe { std::env::remove_var("OMP_NUM_THREADS") };
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_ne!(stdout, "1234\n");
		let n: usize = stdout.trim_end().parse().expect("output is an integer");
		assert!(n >= 1);
	}

	#[test]
	fn ignore_subtracts_and_floors_at_one() {
		let env = HashMap::from([("OMP_NUM_THREADS".to_string(), "8".to_string())]);
		let (code, stdout, _) = run_in(env, vec!["--ignore=3"]);
		assert_eq!((code, stdout.as_str()), (0, "5\n"));

		let env = HashMap::from([("OMP_NUM_THREADS".to_string(), "2".to_string())]);
		let (code, stdout, _) = run_in(env, vec!["--ignore=5"]);
		assert_eq!((code, stdout.as_str()), (0, "1\n"));
	}

	#[test]
	fn invalid_ignore_value_is_an_error() {
		let (code, stdout, stderr) = run_in(HashMap::new(), vec!["--ignore=bogus"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.contains("is not a valid number"), "stderr: {stderr}");
	}
}

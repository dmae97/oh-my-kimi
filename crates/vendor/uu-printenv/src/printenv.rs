// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// pi-uutils: vendored from uutils/coreutils 0.8.0 and patched to run in-process
// as a shell builtin. The environment comes from the SCOPE, not the process:
// the no-argument dump iterates `pi_uutils_ctx::env_snapshot()` and named
// lookups go through `pi_uutils_ctx::var`, because the embedding shell's
// exported variables are not present in the host process environment. All
// output is routed through the context stdout, `translate!` strings are
// literalized, and the entry point no longer calls `std::process::exit`.

use std::{ffi::OsString, io::Write};

use clap::{Arg, ArgAction, ArgMatches, Command};
use pi_uutils_ctx::format_usage;
use uucore::{error::UResult, line_ending::LineEnding};

static OPT_NULL: &str = "null";

static ARG_VARIABLES: &str = "variables";

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
	match printenv_main(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			// pi-uutils: unset-variable failures surface as bare exit-code
			// errors that render to an empty message (upstream prints nothing
			// for them); don't emit a dangling "printenv: " prefix.
			let msg = err.to_string();
			if !msg.is_empty() {
				let _ = writeln!(pi_uutils_ctx::stderr(), "printenv: {msg}");
			}
			if code == 0 { 1 } else { code }
		},
	}
}

fn printenv_main(matches: &ArgMatches) -> UResult<()> {
	let variables: Vec<String> = matches
		.get_many::<String>(ARG_VARIABLES)
		.map(|v| v.map(ToString::to_string).collect())
		.unwrap_or_default();

	let separator = LineEnding::from_zero_flag(matches.get_flag(OPT_NULL));

	if variables.is_empty() {
		// pi-uutils: replacement for `uucore::display::print_all_env_vars` —
		// dumps the scope environment map to the context stdout.
		let mut stdout = pi_uutils_ctx::stdout();
		for (key, value) in pi_uutils_ctx::env_snapshot() {
			write!(stdout, "{key}={value}{separator}")?;
		}
		stdout.flush()?;
		return Ok(());
	}

	let mut error_found = false;
	for env_var in variables {
		// we silently ignore a=b as variable but we trigger an error
		if env_var.contains('=') {
			error_found = true;
			continue;
		}
		// pi-uutils: look the variable up in the scope environment (upstream
		// uses `std::env::var_os`) and write it to the context stdout.
		if let Some(var) = pi_uutils_ctx::var(&env_var) {
			let mut stdout = pi_uutils_ctx::stdout();
			write!(stdout, "{var}{separator}")?;
			stdout.flush()?;
		} else {
			error_found = true;
		}
	}

	if error_found { Err(1.into()) } else { Ok(()) }
}

pub fn uu_app() -> Command {
	Command::new("printenv")
		.version(uucore::crate_version!())
		.about(
			"Display the values of the specified environment VARIABLE(s), or (with no VARIABLE) \
			 display name and value pairs for them all.",
		)
		.override_usage(format_usage("printenv [OPTION]... [VARIABLE]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_NULL)
				.short('0')
				.long(OPT_NULL)
				.help("end each output line with 0 byte rather than newline")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(ARG_VARIABLES)
				.action(ArgAction::Append)
				.num_args(1..),
		)
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, io::Write, sync::Arc};

	use parking_lot::Mutex;
	use pi_uutils_ctx::ScopeIo;

	use super::*;

	fn run_with_env(env: HashMap<String, String>, args: Vec<&str>) -> (i32, String, String) {
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
			cwd: std::path::PathBuf::from("."),
			env,
			cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
		};

		let argv: Vec<OsString> = std::iter::once("printenv")
			.chain(args)
			.map(OsString::from)
			.collect();

		let code = pi_uutils_ctx::scope(io, || run(argv));

		let out_str = String::from_utf8(stdout_buf.lock().clone()).unwrap();
		let err_str = String::from_utf8(stderr_buf.lock().clone()).unwrap();

		(code, out_str, err_str)
	}

	fn scope_env() -> HashMap<String, String> {
		HashMap::from([
			("FOO".to_string(), "bar".to_string()),
			("BAZ".to_string(), "qux".to_string()),
		])
	}

	#[test]
	fn named_variable_prints_scope_value() {
		let (code, stdout, stderr) = run_with_env(scope_env(), vec!["FOO"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "bar\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn unset_variable_is_silent_failure() {
		let (code, stdout, stderr) = run_with_env(scope_env(), vec!["NOPE"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "", "unset variables fail without a message");
	}

	#[test]
	fn mixed_set_and_unset_prints_set_ones_and_fails() {
		let (code, stdout, stderr) = run_with_env(scope_env(), vec!["FOO", "NOPE", "BAZ"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "bar\nqux\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn no_args_dumps_scope_env_not_process_env() {
		// The host process certainly has PATH set; the scope env deliberately
		// does not, so its absence proves the dump reads the scope map.
		assert!(std::env::var_os("PATH").is_some());
		let (code, stdout, stderr) = run_with_env(scope_env(), vec![]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let lines: Vec<&str> = stdout.lines().collect();
		assert_eq!(lines.len(), 2);
		assert!(lines.contains(&"FOO=bar"));
		assert!(lines.contains(&"BAZ=qux"));
		assert!(!lines.iter().any(|l| l.starts_with("PATH=")));
	}

	#[test]
	fn null_flag_terminates_with_nul() {
		let (code, stdout, _) = run_with_env(scope_env(), vec!["-0", "FOO"]);
		assert_eq!((code, stdout.as_str()), (0, "bar\0"));

		let (code, stdout, _) = run_with_env(scope_env(), vec!["--null", "FOO", "BAZ"]);
		assert_eq!((code, stdout.as_str()), (0, "bar\0qux\0"));
	}

	#[test]
	fn name_containing_equals_is_ignored_but_fails() {
		let (code, stdout, stderr) = run_with_env(scope_env(), vec!["FOO=bar", "BAZ"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "qux\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn help_renders_to_scope_stdout() {
		let (code, stdout, stderr) = run_with_env(HashMap::new(), vec!["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("environment VARIABLE"));
		assert_eq!(stderr, "");
	}
}

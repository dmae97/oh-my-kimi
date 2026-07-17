//! Behavioral contract tests driving [`crate::run`] under a
//! [`pi_uutils_ctx::scope`], the way the shell host does.

use std::{
	collections::HashMap,
	ffi::OsString,
	io::{self, Write},
	path::Path,
	sync::{Arc, atomic::AtomicBool},
};

use parking_lot::Mutex;

/// `Send` writer that appends every write to a shared buffer so the test can
/// inspect what the utility wrote to the scope's stdout/stderr.
#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl Sink {
	fn contents(&self) -> Vec<u8> {
		self.0.lock().clone()
	}
}

impl Write for Sink {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		self.0.lock().extend_from_slice(buf);
		Ok(buf.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

/// Runs `xargs` with `argv` (sans the leading command name), feeding `stdin`
/// bytes, in `cwd`, with `env` as the scope's exported environment. Returns
/// `(exit code, stdout, stderr)`.
fn run_xargs(
	argv: &[&str],
	stdin: &[u8],
	cwd: &Path,
	env: &[(&str, &str)],
) -> (i32, String, String) {
	let out = Sink::default();
	let err = Sink::default();
	let mut full_argv = vec![OsString::from("xargs")];
	full_argv.extend(argv.iter().map(OsString::from));
	let env: HashMap<String, String> = env
		.iter()
		.map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
		.collect();
	let code = pi_uutils_ctx::scope(
		pi_uutils_ctx::ScopeIo {
			stdin: Box::new(io::Cursor::new(stdin.to_vec())),
			stdin_fd: None,
			stdin_is_search_input: false,
			stdout: Box::new(out.clone()),
			stderr: Box::new(err.clone()),
			cwd: cwd.to_path_buf(),
			env,
			cancel: Arc::new(AtomicBool::new(false)),
		},
		|| crate::run(full_argv),
	);
	(
		code,
		String::from_utf8(out.contents()).expect("utf8 stdout"),
		String::from_utf8(err.contents()).expect("utf8 stderr"),
	)
}

/// Same, with an empty environment and `.` as the working directory.
fn run_simple(argv: &[&str], stdin: &[u8]) -> (i32, String, String) {
	run_xargs(argv, stdin, Path::new("."), &[])
}

#[test]
fn child_stdout_is_captured_through_ctx() {
	let (code, out, err) = run_simple(&["echo"], b"a b c\n");
	assert_eq!(code, 0);
	assert_eq!(out, "a b c\n", "child echo output flows through ctx stdout");
	assert_eq!(err, "", "clean run leaves stderr empty");
}

#[test]
fn max_args_batches_into_two_invocations() {
	let (code, out, _) = run_simple(&["-n", "2", "echo"], b"a b c\n");
	assert_eq!(code, 0);
	assert_eq!(out, "a b\nc\n", "-n 2 splits three items into two runs");
}

#[test]
fn default_mode_honors_quotes() {
	// "a b" c → exactly two arguments for the child.
	let (code, out, _) = run_simple(&["sh", "-c", "echo $#", "_"], b"\"a b\" c\n");
	assert_eq!(code, 0);
	assert_eq!(out, "2\n", "quoted item stays a single argument");
}

#[test]
fn null_mode_preserves_spaces_and_newlines() {
	let (code, out, _) = run_simple(&["-0", "echo"], b"a b\0c\nd\0");
	assert_eq!(code, 0);
	assert_eq!(out, "a b c\nd\n", "NUL-split items keep spaces and newlines");
}

#[test]
fn replace_places_item_mid_command() {
	let (code, out, _) = run_simple(&["-I", "{}", "echo", "hello", "{}", "!"], b"world\n");
	assert_eq!(code, 0);
	assert_eq!(out, "hello world !\n", "-I substitutes mid-command");
}

#[test]
fn failing_child_yields_123() {
	let (code, out, _) = run_simple(&["false"], b"x\n");
	assert_eq!(code, 123, "any failed invocation maps to 123");
	assert_eq!(out, "");
}

#[test]
fn missing_command_yields_127() {
	let (code, _, err) = run_simple(&["definitely-not-a-real-command-xyz"], b"x\n");
	assert_eq!(code, 127, "command not found maps to 127");
	assert!(err.contains("Command not found"), "diagnostic lands on ctx stderr, got: {err:?}");
}

#[test]
fn exit_255_child_yields_124() {
	let (code, _, err) = run_simple(&["sh", "-c", "exit 255", "_"], b"x\n");
	assert_eq!(code, 124, "a 255 exit aborts with 124");
	assert!(err.contains("255"), "diagnostic mentions the urgent exit, got: {err:?}");
}

#[test]
fn no_run_if_empty_skips_command() {
	let (code, out, err) = run_simple(&["-r", "echo"], b"");
	assert_eq!(code, 0);
	assert_eq!(out, "", "-r with no input runs nothing");
	assert_eq!(err, "");
}

#[test]
fn empty_input_without_r_runs_default_echo_once() {
	// Upstream findutils 0.8.0 (like GNU) still runs the built-in echo once
	// on empty input, producing a single empty line.
	let (code, out, _) = run_simple(&[], b"");
	assert_eq!(code, 0);
	assert_eq!(out, "\n", "default echo prints one empty line");
}

#[test]
fn verbose_echoes_command_line_to_stderr() {
	let (code, out, err) = run_simple(&["-t", "echo", "a"], b"b\n");
	assert_eq!(code, 0);
	assert_eq!(out, "a b\n");
	assert_eq!(err, "echo a b\n", "-t prints the command line on stderr");
}

#[test]
fn children_run_in_scope_cwd() {
	let dir = tempfile::TempDir::new().expect("tempdir");
	let (code, _, err) =
		run_xargs(&["sh", "-c", "touch \"$1\"", "_"], b"made.txt\n", dir.path(), &[]);
	assert_eq!(code, 0, "stderr: {err:?}");
	assert!(
		dir.path().join("made.txt").exists(),
		"relative paths in the child resolve against the scope cwd"
	);
}

#[test]
fn children_see_scope_environment() {
	let (code, out, _) =
		run_simple_env(&["sh", "-c", "echo \"$XVAR\"", "_"], b"x\n", &[("XVAR", "hello")]);
	assert_eq!(code, 0);
	assert_eq!(out, "hello\n", "scope env reaches the child via env_snapshot");
}

fn run_simple_env(argv: &[&str], stdin: &[u8], env: &[(&str, &str)]) -> (i32, String, String) {
	run_xargs(argv, stdin, Path::new("."), env)
}

#[test]
fn arg_file_resolves_against_scope_cwd() {
	let dir = tempfile::TempDir::new().expect("tempdir");
	std::fs::write(dir.path().join("items.txt"), "a b\n").expect("write items");
	let (code, out, _) = run_xargs(&["-a", "items.txt", "echo"], b"", dir.path(), &[]);
	assert_eq!(code, 0);
	assert_eq!(out, "a b\n", "-a file opens relative to the scope cwd");
}

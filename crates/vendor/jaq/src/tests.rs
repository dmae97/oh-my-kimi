//! Behavioral contract tests driving [`crate::run`] under a
//! [`pi_uutils_ctx::scope`], the way the shell host invokes the builtin.

use std::{
	collections::HashMap,
	ffi::OsString,
	io::{self, Write},
	path::PathBuf,
	sync::{Arc, atomic::AtomicBool},
};

use parking_lot::Mutex;

/// `Send + Write` capture buffer for the scope's stdout/stderr.
#[derive(Clone, Default)]
struct Buf(Arc<Mutex<Vec<u8>>>);

impl Buf {
	fn take_string(&self) -> String {
		String::from_utf8(std::mem::take(&mut *self.0.lock())).expect("utf8 output")
	}
}

impl Write for Buf {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		self.0.lock().extend_from_slice(buf);
		Ok(buf.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

/// Runs `jq <args>` with `stdin` under a fresh scope; returns
/// `(exit code, stdout, stderr)`.
fn run_jq_in(
	cwd: PathBuf,
	env: HashMap<String, String>,
	args: &[&str],
	stdin: &str,
) -> (i32, String, String) {
	let out = Buf::default();
	let err = Buf::default();
	let io_ = pi_uutils_ctx::ScopeIo {
		stdin: Box::new(io::Cursor::new(stdin.as_bytes().to_vec())),
		stdin_fd: None,
		stdin_is_search_input: false,
		stdout: Box::new(out.clone()),
		stderr: Box::new(err.clone()),
		cwd,
		env,
		cancel: Arc::new(AtomicBool::new(false)),
	};
	let mut argv = vec![OsString::from("jq")];
	argv.extend(args.iter().map(OsString::from));
	let code = pi_uutils_ctx::scope(io_, || crate::run(argv));
	(code, out.take_string(), err.take_string())
}

fn run_jq(args: &[&str], stdin: &str) -> (i32, String, String) {
	run_jq_in(PathBuf::from("."), HashMap::new(), args, stdin)
}

#[test]
fn identity_pretty_prints() {
	let (code, out, err) = run_jq(&["."], "{\"a\":1}");
	assert_eq!(code, 0);
	assert_eq!(out, "{\n  \"a\": 1\n}\n");
	assert_eq!(err, "");
}

#[test]
fn compact_output() {
	let (code, out, _) = run_jq(&["-c", ".a"], "{\"a\":[1,2]}");
	assert_eq!(code, 0);
	assert_eq!(out, "[1,2]\n");
}

#[test]
fn raw_output_strips_quotes() {
	let (code, out, _) = run_jq(&["-r", ".s"], "{\"s\":\"x y\"}");
	assert_eq!(code, 0);
	assert_eq!(out, "x y\n");

	let (code, out, _) = run_jq(&[".s"], "{\"s\":\"x y\"}");
	assert_eq!(code, 0);
	assert_eq!(out, "\"x y\"\n");
}

#[test]
fn null_input_evaluates_filter() {
	let (code, out, _) = run_jq(&["-n", "1+2"], "");
	assert_eq!(code, 0);
	assert_eq!(out, "3\n");
}

#[test]
fn slurp_collects_documents() {
	let (code, out, _) = run_jq(&["-s", "length"], "{\"a\":1}\n{\"b\":2}\n");
	assert_eq!(code, 0);
	assert_eq!(out, "2\n");
}

#[test]
fn named_arg_binds_variable() {
	let (code, out, _) = run_jq(&["-n", "--arg", "k", "v", "$k"], "");
	assert_eq!(code, 0);
	assert_eq!(out, "\"v\"\n");
}

#[test]
fn argjson_binds_json_value() {
	let (code, out, _) = run_jq(&["-nc", "--argjson", "k", "[1,2]", "$k"], "");
	assert_eq!(code, 0);
	assert_eq!(out, "[1,2]\n");
}

#[test]
fn exit_status_flag() {
	// false -> 1
	let (code, out, _) = run_jq(&["-n", "-e", "false"], "");
	assert_eq!(code, 1);
	assert_eq!(out, "false\n");

	// null (missing key) -> 1
	let (code, out, _) = run_jq(&["-e", ".missing"], "{}");
	assert_eq!(code, 1);
	assert_eq!(out, "null\n");

	// truthy -> 0
	let (code, ..) = run_jq(&["-e", "."], "true");
	assert_eq!(code, 0);

	// no output at all -> 4 (jaq-specific; jq also uses 4 here)
	let (code, ..) = run_jq(&["-n", "-e", "empty"], "");
	assert_eq!(code, 4);
}

#[test]
fn compile_error_exits_3_with_diagnostic() {
	let (code, out, err) = run_jq(&["("], "null");
	assert_eq!(code, 3);
	assert_eq!(out, "", "compile error must not produce output");
	assert!(err.contains("Error:"), "diagnostic on stderr: {err:?}");
	assert!(err.contains("<inline>"), "names the filter source: {err:?}");
}

#[test]
fn runtime_error_exits_5_with_diagnostic() {
	// indexing a number is a runtime (Jaq) error
	let (code, out, err) = run_jq(&[".[0]"], "1");
	assert_eq!(code, 5);
	assert_eq!(out, "");
	assert!(err.starts_with("Error:"), "diagnostic on stderr: {err:?}");
}

#[test]
fn usage_error_exits_2() {
	let (code, _, err) = run_jq(&["--bogus", "."], "");
	assert_eq!(code, 2);
	assert!(err.contains("unknown flag: --bogus"), "stderr: {err:?}");
}

#[test]
fn relative_file_operand_resolves_against_scope_cwd() {
	let dir = tempfile::TempDir::new().expect("tempdir");
	std::fs::write(dir.path().join("in.json"), "{\"a\":[1,2]}").expect("write input");
	// relative operand: must resolve against ScopeIo.cwd, not the process cwd
	let (code, out, err) =
		run_jq_in(dir.path().to_path_buf(), HashMap::new(), &["-c", ".a", "in.json"], "");
	assert_eq!(code, 0, "stderr: {err:?}");
	assert_eq!(out, "[1,2]\n");
}

#[test]
fn missing_file_operand_exits_2() {
	let dir = tempfile::TempDir::new().expect("tempdir");
	let (code, out, err) =
		run_jq_in(dir.path().to_path_buf(), HashMap::new(), &[".", "nope.json"], "");
	assert_eq!(code, 2);
	assert_eq!(out, "");
	assert!(err.contains("nope.json"), "stderr names the operand: {err:?}");
}

#[test]
fn in_place_edit_rewrites_relative_file() {
	let dir = tempfile::TempDir::new().expect("tempdir");
	std::fs::write(dir.path().join("in.json"), "{\"a\":1}").expect("write input");
	let (code, _, err) =
		run_jq_in(dir.path().to_path_buf(), HashMap::new(), &["-c", "-i", ".a", "in.json"], "");
	assert_eq!(code, 0, "stderr: {err:?}");
	let rewritten = std::fs::read_to_string(dir.path().join("in.json")).expect("read back");
	assert_eq!(rewritten, "1\n");
}

#[test]
fn invalid_trailing_json_on_stdin_fails() {
	let (code, out, err) = run_jq(&["-c", "."], "{\"a\":1} xyz");
	assert_eq!(code, 5);
	assert_eq!(out, "{\"a\":1}\n", "valid leading document is still emitted");
	assert!(err.contains("Error:"), "stderr diagnostic: {err:?}");
}

#[test]
fn env_var_and_dollar_env_read_scope_environment() {
	let env = HashMap::from([("FOO".to_string(), "bar".to_string())]);
	let (code, out, _) = run_jq_in(PathBuf::from("."), env, &["-n", "$ENV.FOO, env.FOO"], "");
	assert_eq!(code, 0);
	assert_eq!(out, "\"bar\"\n\"bar\"\n", "$ENV and env read the shell env");
}

#[test]
fn halt_returns_instead_of_killing_process() {
	let (code, out, err) = run_jq(&["-n", "1, halt, 2"], "");
	assert_eq!(code, 0, "halt exits 0");
	assert_eq!(out, "1\n", "outputs before halt are emitted, none after");
	assert_eq!(err, "");
}

#[test]
fn halt_error_prints_message_and_exit_code() {
	let (code, out, _) = run_jq(&["-n", "\"bye\\n\" | halt_error(3)"], "");
	assert_eq!(code, 3);
	assert_eq!(out, "bye\n", "string message printed raw");
}

#[test]
fn stderr_filter_writes_to_scope_stderr() {
	let (code, out, err) = run_jq(&["-n", "\"msg\" | stderr | length"], "");
	assert_eq!(code, 0);
	assert_eq!(out, "3\n", "stderr is an identity filter");
	assert_eq!(err, "msg", "raw string on stderr, no newline");
}

#[test]
fn debug_filter_writes_to_scope_stderr() {
	let (code, out, err) = run_jq(&["-nc", "[1,2] | debug"], "");
	assert_eq!(code, 0);
	assert_eq!(out, "[1,2]\n");
	assert_eq!(err, "[\"DEBUG:\", [1,2]]\n");
}

#[test]
fn rawfile_and_slurpfile_resolve_against_scope_cwd() {
	let dir = tempfile::TempDir::new().expect("tempdir");
	std::fs::write(dir.path().join("raw.txt"), "hi").expect("write raw");
	std::fs::write(dir.path().join("vals.json"), "1 2").expect("write vals");
	let (code, out, err) = run_jq_in(
		dir.path().to_path_buf(),
		HashMap::new(),
		&["-nc", "--rawfile", "r", "raw.txt", "--slurpfile", "v", "vals.json", "$r, $v"],
		"",
	);
	assert_eq!(code, 0, "stderr: {err:?}");
	assert_eq!(out, "\"hi\"\n[1,2]\n");
}

#[test]
fn version_flag_prints_and_exits_0() {
	let (code, out, _) = run_jq(&["--version"], "");
	assert_eq!(code, 0);
	assert_eq!(out, format!("jaq {}\n", env!("CARGO_PKG_VERSION")));
}

#[test]
fn tab_and_indent_control_pretty_printing() {
	let (code, out, _) = run_jq(&["--tab", "."], "{\"a\":1}");
	assert_eq!(code, 0);
	assert_eq!(out, "{\n\t\"a\": 1\n}\n");

	let (code, out, _) = run_jq(&["--indent", "4", "."], "{\"a\":1}");
	assert_eq!(code, 0);
	assert_eq!(out, "{\n    \"a\": 1\n}\n");
}

#[test]
fn from_file_reads_filter_relative_to_scope_cwd() {
	let dir = tempfile::TempDir::new().expect("tempdir");
	std::fs::write(dir.path().join("f.jq"), ".a + 1").expect("write filter");
	let (code, out, err) =
		run_jq_in(dir.path().to_path_buf(), HashMap::new(), &["-f", "f.jq"], "{\"a\":1}");
	assert_eq!(code, 0, "stderr: {err:?}");
	assert_eq!(out, "2\n");
}

#[test]
fn join_output_omits_newlines() {
	let (code, out, _) = run_jq(&["-j", ".[]"], "[\"a\",\"b\"]");
	assert_eq!(code, 0);
	assert_eq!(out, "ab");
}

#[test]
fn positional_args_after_double_dash_args() {
	let (code, out, _) = run_jq(&["-nc", "$ARGS.positional", "--args", "x", "y"], "");
	assert_eq!(code, 0);
	assert_eq!(out, "[\"x\",\"y\"]\n");
}

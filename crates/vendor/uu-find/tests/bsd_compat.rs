use std::{
	collections::HashMap,
	ffi::OsString,
	fs,
	io::Write,
	path::PathBuf,
	sync::{Arc, atomic::AtomicBool},
};

use parking_lot::Mutex;
use pi_uutils_ctx::ScopeIo;

fn run_in(cwd: PathBuf, args: Vec<String>) -> (i32, String, String) {
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
		cwd,
		env: HashMap::new(),
		cancel: Arc::new(AtomicBool::new(false)),
	};
	let argv = std::iter::once(OsString::from("find"))
		.chain(args.into_iter().map(OsString::from))
		.collect();
	let code = pi_uutils_ctx::scope(io, || uu_find::run(argv));

	(
		code,
		String::from_utf8(stdout_buf.lock().clone()).unwrap(),
		String::from_utf8(stderr_buf.lock().clone()).unwrap(),
	)
}

fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
	let dir = tempfile::tempdir().unwrap();
	let canonical = fs::canonicalize(dir.path()).unwrap();
	(dir, canonical)
}

#[test]
fn bsd_dash_e_selects_posix_extended_regexes() {
	let (_dir, root) = canonical_tempdir();
	for file in ["a.txt", "b.md", "c.rs"] {
		fs::write(root.join(file), b"x").unwrap();
	}

	let (code, stdout, stderr) = run_in(root.clone(), vec![
		"-E".to_string(),
		root.display().to_string(),
		"-regex".to_string(),
		r".*\.(txt|md)".to_string(),
	]);
	assert_eq!(code, 0, "stderr: {stderr}");
	assert_eq!(stderr, "");
	let mut matches: Vec<PathBuf> = stdout.lines().map(PathBuf::from).collect();
	matches.sort();
	assert_eq!(matches, vec![root.join("a.txt"), root.join("b.md")]);
}

#[test]
fn regex_without_bsd_dash_e_retains_default_syntax() {
	let (_dir, root) = canonical_tempdir();
	for file in ["a.txt", "b.md", "c.rs"] {
		fs::write(root.join(file), b"x").unwrap();
	}

	let (code, stdout, stderr) = run_in(root.clone(), vec![
		root.display().to_string(),
		"-regex".to_string(),
		r".*\.(txt|md)".to_string(),
	]);
	assert_eq!(code, 0, "stderr: {stderr}");
	assert_eq!(stderr, "");
	assert_eq!(stdout, "");
}

#[test]
fn valid_gnu_expression_can_use_dash_e_as_an_operand() {
	let (_dir, root) = canonical_tempdir();
	fs::write(root.join("-E"), b"x").unwrap();

	let (code, stdout, stderr) =
		run_in(root.clone(), vec![root.display().to_string(), "-name".to_string(), "-E".to_string()]);
	assert_eq!(code, 0, "stderr: {stderr}");
	assert_eq!(stderr, "");
	assert_eq!(stdout, format!("{}\n", root.join("-E").display()));
}

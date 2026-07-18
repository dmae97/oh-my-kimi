//! `diff` implemented as an in-process shell builtin on top of the `similar`
//! diffing library. All I/O and path resolution is routed through
//! `pi-uutils-ctx` so the builtin writes to the command's redirected file
//! descriptors and resolves relative paths against the shell's working
//! directory, while operands are printed as typed.
//!
//! Scope: unified output only (`-u` is accepted and implied, `-U N` controls
//! the context size), `-q/--brief`, `-N/--new-file` (absent files compare as
//! empty), binary detection, `-` for the context stdin, and unconditional
//! recursive directory comparison (`Only in <dir>: <name>` lines plus
//! `diff -r A/x B/x`-headed per-pair diffs).
//!
//! Entry point: [`run`]. It never calls `std::process::exit`; clap
//! help/usage/error output is rendered to the context streams and an exit code
//! is returned following the GNU convention (0 = identical, 1 = differences
//! found, 2 = trouble).

use std::{
	collections::BTreeSet,
	ffi::{OsStr, OsString},
	fs,
	io::{Read, Write},
	path::{Path, PathBuf},
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use pi_uutils_ctx::format_usage;
use similar::TextDiff;

const OPT_UNIFIED_FLAG: &str = "unified-flag";
const OPT_UNIFIED: &str = "unified";
const OPT_BRIEF: &str = "brief";
const OPT_RECURSIVE: &str = "recursive";
const OPT_NEW_FILE: &str = "new-file";
const OPT_COLOR: &str = "color";
const ARG_FILES: &str = "files";

/// In-process builtin entry point. Parses the arguments directly, renders clap
/// help/usage/version to the context streams, and maps errors to the GNU diff
/// exit-code convention, so it is safe to run inside the host shell process.
pub fn run(argv: Vec<OsString>) -> i32 {
	let matches = match uu_app().try_get_matches_from(argv) {
		Ok(matches) => matches,
		Err(err) => {
			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(pi_uutils_ctx::stderr(), "{rendered}");
				return 2;
			}
			let _ = write!(pi_uutils_ctx::stdout(), "{rendered}");
			return 0;
		},
	};
	match diff_main(&matches) {
		Ok(code) => code,
		Err(msg) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "diff: {msg}");
			2
		},
	}
}

pub fn uu_app() -> Command {
	Command::new("diff")
		.version(concat!("diff (pi-uu-diff) ", env!("CARGO_PKG_VERSION")))
		.about("Compare files line by line.")
		.override_usage(format_usage("diff [OPTION]... FILE1 FILE2"))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_UNIFIED_FLAG)
				.short('u')
				.help("output 3 lines of unified context (the default output format)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_UNIFIED)
				.short('U')
				.long(OPT_UNIFIED)
				.value_name("NUM")
				.help("output NUM lines of unified context")
				.value_parser(clap::value_parser!(usize)),
		)
		.arg(
			Arg::new(OPT_BRIEF)
				.short('q')
				.long(OPT_BRIEF)
				.help("report only when files differ")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_RECURSIVE)
				.short('r')
				.long(OPT_RECURSIVE)
				.help("recursively compare subdirectories (always on for directories)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_NEW_FILE)
				.short('N')
				.long(OPT_NEW_FILE)
				.help("treat absent files as empty")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_COLOR)
				.long(OPT_COLOR)
				.value_name("WHEN")
				.num_args(0..=1)
				.require_equals(true)
				.default_missing_value("auto")
				.help("accepted for compatibility; output is never colorized"),
		)
		.arg(
			Arg::new(ARG_FILES)
				.required(true)
				.num_args(2)
				.value_parser(clap::value_parser!(OsString))
				.value_hint(clap::ValueHint::AnyPath),
		)
}

#[derive(Clone, Copy)]
struct Options {
	context:  usize,
	brief:    bool,
	new_file: bool,
}

/// A classified operand: what the name as typed refers to on disk after
/// resolution against the scope working directory.
enum Operand {
	/// The context stdin (`-`).
	Stdin,
	/// A regular (or other non-directory) file at the resolved path.
	File(PathBuf),
	/// A directory at the resolved path.
	Dir(PathBuf),
	/// A missing file tolerated by `-N` and compared as empty.
	Absent,
}

fn diff_main(matches: &ArgMatches) -> Result<i32, String> {
	let files: Vec<&OsString> = matches.get_many::<OsString>(ARG_FILES).unwrap().collect();
	let opts = Options {
		context:  matches.get_one::<usize>(OPT_UNIFIED).copied().unwrap_or(3),
		brief:    matches.get_flag(OPT_BRIEF),
		new_file: matches.get_flag(OPT_NEW_FILE),
	};

	let (mut name_a, mut name_b) = (PathBuf::from(files[0]), PathBuf::from(files[1]));
	let mut op_a = classify(&name_a, opts.new_file)?;
	let mut op_b = classify(&name_b, opts.new_file)?;

	// GNU: comparing a directory with a non-directory compares
	// <dir>/<basename-of-other> with the other operand.
	let a_is_dir = matches!(op_a, Operand::Dir(_));
	let b_is_dir = matches!(op_b, Operand::Dir(_));
	if a_is_dir != b_is_dir {
		if matches!(op_a, Operand::Stdin) || matches!(op_b, Operand::Stdin) {
			return Err("cannot compare '-' to a directory".to_string());
		}
		if a_is_dir {
			name_a = descend(&name_a, &name_b)?;
			op_a = classify(&name_a, opts.new_file)?;
		} else {
			name_b = descend(&name_b, &name_a)?;
			op_b = classify(&name_b, opts.new_file)?;
		}
	}

	let differed = if let (Operand::Dir(res_a), Operand::Dir(res_b)) = (&op_a, &op_b) {
		diff_dirs(&name_a, res_a, &name_b, res_b, opts)?
	} else {
		let bytes_a = read_operand(&op_a, &name_a)?;
		let bytes_b = read_operand(&op_b, &name_b)?;
		diff_pair(&name_a, &bytes_a, &name_b, &bytes_b, opts, None)?
	};
	Ok(i32::from(differed))
}

/// Replaces a directory operand with `<dir>/<basename of other>` for the GNU
/// dir-vs-file comparison form.
fn descend(dir: &Path, other: &Path) -> Result<PathBuf, String> {
	let base = other
		.file_name()
		.ok_or_else(|| format!("cannot compare {} to a directory", other.display()))?;
	Ok(dir.join(base))
}

fn classify(name: &Path, new_file: bool) -> Result<Operand, String> {
	if name.as_os_str() == OsStr::new("-") {
		return Ok(Operand::Stdin);
	}
	// Resolve the operand against the shell working directory; `name` is kept
	// for display (GNU prints operands as typed).
	let resolved = pi_uutils_ctx::resolve(name);
	match fs::metadata(&resolved) {
		Ok(meta) if meta.is_dir() => Ok(Operand::Dir(resolved)),
		Ok(_) => Ok(Operand::File(resolved)),
		Err(err) if err.kind() == std::io::ErrorKind::NotFound && new_file => Ok(Operand::Absent),
		Err(err) => Err(format!("{}: {}", name.display(), io_msg(&err))),
	}
}

fn read_operand(op: &Operand, name: &Path) -> Result<Vec<u8>, String> {
	match op {
		Operand::Stdin => {
			let mut buf = Vec::new();
			pi_uutils_ctx::stdin()
				.read_to_end(&mut buf)
				.map_err(|err| format!("-: {}", io_msg(&err)))?;
			Ok(buf)
		},
		Operand::File(resolved) => {
			fs::read(resolved).map_err(|err| format!("{}: {}", name.display(), io_msg(&err)))
		},
		Operand::Dir(_) => unreachable!("directories are handled by diff_dirs"),
		Operand::Absent => Ok(Vec::new()),
	}
}

/// Diffs one pair of already-read inputs, writing to the context stdout.
/// `prefix` is the `diff -r A/x B/x` line emitted before per-pair output in
/// directory mode. Returns whether the inputs differed.
fn diff_pair(
	name_a: &Path,
	bytes_a: &[u8],
	name_b: &Path,
	bytes_b: &[u8],
	opts: Options,
	prefix: Option<&str>,
) -> Result<bool, String> {
	if bytes_a == bytes_b {
		return Ok(false);
	}
	let mut out = pi_uutils_ctx::stdout();
	let (label_a, label_b) = (name_a.display().to_string(), name_b.display().to_string());
	if opts.brief {
		writeln!(out, "Files {label_a} and {label_b} differ").map_err(|e| io_msg(&e))?;
		return Ok(true);
	}
	if is_binary(bytes_a) || is_binary(bytes_b) {
		writeln!(out, "Binary files {label_a} and {label_b} differ").map_err(|e| io_msg(&e))?;
		return Ok(true);
	}
	if let Some(line) = prefix {
		writeln!(out, "{line}").map_err(|e| io_msg(&e))?;
	}
	let old = String::from_utf8_lossy(bytes_a);
	let new = String::from_utf8_lossy(bytes_b);
	let diff = TextDiff::from_lines(old.as_ref(), new.as_ref());
	write!(
		out,
		"{}",
		diff
			.unified_diff()
			.context_radius(opts.context)
			.header(&label_a, &label_b)
	)
	.map_err(|e| io_msg(&e))?;
	Ok(true)
}

/// Recursively compares two directories over the sorted union of their
/// entries, GNU `diff -r` style. Returns whether any difference was found.
fn diff_dirs(
	name_a: &Path,
	res_a: &Path,
	name_b: &Path,
	res_b: &Path,
	opts: Options,
) -> Result<bool, String> {
	let mut names: BTreeSet<OsString> = BTreeSet::new();
	for (dir_name, dir_res) in [(name_a, res_a), (name_b, res_b)] {
		let entries = fs::read_dir(dir_res)
			.map_err(|err| format!("{}: {}", dir_name.display(), io_msg(&err)))?;
		for entry in entries {
			let entry = entry.map_err(|err| format!("{}: {}", dir_name.display(), io_msg(&err)))?;
			names.insert(entry.file_name());
		}
	}

	let mut differed = false;
	for name in names {
		if pi_uutils_ctx::is_cancelled() {
			return Err("interrupted".to_string());
		}
		let (child_name_a, child_res_a) = (name_a.join(&name), res_a.join(&name));
		let (child_name_b, child_res_b) = (name_b.join(&name), res_b.join(&name));
		let meta_a = fs::metadata(&child_res_a).ok();
		let meta_b = fs::metadata(&child_res_b).ok();
		match (meta_a.as_ref(), meta_b.as_ref()) {
			(Some(ma), Some(mb)) if ma.is_dir() && mb.is_dir() => {
				differed |= diff_dirs(&child_name_a, &child_res_a, &child_name_b, &child_res_b, opts)?;
			},
			(Some(ma), Some(mb)) if ma.is_dir() != mb.is_dir() => {
				let (dir, file) = if ma.is_dir() {
					(&child_name_a, &child_name_b)
				} else {
					(&child_name_b, &child_name_a)
				};
				writeln!(
					pi_uutils_ctx::stdout(),
					"File {} is a directory while file {} is a regular file",
					dir.display(),
					file.display()
				)
				.map_err(|e| io_msg(&e))?;
				differed = true;
			},
			(Some(_), Some(_)) => {
				let bytes_a = fs::read(&child_res_a)
					.map_err(|err| format!("{}: {}", child_name_a.display(), io_msg(&err)))?;
				let bytes_b = fs::read(&child_res_b)
					.map_err(|err| format!("{}: {}", child_name_b.display(), io_msg(&err)))?;
				let prefix = format!("diff -r {} {}", child_name_a.display(), child_name_b.display());
				differed |=
					diff_pair(&child_name_a, &bytes_a, &child_name_b, &bytes_b, opts, Some(&prefix))?;
			},
			(Some(meta), None) | (None, Some(meta)) => {
				let in_a = meta_b.is_none();
				if opts.new_file && meta.is_file() {
					// -N: compare the present file against an empty absent one.
					let (present_name, present_res) = if in_a {
						(&child_name_a, &child_res_a)
					} else {
						(&child_name_b, &child_res_b)
					};
					let bytes = fs::read(present_res)
						.map_err(|err| format!("{}: {}", present_name.display(), io_msg(&err)))?;
					let prefix =
						format!("diff -r {} {}", child_name_a.display(), child_name_b.display());
					let (ba, bb): (&[u8], &[u8]) = if in_a { (&bytes, &[]) } else { (&[], &bytes) };
					differed |= diff_pair(&child_name_a, ba, &child_name_b, bb, opts, Some(&prefix))?;
				} else {
					let present_dir = if in_a { name_a } else { name_b };
					writeln!(
						pi_uutils_ctx::stdout(),
						"Only in {}: {}",
						present_dir.display(),
						Path::new(&name).display()
					)
					.map_err(|e| io_msg(&e))?;
					differed = true;
				}
			},
			(None, None) => {},
		}
	}
	Ok(differed)
}

/// NUL byte within the first 8 KiB marks the input as binary, matching the
/// heuristic GNU diff applies to decide between text and binary output.
fn is_binary(bytes: &[u8]) -> bool {
	bytes.iter().take(8192).any(|&b| b == 0)
}

/// Renders an I/O error without the Rust-specific ` (os error N)` suffix so
/// messages read like GNU diff's (`diff: x: No such file or directory`).
fn io_msg(err: &std::io::Error) -> String {
	let msg = err.to_string();
	match msg.find(" (os error") {
		Some(idx) => msg[..idx].to_string(),
		None => msg,
	}
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, io::Write, path::PathBuf, sync::Arc};

	use parking_lot::Mutex;
	use pi_uutils_ctx::ScopeIo;

	use super::*;

	fn run_with(cwd: PathBuf, stdin: &[u8], args: Vec<&str>) -> (i32, String, String) {
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
			stdin: Box::new(std::io::Cursor::new(stdin.to_vec())),
			stdin_fd: None,
			stdin_is_search_input: false,
			stdout: Box::new(SharedWriter { buf: stdout_buf.clone() }),
			stderr: Box::new(SharedWriter { buf: stderr_buf.clone() }),
			cwd,
			env: HashMap::new(),
			cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
		};

		let argv: Vec<OsString> = std::iter::once("diff")
			.chain(args)
			.map(OsString::from)
			.collect();

		let code = pi_uutils_ctx::scope(io, || run(argv));

		let out_str = String::from_utf8(stdout_buf.lock().clone()).unwrap();
		let err_str = String::from_utf8(stderr_buf.lock().clone()).unwrap();

		(code, out_str, err_str)
	}

	fn run_in(cwd: PathBuf, args: Vec<&str>) -> (i32, String, String) {
		run_with(cwd, b"", args)
	}

	/// Canonicalized temp dir (macOS tempdirs live behind /var -> /private/var).
	fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let canon = fs::canonicalize(dir.path()).unwrap();
		(dir, canon)
	}

	#[test]
	fn identical_files_print_nothing_and_exit_zero() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
		fs::write(root.join("b.txt"), "one\ntwo\n").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["a.txt", "b.txt"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
	}

	/// Relative operands must resolve against the scope cwd (a tempdir), not
	/// the process cwd — the pi-specific contract.
	#[test]
	fn differing_files_emit_unified_diff_with_typed_headers() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
		fs::write(root.join("b.txt"), "one\nTWO\nthree\n").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["a.txt", "b.txt"]);
		assert_eq!(code, 1);
		assert_eq!(stderr, "");
		assert!(stdout.starts_with("--- a.txt\n+++ b.txt\n@@ "), "got: {stdout}");
		assert!(stdout.contains("\n-two\n"), "got: {stdout}");
		assert!(stdout.contains("\n+TWO\n"), "got: {stdout}");
		// Context lines around the change (default -U 3).
		assert!(stdout.contains("\n one\n"), "got: {stdout}");
		assert!(stdout.contains("\n three\n"), "got: {stdout}");
	}

	#[test]
	fn unified_zero_drops_context_lines() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
		fs::write(root.join("b.txt"), "one\nTWO\nthree\n").unwrap();

		let (code, stdout, _) = run_in(root, vec!["-U", "0", "a.txt", "b.txt"]);
		assert_eq!(code, 1);
		assert!(!stdout.contains("\n one\n"), "got: {stdout}");
		assert!(!stdout.contains("\n three\n"), "got: {stdout}");
		assert!(stdout.contains("\n-two\n"), "got: {stdout}");
		assert!(stdout.contains("\n+TWO\n"), "got: {stdout}");
	}

	#[test]
	fn brief_reports_one_line_per_differing_pair() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "x\n").unwrap();
		fs::write(root.join("b.txt"), "y\n").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["-q", "a.txt", "b.txt"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "Files a.txt and b.txt differ\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn compat_flags_are_accepted_and_ignored() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "x\n").unwrap();
		fs::write(root.join("b.txt"), "y\n").unwrap();

		let (code, stdout, stderr) =
			run_in(root, vec!["-u", "-r", "--color=always", "a.txt", "b.txt"]);
		assert_eq!(code, 1);
		assert_eq!(stderr, "");
		// Plain unified output, no ANSI escapes.
		assert!(stdout.starts_with("--- a.txt\n+++ b.txt\n"), "got: {stdout}");
		assert!(!stdout.contains('\u{1b}'), "got: {stdout}");
	}

	#[test]
	fn binary_inputs_report_binary_difference() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.bin"), b"aa\x00bb").unwrap();
		fs::write(root.join("b.bin"), b"aa\x00cc").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["a.bin", "b.bin"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "Binary files a.bin and b.bin differ\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn missing_operand_file_is_trouble() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "x\n").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["a.txt", "nope.txt"]);
		assert_eq!(code, 2);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "diff: nope.txt: No such file or directory\n");
	}

	#[test]
	fn missing_second_operand_is_usage_error() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec!["only-one"]);
		assert_eq!(code, 2);
		assert_eq!(stdout, "");
		assert!(stderr.contains("required"), "got: {stderr}");
	}

	#[test]
	fn new_file_treats_missing_operand_as_empty() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "one\n").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["-N", "nope.txt", "a.txt"]);
		assert_eq!(code, 1);
		assert_eq!(stderr, "");
		assert!(stdout.starts_with("--- nope.txt\n+++ a.txt\n"), "got: {stdout}");
		assert!(stdout.contains("\n+one\n"), "got: {stdout}");
	}

	#[test]
	fn dash_reads_context_stdin() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();

		let (code, stdout, stderr) = run_with(root.clone(), b"one\ntwo\n", vec!["a.txt", "-"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));

		let (code, stdout, _) = run_with(root, b"one\nTWO\n", vec!["a.txt", "-"]);
		assert_eq!(code, 1);
		assert!(stdout.starts_with("--- a.txt\n+++ -\n"), "got: {stdout}");
	}

	#[test]
	fn directories_diff_recursively_with_only_in_lines() {
		let (_dir, root) = canonical_tempdir();
		let (a, b) = (root.join("a"), root.join("b"));
		fs::create_dir_all(a.join("sub")).unwrap();
		fs::create_dir_all(b.join("sub")).unwrap();
		fs::write(a.join("common.txt"), "same\n").unwrap();
		fs::write(b.join("common.txt"), "same\n").unwrap();
		fs::write(a.join("only.txt"), "left\n").unwrap();
		fs::write(b.join("other.txt"), "right\n").unwrap();
		fs::write(a.join("sub/inner.txt"), "old\n").unwrap();
		fs::write(b.join("sub/inner.txt"), "new\n").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["a", "b"]);
		assert_eq!(code, 1);
		assert_eq!(stderr, "");
		assert!(stdout.contains("Only in a: only.txt\n"), "got: {stdout}");
		assert!(stdout.contains("Only in b: other.txt\n"), "got: {stdout}");
		assert!(
			stdout.contains(
				"diff -r a/sub/inner.txt b/sub/inner.txt\n--- a/sub/inner.txt\n+++ b/sub/inner.txt\n"
			),
			"got: {stdout}"
		);
		assert!(stdout.contains("\n-old\n"), "got: {stdout}");
		assert!(stdout.contains("\n+new\n"), "got: {stdout}");
		// Identical common.txt must not appear at all.
		assert!(!stdout.contains("common.txt"), "got: {stdout}");
	}

	#[test]
	fn identical_directories_exit_zero() {
		let (_dir, root) = canonical_tempdir();
		let (a, b) = (root.join("a"), root.join("b"));
		fs::create_dir_all(&a).unwrap();
		fs::create_dir_all(&b).unwrap();
		fs::write(a.join("f.txt"), "same\n").unwrap();
		fs::write(b.join("f.txt"), "same\n").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["-r", "a", "b"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
	}

	#[test]
	fn help_renders_to_scope_stdout() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec!["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("Compare files line by line"));
		assert_eq!(stderr, "");
	}
}

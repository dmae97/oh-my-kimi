// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) sbytes slen dlen memmem memmap Mmap mmap SIGBUS

// pi-uutils: vendored from uutils/coreutils 0.8.0 and patched to run in-process
// as a shell builtin. FILE operands resolve against the shell working directory
// via `pi_uutils_ctx::resolve` at the open/mmap call site (the original operand
// is kept for error messages), `-`/no-operand read the context stdin, output is
// written through the context stdout, recoverable per-file errors go to the
// context stderr with `pi_uutils_ctx::set_exit_code` (upstream `show!`), the
// `translate!` strings are literalized, and the process-global signal handling
// plus the stdin mmap/tempfile buffering (which target the process stdin fd)
// are removed.

mod error;

use std::{
	ffi::{OsStr, OsString},
	fs::File,
	io::{BufWriter, Read, Write},
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use memchr::memmem;
use memmap2::Mmap;
use pi_uutils_ctx::format_usage;
use uucore::error::UResult;

use crate::error::TacError;

mod options {
	pub static BEFORE: &str = "before";
	pub static REGEX: &str = "regex";
	pub static SEPARATOR: &str = "separator";
	pub static FILE: &str = "file";
}

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
	match tac_main(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let msg = err.to_string();
			if !msg.is_empty() {
				let _ = writeln!(pi_uutils_ctx::stderr(), "tac: {msg}");
			}
			if code == 0 { 1 } else { code }
		},
	}
}

fn tac_main(matches: &ArgMatches) -> UResult<()> {
	let before = matches.get_flag(options::BEFORE);
	let regex = matches.get_flag(options::REGEX);
	let raw_separator = matches
		.get_one::<OsString>(options::SEPARATOR)
		.map_or(OsStr::new("\n"), |s| s.as_os_str());

	let separator = if raw_separator.is_empty() {
		OsStr::new("\0")
	} else {
		raw_separator
	};

	let files: Vec<OsString> = match matches.get_many::<OsString>(options::FILE) {
		Some(v) => v.cloned().collect(),
		None => vec![OsString::from("-")],
	};

	tac(&files, before, regex, separator)
}

pub fn uu_app() -> Command {
	Command::new("tac")
		.version(uucore::crate_version!())
		.override_usage(format_usage("tac [OPTION]... [FILE]..."))
		.about("Write each file to standard output, last line first.")
		.infer_long_args(true)
		.arg(
			Arg::new(options::BEFORE)
				.short('b')
				.long(options::BEFORE)
				.help("attach the separator before instead of after")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::REGEX)
				.short('r')
				.long(options::REGEX)
				.help("interpret the sequence as a regular expression")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SEPARATOR)
				.short('s')
				.long(options::SEPARATOR)
				.help("use STRING as the separator instead of newline")
				.value_parser(clap::value_parser!(OsString))
				.value_name("STRING"),
		)
		.arg(
			Arg::new(options::FILE)
				.hide(true)
				.action(ArgAction::Append)
				.value_parser(clap::value_parser!(OsString))
				.value_hint(clap::ValueHint::FilePath),
		)
}

/// pi-uutils: replacement for upstream's `show!` — reports a recoverable
/// per-file error to the context stderr and accumulates a non-zero exit code
/// while processing continues with the next operand.
fn show(err: &TacError) {
	let _ = writeln!(pi_uutils_ctx::stderr(), "tac: {err}");
	pi_uutils_ctx::set_exit_code(1);
}

/// Print lines of a buffer in reverse, with line separator given as a regex.
///
/// `data` contains the bytes of the file.
///
/// `pattern` is the regular expression given as a
/// [`regex::bytes::Regex`] (not a [`regex::Regex`], since the input is
/// given as a slice of bytes). If `before` is `true`, then each match
/// of this pattern in `data` is interpreted as the start of a line. If
/// `before` is `false`, then each match of this pattern is interpreted
/// as the end of a line.
///
/// This function writes each line in `data` to the context stdout in
/// reverse.
///
/// # Errors
///
/// If there is a problem writing to stdout, then this function
/// returns [`std::io::Error`].
fn buffer_tac_regex(
	data: &[u8],
	pattern: &regex::bytes::Regex,
	before: bool,
) -> std::io::Result<()> {
	// pi-uutils: write through the context stdout instead of the process stdout.
	let mut out = BufWriter::new(pi_uutils_ctx::stdout());

	// The index of the line separator for the current line.
	//
	// As we scan through the `data` from right to left, we update this
	// variable each time we find a new line separator. We restrict our
	// regular expression search to only those bytes up to the line
	// separator.
	let mut this_line_end = data.len();

	// The index of the start of the next line in the `data`.
	//
	// As we scan through the `data` from right to left, we update this
	// variable each time we find a new line.
	//
	// If `before` is `true`, then each line starts immediately before
	// the line separator. Otherwise, each line starts immediately after
	// the line separator.
	let mut following_line_start = data.len();

	// Iterate over each byte in the buffer in reverse. When we find a
	// line separator, write the line to stdout.
	//
	// The `before` flag controls whether the line separator appears at
	// the end of the line (as in "abc\ndef\n") or at the beginning of
	// the line (as in "/abc/def").
	for i in (0..data.len()).rev() {
		// Determine if there is a match for `pattern` starting at index
		// `i` in `data`. Only search up to the line ending that was
		// found previously.
		if let Some(match_) = pattern.find_at(&data[..this_line_end], i)
			&& match_.start() == i
		{
			// Record this index as the ending of the current line.
			this_line_end = i;

			// The length of the match (that is, the line separator), in bytes.
			let slen = match_.end() - match_.start();

			if before {
				out.write_all(&data[i..following_line_start])?;
				following_line_start = i;
			} else {
				out.write_all(&data[i + slen..following_line_start])?;
				following_line_start = i + slen;
			}
		}
	}

	// After the loop terminates, write whatever bytes are remaining at
	// the beginning of the buffer.
	out.write_all(&data[0..following_line_start])?;
	out.flush()?;
	Ok(())
}

/// Write lines from `data` to stdout in reverse.
///
/// This function writes to the context stdout each line appearing in `data`,
/// starting with the last line and ending with the first line. The
/// `separator` parameter defines what characters to use as a line
/// separator.
///
/// If `before` is `false`, then this function assumes that the
/// `separator` appears at the end of each line, as in `"abc\ndef\n"`.
/// If `before` is `true`, then this function assumes that the
/// `separator` appears at the beginning of each line, as in
/// `"/abc/def"`.
fn buffer_tac(data: &[u8], before: bool, separator: &OsStr) -> std::io::Result<()> {
	// pi-uutils: write through the context stdout instead of the process stdout.
	let mut out = BufWriter::new(pi_uutils_ctx::stdout());

	// The number of bytes in the line separator.
	let slen = separator.len();

	// The index of the start of the next line in the `data`.
	//
	// As we scan through the `data` from right to left, we update this
	// variable each time we find a new line.
	//
	// If `before` is `true`, then each line starts immediately before
	// the line separator. Otherwise, each line starts immediately after
	// the line separator.
	let mut following_line_start = data.len();

	// Iterate over each byte in the buffer in reverse. When we find a
	// line separator, write the line to stdout.
	//
	// The `before` flag controls whether the line separator appears at
	// the end of the line (as in "abc\ndef\n") or at the beginning of
	// the line (as in "/abc/def").
	for i in memmem::rfind_iter(data, separator.as_encoded_bytes()) {
		if before {
			out.write_all(&data[i..following_line_start])?;
			following_line_start = i;
		} else {
			out.write_all(&data[i + slen..following_line_start])?;
			following_line_start = i + slen;
		}
	}

	// After the loop terminates, write whatever bytes are remaining at
	// the beginning of the buffer.
	out.write_all(&data[0..following_line_start])?;
	out.flush()?;
	Ok(())
}

/// Make the regex flavor compatible with `regex` crate
///
/// Concretely:
/// - Toggle escaping of (), |, {}
/// - Escape ^ and $ when not at edges
/// - Leave only ASCII bytes inside []
/// - Escape non-ASCII bytes as `(?-u:\xFF)` outside []
fn translate_regex_flavor(bytes: &[u8]) -> String {
	let mut result = Vec::new();
	let mut i = 0;
	let mut inside_brackets = false;
	let mut prev_was_backslash = false;
	let mut last_byte: Option<u8> = None;

	while let Some(b) = bytes.get(i) {
		let is_escaped = prev_was_backslash;
		prev_was_backslash = false;

		match b {
			_ if inside_brackets && !b.is_ascii() => {
				i += 1;
				continue;
			},
			// Unescape escaped (), |, {} when not inside brackets
			b'\\' if !inside_brackets && !is_escaped => {
				if let Some(next) = bytes.get(i + 1)
					&& matches!(next, b'(' | b')' | b'|' | b'{' | b'}')
				{
					result.push(*next);
					last_byte = Some(*next);
					i += 2;
					continue;
				}

				result.push(b'\\');
				last_byte = Some(b'\\');
				prev_was_backslash = true;
			},
			// Bracket tracking
			b'[' => {
				inside_brackets = true;
				result.push(*b);
				last_byte = Some(*b);
			},
			b']' => {
				inside_brackets = false;
				result.push(*b);
				last_byte = Some(*b);
			},
			// Escape (), |, {} when not escaped and outside brackets
			b'(' | b')' | b'|' | b'{' | b'}' if !inside_brackets && !is_escaped => {
				result.push(b'\\');
				result.push(*b);
				last_byte = Some(*b);
			},
			b'^' if !inside_brackets && !is_escaped => {
				let is_anchor_position = result.is_empty() || matches!(last_byte, Some(b'(' | b'|'));
				if !is_anchor_position {
					result.push(b'\\');
				}
				result.push(*b);
				last_byte = Some(*b);
			},
			b'$' if !inside_brackets && !is_escaped => {
				let next_is_anchor_position = match bytes.get(i + 1) {
					None => true,
					Some(b')' | b'|') => true,
					Some(b'\\') => {
						// Peek two ahead to see if it's \) or \|
						matches!(bytes.get(i + 2), Some(b')' | b'|'))
					},
					_ => false,
				};
				if !next_is_anchor_position {
					result.push(b'\\');
				}
				result.push(*b);
				last_byte = Some(*b);
			},
			_ if !b.is_ascii() => {
				let _ = write!(result, r"(?-u:\x{b:02x})");
				last_byte = None;
			},
			_ => {
				result.push(*b);
				last_byte = Some(*b);
			},
		}

		i += 1;
	}

	String::from_utf8(result).expect("produces ASCII bytes")
}

#[allow(clippy::cognitive_complexity)]
fn tac(filenames: &[OsString], before: bool, regex: bool, separator: &OsStr) -> UResult<()> {
	// Compile the regular expression pattern if it is provided.
	let maybe_pattern = if regex {
		match regex::bytes::RegexBuilder::new(&translate_regex_flavor(separator.as_encoded_bytes()))
			.multi_line(true)
			.build()
		{
			Ok(p) => Some(p),
			Err(e) => return Err(TacError::InvalidRegex(e).into()),
		}
	} else {
		None
	};

	for filename in filenames {
		let mmap;
		let buf;

		let data: &[u8] = if filename == "-" {
			// pi-uutils: in-process stdin is a context stream, not the process
			// stdin fd; upstream's stdin mmap / tempfile buffering and the
			// `stdin_was_closed` signal check do not apply. Read it fully.
			let mut contents = Vec::new();
			match pi_uutils_ctx::stdin().read_to_end(&mut contents) {
				Ok(_) => {
					buf = contents;
					&buf
				},
				Err(e) => {
					show(&TacError::ReadError(OsString::from("stdin"), e));
					continue;
				},
			}
		} else {
			// pi-uutils: resolve the operand against the shell working
			// directory at the open site; `filename` is kept for errors.
			let path = pi_uutils_ctx::resolve(filename);
			let mut file = match File::open(&path) {
				Ok(f) => f,
				Err(e) => {
					show(&TacError::OpenError(filename.clone(), e));
					continue;
				},
			};

			if let Some(mmap1) = try_mmap_file(&file) {
				mmap = mmap1;
				&mmap
			} else {
				let mut contents = Vec::new();
				match file.read_to_end(&mut contents) {
					Ok(_) => {
						buf = contents;
						&buf
					},
					Err(e) => {
						show(&TacError::ReadError(filename.clone(), e));
						continue;
					},
				}
			}
		};

		// Select the appropriate `tac` algorithm based on whether the
		// separator is given as a regular expression or a fixed string.
		// pi-uutils: match ergonomics instead of upstream's `Some(ref pattern)`.
		let result = match &maybe_pattern {
			Some(pattern) => buffer_tac_regex(data, pattern, before),
			None => buffer_tac(data, before, separator),
		};

		// If there is any error in writing the output, terminate immediately.
		if let Err(e) = result {
			return Err(TacError::WriteError(e).into());
		}
	}
	Ok(())
}

fn try_mmap_file(file: &File) -> Option<Mmap> {
	// SAFETY: If the file is truncated while we map it, SIGBUS will be raised
	// and our process will be terminated, thus preventing access of invalid memory.
	unsafe { Mmap::map(file).ok() }
}

#[cfg(test)]
mod tests_hybrid_flavor {
	use super::translate_regex_flavor;

	#[test]
	fn test_grouping_and_alternation() {
		assert_eq!(translate_regex_flavor(br"\(abc\)"), r"(abc)");

		assert_eq!(translate_regex_flavor(br"(abc)"), r"\(abc\)");

		assert_eq!(translate_regex_flavor(br"a\|b"), r"a|b");

		assert_eq!(translate_regex_flavor(br"a|b"), r"a\|b");
	}

	#[test]
	fn test_anchors_context() {
		assert_eq!(translate_regex_flavor(br"^abc$"), r"^abc$");

		assert_eq!(translate_regex_flavor(br"a^b"), r"a\^b");
		assert_eq!(translate_regex_flavor(br"a$b"), r"a\$b");

		// Anchors inside groups (reset by \(...\) regardless of position)
		assert_eq!(translate_regex_flavor(br"\(^abc\)"), r"(^abc)");
		assert_eq!(translate_regex_flavor(br"\(abc$\)"), r"(abc$)");

		// Anchors inside alternation (reset by \| regardless of position)
		assert_eq!(translate_regex_flavor(br"^a\|^b"), r"^a|^b");
		assert_eq!(translate_regex_flavor(br"a$\|b$"), r"a$|b$");
	}

	#[test]
	fn test_character_classes() {
		assert_eq!(translate_regex_flavor(br"[a-z]"), r"[a-z]");

		assert_eq!(translate_regex_flavor(br"[.]"), r"[.]");

		assert_eq!(translate_regex_flavor(br"[]abc]"), r"[]abc]");

		assert_eq!(translate_regex_flavor(br"[^]abc]"), r"[^]abc]");
	}
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, fs, io::Write, path::PathBuf, sync::Arc};

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

		let argv: Vec<OsString> = std::iter::once("tac")
			.chain(args)
			.map(OsString::from)
			.collect();

		let code = pi_uutils_ctx::scope(io, || run(argv));

		let out_str = String::from_utf8(stdout_buf.lock().clone()).unwrap();
		let err_str = String::from_utf8(stderr_buf.lock().clone()).unwrap();

		(code, out_str, err_str)
	}

	/// Canonicalized temp dir (macOS tempdirs live behind /var -> /private/var).
	fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let canon = fs::canonicalize(dir.path()).unwrap();
		(dir, canon)
	}

	#[test]
	fn resolves_relative_operand_against_scope_cwd() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("input.txt"), b"a\nb\nc\n").unwrap();

		// Relative operand + scope cwd differing from the process cwd: only the
		// call-site `pi_uutils_ctx::resolve` patch makes this find the file.
		let (code, stdout, stderr) = run_with(root, b"", vec!["input.txt"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "c\nb\na\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn no_operand_reads_context_stdin() {
		let (code, stdout, stderr) = run_with(PathBuf::from("."), b"one\ntwo\nthree\n", vec![]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "three\ntwo\none\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn dash_operand_reads_context_stdin() {
		let (code, stdout, stderr) = run_with(PathBuf::from("."), b"x\ny\n", vec!["-"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "y\nx\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn custom_separator_reverses_fields() {
		let (code, stdout, stderr) = run_with(PathBuf::from("."), b"a,b,c,", vec!["-s", ","]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "c,b,a,");
		assert_eq!(stderr, "");
	}

	#[test]
	fn before_flag_attaches_separator_before_each_line() {
		let (code, stdout, stderr) = run_with(PathBuf::from("."), b"/abc/def", vec!["-b", "-s", "/"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "/def/abc");
		assert_eq!(stderr, "");
	}

	#[test]
	fn regex_separator_splits_on_character_class() {
		// `[,;]` treats either byte as a separator; records are emitted in
		// reverse with each separator kept attached to its preceding record.
		let (code, stdout, stderr) = run_with(PathBuf::from("."), b"a,b;c", vec!["-r", "-s", "[,;]"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "cb;a,");
		assert_eq!(stderr, "");
	}

	#[test]
	fn invalid_regex_is_fatal_error() {
		let (code, stdout, stderr) = run_with(PathBuf::from("."), b"abc", vec!["-r", "-s", "["]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.starts_with("tac: invalid regular expression:"), "stderr: {stderr}");
	}

	#[test]
	fn missing_file_continues_with_next_operand_and_exits_nonzero() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("good.txt"), b"1\n2\n").unwrap();

		let (code, stdout, stderr) = run_with(root, b"", vec!["nope.txt", "good.txt"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "2\n1\n", "valid operand still printed after the failure");
		assert!(stderr.contains("tac: failed to open 'nope.txt' for reading:"), "stderr: {stderr}");
	}

	#[test]
	fn help_renders_to_scope_stdout() {
		let (code, stdout, stderr) = run_with(PathBuf::from("."), b"", vec!["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("last line first"));
		assert_eq!(stderr, "");
	}
}

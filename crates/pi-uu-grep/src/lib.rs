//! `grep` implemented as an in-process shell builtin on top of the ripgrep
//! libraries (`grep-regex` for the matcher, `grep-searcher` for line scanning),
//! with directory recursion via `pi-walker` and `--include` filtering via
//! `globset`. All I/O and path resolution is routed through `pi-uutils-ctx` so
//! the builtin writes to the command's redirected file descriptors and resolves
//! relative paths against the shell's working directory.
//!
//! Entry point: [`run`]. It never calls `std::process::exit`; clap
//! help/usage/error output is rendered to the context streams and an exit code
//! is returned following the GNU convention (0 = matched, 1 = no match,
//! 2 = error).

mod rg;

use std::{
	ffi::{OsStr, OsString},
	fs::File,
	io::{self, BufWriter, Read, Write},
	path::{Path, PathBuf},
};

use clap::Parser;
use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkContext, SinkFinish, SinkMatch};
pub use rg::run as run_rg;

#[derive(Parser, Debug)]
#[command(
	name = "grep",
	version = concat!("grep (pi-uu-grep) ", env!("CARGO_PKG_VERSION")),
	about = "Search for PATTERN in each FILE or standard input.",
	disable_help_flag = true,
	disable_version_flag = true
)]
struct Cli {
	/// Use PATTERN for matching (may be repeated; all patterns are OR-ed).
	#[arg(short = 'e', long = "regexp", value_name = "PATTERN")]
	patterns: Vec<String>,

	/// Treat PATTERN as a strict extended regular expression: a pattern that
	/// fails to parse is reported as an error rather than matched literally.
	#[arg(short = 'E', long = "extended-regexp")]
	extended: bool,

	/// PATTERN is a set of fixed strings, matched literally.
	#[arg(short = 'F', long = "fixed-strings")]
	fixed: bool,

	/// Ignore case distinctions in patterns and data.
	#[arg(short = 'i', long = "ignore-case")]
	ignore_case: bool,

	/// Select non-matching lines.
	#[arg(short = 'v', long = "invert-match")]
	invert: bool,

	/// Prefix each line of output with its line number.
	#[arg(short = 'n', long = "line-number")]
	line_number: bool,

	/// Print only a count of matching lines per FILE.
	#[arg(short = 'c', long = "count")]
	count: bool,

	/// Print only the names of FILEs with at least one match.
	#[arg(short = 'l', long = "files-with-matches")]
	files_with_matches: bool,

	/// Always print the file name with output lines.
	#[arg(short = 'H', long = "with-filename")]
	with_filename: bool,

	/// Never print the file name with output lines.
	#[arg(short = 'h', long = "no-filename")]
	no_filename: bool,

	/// Recursively search each directory listed.
	#[arg(short = 'r', long = "recursive")]
	recursive: bool,

	/// Like -r but follow all symbolic links.
	#[arg(short = 'R', long = "dereference-recursive")]
	dereference_recursive: bool,

	/// During recursion, search only files whose name matches GLOB.
	#[arg(long = "include", value_name = "GLOB")]
	include: Vec<String>,

	/// Match only whole words.
	#[arg(short = 'w', long = "word-regexp")]
	word: bool,

	/// Match only whole lines (anchor each pattern to line boundaries).
	#[arg(short = 'x', long = "line-regexp")]
	line_regexp: bool,

	/// Print only the matched (non-empty) parts of a matching line.
	#[arg(short = 'o', long = "only-matching")]
	only_matching: bool,

	/// Print NUM lines of trailing context after matching lines.
	#[arg(short = 'A', long = "after-context", value_name = "NUM")]
	after_context: Option<usize>,

	/// Print NUM lines of leading context before matching lines.
	#[arg(short = 'B', long = "before-context", value_name = "NUM")]
	before_context: Option<usize>,

	/// Print NUM lines of output context (both leading and trailing).
	#[arg(short = 'C', long = "context", value_name = "NUM")]
	context: Option<usize>,

	/// Suppress error messages about nonexistent or unreadable files.
	#[arg(short = 's', long = "no-messages")]
	no_messages: bool,

	/// Quiet; suppress all normal output. Exit with zero status on the first
	/// match (even if an error was detected later).
	#[arg(short = 'q', long = "quiet", visible_alias = "silent")]
	quiet: bool,

	/// Print a help message.
	#[allow(dead_code)]
	#[arg(long = "help", action = clap::ArgAction::Help)]
	help: Option<bool>,

	/// Print version information.
	///
	/// GNU grep ships a `--version`, and shell startup scripts probe it.
	/// Routed through clap so output lands on the in-process stdout via the
	/// same path as `--help`.
	#[allow(dead_code)]
	#[arg(short = 'V', long = "version", action = clap::ArgAction::Version)]
	version: Option<bool>,

	/// Surface color in matches: accepted for GNU-grep compatibility and
	/// silently ignored. The builtin writes to in-process file descriptors
	/// (often a pipe consumed by another tool), so injecting ANSI escapes
	/// would corrupt downstream output. The common `alias grep='grep
	/// --color=auto'` from distro bashrc files passes through unchanged.
	#[allow(dead_code)]
	#[arg(
		long = "color",
		alias = "colour",
		value_name = "WHEN",
		num_args = 0..=1,
		require_equals = true,
		default_missing_value = "auto",
	)]
	color: Option<String>,

	/// PATTERN followed by FILEs (PATTERN is omitted when -e is given).
	#[arg(value_name = "ARGS")]
	args: Vec<OsString>,
}

/// Resolved, flag-free options shared with the search [`Sink`].
struct Options {
	line_number:        bool,
	count:              bool,
	files_with_matches: bool,
	only_matching:      bool,
	before:             usize,
	after:              usize,
	no_messages:        bool,
	quiet:              bool,
}

/// Escape regular-expression meta-characters so a pattern is matched literally,
/// mirroring `regex::escape` (used to implement `-F`/`--fixed-strings`).
fn escape_literal(pat: &str) -> String {
	const META: &[char] =
		&['\\', '.', '+', '*', '?', '(', ')', '|', '[', ']', '{', '}', '^', '$', '#', '&', '-', '~'];
	let mut out = String::with_capacity(pat.len());
	for ch in pat.chars() {
		if META.contains(&ch) {
			out.push('\\');
		}
		out.push(ch);
	}
	out
}

/// Build the regex matcher from the collected patterns and flags.
///
/// In the default mode, any pattern that is not valid extended-regex syntax is
/// matched literally instead of rejected — so `grep "fail)"` finds the text
/// `fail)` the way GNU basic grep does, rather than erroring on the unbalanced
/// `)`. The fallback is per-pattern: in a multi-`-e` search, valid alternatives
/// keep their regex meaning and only the offending pattern is escaped. `-E`
/// opts into strict extended-regex syntax (no fallback); `-F` escapes every
/// pattern up front.
fn build_matcher(patterns: &[String], cli: &Cli) -> Result<RegexMatcher, grep_regex::Error> {
	let mut builder = RegexMatcherBuilder::new();
	builder.case_insensitive(cli.ignore_case);
	if cli.word {
		builder.word(true);
	}
	if cli.line_regexp {
		builder.whole_line(true);
	}
	if cli.fixed {
		let escaped: Vec<String> = patterns.iter().map(|p| escape_literal(p)).collect();
		return builder.build_many(&escaped);
	}
	match builder.build_many(patterns) {
		Ok(matcher) => Ok(matcher),
		Err(err) if !cli.extended => {
			// Escape only the patterns that fail to compile so valid regex
			// alternatives keep their meaning.
			let sanitized: Vec<String> = patterns
				.iter()
				.map(|p| {
					if builder.build(p).is_ok() {
						p.clone()
					} else {
						escape_literal(p)
					}
				})
				.collect();
			builder.build_many(&sanitized).map_err(|_| err)
		},
		Err(err) => Err(err),
	}
}

/// A `grep_searcher` sink that renders matches/context to `out` in GNU grep's
/// output format, while tracking match count and whether anything matched.
struct GrepSink<'a, W: Write> {
	out:         &'a mut W,
	matcher:     &'a RegexMatcher,
	/// Filename prefix bytes, or `None` to suppress the prefix.
	display:     Option<&'a [u8]>,
	opts:        &'a Options,
	match_count: u64,
	any_match:   bool,
}

impl<W: Write> GrepSink<'_, W> {
	/// Write the `file:` / `linenum:` (or `-` for context) prefix.
	fn write_prefix(&mut self, line_number: Option<u64>, sep: u8) -> io::Result<()> {
		if let Some(name) = self.display {
			self.out.write_all(name)?;
			self.out.write_all(&[sep])?;
		}
		if self.opts.line_number
			&& let Some(n) = line_number
		{
			write!(self.out, "{n}")?;
			self.out.write_all(&[sep])?;
		}
		Ok(())
	}

	/// Write a line, ensuring it is newline-terminated.
	fn write_line(&mut self, line: &[u8]) -> io::Result<()> {
		self.out.write_all(line)?;
		if !line.ends_with(b"\n") {
			self.out.write_all(b"\n")?;
		}
		Ok(())
	}

	/// `-o`: emit each non-overlapping match span on its own line.
	fn print_only_matching(&mut self, line: &[u8], line_number: Option<u64>) -> io::Result<()> {
		let mut at = 0usize;
		while at <= line.len() {
			match self.matcher.find_at(line, at) {
				Ok(Some(m)) => {
					self.write_prefix(line_number, b':')?;
					self.out.write_all(&line[m.start()..m.end()])?;
					self.out.write_all(b"\n")?;
					at = if m.end() > at { m.end() } else { at + 1 };
				},
				_ => break,
			}
		}
		Ok(())
	}
}

impl<W: Write> Sink for GrepSink<'_, W> {
	type Error = io::Error;

	fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
		self.any_match = true;
		// -l / -q: a single match is enough; stop scanning this source.
		if self.opts.files_with_matches || self.opts.quiet {
			return Ok(false);
		}
		self.match_count += 1;
		if self.opts.count {
			return Ok(true);
		}
		let line = mat.bytes();
		let line_number = mat.line_number();
		if self.opts.only_matching {
			self.print_only_matching(line, line_number)?;
		} else {
			self.write_prefix(line_number, b':')?;
			self.write_line(line)?;
		}
		Ok(true)
	}

	fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, io::Error> {
		if self.opts.count || self.opts.files_with_matches || self.opts.only_matching {
			return Ok(true);
		}
		self.write_prefix(ctx.line_number(), b'-')?;
		self.write_line(ctx.bytes())?;
		Ok(true)
	}

	fn context_break(&mut self, _searcher: &Searcher) -> Result<bool, io::Error> {
		if !(self.opts.count || self.opts.files_with_matches || self.opts.only_matching) {
			self.out.write_all(b"--\n")?;
		}
		Ok(true)
	}

	fn finish(&mut self, _searcher: &Searcher, _: &SinkFinish) -> Result<(), io::Error> {
		if self.opts.quiet {
			return Ok(());
		}
		if self.opts.files_with_matches {
			if self.any_match
				&& let Some(name) = self.display
			{
				self.out.write_all(name)?;
				self.out.write_all(b"\n")?;
			}
		} else if self.opts.count {
			if let Some(name) = self.display {
				self.out.write_all(name)?;
				self.out.write_all(b":")?;
			}
			writeln!(self.out, "{}", self.match_count)?;
		}
		Ok(())
	}
}

/// Search a single reader, returning whether anything matched.
fn process_reader<R: Read, W: Write>(
	matcher: &RegexMatcher,
	searcher: &mut Searcher,
	reader: R,
	display: Option<&[u8]>,
	opts: &Options,
	out: &mut W,
) -> io::Result<bool> {
	let mut sink = GrepSink { out, matcher, display, opts, match_count: 0, any_match: false };
	searcher.search_reader(matcher, reader, &mut sink)?;
	Ok(sink.any_match)
}

fn display_path_for_operand(operand: &OsStr, resolved: &Path, path: &Path) -> PathBuf {
	let rel = path.strip_prefix(resolved).unwrap_or(path);
	if rel.as_os_str().is_empty() {
		PathBuf::from(operand)
	} else {
		Path::new(operand).join(rel)
	}
}

#[allow(clippy::too_many_arguments)]
fn search_file_path<W: Write>(
	operand: &OsStr,
	resolved: &Path,
	path: &Path,
	matcher: &RegexMatcher,
	searcher: &mut Searcher,
	opts: &Options,
	include_set: Option<&GlobSet>,
	show_names: bool,
	out: &mut W,
	had_error: &mut bool,
) -> bool {
	if let Some(set) = include_set {
		let name = path.file_name().unwrap_or_default();
		if !set.is_match(name) {
			return false;
		}
	}
	let display_path = display_path_for_operand(operand, resolved, path);
	match File::open(path) {
		Ok(file) => {
			let bytes = display_path.as_os_str().as_encoded_bytes().to_vec();
			let name: Option<&[u8]> = if show_names { Some(&bytes) } else { None };
			match process_reader(matcher, searcher, file, name, opts, out) {
				Ok(matched) => matched,
				Err(err) => {
					*had_error = true;
					if !opts.no_messages {
						let _ = writeln!(
							pi_uutils_ctx::stderr(),
							"grep: {}: {err}",
							display_path.to_string_lossy()
						);
					}
					false
				},
			}
		},
		Err(err) => {
			*had_error = true;
			if !opts.no_messages {
				let _ =
					writeln!(pi_uutils_ctx::stderr(), "grep: {}: {err}", display_path.to_string_lossy());
			}
			false
		},
	}
}

fn grep_walk_request(root: &Path, follow_links: bool) -> pi_walker::WalkRequest {
	pi_walker::WalkRequest::new(root)
		.hidden(true)
		.gitignore(false)
		.skip_git(false)
		.skip_node_modules(false)
		.follow_links(pi_walker::FollowLinks::from(follow_links))
		.detail(pi_walker::WalkDetail::Minimal)
		.order(pi_walker::WalkOrder::Unordered)
		.emit_root(true)
		.depth(0, usize::MAX)
		.visit_order(pi_walker::VisitOrder::PreOrder)
		.directory_errors(pi_walker::DirectoryErrorMode::Visit)
		.same_file_system(false)
		.cache(false)
		.filter(pi_walker::WalkFilter::files_only())
}

/// Recursively search a directory operand. `operand` is the path as typed (used
/// for display), `resolved` is the cwd-resolved root walked on the filesystem.
#[allow(clippy::too_many_arguments)]
fn search_dir<W: Write>(
	operand: &OsStr,
	resolved: &Path,
	matcher: &RegexMatcher,
	searcher: &mut Searcher,
	opts: &Options,
	include_set: Option<&GlobSet>,
	show_names: bool,
	follow_links: bool,
	out: &mut W,
	had_error: &mut bool,
) -> bool {
	let request = grep_walk_request(resolved, follow_links);
	let mut any = false;
	let had_error_state = std::cell::Cell::new(*had_error);
	let walk = request.for_each_entry_with_heartbeat(
		|| {
			if pi_uutils_ctx::is_cancelled() {
				Err(io::Error::from(io::ErrorKind::Interrupted))
			} else {
				Ok::<(), io::Error>(())
			}
		},
		|entry: pi_walker::EntryMeta<'_>| {
			if opts.quiet && any {
				return Ok(pi_walker::WalkDecision::Stop);
			}
			if entry.file_type == pi_walker::FileType::Dir {
				return Ok(pi_walker::WalkDecision::Skip);
			}
			let mut entry_had_error = had_error_state.get();
			let matched = search_file_path(
				operand,
				resolved,
				entry.absolute_path.as_ref(),
				matcher,
				searcher,
				opts,
				include_set,
				show_names,
				out,
				&mut entry_had_error,
			);
			had_error_state.set(entry_had_error);
			any |= matched;
			if opts.quiet && any {
				Ok(pi_walker::WalkDecision::Stop)
			} else {
				Ok(pi_walker::WalkDecision::Include)
			}
		},
		|error: pi_walker::DirectoryError<'_>| {
			had_error_state.set(true);
			if !opts.no_messages {
				let display_path = display_path_for_operand(operand, resolved, error.path);
				let _ = writeln!(
					pi_uutils_ctx::stderr(),
					"grep: {}: {}",
					display_path.to_string_lossy(),
					error.error
				);
			}
			Ok(pi_walker::WalkDecision::Include)
		},
	);
	*had_error |= had_error_state.get();
	match walk {
		Ok(pi_walker::WalkStatus::Complete | pi_walker::WalkStatus::Stopped) => any,
		Err(pi_walker::WalkError::Interrupted(_)) if pi_uutils_ctx::is_cancelled() => {
			// Harness cancellation (shell abort/timeout). The shell wrapper
			// overrides the exit code, so stay silent and let the walk unwind
			// without injecting a spurious diagnostic on the command's stderr.
			*had_error = true;
			any
		},
		Err(pi_walker::WalkError::Interrupted(err)) => {
			*had_error = true;
			if !opts.no_messages {
				let _ = writeln!(pi_uutils_ctx::stderr(), "grep: {err}");
			}
			any
		},
		Err(pi_walker::WalkError::InvalidData { path, message }) => {
			*had_error = true;
			if !opts.no_messages {
				let display_path = display_path_for_operand(operand, resolved, &path);
				let _ = writeln!(
					pi_uutils_ctx::stderr(),
					"grep: {}: {message}",
					display_path.to_string_lossy()
				);
			}
			any
		},
	}
}

/// In-process builtin entry point. The host installs a [`pi_uutils_ctx`] scope
/// (stdio + working directory) on a dedicated blocking thread, then calls this.
///
/// Returns a GNU-grep exit code: 0 if any line matched, 1 if none matched,
/// 2 if any error occurred (errors take precedence over the match result).
pub fn run(argv: Vec<OsString>) -> i32 {
	let cli = match Cli::try_parse_from(argv) {
		Ok(c) => c,
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

	// Resolve the classic grep ambiguity: with -e present, every positional is a
	// FILE; otherwise the first positional is the PATTERN.
	let mut patterns = cli.patterns.clone();
	let mut files: Vec<OsString> = Vec::new();
	if patterns.is_empty() {
		let mut rest = cli.args.iter();
		match rest.next() {
			Some(first) => {
				patterns.push(first.to_string_lossy().into_owned());
				files.extend(rest.cloned());
			},
			None => {
				let _ = writeln!(
					pi_uutils_ctx::stderr(),
					"grep: no pattern given\nUsage: grep [OPTION]... PATTERN [FILE]..."
				);
				return 2;
			},
		}
	} else {
		files = cli.args.clone();
	}

	let recursive = cli.recursive || cli.dereference_recursive;

	let matcher = match build_matcher(&patterns, &cli) {
		Ok(m) => m,
		Err(e) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "grep: {e}");
			return 2;
		},
	};

	// --include globs apply during recursion only (GNU behaviour).
	let include_set = if cli.include.is_empty() {
		None
	} else {
		let mut gb = GlobSetBuilder::new();
		for g in &cli.include {
			match Glob::new(g) {
				Ok(glob) => {
					gb.add(glob);
				},
				Err(e) => {
					let _ = writeln!(pi_uutils_ctx::stderr(), "grep: {e}");
					return 2;
				},
			}
		}
		match gb.build() {
			Ok(set) => Some(set),
			Err(e) => {
				let _ = writeln!(pi_uutils_ctx::stderr(), "grep: {e}");
				return 2;
			},
		}
	};

	if files.is_empty() {
		files.push(OsString::from(if recursive { "." } else { "-" }));
	}

	// -l always prints names; otherwise show names when forced (-H), recursive,
	// or searching more than one operand. -h overrides everything.
	let show_names = if cli.no_filename {
		false
	} else if cli.with_filename || cli.files_with_matches {
		true
	} else {
		recursive || files.len() > 1
	};

	let (before, after) = if cli.count || cli.files_with_matches || cli.quiet {
		(0, 0)
	} else {
		let c = cli.context.unwrap_or(0);
		(cli.before_context.unwrap_or(c), cli.after_context.unwrap_or(c))
	};

	let opts = Options {
		line_number: cli.line_number,
		count: cli.count,
		files_with_matches: cli.files_with_matches,
		only_matching: cli.only_matching,
		before,
		after,
		no_messages: cli.no_messages,
		quiet: cli.quiet,
	};

	let mut searcher = SearcherBuilder::new()
		.line_number(opts.line_number)
		.before_context(opts.before)
		.after_context(opts.after)
		.invert_match(cli.invert)
		.build();

	let mut out = BufWriter::new(pi_uutils_ctx::stdout());
	let mut any_match = false;
	let mut had_error = false;

	let mut processed_operand = false;
	for f in &files {
		// -q: once something matched, exit immediately; the status is settled
		// below. Checked at the top so the stdin `continue` path stops too.
		if opts.quiet && any_match {
			break;
		}
		if processed_operand && pi_uutils_ctx::is_cancelled() {
			had_error = true;
			break;
		}
		processed_operand = true;
		// stdin
		if f.as_os_str() == OsStr::new("-") {
			let name: Option<&[u8]> = if show_names {
				Some(b"(standard input)")
			} else {
				None
			};
			match process_reader(
				&matcher,
				&mut searcher,
				pi_uutils_ctx::stdin(),
				name,
				&opts,
				&mut out,
			) {
				Ok(m) => any_match |= m,
				Err(e) => {
					had_error = true;
					if !opts.no_messages {
						let _ = writeln!(pi_uutils_ctx::stderr(), "grep: (standard input): {e}");
					}
				},
			}
			if pi_uutils_ctx::is_cancelled() {
				had_error = true;
				break;
			}
			continue;
		}

		let resolved = pi_uutils_ctx::resolve(f);
		match std::fs::metadata(&resolved) {
			Ok(meta) if meta.is_dir() => {
				if recursive {
					if search_dir(
						f.as_os_str(),
						&resolved,
						&matcher,
						&mut searcher,
						&opts,
						include_set.as_ref(),
						show_names,
						cli.dereference_recursive,
						&mut out,
						&mut had_error,
					) {
						any_match = true;
					}
				} else {
					// GNU prints this regardless of -s and exits 2.
					had_error = true;
					let _ = writeln!(
						pi_uutils_ctx::stderr(),
						"grep: {}: Is a directory",
						f.to_string_lossy()
					);
				}
			},
			Ok(_) => match File::open(&resolved) {
				Ok(file) => {
					let bytes = f.as_os_str().as_encoded_bytes();
					let name: Option<&[u8]> = if show_names { Some(bytes) } else { None };
					match process_reader(&matcher, &mut searcher, file, name, &opts, &mut out) {
						Ok(m) => any_match |= m,
						Err(e) => {
							had_error = true;
							if !opts.no_messages {
								let _ =
									writeln!(pi_uutils_ctx::stderr(), "grep: {}: {e}", f.to_string_lossy());
							}
						},
					}
				},
				Err(e) => {
					had_error = true;
					if !opts.no_messages {
						let _ = writeln!(pi_uutils_ctx::stderr(), "grep: {}: {e}", f.to_string_lossy());
					}
				},
			},
			Err(e) => {
				had_error = true;
				if !opts.no_messages {
					let _ = writeln!(pi_uutils_ctx::stderr(), "grep: {}: {e}", f.to_string_lossy());
				}
			},
		}
		if pi_uutils_ctx::is_cancelled() {
			had_error = true;
			break;
		}
	}

	let _ = out.flush();

	if opts.quiet {
		// -q reports success on any match even when an error was detected.
		if any_match {
			0
		} else if had_error {
			2
		} else {
			1
		}
	} else if had_error {
		2
	} else if any_match {
		0
	} else {
		1
	}
}

#[cfg(test)]
mod tests {
	use std::{
		collections::HashMap,
		io::Cursor,
		sync::{Arc, atomic::AtomicBool},
	};

	use parking_lot::Mutex;
	use pi_uutils_ctx::{ScopeIo, scope};

	use super::*;

	/// Sink that collects writes into a shared buffer for assertions.
	struct SharedBuf(Arc<Mutex<Vec<u8>>>);

	impl Write for SharedBuf {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			self.0.lock().extend_from_slice(buf);
			Ok(buf.len())
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	/// Run the `grep` builtin with `args` (no argv[0]) over `stdin`, returning
	/// `(exit_code, stdout, stderr)`.
	fn run_grep(args: &[&str], stdin: &str) -> (i32, String, String) {
		let out = Arc::new(Mutex::new(Vec::new()));
		let err = Arc::new(Mutex::new(Vec::new()));
		let io = ScopeIo {
			stdin:                 Box::new(Cursor::new(stdin.as_bytes().to_vec())),
			stdin_fd:              None,
			stdin_is_search_input: true,
			stdout:                Box::new(SharedBuf(Arc::clone(&out))),
			stderr:                Box::new(SharedBuf(Arc::clone(&err))),
			cwd:                   std::env::temp_dir(),
			env:                   HashMap::new(),
			cancel:                Arc::new(AtomicBool::new(false)),
		};
		let argv: Vec<OsString> = std::iter::once("grep")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = scope(io, || run(argv));
		let stdout = String::from_utf8(out.lock().clone()).expect("utf8 stdout");
		let stderr = String::from_utf8(err.lock().clone()).expect("utf8 stderr");
		(code, stdout, stderr)
	}

	#[test]
	fn unbalanced_paren_pattern_matches_literally() {
		// Regression: `grep "fail)"` used to abort with `regex parse error:
		// unopened group`. It must now match the literal text and exit 0.
		let (code, stdout, stderr) = run_grep(&["-A", "1", "fail)"], "ok\n(1 fail)\nnext\n");
		assert_eq!(code, 0, "stderr: {stderr}");
		assert!(stderr.is_empty(), "no error expected, got: {stderr}");
		assert!(stdout.contains("(1 fail)"), "matched line missing: {stdout}");
		assert!(stdout.contains("next"), "after-context line missing: {stdout}");
	}

	#[test]
	fn extended_flag_reports_parse_error() {
		// -E opts into strict extended-regex syntax: the bad pattern is an error.
		let (code, _stdout, stderr) = run_grep(&["-E", "fail)"], "fail)\n");
		assert_eq!(code, 2);
		assert!(stderr.contains("grep:"), "expected a grep error, got: {stderr}");
	}

	#[test]
	fn valid_regex_still_applies() {
		// A parseable pattern is used as a regex, not matched literally.
		let (code, stdout, _err) = run_grep(&["fo+"], "foooo\nbar\n");
		assert_eq!(code, 0);
		assert!(stdout.contains("foooo"));
		assert!(!stdout.contains("bar"));
	}

	#[test]
	fn multi_pattern_keeps_valid_alternative_as_regex() {
		// Per-pattern fallback: valid `fo+` stays a regex while `bar)` is escaped.
		let (code, stdout, err) = run_grep(&["-e", "fo+", "-e", "bar)", "-h"], "foooo\nbar)\nbaz\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert!(stdout.contains("foooo"), "regex alternative should match: {stdout}");
		assert!(stdout.contains("bar)"), "literal alternative should match: {stdout}");
		assert!(!stdout.contains("baz"), "non-matching line leaked: {stdout}");
	}

	#[test]
	fn color_flag_is_accepted_and_ignored() {
		// Regression for #3755: the universal `alias grep='grep --color=auto'`
		// must not break bare `grep` in shell pipelines.
		for color in ["--color=auto", "--color=always", "--color=never", "--color", "--colour=auto"] {
			let (code, stdout, stderr) = run_grep(&[color, "foo"], "foo\nbar\n");
			assert_eq!(code, 0, "{color}: stderr: {stderr}");
			assert!(stderr.is_empty(), "{color}: unexpected stderr: {stderr}");
			assert_eq!(stdout, "foo\n", "{color}: matched lines: {stdout:?}");
		}
	}

	#[test]
	fn version_flag_prints_and_exits_zero() {
		// `grep --version` is the universal probe shells run; the builtin must
		// not reject it with exit 2.
		let (code, stdout, stderr) = run_grep(&["--version"], "");
		assert_eq!(code, 0, "stderr: {stderr}");
		assert!(stderr.is_empty(), "unexpected stderr: {stderr}");
		assert!(
			stdout.contains("grep") && stdout.contains("pi-uu-grep"),
			"version output should identify the builtin, got: {stdout:?}"
		);
	}

	/// Run `grep` with a pre-set cancel flag, mirroring how the shell wrapper
	/// flips the flag when an abort/timeout fires while the blocking task is
	/// still walking. Returns `(exit, stdout, stderr)`.
	fn run_grep_cancelled(args: &[&str], cwd: &Path) -> (i32, String, String) {
		let out = Arc::new(Mutex::new(Vec::new()));
		let err = Arc::new(Mutex::new(Vec::new()));
		let io = ScopeIo {
			stdin:                 Box::new(io::empty()),
			stdin_fd:              None,
			stdin_is_search_input: false,
			stdout:                Box::new(SharedBuf(Arc::clone(&out))),
			stderr:                Box::new(SharedBuf(Arc::clone(&err))),
			cwd:                   cwd.to_path_buf(),
			env:                   HashMap::new(),
			cancel:                Arc::new(AtomicBool::new(true)),
		};
		let argv: Vec<OsString> = std::iter::once("grep")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = scope(io, || run(argv));
		let stdout = String::from_utf8(out.lock().clone()).expect("utf8 stdout");
		let stderr = String::from_utf8(err.lock().clone()).expect("utf8 stderr");
		(code, stdout, stderr)
	}

	#[test]
	fn recursive_search_observes_scope_cancellation() {
		// Regression for #3933: recursive grep used to pass a no-op heartbeat to
		// pi_walker, so directory walks ignored the uutils cancel flag and the
		// shell-side abort/timeout waited for the whole tree to be scanned.
		// The walk must now bail out before scanning any file when the flag is
		// already set, and it must do so without printing an "interrupted"
		// diagnostic — the shell wrapper owns the user-visible status.
		let tree = std::env::temp_dir().join(format!(
			"pi-uu-grep-cancel-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.map(|d| d.as_nanos())
				.unwrap_or(0)
		));
		std::fs::create_dir_all(&tree).expect("temp tree should be created");
		let walk_root = tree.join("walk-root");
		std::fs::create_dir_all(&walk_root).expect("walk root should be created");
		std::fs::write(walk_root.join("haystack.txt"), "match-me\n")
			.expect("walked file should be written");
		let later_file = tree.join("later.txt");
		std::fs::write(&later_file, "match-me\n").expect("later file should be written");

		let (code, stdout, stderr) = run_grep_cancelled(
			&[
				"-r",
				"match-me",
				walk_root.to_str().expect("utf8 path"),
				later_file.to_str().expect("utf8 path"),
			],
			&tree,
		);

		// Walker must have observed the heartbeat before visiting the file,
		// and the operand loop must not continue into the later regular file
		// after cancellation is observed.
		assert!(stdout.is_empty(), "cancelled walk should not output matches: {stdout:?}");
		assert!(
			stderr.is_empty(),
			"cancelled walk should stay silent — diagnostic is the shell's job: {stderr:?}"
		);
		assert_eq!(code, 2, "interrupted directory walk should report had_error (exit 2)");

		let _ = std::fs::remove_dir_all(&tree);
	}
}

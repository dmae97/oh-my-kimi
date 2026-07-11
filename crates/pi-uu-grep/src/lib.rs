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

use clap::{
	ArgMatches, CommandFactory, FromArgMatches, Parser, ValueEnum, parser::ValueSource,
};
use globset::{Glob, GlobMatcher};
use grep_matcher::{LineTerminator, Matcher};
use grep_pcre2::{RegexMatcher as PcreMatcher, RegexMatcherBuilder as PcreMatcherBuilder};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{
	BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkFinish, SinkMatch,
};
pub use rg::run as run_rg;

#[derive(Parser, Debug)]
#[command(
	name = "grep",
	version = concat!("grep (pi-uu-grep) ", env!("CARGO_PKG_VERSION")),
	about = "Search for PATTERN in each FILE or standard input.",
	disable_help_flag = true,
	disable_version_flag = true,
	args_override_self = true
)]
struct Cli {
	/// Use PATTERN for matching (may be repeated; all patterns are OR-ed).
	#[arg(short = 'e', long = "regexp", value_name = "PATTERN")]
	patterns: Vec<String>,

	/// Read patterns from FILE, one per line.
	#[arg(short = 'f', long = "file", value_name = "FILE")]
	pattern_files: Vec<OsString>,

	/// Interpret PATTERN as a strict extended regular expression.
	#[arg(short = 'E', long = "extended-regexp")]
	extended: bool,

	/// Interpret PATTERN using the default basic-compatible mode.
	#[arg(short = 'G', long = "basic-regexp")]
	basic: bool,

	/// Interpret PATTERN as a fixed string.
	#[arg(short = 'F', long = "fixed-strings")]
	fixed: bool,

	/// Interpret PATTERN as a Perl-compatible regular expression.
	#[arg(short = 'P', long = "perl-regexp")]
	perl: bool,

	/// Ignore case distinctions in patterns and data.
	#[arg(short = 'i', short_alias = 'y', long = "ignore-case")]
	ignore_case: bool,

	/// Restore case-sensitive matching after an earlier -i.
	#[arg(long = "no-ignore-case")]
	no_ignore_case: bool,

	/// Select non-matching lines.
	#[arg(short = 'v', long = "invert-match")]
	invert: bool,

	/// Match only whole words.
	#[arg(short = 'w', long = "word-regexp")]
	word: bool,

	/// Match only whole lines.
	#[arg(short = 'x', long = "line-regexp")]
	line_regexp: bool,

	/// Print only a count of selected lines per FILE.
	#[arg(short = 'c', long = "count")]
	count: bool,

	/// Print only the names of FILEs with at least one selected line.
	#[arg(short = 'l', long = "files-with-matches")]
	files_with_matches: bool,

	/// Print only the names of FILEs with no selected lines.
	#[arg(short = 'L', long = "files-without-match")]
	files_without_match: bool,

	/// Stop after NUM selected lines in each input.
	#[arg(short = 'm', long = "max-count", value_name = "NUM", allow_hyphen_values = true)]
	max_count: Option<i64>,

	/// Print only the matched non-empty parts of selected lines.
	#[arg(short = 'o', long = "only-matching")]
	only_matching: bool,

	/// Quiet; suppress normal output and stop after the first selected line.
	#[arg(short = 'q', long = "quiet", visible_alias = "silent")]
	quiet: bool,

	/// Suppress error messages about nonexistent or unreadable files.
	#[arg(short = 's', long = "no-messages")]
	no_messages: bool,

	/// Prefix output with the zero-based byte offset.
	#[arg(short = 'b', long = "byte-offset")]
	byte_offset: bool,

	/// Always print the file name with output lines.
	#[arg(short = 'H', long = "with-filename")]
	with_filename: bool,

	/// Never print the file name with output lines.
	#[arg(short = 'h', long = "no-filename")]
	no_filename: bool,

	/// Use LABEL as the displayed name for standard input.
	#[arg(long = "label", value_name = "LABEL")]
	label: Option<OsString>,

	/// Prefix each output line with its one-based line number.
	#[arg(short = 'n', long = "line-number")]
	line_number: bool,

	/// Align line content on a tab stop after output prefixes.
	#[arg(short = 'T', long = "initial-tab")]
	initial_tab: bool,

	/// Write NUL instead of the separator following a file name.
	#[arg(short = 'Z', long = "null")]
	null_paths: bool,

	/// Print NUM lines of trailing context after selected lines.
	#[arg(short = 'A', long = "after-context", value_name = "NUM")]
	after_context: Option<usize>,

	/// Print NUM lines of leading context before selected lines.
	#[arg(short = 'B', long = "before-context", value_name = "NUM")]
	before_context: Option<usize>,

	/// Print NUM lines of leading and trailing context.
	#[arg(short = 'C', long = "context", value_name = "NUM")]
	context: Option<usize>,

	/// Print STRING between non-adjacent groups of context lines.
	#[arg(long = "group-separator", value_name = "STRING")]
	group_separator: Option<String>,

	/// Do not print a separator between context groups.
	#[arg(long = "no-group-separator")]
	no_group_separator: bool,

	/// Process binary input as text.
	#[arg(short = 'a', long = "text")]
	text: bool,

	/// Treat binary input as having no selected lines.
	#[arg(short = 'I')]
	binary_without_match: bool,

	/// Choose how binary input is searched.
	#[arg(long = "binary-files", value_name = "TYPE")]
	binary_files: Option<BinaryFiles>,

	/// Choose how device, FIFO, and socket operands are handled.
	#[arg(short = 'D', long = "devices", value_name = "ACTION")]
	devices: Option<DeviceAction>,

	/// Choose how directory operands are handled.
	#[arg(short = 'd', long = "directories", value_name = "ACTION")]
	directories: Option<DirectoryAction>,

	/// Search files matching GLOB.
	#[arg(long = "include", value_name = "GLOB")]
	include: Vec<String>,

	/// Skip files matching GLOB.
	#[arg(long = "exclude", value_name = "GLOB")]
	exclude: Vec<String>,

	/// Read file exclusion globs from FILE.
	#[arg(long = "exclude-from", value_name = "FILE")]
	exclude_from: Vec<OsString>,

	/// Skip directories matching GLOB during recursive searches.
	#[arg(long = "exclude-dir", value_name = "GLOB")]
	exclude_dir: Vec<String>,

	/// Search directories matching GLOB during recursive searches.
	#[arg(long = "include-dir", value_name = "GLOB")]
	include_dir: Vec<String>,

	/// Recursively search each directory operand.
	#[arg(short = 'r', long = "recursive")]
	recursive: bool,

	/// Recursively search and follow every symbolic link.
	#[arg(short = 'R', long = "dereference-recursive")]
	dereference_recursive: bool,

	/// Follow symbolic links named as command-line operands.
	#[arg(short = 'O')]
	follow_command_line: bool,

	/// Do not follow symbolic links during recursive searches.
	#[arg(short = 'p')]
	no_follow: bool,

	/// Follow every symbolic link during recursive searches.
	#[arg(short = 'S')]
	follow_all: bool,

	/// Flush standard output after each output record.
	#[arg(long = "line-buffered")]
	line_buffered: bool,

	/// Use binary I/O where the platform distinguishes it.
	#[arg(short = 'U', long = "binary")]
	binary_io: bool,

	/// Treat NUL rather than newline as the input and output record delimiter.
	#[arg(short = 'z', long = "null-data")]
	null_data: bool,

	/// Request memory-mapped input where supported.
	#[allow(dead_code, reason = "accepted BSD grep compatibility option")]
	#[arg(long = "mmap")]
	mmap: bool,

	/// Accepted compatibility option with no effect.
	#[allow(dead_code, reason = "accepted GNU grep compatibility option")]
	#[arg(short = 'u')]
	unix_byte_offsets: bool,

	/// Print a help message.
	#[allow(dead_code, reason = "clap consumes help before options are inspected")]
	#[arg(long = "help", action = clap::ArgAction::Help)]
	help: Option<bool>,

	/// Print version information.
	#[allow(dead_code, reason = "clap consumes version before options are inspected")]
	#[arg(short = 'V', long = "version", action = clap::ArgAction::Version)]
	version: Option<bool>,

	/// Accept color configuration without injecting ANSI into redirected output.
	#[allow(dead_code, reason = "color is intentionally disabled for builtin output")]
	#[arg(
		long = "color",
		alias = "colour",
		value_name = "WHEN",
		num_args = 0..=1,
		require_equals = true,
		default_missing_value = "auto",
	)]
	color: Option<String>,

	/// PATTERN followed by FILEs (PATTERN is omitted with -e or -f).
	#[arg(value_name = "ARGS")]
	args: Vec<OsString>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum BinaryFiles {
	Binary,
	Text,
	WithoutMatch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum DeviceAction {
	Read,
	Skip,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum DirectoryAction {
	Read,
	Skip,
	Recurse,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MatchMode {
	Default,
	Extended,
	Fixed,
	Perl,
}

/// Resolved, flag-free options shared with the search [`Sink`].
struct Options {
	line_number:         bool,
	byte_offset:         bool,
	count:               bool,
	files_with_matches:  bool,
	files_without_match: bool,
	only_matching:       bool,
	before:              usize,
	after:               usize,
	no_messages:         bool,
	quiet:               bool,
	prefix_filename:     bool,
	initial_tab:         bool,
	null_paths:          bool,
	record_terminator:   u8,
	group_separator:     Option<Vec<u8>>,
	line_buffered:       bool,
	binary_files:        BinaryFiles,
}

enum CompiledMatcher {
	Rust(RegexMatcher),
	Pcre(PcreMatcher),
}

struct PathRule {
	include: bool,
	matcher: GlobMatcher,
}

struct RuleSpec {
	index:   usize,
	include: bool,
	pattern: String,
}

#[derive(Default)]
struct PathRules {
	files: Vec<PathRule>,
	dirs:  Vec<PathRule>,
}

impl PathRules {
	fn allows_file(&self, path: &Path) -> bool {
		Self::allows(&self.files, path)
	}

	fn allows_dir(&self, path: &Path) -> bool {
		Self::allows(&self.dirs, path)
	}

	fn allows(rules: &[PathRule], path: &Path) -> bool {
		let mut allowed = rules.first().is_none_or(|first| !first.include);
		for rule in rules {
			if path_suffix_matches(&rule.matcher, path) {
				allowed = rule.include;
			}
		}
		allowed
	}
}

fn path_suffix_matches(matcher: &GlobMatcher, path: &Path) -> bool {
	let mut components = path.components();
	loop {
		let suffix = components.as_path();
		if suffix.as_os_str().is_empty() {
			return false;
		}
		if matcher.is_match(suffix) {
			return true;
		}
		if components.next().is_none() {
			return false;
		}
	}
}

fn last_index(matches: &ArgMatches, id: &str) -> Option<usize> {
	if matches.value_source(id) != Some(ValueSource::CommandLine) {
		return None;
	}
	matches.indices_of(id).and_then(|indices| indices.max())
}

fn choose_latest<T>(selected: &mut (usize, T), index: Option<usize>, value: T) {
	if let Some(index) = index
		&& index >= selected.0
	{
		*selected = (index, value);
	}
}

fn resolve_match_mode(matches: &ArgMatches) -> MatchMode {
	let mut selected = (0, MatchMode::Default);
	choose_latest(&mut selected, last_index(matches, "basic"), MatchMode::Default);
	choose_latest(&mut selected, last_index(matches, "extended"), MatchMode::Extended);
	choose_latest(&mut selected, last_index(matches, "fixed"), MatchMode::Fixed);
	choose_latest(&mut selected, last_index(matches, "perl"), MatchMode::Perl);
	selected.1
}

fn resolve_ignore_case(matches: &ArgMatches) -> bool {
	let mut selected = (0, false);
	choose_latest(&mut selected, last_index(matches, "ignore_case"), true);
	choose_latest(&mut selected, last_index(matches, "no_ignore_case"), false);
	selected.1
}

fn resolve_filename_prefix(matches: &ArgMatches) -> Option<bool> {
	let mut selected = (0, None);
	choose_latest(&mut selected, last_index(matches, "with_filename"), Some(true));
	choose_latest(&mut selected, last_index(matches, "no_filename"), Some(false));
	selected.1
}

fn resolve_file_list_modes(matches: &ArgMatches) -> (bool, bool) {
	let mut selected = (0, None);
	choose_latest(&mut selected, last_index(matches, "files_with_matches"), Some(true));
	choose_latest(&mut selected, last_index(matches, "files_without_match"), Some(false));
	match selected.1 {
		Some(true) => (true, false),
		Some(false) => (false, true),
		None => (false, false),
	}
}

fn resolve_context(cli: &Cli, matches: &ArgMatches) -> (usize, usize) {
	let mut events = Vec::with_capacity(3);
	if let (Some(index), Some(value)) = (last_index(matches, "after_context"), cli.after_context) {
		events.push((index, false, value));
	}
	if let (Some(index), Some(value)) = (last_index(matches, "before_context"), cli.before_context) {
		events.push((index, true, value));
	}
	if let (Some(index), Some(value)) = (last_index(matches, "context"), cli.context) {
		events.push((index, false, value));
		events.push((index, true, value));
	}
	events.sort_unstable_by_key(|event| event.0);

	let mut before = 0;
	let mut after = 0;
	for (_, is_before, value) in events {
		if is_before {
			before = value;
		} else {
			after = value;
		}
	}
	(before, after)
}

fn resolve_group_separator(cli: &Cli, matches: &ArgMatches) -> Option<Vec<u8>> {
	let mut selected = (0, Some(b"--".to_vec()));
	if let Some(separator) = &cli.group_separator {
		choose_latest(
			&mut selected,
			last_index(matches, "group_separator"),
			Some(separator.as_bytes().to_vec()),
		);
	}
	choose_latest(&mut selected, last_index(matches, "no_group_separator"), None);
	selected.1
}

fn resolve_directory_action(cli: &Cli, matches: &ArgMatches) -> DirectoryAction {
	let mut selected = (0, DirectoryAction::Read);
	choose_latest(&mut selected, last_index(matches, "recursive"), DirectoryAction::Recurse);
	choose_latest(
		&mut selected,
		last_index(matches, "dereference_recursive"),
		DirectoryAction::Recurse,
	);
	if let Some(action) = cli.directories {
		choose_latest(&mut selected, last_index(matches, "directories"), action);
	}
	selected.1
}

fn resolve_follow_links(cli: &Cli, matches: &ArgMatches) -> pi_walker::FollowLinks {
	let mut selected = (0, pi_walker::FollowLinks::Roots);
	choose_latest(&mut selected, last_index(matches, "recursive"), pi_walker::FollowLinks::Roots);
	choose_latest(
		&mut selected,
		last_index(matches, "dereference_recursive"),
		pi_walker::FollowLinks::Always,
	);
	if cli.directories == Some(DirectoryAction::Recurse) {
		choose_latest(
			&mut selected,
			last_index(matches, "directories"),
			pi_walker::FollowLinks::Roots,
		);
	}
	choose_latest(
		&mut selected,
		last_index(matches, "follow_command_line"),
		pi_walker::FollowLinks::Roots,
	);
	choose_latest(&mut selected, last_index(matches, "no_follow"), pi_walker::FollowLinks::Never);
	choose_latest(&mut selected, last_index(matches, "follow_all"), pi_walker::FollowLinks::Always);
	selected.1
}

fn resolve_binary_files(cli: &Cli, matches: &ArgMatches) -> BinaryFiles {
	// Preserve the builtin's historical byte-transparent default. Explicit
	// GNU/BSD binary controls opt into detection.
	let mut selected = (0, BinaryFiles::Text);
	choose_latest(&mut selected, last_index(matches, "text"), BinaryFiles::Text);
	choose_latest(
		&mut selected,
		last_index(matches, "binary_without_match"),
		BinaryFiles::WithoutMatch,
	);
	if let Some(mode) = cli.binary_files {
		choose_latest(&mut selected, last_index(matches, "binary_files"), mode);
	}
	choose_latest(&mut selected, last_index(matches, "binary_io"), BinaryFiles::Binary);
	selected.1
}

fn resolve_max_count(cli: &Cli) -> Result<Option<u64>, String> {
	match cli.max_count {
		None | Some(-1) => Ok(None),
		Some(value) if value >= 0 => u64::try_from(value)
			.map(Some)
			.map_err(|_| format!("invalid max count: {value}")),
		Some(value) => Err(format!("invalid max count: {value}")),
	}
}

fn option_takes_next_value(arg: &str) -> bool {
	matches!(
		arg,
		"-e"
			| "-f" | "-m"
			| "-A" | "-B"
			| "-C" | "-D"
			| "-d" | "--regexp"
			| "--file"
			| "--max-count"
			| "--after-context"
			| "--before-context"
			| "--context"
			| "--label"
			| "--group-separator"
			| "--binary-files"
			| "--devices"
			| "--directories"
			| "--include"
			| "--exclude"
			| "--exclude-from"
			| "--exclude-dir"
			| "--include-dir"
	)
}

fn normalize_context_args(argv: Vec<OsString>) -> Vec<OsString> {
	let mut normalized = Vec::with_capacity(argv.len());
	let mut literal = false;
	let mut value_pending = false;

	for (index, arg) in argv.into_iter().enumerate() {
		if index == 0 || literal || value_pending {
			value_pending = false;
			normalized.push(arg);
			continue;
		}
		let Some(text) = arg.to_str() else {
			normalized.push(arg);
			continue;
		};
		if text == "--" {
			literal = true;
			normalized.push(arg);
			continue;
		}
		if let Some(digits) = text.strip_prefix('-')
			&& !digits.is_empty()
			&& digits.bytes().all(|byte| byte.is_ascii_digit())
		{
			normalized.push(OsString::from(format!("--context={digits}")));
			continue;
		}
		value_pending = option_takes_next_value(text);
		normalized.push(arg);
	}
	normalized
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

/// Compile all patterns using the last-selected matcher mode.
fn build_matcher(
	patterns: &[String],
	cli: &Cli,
	mode: MatchMode,
	ignore_case: bool,
) -> Result<CompiledMatcher, String> {
	if mode == MatchMode::Perl {
		let mut builder = PcreMatcherBuilder::new();
		builder
			.caseless(ignore_case)
			.word(cli.word && !cli.line_regexp)
			.whole_line(cli.line_regexp)
			.utf(true)
			.ucp(true)
			.jit_if_available(true);
		return builder
			.build_many(patterns)
			.map(CompiledMatcher::Pcre)
			.map_err(|error| error.to_string());
	}

	let mut builder = RegexMatcherBuilder::new();
	builder
		.case_insensitive(ignore_case)
		.word(cli.word && !cli.line_regexp)
		.whole_line(cli.line_regexp);
	if cli.null_data {
		builder.line_terminator(Some(b'\0'));
	}
	if mode == MatchMode::Fixed {
		let escaped: Vec<String> = patterns
			.iter()
			.map(|pattern| escape_literal(pattern))
			.collect();
		return builder
			.build_many(&escaped)
			.map(CompiledMatcher::Rust)
			.map_err(|error| error.to_string());
	}

	match builder.build_many(patterns) {
		Ok(matcher) => Ok(CompiledMatcher::Rust(matcher)),
		Err(error) if mode == MatchMode::Default => {
			// The historical builtin accepts ERE syntax by default but falls
			// back to literals per malformed alternative.
			let sanitized: Vec<String> = patterns
				.iter()
				.map(|pattern| {
					if builder.build(pattern).is_ok() {
						pattern.clone()
					} else {
						escape_literal(pattern)
					}
				})
				.collect();
			builder
				.build_many(&sanitized)
				.map(CompiledMatcher::Rust)
				.map_err(|_| error.to_string())
		},
		Err(error) => Err(error.to_string()),
	}
}

/// A search sink that renders GNU-compatible records and tracks selection.
struct GrepSink<'a, M: Matcher, W: Write> {
	out:         &'a mut W,
	matcher:     &'a M,
	display:     &'a [u8],
	opts:        &'a Options,
	match_count: u64,
	any_match:   bool,
	binary:      bool,
}

impl<M: Matcher, W: Write> GrepSink<'_, M, W> {
	fn flush_record(&mut self) -> io::Result<()> {
		if self.opts.line_buffered {
			self.out.flush()?;
		}
		Ok(())
	}

	fn write_prefix(
		&mut self,
		line_number: Option<u64>,
		byte_offset: u64,
		separator: u8,
	) -> io::Result<()> {
		let mut has_prefix = false;
		if self.opts.prefix_filename {
			self.out.write_all(self.display)?;
			if self.opts.null_paths {
				self.out.write_all(b"\0")?;
			} else {
				self.out.write_all(&[separator])?;
			}
			has_prefix = true;
		}
		if self.opts.line_number
			&& let Some(number) = line_number
		{
			write!(self.out, "{number}")?;
			self.out.write_all(&[separator])?;
			has_prefix = true;
		}
		if self.opts.byte_offset {
			write!(self.out, "{byte_offset}")?;
			self.out.write_all(&[separator])?;
			has_prefix = true;
		}
		if self.opts.initial_tab && has_prefix {
			self.out.write_all(b"\t")?;
		}
		Ok(())
	}

	fn write_record(&mut self, record: &[u8]) -> io::Result<()> {
		self.out.write_all(record)?;
		if record.last().copied() != Some(self.opts.record_terminator) {
			self.out.write_all(&[self.opts.record_terminator])?;
		}
		self.flush_record()
	}

	fn write_path_record(&mut self) -> io::Result<()> {
		self.out.write_all(self.display)?;
		let terminator = if self.opts.null_paths {
			b'\0'
		} else {
			self.opts.record_terminator
		};
		self.out.write_all(&[terminator])?;
		self.flush_record()
	}

	fn print_only_matching(
		&mut self,
		line: &[u8],
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<()> {
		let mut at = 0usize;
		while at <= line.len() {
			let Some(found) = self
				.matcher
				.find_at(line, at)
				.map_err(|error| io::Error::other(error.to_string()))?
			else {
				break;
			};
			if found.is_empty() {
				at = found.end() + 1;
				continue;
			}
			let match_offset = line_offset.saturating_add(
				u64::try_from(found.start()).map_err(|error| io::Error::other(error.to_string()))?,
			);
			self.write_prefix(line_number, match_offset, b':')?;
			self.write_record(&line[found.start()..found.end()])?;
			at = found.end();
		}
		Ok(())
	}

	fn normal_output_is_suppressed(&self) -> bool {
		self.opts.count
			|| self.opts.files_with_matches
			|| self.opts.files_without_match
			|| self.opts.quiet
	}

	fn binary_summary(&self) -> bool {
		self.binary
			&& self.opts.binary_files == BinaryFiles::Binary
			&& !self.normal_output_is_suppressed()
	}
}

impl<M: Matcher, W: Write> Sink for GrepSink<'_, M, W> {
	type Error = io::Error;

	fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
		if self.binary && self.opts.binary_files == BinaryFiles::WithoutMatch {
			return Ok(false);
		}
		self.any_match = true;
		self.match_count += 1;
		if self.opts.quiet
			|| self.opts.files_with_matches
			|| self.opts.files_without_match
			|| self.binary_summary()
		{
			return Ok(false);
		}
		if self.opts.count {
			return Ok(true);
		}
		if self.opts.only_matching {
			self.print_only_matching(mat.bytes(), mat.line_number(), mat.absolute_byte_offset())?;
		} else {
			self.write_prefix(mat.line_number(), mat.absolute_byte_offset(), b':')?;
			self.write_record(mat.bytes())?;
		}
		Ok(true)
	}

	fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, io::Error> {
		if self.normal_output_is_suppressed() || self.opts.only_matching || self.binary_summary() {
			return Ok(true);
		}
		self.write_prefix(ctx.line_number(), ctx.absolute_byte_offset(), b'-')?;
		self.write_record(ctx.bytes())?;
		Ok(true)
	}

	fn context_break(&mut self, _searcher: &Searcher) -> Result<bool, io::Error> {
		if !self.normal_output_is_suppressed()
			&& !self.opts.only_matching
			&& !self.binary_summary()
			&& let Some(separator) = &self.opts.group_separator
		{
			self.out.write_all(separator)?;
			self.out.write_all(&[self.opts.record_terminator])?;
			self.flush_record()?;
		}
		Ok(true)
	}

	fn binary_data(
		&mut self,
		_searcher: &Searcher,
		_binary_byte_offset: u64,
	) -> Result<bool, io::Error> {
		self.binary = true;
		if self.opts.binary_files == BinaryFiles::WithoutMatch {
			self.any_match = false;
			self.match_count = 0;
			return Ok(false);
		}
		Ok(true)
	}

	fn finish(&mut self, _searcher: &Searcher, _: &SinkFinish) -> Result<(), io::Error> {
		if self.opts.quiet {
			return Ok(());
		}
		if self.binary_summary() && self.any_match {
			self.out.write_all(b"Binary file ")?;
			self.out.write_all(self.display)?;
			self.out.write_all(b" matches")?;
			self.out.write_all(&[self.opts.record_terminator])?;
			return self.flush_record();
		}
		if self.opts.files_with_matches {
			if self.any_match {
				self.write_path_record()?;
			}
		} else if self.opts.files_without_match {
			if !self.any_match {
				self.write_path_record()?;
			}
		} else if self.opts.count {
			if self.opts.prefix_filename {
				self.out.write_all(self.display)?;
				if self.opts.null_paths {
					self.out.write_all(b"\0")?;
				} else {
					self.out.write_all(b":")?;
				}
			}
			write!(self.out, "{}", self.match_count)?;
			self.out.write_all(&[self.opts.record_terminator])?;
			self.flush_record()?;
		}
		Ok(())
	}
}

/// Search one input and return whether it contained a selected record.
fn process_reader<M: Matcher, R: Read, W: Write>(
	matcher: &M,
	searcher: &mut Searcher,
	reader: R,
	display: &[u8],
	opts: &Options,
	out: &mut W,
) -> io::Result<bool> {
	let mut sink =
		GrepSink { out, matcher, display, opts, match_count: 0, any_match: false, binary: false };
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
fn search_file_path<M: Matcher, W: Write>(
	operand: &OsStr,
	resolved: &Path,
	path: &Path,
	matcher: &M,
	searcher: &mut Searcher,
	opts: &Options,
	out: &mut W,
	had_error: &mut bool,
) -> bool {
	let display_path = display_path_for_operand(operand, resolved, path);
	match File::open(path) {
		Ok(file) => {
			let display = display_path.as_os_str().as_encoded_bytes();
			match process_reader(matcher, searcher, file, display, opts, out) {
				Ok(matched) => matched,
				Err(error) => {
					*had_error = true;
					if !opts.no_messages {
						let _ = writeln!(
							pi_uutils_ctx::stderr(),
							"grep: {}: {error}",
							display_path.to_string_lossy()
						);
					}
					false
				},
			}
		},
		Err(error) => {
			*had_error = true;
			if !opts.no_messages {
				let _ = writeln!(
					pi_uutils_ctx::stderr(),
					"grep: {}: {error}",
					display_path.to_string_lossy()
				);
			}
			false
		},
	}
}

fn grep_walk_request(root: &Path, follow_links: pi_walker::FollowLinks) -> pi_walker::WalkRequest {
	pi_walker::WalkRequest::new(root)
		.hidden(true)
		.gitignore(false)
		.skip_git(false)
		.skip_node_modules(false)
		.follow_links(follow_links)
		.detail(pi_walker::WalkDetail::Minimal)
		.order(pi_walker::WalkOrder::Unordered)
		.emit_root(true)
		.depth(0, usize::MAX)
		.visit_order(pi_walker::VisitOrder::PreOrder)
		.directory_errors(pi_walker::DirectoryErrorMode::Visit)
		.same_file_system(false)
		.cache(false)
		.filter(pi_walker::WalkFilter::all())
}

/// Recursively search a directory operand while pruning excluded directories.
#[allow(clippy::too_many_arguments)]
fn search_dir<M: Matcher, W: Write>(
	operand: &OsStr,
	resolved: &Path,
	matcher: &M,
	searcher: &mut Searcher,
	opts: &Options,
	rules: &PathRules,
	follow_links: pi_walker::FollowLinks,
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
				if entry.depth > 0 && !rules.allows_dir(Path::new(entry.relative_path)) {
					return Ok(pi_walker::WalkDecision::SkipDescend);
				}
				return Ok(pi_walker::WalkDecision::Include);
			}
			if entry.file_type != pi_walker::FileType::File
				|| !rules.allows_file(Path::new(entry.relative_path))
			{
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
			// The shell wrapper owns the user-visible cancellation status.
			*had_error = true;
			any
		},
		Err(pi_walker::WalkError::Interrupted(error)) => {
			*had_error = true;
			if !opts.no_messages {
				let _ = writeln!(pi_uutils_ctx::stderr(), "grep: {error}");
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

fn read_auxiliary_file(path: &OsStr) -> Result<Vec<u8>, String> {
	let mut bytes = Vec::new();
	let result = if path == OsStr::new("-") {
		pi_uutils_ctx::stdin().read_to_end(&mut bytes)
	} else {
		File::open(pi_uutils_ctx::resolve(path)).and_then(|mut file| file.read_to_end(&mut bytes))
	};
	result
		.map(|_| bytes)
		.map_err(|error| format!("{}: {error}", path.to_string_lossy()))
}

fn pattern_file_lines(bytes: &[u8]) -> Vec<String> {
	if bytes.is_empty() {
		return Vec::new();
	}
	String::from_utf8_lossy(bytes)
		.split_terminator('\n')
		.map(str::to_owned)
		.collect()
}

fn resolve_patterns(cli: &Cli) -> Result<(Vec<String>, Vec<OsString>), String> {
	let has_explicit_patterns = !cli.patterns.is_empty() || !cli.pattern_files.is_empty();
	let mut patterns = Vec::new();
	let mut files = Vec::new();

	if has_explicit_patterns {
		for pattern in &cli.patterns {
			patterns.extend(pattern.split('\n').map(str::to_owned));
		}
		for path in &cli.pattern_files {
			patterns.extend(pattern_file_lines(&read_auxiliary_file(path)?));
		}
		files.clone_from(&cli.args);
		return Ok((patterns, files));
	}

	let mut args = cli.args.iter();
	let Some(pattern) = args.next() else {
		return Err("no pattern given\nUsage: grep [OPTION]... PATTERN [FILE]...".to_owned());
	};
	patterns.extend(pattern.to_string_lossy().split('\n').map(str::to_owned));
	files.extend(args.cloned());
	Ok((patterns, files))
}

fn collect_rule_specs(
	cli: &Cli,
	matches: &ArgMatches,
) -> Result<(Vec<RuleSpec>, Vec<RuleSpec>), String> {
	let mut files = Vec::new();
	if let Some(indices) = matches.indices_of("include") {
		for (index, pattern) in indices.zip(&cli.include) {
			files.push(RuleSpec { index, include: true, pattern: pattern.clone() });
		}
	}
	if let Some(indices) = matches.indices_of("exclude") {
		for (index, pattern) in indices.zip(&cli.exclude) {
			files.push(RuleSpec { index, include: false, pattern: pattern.clone() });
		}
	}
	if let Some(indices) = matches.indices_of("exclude_from") {
		for (index, path) in indices.zip(&cli.exclude_from) {
			for pattern in pattern_file_lines(&read_auxiliary_file(path)?) {
				files.push(RuleSpec { index, include: false, pattern });
			}
		}
	}

	let mut dirs = Vec::new();
	if let Some(indices) = matches.indices_of("include_dir") {
		for (index, pattern) in indices.zip(&cli.include_dir) {
			dirs.push(RuleSpec { index, include: true, pattern: pattern.clone() });
		}
	}
	if let Some(indices) = matches.indices_of("exclude_dir") {
		for (index, pattern) in indices.zip(&cli.exclude_dir) {
			dirs.push(RuleSpec { index, include: false, pattern: pattern.clone() });
		}
	}
	Ok((files, dirs))
}

fn compile_rules(mut specs: Vec<RuleSpec>) -> Result<Vec<PathRule>, String> {
	specs.sort_by_key(|spec| spec.index);
	specs
		.into_iter()
		.map(|spec| {
			Glob::new(&spec.pattern)
				.map(|glob| PathRule { include: spec.include, matcher: glob.compile_matcher() })
				.map_err(|error| format!("{}: {error}", spec.pattern))
		})
		.collect()
}

fn build_path_rules(cli: &Cli, matches: &ArgMatches) -> Result<PathRules, String> {
	let (files, dirs) = collect_rule_specs(cli, matches)?;
	Ok(PathRules { files: compile_rules(files)?, dirs: compile_rules(dirs)? })
}

fn build_searcher(cli: &Cli, opts: &Options, max_count: Option<u64>) -> Searcher {
	let binary_detection = if cli.null_data || opts.binary_files == BinaryFiles::Text {
		BinaryDetection::none()
	} else if opts.binary_files == BinaryFiles::WithoutMatch {
		BinaryDetection::quit(b'\0')
	} else {
		BinaryDetection::convert(b'\0')
	};
	let mut builder = SearcherBuilder::new();
	builder
		.line_number(opts.line_number)
		.before_context(opts.before)
		.after_context(opts.after)
		.invert_match(cli.invert)
		.binary_detection(binary_detection)
		.max_matches(max_count);
	if cli.null_data {
		builder.line_terminator(LineTerminator::byte(b'\0'));
	}
	builder.build()
}

#[allow(clippy::too_many_arguments)]
fn execute_search<M: Matcher>(
	cli: &Cli,
	matcher: &M,
	files: &[OsString],
	directory_action: DirectoryAction,
	follow_links: pi_walker::FollowLinks,
	rules: &PathRules,
	opts: &Options,
	max_count: Option<u64>,
) -> i32 {
	let mut searcher = build_searcher(cli, opts, max_count);
	let mut out = BufWriter::new(pi_uutils_ctx::stdout());
	let mut any_match = false;
	let mut had_error = false;
	let mut processed_operand = false;

	for operand in files {
		if opts.quiet && any_match {
			break;
		}
		if processed_operand && pi_uutils_ctx::is_cancelled() {
			had_error = true;
			break;
		}
		processed_operand = true;

		if operand == OsStr::new("-") {
			let display = cli
				.label
				.as_deref()
				.unwrap_or_else(|| OsStr::new("(standard input)"))
				.as_encoded_bytes();
			match process_reader(
				matcher,
				&mut searcher,
				pi_uutils_ctx::stdin(),
				display,
				opts,
				&mut out,
			) {
				Ok(matched) => any_match |= matched,
				Err(error) => {
					had_error = true;
					if !opts.no_messages {
						let _ = writeln!(pi_uutils_ctx::stderr(), "grep: (standard input): {error}");
					}
				},
			}
			if pi_uutils_ctx::is_cancelled() {
				had_error = true;
				break;
			}
			continue;
		}

		let resolved = pi_uutils_ctx::resolve(operand);
		match std::fs::metadata(&resolved) {
			Ok(metadata) if metadata.is_dir() => match directory_action {
				DirectoryAction::Recurse => {
					if rules.allows_dir(Path::new(operand))
						&& search_dir(
							operand.as_os_str(),
							&resolved,
							matcher,
							&mut searcher,
							opts,
							rules,
							follow_links,
							&mut out,
							&mut had_error,
						) {
						any_match = true;
					}
				},
				DirectoryAction::Skip => {},
				DirectoryAction::Read => {
					had_error = true;
					let _ = writeln!(
						pi_uutils_ctx::stderr(),
						"grep: {}: Is a directory",
						operand.to_string_lossy()
					);
				},
			},
			Ok(metadata) => {
				if cli.devices == Some(DeviceAction::Skip) && !metadata.is_file() {
					continue;
				}
				if !rules.allows_file(Path::new(operand)) {
					continue;
				}
				if search_file_path(
					operand.as_os_str(),
					&resolved,
					&resolved,
					matcher,
					&mut searcher,
					opts,
					&mut out,
					&mut had_error,
				) {
					any_match = true;
				}
			},
			Err(error) => {
				had_error = true;
				if !opts.no_messages {
					let _ =
						writeln!(pi_uutils_ctx::stderr(), "grep: {}: {error}", operand.to_string_lossy());
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

fn report_clap_error(error: clap::Error) -> i32 {
	let rendered = error.to_string();
	if error.use_stderr() {
		let _ = write!(pi_uutils_ctx::stderr(), "{rendered}");
		2
	} else {
		let _ = write!(pi_uutils_ctx::stdout(), "{rendered}");
		0
	}
}

/// Runs the in-process grep builtin and returns a GNU-compatible exit code.
pub fn run(argv: Vec<OsString>) -> i32 {
	let matches = match Cli::command().try_get_matches_from(normalize_context_args(argv)) {
		Ok(matches) => matches,
		Err(error) => return report_clap_error(error),
	};
	let cli = match Cli::from_arg_matches(&matches) {
		Ok(cli) => cli,
		Err(error) => return report_clap_error(error),
	};

	let (mut patterns, mut files) = match resolve_patterns(&cli) {
		Ok(resolved) => resolved,
		Err(error) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "grep: {error}");
			return 2;
		},
	};
	let directory_action = resolve_directory_action(&cli, &matches);
	if files.is_empty() {
		files.push(OsString::from(if directory_action == DirectoryAction::Recurse {
			"."
		} else {
			"-"
		}));
	}

	let max_count = match resolve_max_count(&cli) {
		Ok(max_count) => max_count,
		Err(error) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "grep: {error}");
			return 2;
		},
	};
	let rules = match build_path_rules(&cli, &matches) {
		Ok(rules) => rules,
		Err(error) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "grep: {error}");
			return 2;
		},
	};
	let matcher = match build_matcher(
		&patterns,
		&cli,
		resolve_match_mode(&matches),
		resolve_ignore_case(&matches),
	) {
		Ok(matcher) => matcher,
		Err(error) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "grep: {error}");
			return 2;
		},
	};
	patterns.clear();

	let (files_with_matches, files_without_match) = resolve_file_list_modes(&matches);
	let suppress_context =
		cli.count || files_with_matches || files_without_match || cli.quiet || cli.only_matching;
	let (before, after) = if suppress_context {
		(0, 0)
	} else {
		resolve_context(&cli, &matches)
	};
	let prefix_filename = resolve_filename_prefix(&matches)
		.unwrap_or(directory_action == DirectoryAction::Recurse || files.len() > 1);
	let opts = Options {
		line_number: cli.line_number,
		byte_offset: cli.byte_offset,
		count: cli.count,
		files_with_matches,
		files_without_match,
		only_matching: cli.only_matching,
		before,
		after,
		no_messages: cli.no_messages,
		quiet: cli.quiet,
		prefix_filename,
		initial_tab: cli.initial_tab,
		null_paths: cli.null_paths,
		record_terminator: if cli.null_data { b'\0' } else { b'\n' },
		group_separator: resolve_group_separator(&cli, &matches),
		line_buffered: cli.line_buffered,
		binary_files: resolve_binary_files(&cli, &matches),
	};
	let follow_links = resolve_follow_links(&cli, &matches);

	match matcher {
		CompiledMatcher::Rust(matcher) => execute_search(
			&cli,
			&matcher,
			&files,
			directory_action,
			follow_links,
			&rules,
			&opts,
			max_count,
		),
		CompiledMatcher::Pcre(matcher) => execute_search(
			&cli,
			&matcher,
			&files,
			directory_action,
			follow_links,
			&rules,
			&opts,
			max_count,
		),
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
		run_grep_in(args, stdin, &std::env::temp_dir())
	}

	fn run_grep_in(args: &[&str], stdin: &str, cwd: &Path) -> (i32, String, String) {
		let out = Arc::new(Mutex::new(Vec::new()));
		let err = Arc::new(Mutex::new(Vec::new()));
		let io = ScopeIo {
			stdin:                 Box::new(Cursor::new(stdin.as_bytes().to_vec())),
			stdin_fd:              None,
			stdin_is_search_input: true,
			stdout:                Box::new(SharedBuf(Arc::clone(&out))),
			stderr:                Box::new(SharedBuf(Arc::clone(&err))),
			cwd:                   cwd.to_path_buf(),
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

	fn unique_tree(label: &str) -> PathBuf {
		let tree = std::env::temp_dir().join(format!(
			"pi-uu-grep-{label}-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.map(|duration| duration.as_nanos())
				.unwrap_or(0)
		));
		std::fs::create_dir_all(&tree).expect("temp tree should be created");
		tree
	}

	#[test]
	fn max_count_accepts_compact_and_long_values() {
		for option in ["-m1", "--max-count=1"] {
			let (code, stdout, stderr) = run_grep(&[option, "hit"], "hit\nmiss\nhit\n");
			assert_eq!(code, 0, "{option}: {stderr}");
			assert_eq!(stdout, "hit\n", "{option}");
		}

		let (code, stdout, stderr) = run_grep(&["-m0", "hit"], "hit\n");
		assert_eq!(code, 1, "{stderr}");
		assert!(stdout.is_empty());
	}

	#[test]
	fn pattern_file_combines_patterns_without_consuming_a_file_operand() {
		let tree = unique_tree("patterns");
		std::fs::write(tree.join("patterns"), "alpha\nbeta\n").expect("pattern file written");
		std::fs::write(tree.join("haystack"), "alpha\ngamma\nbeta\n").expect("haystack written");

		let (code, stdout, stderr) = run_grep_in(&["-f", "patterns", "haystack"], "", &tree);
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout, "alpha\nbeta\n");

		let _ = std::fs::remove_dir_all(tree);
	}

	#[test]
	fn perl_mode_supports_lookbehind() {
		let (code, stdout, stderr) = run_grep(&["-P", "(?<=foo)bar"], "foobar\nbar\n");
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout, "foobar\n");
	}

	#[test]
	fn byte_offsets_labels_and_nul_filename_separators_are_rendered() {
		let (code, stdout, stderr) = run_grep(&["-bn", "hit"], "no\nhit\n");
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout, "2:3:hit\n");

		let (code, stdout, stderr) =
			run_grep(&["--label=pipe", "-HZ", "hit"], "hit\n");
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout.as_bytes(), b"pipe\0hit\n");
	}

	#[test]
	fn numeric_context_uses_the_configured_group_separator() {
		let input = "a\nhit\nb\ngap\nc\nhit\nd\n";
		let (code, stdout, stderr) =
			run_grep(&["-1", "--group-separator=@", "hit"], input);
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout, "a\nhit\nb\n@\nc\nhit\nd\n");
	}

	#[test]
	fn recursive_include_and_exclude_dir_rules_filter_the_walk() {
		let tree = unique_tree("filters");
		std::fs::write(tree.join("keep.rs"), "hit\n").expect("included file written");
		std::fs::write(tree.join("drop.txt"), "hit\n").expect("excluded file written");
		std::fs::create_dir(tree.join("vendor")).expect("excluded directory created");
		std::fs::write(tree.join("vendor/hidden.rs"), "hit\n").expect("excluded file written");

		let (code, stdout, stderr) = run_grep_in(
			&["-r", "--include=*.rs", "--exclude-dir=vendor", "hit", "."],
			"",
			&tree,
		);
		assert_eq!(code, 0, "{stderr}");
		assert!(stdout.contains("keep.rs:hit"), "{stdout:?}");
		assert!(!stdout.contains("drop.txt"), "{stdout:?}");
		assert!(!stdout.contains("hidden.rs"), "{stdout:?}");

		let _ = std::fs::remove_dir_all(tree);
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

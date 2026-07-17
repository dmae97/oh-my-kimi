// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.
// Vendored from uutils/coreutils 0.8.0 and patched for pi-uutils context I/O.

use std::{
	cmp::Ordering,
	ffi::{OsStr, OsString},
	fs::{self, File},
	io::{self, BufRead, BufReader, BufWriter, Read, Write},
	path::Path,
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use pi_uutils_ctx::format_usage;
use uucore::{
	display::Quotable,
	error::{FromIo, UResult, USimpleError},
	line_ending::LineEnding,
};

mod options {
	pub const COLUMN_1: &str = "1";
	pub const COLUMN_2: &str = "2";
	pub const COLUMN_3: &str = "3";
	pub const DELIMITER: &str = "output-delimiter";
	pub const FILE_1: &str = "FILE1";
	pub const FILE_2: &str = "FILE2";
	pub const TOTAL: &str = "total";
	pub const ZERO_TERMINATED: &str = "zero-terminated";
	pub const CHECK_ORDER: &str = "check-order";
	pub const NO_CHECK_ORDER: &str = "nocheck-order";
}

#[derive(Clone, Copy)]
enum FileNumber {
	One,
	Two,
}
impl FileNumber {
	fn as_str(self) -> &'static str {
		match self {
			Self::One => "1",
			Self::Two => "2",
		}
	}
}

struct OrderChecker {
	last_line:   Vec<u8>,
	file_num:    FileNumber,
	check_order: bool,
	has_error:   bool,
}
impl OrderChecker {
	fn new(file_num: FileNumber, check_order: bool) -> Self {
		Self { last_line: Vec::new(), file_num, check_order, has_error: false }
	}

	fn verify_order(&mut self, line: &[u8]) -> bool {
		if self.last_line.is_empty() {
			self.last_line = line.to_vec();
			return true;
		}
		let ordered = line >= self.last_line.as_slice();
		if !ordered && !self.has_error {
			let _ = writeln!(
				pi_uutils_ctx::stderr(),
				"comm: file {} is not in sorted order",
				self.file_num.as_str()
			);
			self.has_error = true;
		}
		self.last_line.clear();
		self.last_line.extend_from_slice(line);
		ordered || !self.check_order
	}
}

struct LineReader {
	line_ending: u8,
	input:       Box<dyn BufRead>,
}
impl LineReader {
	fn new(input: Box<dyn BufRead>, line_ending: LineEnding) -> Self {
		Self { input, line_ending: line_ending.into() }
	}

	fn read_line(&mut self, buf: &mut Vec<u8>) -> io::Result<usize> {
		let result = self.input.read_until(self.line_ending, buf)?;
		if result != 0 && !buf.ends_with(&[self.line_ending]) {
			buf.push(self.line_ending);
		}
		Ok(result)
	}
}

fn files_identical(path1: &Path, path2: &Path) -> io::Result<bool> {
	let m1 = fs::metadata(path1)?;
	let m2 = fs::metadata(path2)?;
	if !m1.is_file() || !m2.is_file() || m1.len() != m2.len() {
		return Ok(false);
	}
	let mut a = BufReader::new(File::open(path1)?);
	let mut b = BufReader::new(File::open(path2)?);
	let mut ba = [0; 8192];
	let mut bb = [0; 8192];
	loop {
		let na = loop {
			match a.read(&mut ba) {
				Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
				r => break r?,
			}
		};
		let nb = loop {
			match b.read(&mut bb) {
				Err(e) if e.kind() == io::ErrorKind::Interrupted => {},
				r => break r?,
			}
		};
		if na != nb || ba[..na] != bb[..nb] {
			return Ok(false);
		}
		if na == 0 {
			return Ok(true);
		}
	}
}

fn write_delimited(writer: &mut impl Write, delim: &[u8], line: &[u8]) -> UResult<()> {
	writer
		.write_all(delim)
		.map_err_context(|| "write error".to_string())?;
	writer
		.write_all(line)
		.map_err_context(|| "write error".to_string())
}

fn compare(
	a: &mut LineReader,
	b: &mut LineReader,
	name1: &OsStr,
	name2: &OsStr,
	delim: &str,
	opts: &ArgMatches,
	identical: bool,
) -> UResult<bool> {
	let col2 = delim.repeat(usize::from(!opts.get_flag(options::COLUMN_1)));
	let col3 = delim.repeat(
		usize::from(!opts.get_flag(options::COLUMN_1))
			+ usize::from(!opts.get_flag(options::COLUMN_2)),
	);
	let mut writer = BufWriter::new(pi_uutils_ctx::stdout());
	let (mut ra, mut rb) = (Vec::new(), Vec::new());
	let mut na = a
		.read_line(&mut ra)
		.map_err_context(|| name1.maybe_quote().to_string())?;
	let mut nb = b
		.read_line(&mut rb)
		.map_err_context(|| name2.maybe_quote().to_string())?;
	let (mut n1, mut n2, mut n3) = (0usize, 0usize, 0usize);
	let explicit = opts.get_flag(options::CHECK_ORDER);
	let should_check = !opts.get_flag(options::NO_CHECK_ORDER) && (explicit || !identical);
	let (mut c1, mut c2) =
		(OrderChecker::new(FileNumber::One, explicit), OrderChecker::new(FileNumber::Two, explicit));
	let mut delayed_error = false;
	while na != 0 || nb != 0 {
		let ord = match (na, nb) {
			(0, _) => Ordering::Greater,
			(_, 0) => Ordering::Less,
			_ => ra.cmp(&rb),
		};
		match ord {
			Ordering::Less => {
				if should_check && !c1.verify_order(&ra) {
					break;
				}
				if !opts.get_flag(options::COLUMN_1) {
					writer
						.write_all(&ra)
						.map_err_context(|| "write error".to_string())?;
				}
				ra.clear();
				na = a
					.read_line(&mut ra)
					.map_err_context(|| name1.maybe_quote().to_string())?;
				n1 += 1;
			},
			Ordering::Greater => {
				if should_check && !c2.verify_order(&rb) {
					break;
				}
				if !opts.get_flag(options::COLUMN_2) {
					write_delimited(&mut writer, col2.as_bytes(), &rb)?;
				}
				rb.clear();
				nb = b
					.read_line(&mut rb)
					.map_err_context(|| name2.maybe_quote().to_string())?;
				n2 += 1;
			},
			Ordering::Equal => {
				if should_check && (!c1.verify_order(&ra) || !c2.verify_order(&rb)) {
					break;
				}
				if !opts.get_flag(options::COLUMN_3) {
					write_delimited(&mut writer, col3.as_bytes(), &ra)?;
				}
				ra.clear();
				rb.clear();
				na = a
					.read_line(&mut ra)
					.map_err_context(|| name1.maybe_quote().to_string())?;
				nb = b
					.read_line(&mut rb)
					.map_err_context(|| name2.maybe_quote().to_string())?;
				n3 += 1;
			},
		}
		if (c1.has_error || c2.has_error) && !explicit {
			delayed_error = true;
		}
	}
	if opts.get_flag(options::TOTAL) {
		let ending = LineEnding::from_zero_flag(opts.get_flag(options::ZERO_TERMINATED));
		write!(writer, "{n1}{delim}{n2}{delim}{n3}{delim}total{ending}")
			.map_err_context(|| "write error".to_string())?;
	}
	writer
		.flush()
		.map_err_context(|| "write error".to_string())?;
	if should_check && (c1.has_error || c2.has_error) {
		if delayed_error {
			let _ = writeln!(pi_uutils_ctx::stderr(), "comm: input is not in sorted order");
		}
		Ok(false)
	} else {
		Ok(true)
	}
}

fn open_file(name: &OsStr, ending: LineEnding) -> io::Result<LineReader> {
	if name == "-" {
		return Ok(LineReader::new(Box::new(BufReader::new(pi_uutils_ctx::stdin())), ending));
	}
	let resolved = pi_uutils_ctx::resolve(name);
	if fs::metadata(&resolved)?.is_dir() {
		return Err(io::Error::other("is a directory"));
	}
	Ok(LineReader::new(Box::new(BufReader::new(File::open(resolved)?)), ending))
}

fn comm_main(matches: &ArgMatches) -> UResult<bool> {
	let name1 = matches.get_one::<OsString>(options::FILE_1).unwrap();
	let name2 = matches.get_one::<OsString>(options::FILE_2).unwrap();
	if name1 == "-" && name2 == "-" {
		return Err(USimpleError::new(1, "standard input is specified twice"));
	}
	let ending = LineEnding::from_zero_flag(matches.get_flag(options::ZERO_TERMINATED));
	let mut f1 = open_file(name1, ending).map_err_context(|| name1.maybe_quote().to_string())?;
	let mut f2 = open_file(name2, ending).map_err_context(|| name2.maybe_quote().to_string())?;
	let delimiters: Vec<_> = matches
		.get_many::<String>(options::DELIMITER)
		.unwrap()
		.collect();
	if delimiters[1..].iter().any(|d| *d != delimiters[0]) {
		return Err(USimpleError::new(1, "multiple conflicting output delimiters specified"));
	}
	let delim = if delimiters[0].is_empty() {
		"\0"
	} else {
		delimiters[0]
	};
	let identical = if name1 == "-" || name2 == "-" {
		false
	} else {
		files_identical(&pi_uutils_ctx::resolve(name1), &pi_uutils_ctx::resolve(name2))
			.unwrap_or(false)
	};
	compare(&mut f1, &mut f2, name1, name2, delim, matches, identical)
}

/// Context-safe in-process entrypoint.
pub fn run(argv: Vec<OsString>) -> i32 {
	let matches = match uu_app().try_get_matches_from(argv) {
		Ok(m) => m,
		Err(e) => {
			let rendered = e.to_string();
			if e.use_stderr() {
				let _ = write!(pi_uutils_ctx::stderr(), "{rendered}");
				return 1;
			}
			let _ = write!(pi_uutils_ctx::stdout(), "{rendered}");
			return 0;
		},
	};
	match comm_main(&matches) {
		Ok(true) => pi_uutils_ctx::exit_code(),
		Ok(false) => 1,
		Err(e) => {
			let code = e.code();
			let _ = writeln!(pi_uutils_ctx::stderr(), "comm: {e}");
			if code == 0 { 1 } else { code }
		},
	}
}

pub fn uu_app() -> Command {
	Command::new("comm")
		.version(uucore::crate_version!())
		.about("Compare sorted files FILE1 and FILE2 line by line.")
		.override_usage(format_usage("comm [OPTION]... FILE1 FILE2"))
		.infer_long_args(true)
		.args_override_self(true)
		.arg(
			Arg::new(options::COLUMN_1)
				.short('1')
				.help("suppress column 1 (lines unique to FILE1)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::COLUMN_2)
				.short('2')
				.help("suppress column 2 (lines unique to FILE2)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::COLUMN_3)
				.short('3')
				.help("suppress column 3 (lines that appear in both files)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DELIMITER)
				.long(options::DELIMITER)
				.help("separate columns with STR")
				.value_name("STR")
				.default_value("\t")
				.allow_hyphen_values(true)
				.action(ArgAction::Append)
				.hide_default_value(true),
		)
		.arg(
			Arg::new(options::ZERO_TERMINATED)
				.long(options::ZERO_TERMINATED)
				.short('z')
				.overrides_with(options::ZERO_TERMINATED)
				.help("line delimiter is NUL, not newline")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::FILE_1)
				.required(true)
				.value_hint(clap::ValueHint::FilePath)
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(options::FILE_2)
				.required(true)
				.value_hint(clap::ValueHint::FilePath)
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(options::TOTAL)
				.long(options::TOTAL)
				.help("output a summary")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::CHECK_ORDER)
				.long(options::CHECK_ORDER)
				.help("check that input is correctly sorted, even if all input lines are pairable")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_CHECK_ORDER)
				.long(options::NO_CHECK_ORDER)
				.help("do not check that input is correctly sorted")
				.action(ArgAction::SetTrue)
				.conflicts_with(options::CHECK_ORDER),
		)
}

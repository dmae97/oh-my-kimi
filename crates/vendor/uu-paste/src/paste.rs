// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{
	cell::RefCell,
	ffi::OsString,
	fs::File,
	io::{BufRead, BufReader, Read, Write},
	iter::Cycle,
	rc::Rc,
	slice::Iter,
};

use clap::{Arg, ArgAction, Command};
use uucore::{
	error::{UResult, USimpleError, strip_errno},
	i18n::charmap::mb_char_len,
};

mod options {
	pub const DELIMITER: &str = "delimiters";
	pub const SERIAL: &str = "serial";
	pub const FILE: &str = "file";
	pub const ZERO_TERMINATED: &str = "zero-terminated";
}

/// In-process entry point. Clap and utility I/O are routed exclusively through
/// the invocation context; no uucore entry macro may terminate the host.
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

	let serial = matches.get_flag(options::SERIAL);
	let delimiters = matches.get_one::<OsString>(options::DELIMITER).unwrap();
	let files = matches
		.get_many::<OsString>(options::FILE)
		.unwrap()
		.cloned()
		.collect();
	let line_ending = if matches.get_flag(options::ZERO_TERMINATED) {
		b'\0'
	} else {
		b'\n'
	};

	match paste(files, serial, delimiters, line_ending) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let _ = writeln!(pi_uutils_ctx::stderr(), "paste: {err}");
			if code == 0 { 1 } else { code }
		},
	}
}

pub fn uu_app() -> Command {
	Command::new("paste")
		.version(uucore::crate_version!())
		.about("Merge lines of files")
		.override_usage(pi_uutils_ctx::format_usage("paste [OPTION]... [FILE]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(options::SERIAL)
				.long(options::SERIAL)
				.short('s')
				.help("paste one file at a time instead of in parallel")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DELIMITER)
				.long(options::DELIMITER)
				.short('d')
				.help("reuse characters from LIST instead of TABs")
				.value_name("LIST")
				.default_value("\t")
				.hide_default_value(true)
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(options::FILE)
				.value_name("FILE")
				.action(ArgAction::Append)
				.default_value("-")
				.value_hint(clap::ValueHint::FilePath)
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(options::ZERO_TERMINATED)
				.long(options::ZERO_TERMINATED)
				.short('z')
				.help("line delimiter is NUL, not newline")
				.action(ArgAction::SetTrue),
		)
}

fn paste(
	filenames: Vec<OsString>,
	serial: bool,
	delimiters: &OsString,
	line_ending: u8,
) -> UResult<()> {
	let delimiters = parse_delimiters(delimiters)?;
	// pi-uutils: all `-` operands share the scoped stdin and consume it in order.
	let stdin = Rc::new(RefCell::new(BufReader::new(pi_uutils_ctx::stdin())));
	let mut sources = Vec::with_capacity(filenames.len());
	for filename in filenames {
		if filename == "-" {
			sources.push(InputSource::StandardInput(stdin.clone()));
		} else {
			// pi-uutils: resolve filesystem access against shell cwd, while retaining
			// the user's spelling in diagnostics.
			let file = File::open(pi_uutils_ctx::resolve(&filename)).map_err(|err| {
				USimpleError::new(1, format!("{}: {}", filename.to_string_lossy(), strip_errno(&err)))
			})?;
			sources.push(InputSource::File(BufReader::new(file)));
		}
	}

	let source_count = sources.len();
	let mut stdout = pi_uutils_ctx::stdout();
	if !serial && source_count == 1 {
		return write_single_input_source(&mut stdout, sources.pop().unwrap(), line_ending);
	}

	let mut delimiter_state = DelimiterState::new(&delimiters);
	let mut output = Vec::new();
	if serial {
		for source in &mut sources {
			output.clear();
			loop {
				if source.read_until(line_ending, &mut output)? == 0 {
					break;
				}
				remove_trailing_line_ending(line_ending, &mut output);
				delimiter_state.write_delimiter(&mut output);
			}
			delimiter_state.remove_trailing_delimiter(&mut output);
			stdout.write_all(&output)?;
			stdout.write_all(&[line_ending])?;
		}
	} else {
		let mut eof = vec![false; source_count];
		loop {
			output.clear();
			let mut eof_count = 0;
			for (i, source) in sources.iter_mut().enumerate() {
				if eof[i] {
					eof_count += 1;
				} else if source.read_until(line_ending, &mut output)? == 0 {
					eof[i] = true;
					eof_count += 1;
				} else {
					remove_trailing_line_ending(line_ending, &mut output);
				}
				delimiter_state.write_delimiter(&mut output);
			}
			if eof_count == source_count {
				break;
			}
			delimiter_state.remove_trailing_delimiter(&mut output);
			stdout.write_all(&output)?;
			stdout.write_all(&[line_ending])?;
			delimiter_state.reset_to_first_delimiter();
		}
	}
	Ok(())
}

fn write_single_input_source(
	writer: &mut impl Write,
	mut source: InputSource,
	line_ending: u8,
) -> UResult<()> {
	let mut buffer = [0_u8; 8192];
	let mut has_data = false;
	let mut last_byte = line_ending;
	loop {
		let count = source.read(&mut buffer)?;
		if count == 0 {
			break;
		}
		has_data = true;
		last_byte = buffer[count - 1];
		writer.write_all(&buffer[..count])?;
	}
	if has_data && last_byte != line_ending {
		writer.write_all(&[line_ending])?;
	}
	Ok(())
}

fn parse_delimiters(delimiters: &OsString) -> UResult<Box<[Box<[u8]>]>> {
	let bytes = uucore::os_str_as_bytes(delimiters)?;
	let mut result = Vec::<Box<[u8]>>::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'\\' {
			i += 1;
			if i >= bytes.len() {
				return Err(USimpleError::new(
					1,
					format!(
						"delimiter list ends with an unescaped backslash: {}",
						delimiters.to_string_lossy()
					),
				));
			}
			match bytes[i] {
				b'0' => result.push(Box::new([])),
				b'\\' => result.push(Box::new(*b"\\")),
				b'n' => result.push(Box::new(*b"\n")),
				b't' => result.push(Box::new(*b"\t")),
				b'b' => result.push(Box::new(*b"\x08")),
				b'f' => result.push(Box::new(*b"\x0c")),
				b'r' => result.push(Box::new(*b"\r")),
				b'v' => result.push(Box::new(*b"\x0b")),
				_ => {
					let len = mb_char_len(&bytes[i..]).min(bytes.len() - i);
					result.push(Box::from(&bytes[i..i + len]));
					i += len;
					continue;
				},
			}
			i += 1;
		} else {
			let len = mb_char_len(&bytes[i..]).min(bytes.len() - i);
			result.push(Box::from(&bytes[i..i + len]));
			i += len;
		}
	}
	Ok(result.into_boxed_slice())
}

fn remove_trailing_line_ending(line_ending: u8, output: &mut Vec<u8>) {
	if output.last() == Some(&line_ending) {
		output.pop();
	}
}

enum DelimiterState<'a> {
	NoDelimiters,
	OneDelimiter(&'a [u8]),
	MultipleDelimiters {
		current:    &'a [u8],
		delimiters: &'a [Box<[u8]>],
		iterator:   Cycle<Iter<'a, Box<[u8]>>>,
	},
}

impl<'a> DelimiterState<'a> {
	fn new(delimiters: &'a [Box<[u8]>]) -> Self {
		match delimiters {
			[] => Self::NoDelimiters,
			[only] if only.is_empty() => Self::NoDelimiters,
			[only] => Self::OneDelimiter(only),
			[first, ..] => Self::MultipleDelimiters {
				current: first,
				delimiters,
				iterator: delimiters.iter().cycle(),
			},
		}
	}

	fn reset_to_first_delimiter(&mut self) {
		if let Self::MultipleDelimiters { delimiters, iterator, .. } = self {
			*iterator = delimiters.iter().cycle();
		}
	}

	fn remove_trailing_delimiter(&self, output: &mut Vec<u8>) {
		let len = match self {
			Self::NoDelimiters => return,
			Self::OneDelimiter(d) => d.len(),
			Self::MultipleDelimiters { current, .. } => current.len(),
		};
		if len > 0 {
			output.truncate(output.len().saturating_sub(len));
		}
	}

	fn write_delimiter(&mut self, output: &mut Vec<u8>) {
		match self {
			Self::NoDelimiters => {},
			Self::OneDelimiter(d) => output.extend_from_slice(d),
			Self::MultipleDelimiters { current, iterator, .. } => {
				let d = iterator.next().unwrap();
				output.extend_from_slice(d);
				*current = d;
			},
		}
	}
}

enum InputSource {
	File(BufReader<File>),
	StandardInput(Rc<RefCell<BufReader<pi_uutils_ctx::CtxStdin>>>),
}

impl InputSource {
	fn read(&mut self, buf: &mut [u8]) -> UResult<usize> {
		Ok(match self {
			Self::File(reader) => reader.read(buf)?,
			Self::StandardInput(stdin) => stdin
				.try_borrow_mut()
				.map_err(|err| {
					USimpleError::new(1, format!("standard input is already borrowed: {err}"))
				})?
				.read(buf)?,
		})
	}

	fn read_until(&mut self, byte: u8, buf: &mut Vec<u8>) -> UResult<usize> {
		Ok(match self {
			Self::File(reader) => reader.read_until(byte, buf)?,
			Self::StandardInput(stdin) => stdin
				.try_borrow_mut()
				.map_err(|err| {
					USimpleError::new(1, format!("standard input is already borrowed: {err}"))
				})?
				.read_until(byte, buf)?,
		})
	}
}

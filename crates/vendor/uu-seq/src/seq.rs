// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) bigdecimal extendedbigdecimal numberparse
// hexadecimalfloat biguint

// pi-uutils: vendored from uutils/coreutils 0.8.0 and patched to run in-process
// as a shell builtin. seq is pure computation + stdout: all process-global
// stdio is routed through `pi_uutils_ctx` (the emission loops write to a
// `BufWriter` around the context stdout handle and poll
// `pi_uutils_ctx::is_cancelled()` periodically, since seq can generate
// unbounded output), `translate!` strings are literalized, SIGPIPE probing is
// dropped, and the entry point no longer calls `std::process::exit`.

use std::{
	ffi::{OsStr, OsString},
	io::{BufWriter, Write},
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use pi_uutils_ctx::format_usage;
use uucore::{
	error::{FromIo, UResult},
	extendedbigdecimal::ExtendedBigDecimal,
	fast_inc::fast_inc,
	format::{Format, num_format, num_format::FloatVariant},
};

mod error;

mod number;
mod numberparse;
use crate::{error::SeqError, number::PreciseNumber};

const OPT_SEPARATOR: &str = "separator";
const OPT_TERMINATOR: &str = "terminator";
const OPT_EQUAL_WIDTH: &str = "equal-width";
const OPT_FORMAT: &str = "format";

const ARG_NUMBERS: &str = "numbers";

/// pi-uutils: how many emitted numbers to print between cancellation polls in
/// the (potentially unbounded) emission loops.
const CANCEL_POLL_INTERVAL: u64 = 4096;

#[derive(Clone)]
struct SeqOptions<'a> {
	separator:   OsString,
	terminator:  OsString,
	equal_width: bool,
	format:      Option<&'a str>,
}

/// A range of floats.
///
/// The elements are (first, increment, last).
type RangeFloat = (ExtendedBigDecimal, ExtendedBigDecimal, ExtendedBigDecimal);

/// Turn short args with attached value, for example "-s,", into two args "-s"
/// and "," to make them work with clap.
fn split_short_args_with_value(args: impl uucore::Args) -> impl uucore::Args {
	let mut v: Vec<OsString> = Vec::new();

	for arg in args {
		let bytes = arg.as_encoded_bytes();

		if bytes.len() > 2
			&& (bytes.starts_with(b"-f") || bytes.starts_with(b"-s") || bytes.starts_with(b"-t"))
		{
			let (short_arg, value) = bytes.split_at(2);
			// SAFETY:
			// Both `short_arg` and `value` only contain content that originated from
			// `OsStr::as_encoded_bytes`
			v.push(unsafe { OsString::from_encoded_bytes_unchecked(short_arg.to_vec()) });
			v.push(unsafe { OsString::from_encoded_bytes_unchecked(value.to_vec()) });
		} else {
			v.push(arg);
		}
	}

	v.into_iter()
}

fn select_precision(
	first: &PreciseNumber,
	increment: &PreciseNumber,
	last: &PreciseNumber,
) -> Option<usize> {
	match (first.num_fractional_digits, increment.num_fractional_digits, last.num_fractional_digits)
	{
		(Some(0), Some(0), Some(0)) => Some(0),
		(Some(f), Some(i), Some(_)) => Some(f.max(i)),
		_ => None,
	}
}

/// In-process builtin entry point. Unlike upstream's `uumain`, this parses the
/// arguments directly (without the uucore clap-localization helper that would
/// terminate the process), renders clap help/usage/version to the context
/// streams, and maps the `UResult` to an exit code, so it is safe to run inside
/// the host shell process.
pub fn run(argv: Vec<OsString>) -> i32 {
	let matches = match uu_app().try_get_matches_from(split_short_args_with_value(argv.into_iter()))
	{
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
	match seq_main(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let msg = err.to_string();
			if !msg.is_empty() {
				let _ = writeln!(pi_uutils_ctx::stderr(), "seq: {msg}");
			}
			if code == 0 { 1 } else { code }
		},
	}
}

fn seq_main(matches: &ArgMatches) -> UResult<()> {
	let numbers_option = matches.get_many::<String>(ARG_NUMBERS);

	if numbers_option.is_none() {
		return Err(SeqError::NoArguments.into());
	}

	let numbers = numbers_option.unwrap().collect::<Vec<_>>();

	let options = SeqOptions {
		separator:   matches
			.get_one::<OsString>(OPT_SEPARATOR)
			.cloned()
			.unwrap_or_else(|| OsString::from("\n")),
		terminator:  matches
			.get_one::<OsString>(OPT_TERMINATOR)
			.cloned()
			.unwrap_or_else(|| OsString::from("\n")),
		equal_width: matches.get_flag(OPT_EQUAL_WIDTH),
		format:      matches.get_one::<String>(OPT_FORMAT).map(String::as_str),
	};

	if options.equal_width && options.format.is_some() {
		return Err(SeqError::FormatAndEqualWidth.into());
	}

	let first = if numbers.len() > 1 {
		match numbers[0].parse() {
			Ok(num) => num,
			Err(e) => return Err(SeqError::ParseError(numbers[0].to_owned(), e).into()),
		}
	} else {
		PreciseNumber::one()
	};
	let increment = if numbers.len() > 2 {
		match numbers[1].parse() {
			Ok(num) => num,
			Err(e) => return Err(SeqError::ParseError(numbers[1].to_owned(), e).into()),
		}
	} else {
		PreciseNumber::one()
	};
	if increment.is_zero() {
		return Err(SeqError::ZeroIncrement(numbers[1].to_owned()).into());
	}
	let last: PreciseNumber = {
		// We are guaranteed that `numbers.len()` is greater than zero
		// and at most three because of the argument specification in
		// `uu_app()`.
		let n: usize = numbers.len();
		match numbers[n - 1].parse() {
			Ok(num) => num,
			Err(e) => return Err(SeqError::ParseError(numbers[n - 1].to_owned(), e).into()),
		}
	};

	// If a format was passed on the command line, use that.
	// If not, use some default format based on parameters precision.
	let (format, padding, fast_allowed) = if let Some(str) = options.format {
		(Format::<num_format::Float, &ExtendedBigDecimal>::parse(str)?, 0, false)
	} else {
		let precision = select_precision(&first, &increment, &last);

		let padding = if options.equal_width {
			let precision_value = precision.unwrap_or(0);
			first
				.num_integral_digits
				.max(increment.num_integral_digits)
				.max(last.num_integral_digits)
				+ if precision_value > 0 {
					precision_value + 1
				} else {
					0
				}
		} else {
			0
		};

		let formatter = match precision {
			// format with precision: decimal floats and integers
			Some(precision) => num_format::Float {
				variant: FloatVariant::Decimal,
				width: padding,
				alignment: num_format::NumberAlignment::RightZero,
				precision: Some(precision),
				..Default::default()
			},
			// format without precision: hexadecimal floats
			None => num_format::Float { variant: FloatVariant::Shortest, ..Default::default() },
		};
		// Allow fast printing if precision is 0 (integer inputs), `print_seq` will do
		// further checks.
		(Format::from_formatter(formatter), padding, precision == Some(0))
	};

	let result = print_seq(
		(first.number, increment.number, last.number),
		&options.separator,
		&options.terminator,
		&format,
		fast_allowed,
		padding,
	);

	match result {
		Ok(()) => Ok(()),
		Err(err) if err.kind() == std::io::ErrorKind::BrokenPipe => {
			// GNU seq prints the Broken pipe message but still exits with status 0
			// unless SIGPIPE was explicitly ignored, in which case it should fail.
			// pi-uutils: the in-process builtin does not manipulate process
			// signal dispositions, so the upstream `sigpipe_was_ignored` probe
			// is dropped and the message goes to the context stderr.
			let err = err.map_err_context(|| "write error".into());
			let _ = writeln!(pi_uutils_ctx::stderr(), "seq: {err}");
			Ok(())
		},
		Err(err) => Err(err.map_err_context(|| "write error".into())),
	}
}

pub fn uu_app() -> Command {
	Command::new("seq")
		.trailing_var_arg(true)
		.infer_long_args(true)
		.version(uucore::crate_version!())
		.about("Display numbers from FIRST to LAST, in steps of INCREMENT.")
		.override_usage(format_usage(
			"seq [OPTION]... LAST\nseq [OPTION]... FIRST LAST\nseq [OPTION]... FIRST INCREMENT LAST",
		))
		.arg(
			Arg::new(OPT_SEPARATOR)
				.short('s')
				.long("separator")
				.help("Separator character (defaults to \\n)")
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(OPT_TERMINATOR)
				.short('t')
				.long("terminator")
				.help("Terminator character (defaults to \\n)")
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(OPT_EQUAL_WIDTH)
				.short('w')
				.long("equal-width")
				.help("Equalize widths of all numbers by padding with zeros")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_FORMAT)
				.short('f')
				.long(OPT_FORMAT)
				.help("use printf style floating-point FORMAT"),
		)
		.arg(
			// we use allow_hyphen_values instead of allow_negative_numbers because clap removed
			// the support for "exotic" negative numbers like -.1 (see https://github.com/clap-rs/clap/discussions/5837)
			Arg::new(ARG_NUMBERS)
				.allow_hyphen_values(true)
				.action(ArgAction::Append)
				.num_args(1..=3),
		)
}

/// Integer print, default format, positive increment: fast code path
/// that avoids reformatting digit at all iterations.
fn fast_print_seq(
	mut stdout: impl Write,
	first: &BigUint,
	increment: u64,
	last: &BigUint,
	separator: &OsStr,
	terminator: &OsStr,
	padding: usize,
) -> std::io::Result<()> {
	// Nothing to do, just return.
	if last < first {
		return Ok(());
	}

	// Do at most u64::MAX loops. We can print in the order of 1e8 digits per
	// second, u64::MAX is 1e19, so it'd take hundreds of years for this to
	// complete anyway. TODO: we can move this test to `print_seq` if we care about
	// this case.
	let loop_cnt = ((last - first) / increment).to_u64().unwrap_or(u64::MAX);

	// Format the first number.
	let first_str = first.to_string();

	// Makeshift log10.ceil
	let last_length = last.to_string().len();

	// Allocate a large u8 buffer, that contains a preformatted string
	// of the number followed by the `separator`.
	//
	// | ... head space ... | number | separator |
	// ^0                   ^ start  ^ num_end   ^ size (==buf.len())
	//
	// We keep track of start in this buffer, as the number grows.
	// When printing, we take a slice between start and end.
	let size = last_length.max(padding) + separator.len();
	// Fill with '0', this is needed for equal_width, and harmless otherwise.
	let mut buf = vec![b'0'; size];
	let buf = buf.as_mut_slice();

	let num_end = buf.len() - separator.len();
	let mut start = num_end - first_str.len();

	// Initialize buf with first and separator.
	buf[start..num_end].copy_from_slice(first_str.as_bytes());
	buf[num_end..].copy_from_slice(separator.as_encoded_bytes());

	// Normally, if padding is > 0, it should be equal to last_length,
	// so start would be == 0, but there are corner cases.
	start = start.min(num_end - padding);

	// Prepare the number to increment with as a string
	let inc_str = increment.to_string();
	let inc_str = inc_str.as_bytes();

	for i in 0..loop_cnt {
		// pi-uutils: seq can generate effectively unbounded output; poll the
		// host cancel flag periodically so shell abort/timeout is observed.
		if i % CANCEL_POLL_INTERVAL == 0 && pi_uutils_ctx::is_cancelled() {
			return Ok(());
		}
		stdout.write_all(&buf[start..])?;
		fast_inc(buf, &mut start, num_end, inc_str);
	}
	// Write the last number without separator, but with terminator.
	stdout.write_all(&buf[start..num_end])?;
	stdout.write_all(terminator.as_encoded_bytes())?;
	stdout.flush()?;
	Ok(())
}

fn done_printing<T: Zero + PartialOrd>(next: &T, increment: &T, last: &T) -> bool {
	if increment >= &T::zero() {
		next > last
	} else {
		next < last
	}
}

/// Arbitrary precision decimal number code path ("slow" path)
fn print_seq(
	range: RangeFloat,
	separator: &OsStr,
	terminator: &OsStr,
	format: &Format<num_format::Float, &ExtendedBigDecimal>,
	fast_allowed: bool,
	padding: usize, // Used by fast path only
) -> std::io::Result<()> {
	// pi-uutils: buffer the context stdout handle instead of the (locked)
	// process stdout.
	let mut stdout = BufWriter::new(pi_uutils_ctx::stdout());
	let (first, increment, last) = range;

	if fast_allowed {
		// Test if we can use fast code path.
		// First try to convert the range to BigUint (u64 for the increment).
		let (first_bui, increment_u64, last_bui) =
			(first.to_biguint(), increment.to_biguint().and_then(|x| x.to_u64()), last.to_biguint());
		if let (Some(first_bui), Some(increment_u64), Some(last_bui)) =
			(first_bui, increment_u64, last_bui)
		{
			return fast_print_seq(
				stdout,
				&first_bui,
				increment_u64,
				&last_bui,
				separator,
				terminator,
				padding,
			);
		}
	}

	let mut value = first;

	let mut is_first_iteration = true;
	// pi-uutils: iteration counter for periodic cancellation polling.
	let mut iterations: u64 = 0;
	while !done_printing(&value, &increment, &last) {
		// pi-uutils: seq can generate effectively unbounded output; poll the
		// host cancel flag periodically so shell abort/timeout is observed.
		if iterations.is_multiple_of(CANCEL_POLL_INTERVAL) && pi_uutils_ctx::is_cancelled() {
			return Ok(());
		}
		iterations += 1;
		if !is_first_iteration {
			stdout.write_all(separator.as_encoded_bytes())?;
		}
		format.fmt(&mut stdout, &value)?;
		// TODO Implement augmenting addition.
		value = value + increment.clone();
		is_first_iteration = false;
	}
	if !is_first_iteration {
		stdout.write_all(terminator.as_encoded_bytes())?;
	}
	stdout.flush()?;
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, io::Write, path::PathBuf, sync::Arc};

	use parking_lot::Mutex;
	use pi_uutils_ctx::ScopeIo;

	use super::*;

	fn run_scoped(args: Vec<&str>, cancelled: bool) -> (i32, String, String) {
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
			stdin:                 Box::new(std::io::empty()),
			stdin_fd:              None,
			stdin_is_search_input: false,
			stdout:                Box::new(SharedWriter { buf: stdout_buf.clone() }),
			stderr:                Box::new(SharedWriter { buf: stderr_buf.clone() }),
			cwd:                   PathBuf::from("."),
			env:                   HashMap::new(),
			cancel:                Arc::new(std::sync::atomic::AtomicBool::new(cancelled)),
		};

		let argv: Vec<OsString> = std::iter::once("seq")
			.chain(args)
			.map(OsString::from)
			.collect();

		let code = pi_uutils_ctx::scope(io, || run(argv));

		let out_str = String::from_utf8(stdout_buf.lock().clone()).unwrap();
		let err_str = String::from_utf8(stderr_buf.lock().clone()).unwrap();

		(code, out_str, err_str)
	}

	fn run_in(args: Vec<&str>) -> (i32, String, String) {
		run_scoped(args, false)
	}

	#[test]
	fn single_operand_counts_from_one() {
		let (code, stdout, stderr) = run_in(vec!["3"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "1\n2\n3\n", ""));
	}

	#[test]
	fn first_increment_last_arithmetic() {
		let (code, stdout, stderr) = run_in(vec!["2", "2", "10"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "2\n4\n6\n8\n10\n", ""));
	}

	#[test]
	fn separator_joins_values_terminator_ends_them() {
		let (code, stdout, stderr) = run_in(vec!["-s", ",", "1", "3"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "1,2,3\n", ""));

		// Attached short-arg value goes through `split_short_args_with_value`.
		let (code, stdout, _) = run_in(vec!["-s,", "1", "3"]);
		assert_eq!((code, stdout.as_str()), (0, "1,2,3\n"));
	}

	#[test]
	fn equal_width_pads_with_zeros() {
		let (code, stdout, stderr) = run_in(vec!["-w", "8", "10"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "08\n09\n10\n", ""));
	}

	#[test]
	fn float_increment_selects_widest_precision() {
		let (code, stdout, stderr) = run_in(vec!["1", "0.5", "2"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "1.0\n1.5\n2.0\n", ""));
	}

	#[test]
	fn invalid_operand_reports_error_and_fails() {
		let (code, stdout, stderr) = run_in(vec!["foo"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "seq: invalid floating point argument: 'foo'\n");
	}

	#[test]
	fn zero_increment_is_rejected() {
		let (code, stdout, stderr) = run_in(vec!["1", "0", "5"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "seq: invalid Zero increment value: '0'\n");
	}

	#[test]
	fn cancelled_scope_stops_emission() {
		// pi-specific contract: a pre-cancelled scope aborts the (potentially
		// unbounded) emission loop instead of printing the full range.
		let (code, stdout, stderr) = run_scoped(vec!["1", "1000000"], true);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
	}

	#[test]
	fn help_renders_to_scope_stdout() {
		let (code, stdout, stderr) = run_in(vec!["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("steps of INCREMENT"));
		assert_eq!(stderr, "");
	}
}

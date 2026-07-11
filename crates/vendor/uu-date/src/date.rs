// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore strtime ; (format) DATEFILE MMDDhhmm ; (vars) datetime
// datetimes getres AWST ACST AEST foobarbaz

// pi-uutils: vendored from uutils/coreutils 0.8.0 and patched to run in-process
// as a shell builtin. The set-date capability (`--set`, clock_settime /
// SetSystemTime) is removed entirely — a builtin must never mutate the host
// system clock — and `--set` now reports "setting the date is not supported by
// this builtin". The fluent/icu localization stack is dropped (`translate!`
// strings are literalized with the en-US locale text, the i18n-datetime
// feature is not vendored, and the locale.rs default-format probe — which
// calls the process-global setlocale(3) — is replaced by upstream's 24-hour
// fallback format). File operands (`--file`, `--reference`) resolve against
// the shell working directory via `pi_uutils_ctx::resolve` AT THE CALL SITE
// while the original operands are kept for display/error messages, stdio is
// routed through `pi_uutils_ctx`, and the entry point no longer calls
// `std::process::exit`. Time-zone handling stays process-global: jiff reads
// the host TZ environment variable and tzdb (same behavior as upstream).

mod format_modifiers;

use std::{
	borrow::Cow,
	collections::HashMap,
	ffi::OsString,
	fs::File,
	io::{BufRead, BufReader, BufWriter, Read, Write},
	path::PathBuf,
	sync::LazyLock,
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use jiff::{
	Timestamp, Zoned,
	fmt::strtime::{self, BrokenDownTime, Config, PosixCustom},
	tz::{Offset, TimeZone, TimeZoneDatabase},
};
use pi_uutils_ctx::format_usage;
use uucore::{
	display::Quotable,
	error::{FromIo, UResult, USimpleError},
	parser::shortcut_value_parser::ShortcutValueParser,
};

// Options
const DATE: &str = "date";
const HOURS: &str = "hours";
const MINUTES: &str = "minutes";
const SECONDS: &str = "seconds";
const NS: &str = "ns";

const OPT_DATE: &str = "date";
const OPT_FORMAT: &str = "format";
const OPT_FILE: &str = "file";
const OPT_DEBUG: &str = "debug";
const OPT_ISO_8601: &str = "iso-8601";
const OPT_RESOLUTION: &str = "resolution";
const OPT_RFC_EMAIL: &str = "rfc-email";
const OPT_RFC_822: &str = "rfc-822";
const OPT_RFC_2822: &str = "rfc-2822";
const OPT_RFC_3339: &str = "rfc-3339";
const OPT_SET: &str = "set";
const OPT_REFERENCE: &str = "reference";
const OPT_UNIVERSAL: &str = "universal";
const OPT_UNIVERSAL_2: &str = "utc";

/// Settings for this program, parsed from the command line
// pi-uutils: the upstream `set_to` field is gone with the set-date capability.
struct Settings {
	utc:         bool,
	format:      Format,
	date_source: DateSource,
	debug:       bool,
}

/// Options for parsing dates
#[derive(Clone, Copy)]
struct DebugOptions {
	/// Enable debug output
	debug:         bool,
	/// Warn when midnight is used without explicit time specification
	warn_midnight: bool,
}

impl DebugOptions {
	fn new(debug: bool, warn_midnight: bool) -> Self {
		Self { debug, warn_midnight }
	}
}

/// Various ways of displaying the date
enum Format {
	Iso8601(Iso8601Format),
	Rfc5322,
	Rfc3339(Rfc3339Format),
	Resolution,
	Custom(String),
	Default,
}

/// Various places that dates can come from
enum DateSource {
	Now,
	File(PathBuf),
	FileMtime(PathBuf),
	Stdin,
	Human(String),
	Resolution,
}

enum Iso8601Format {
	Date,
	Hours,
	Minutes,
	Seconds,
	Ns,
}

impl From<&str> for Iso8601Format {
	fn from(s: &str) -> Self {
		match s {
			HOURS => Self::Hours,
			MINUTES => Self::Minutes,
			SECONDS => Self::Seconds,
			NS => Self::Ns,
			DATE => Self::Date,
			// Note: This is caught by clap via `possible_values`
			_ => unreachable!(),
		}
	}
}

enum Rfc3339Format {
	Date,
	Seconds,
	Ns,
}

impl From<&str> for Rfc3339Format {
	fn from(s: &str) -> Self {
		match s {
			DATE => Self::Date,
			SECONDS => Self::Seconds,
			NS => Self::Ns,
			// Should be caught by clap
			_ => panic!("Invalid format: {s}"),
		}
	}
}

/// Indicates whether parsing a military timezone causes the date to remain the
/// same, roll back to the previous day, or advance to the next day.
/// This can occur when applying a military timezone with an optional hour
/// offset crosses midnight in either direction.
#[derive(PartialEq, Debug)]
enum DayDelta {
	/// The date does not change
	Same,
	/// The date rolls back to the previous day.
	Previous,
	/// The date advances to the next day.
	Next,
}

/// Escape invalid UTF-8 bytes in GNU-compatible octal notation.
///
/// Converts bytes to a string with printable ASCII characters preserved
/// and non-printable/invalid UTF-8 bytes escaped as `\NNN` octal sequences.
///
/// This matches GNU date's behavior for invalid input.
///
/// # Arguments
/// * `bytes` - The byte sequence to escape
///
/// # Returns
/// A string with invalid bytes escaped in octal notation
///
/// # Example
/// ```ignore
/// let invalid = b"\xb0";
/// assert_eq!(escape_invalid_bytes(invalid), "\\260");
/// ```
fn escape_invalid_bytes(bytes: &[u8]) -> String {
	let escaped = bytes
		.iter()
		.flat_map(|&b| {
			// Preserve printable ASCII except backslash
			if (0x20..0x7f).contains(&b) && b != b'\\' {
				vec![b]
			} else {
				// Escape as octal: \NNN
				format!("\\{b:03o}").into_bytes()
			}
		})
		.collect::<Vec<u8>>();
	String::from_utf8_lossy(&escaped).into_owned()
}

/// Strip parenthesized comments from a date string.
///
/// GNU date removes balanced parentheses and their content, treating them as
/// comments. If parentheses are unbalanced, everything from the unmatched '('
/// onwards is ignored.
///
/// Examples:
/// - "2026(comment)-01-05" -> "2026-01-05"
/// - "1(ignore comment to eol" -> "1"
/// - "(" -> ""
/// - "((foo)2026-01-05)" -> ""
fn strip_parenthesized_comments(input: &str) -> Cow<'_, str> {
	if !input.contains('(') {
		return Cow::Borrowed(input);
	}

	let mut result = String::with_capacity(input.len());
	let mut depth = 0;

	for c in input.chars() {
		match c {
			'(' => {
				depth += 1;
			},
			')' if depth > 0 => {
				depth -= 1;
			},
			_ if depth == 0 => {
				result.push(c);
			},
			_ => {},
		}
	}

	Cow::Owned(result)
}

/// Parse military timezone with optional hour offset.
/// Pattern: single letter (a-z except j) optionally followed by 1-2 digits.
/// Returns Some(total_hours_in_utc) or None if pattern doesn't match.
///
/// Military timezone mappings:
/// - A-I: UTC+1 to UTC+9 (J is skipped for local time)
/// - K-M: UTC+10 to UTC+12
/// - N-Y: UTC-1 to UTC-12
/// - Z: UTC+0
///
/// The hour offset from digits is added to the base military timezone offset.
/// Examples: "m" -> 12 (noon UTC), "m9" -> 21 (9pm UTC), "a5" -> 4 (4am UTC
/// next day)
fn parse_military_timezone_with_offset(s: &str) -> Option<(i32, DayDelta)> {
	if s.is_empty() || s.len() > 3 {
		return None;
	}

	let mut chars = s.chars();
	let letter = chars.next()?.to_ascii_lowercase();

	// Check if first character is a letter (a-z, except j which is handled
	// separately)
	if !letter.is_ascii_lowercase() || letter == 'j' {
		return None;
	}

	// Parse optional digits (1-2 digits for hour offset)
	let additional_hours: i32 = if let Some(rest) = chars.as_str().chars().next() {
		if !rest.is_ascii_digit() {
			return None;
		}
		chars.as_str().parse().ok()?
	} else {
		0
	};

	// Map military timezone letter to UTC offset
	let tz_offset = match letter {
		'a'..='i' => (letter as i32 - 'a' as i32) + 1, // A=+1, B=+2, ..., I=+9
		'k'..='m' => (letter as i32 - 'k' as i32) + 10, // K=+10, L=+11, M=+12
		'n'..='y' => -((letter as i32 - 'n' as i32) + 1), // N=-1, O=-2, ..., Y=-12
		'z' => 0,                                      // Z=+0
		_ => return None,
	};

	let day_delta = match additional_hours - tz_offset {
		h if h < 0 => DayDelta::Previous,
		h if h >= 24 => DayDelta::Next,
		_ => DayDelta::Same,
	};

	// Calculate total hours: midnight (0) + tz_offset + additional_hours
	// Midnight in timezone X converted to UTC
	let hours_from_midnight = (0 - tz_offset + additional_hours).rem_euclid(24);

	Some((hours_from_midnight, day_delta))
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
	match date_main(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let msg = err.to_string();
			if !msg.is_empty() {
				let _ = writeln!(pi_uutils_ctx::stderr(), "date: {msg}");
			}
			if code == 0 { 1 } else { code }
		},
	}
}

#[allow(clippy::cognitive_complexity)]
fn date_main(matches: &ArgMatches) -> UResult<()> {
	// pi-uutils: the set-date capability is removed — a shell builtin must
	// never mutate the host system clock, so `--set` fails up front instead of
	// parsing the operand and calling clock_settime(2)/SetSystemTime.
	if matches.get_one::<String>(OPT_SET).is_some() {
		return Err(USimpleError::new(1, "setting the date is not supported by this builtin"));
	}

	let date_source = if let Some(date_os) = matches.get_one::<OsString>(OPT_DATE) {
		// Convert OsString to String, handling invalid UTF-8 with GNU-compatible error
		let date = date_os.to_str().ok_or_else(|| {
			let bytes = date_os.as_encoded_bytes();
			let escaped_str = escape_invalid_bytes(bytes);
			USimpleError::new(1, format!("invalid date '{escaped_str}'"))
		})?;
		DateSource::Human(date.into())
	} else if let Some(file) = matches.get_one::<String>(OPT_FILE) {
		match file.as_ref() {
			"-" => DateSource::Stdin,
			_ => DateSource::File(file.into()),
		}
	} else if let Some(file) = matches.get_one::<String>(OPT_REFERENCE) {
		DateSource::FileMtime(file.into())
	} else if matches.get_flag(OPT_RESOLUTION) {
		DateSource::Resolution
	} else {
		DateSource::Now
	};

	// Check for extra operands (multiple positional arguments)
	if let Some(formats) = matches.get_many::<String>(OPT_FORMAT) {
		let format_args: Vec<&String> = formats.collect();
		if format_args.len() > 1 {
			return Err(USimpleError::new(1, format!("extra operand '{}'", format_args[1])));
		}
	}

	let format = if let Some(form) = matches.get_one::<String>(OPT_FORMAT) {
		if !form.starts_with('+') {
			// if an optional Format String was found but the user has not provided an input
			// date GNU prints an invalid date Error
			if !matches!(date_source, DateSource::Human(_)) {
				return Err(USimpleError::new(1, format!("invalid date '{form}'")));
			}
			// If the user did provide an input date with the --date flag and the Format
			// String is not starting with '+' GNU prints the missing '+' error message
			return Err(USimpleError::new(
				1,
				format!(
					"the argument {form} lacks a leading '+';\nwhen using an option to specify \
					 date(s), any non-option\nargument must be a format string beginning with '+'"
				),
			));
		}
		let form = form[1..].to_string();
		Format::Custom(form)
	} else if let Some(fmt) = matches
		.get_many::<String>(OPT_ISO_8601)
		.map(|mut iter| iter.next().unwrap_or(&DATE.to_string()).as_str().into())
	{
		Format::Iso8601(fmt)
	} else if matches.get_flag(OPT_RFC_EMAIL) {
		Format::Rfc5322
	} else if let Some(fmt) = matches
		.get_one::<String>(OPT_RFC_3339)
		.map(|s| s.as_str().into())
	{
		Format::Rfc3339(fmt)
	} else if matches.get_flag(OPT_RESOLUTION) {
		Format::Resolution
	} else {
		Format::Default
	};

	let utc = matches.get_flag(OPT_UNIVERSAL);
	let debug_mode = matches.get_flag(OPT_DEBUG);

	// Get the current time, either in the local time zone or UTC.
	// pi-uutils: time-zone handling stays process-global — jiff reads the host
	// TZ environment variable and system tzdb here, as upstream does.
	let now = if utc {
		Timestamp::now().to_zoned(TimeZone::UTC)
	} else {
		Zoned::now()
	};

	let settings = Settings { utc, format, date_source, debug: debug_mode };

	// Iterate over all dates - whether it's a single date or a file.
	let dates: Box<dyn Iterator<Item = _>> = match &settings.date_source {
		DateSource::Human(input) => {
			// GNU compatibility (Comments in parentheses)
			let input = strip_parenthesized_comments(input);
			let input = input.trim();

			// GNU compatibility (Empty string):
			// An empty string (or whitespace-only) should be treated as midnight today.
			let is_empty_or_whitespace = input.is_empty();

			// GNU compatibility (Military timezone 'J'):
			// 'J' is reserved for local time in military timezones.
			// GNU date accepts it and treats it as midnight today (00:00:00).
			let is_military_j = input.eq_ignore_ascii_case("j");

			// GNU compatibility (Military timezone with optional hour offset):
			// Single letter (a-z except j) optionally followed by 1-2 digits.
			// Letter represents midnight in that military timezone (UTC offset).
			// Digits represent additional hours to add.
			// Examples: "m" -> noon UTC (12:00); "m9" -> 21:00 UTC; "a5" -> 04:00 UTC
			let military_tz_with_offset = parse_military_timezone_with_offset(input);

			// GNU compatibility (Pure numbers in date strings):
			// - Manual: https://www.gnu.org/software/coreutils/manual/html_node/Pure-numbers-in-date-strings.html
			// - Semantics: a pure decimal number denotes today's time-of-day (HH or HHMM).
			//   Examples: "0"/"00" => 00:00 today; "7"/"07" => 07:00 today; "0700" => 07:00
			//   today.
			// For all other forms, fall back to the general parser.
			let is_pure_digits =
				!input.is_empty() && input.len() <= 4 && input.chars().all(|c| c.is_ascii_digit());

			let date = if is_empty_or_whitespace || is_military_j {
				// Treat empty string or 'J' as midnight today (00:00:00) in local time
				let date_part =
					strtime::format("%F", &now).unwrap_or_else(|_| String::from("1970-01-01"));
				let offset = if settings.utc {
					String::from("+00:00")
				} else {
					strtime::format("%:z", &now).unwrap_or_default()
				};
				let composed = if offset.is_empty() {
					format!("{date_part} 00:00")
				} else {
					format!("{date_part} 00:00 {offset}")
				};
				if settings.debug {
					let _ = writeln!(
						pi_uutils_ctx::stderr(),
						"date: warning: using midnight as starting time: 00:00:00"
					);
				}
				parse_date(composed, &now, DebugOptions::new(settings.debug, false))
			} else if let Some((total_hours, day_delta)) = military_tz_with_offset {
				// Military timezone with optional hour offset
				// Convert to UTC time: midnight + military_tz_offset + additional_hours

				// When calculating a military timezone with an optional hour offset, midnight
				// may be crossed in either direction. `day_delta` indicates whether the
				// date remains the same, moves to the previous day, or advances to the next
				// day. Changing day can result in error, this closure will help handle
				// these errors gracefully.
				let format_date_with_epoch_fallback = |date: Result<Zoned, _>| -> String {
					date
						.and_then(|d| strtime::format("%F", &d))
						.unwrap_or_else(|_| String::from("1970-01-01"))
				};
				let date_part = match day_delta {
					DayDelta::Same => format_date_with_epoch_fallback(Ok(now.clone())),
					DayDelta::Next => format_date_with_epoch_fallback(now.tomorrow()),
					DayDelta::Previous => format_date_with_epoch_fallback(now.yesterday()),
				};
				let composed = format!("{date_part} {total_hours:02}:00:00 +00:00");
				parse_date(composed, &now, DebugOptions::new(settings.debug, false))
			} else if is_pure_digits {
				// Derive HH and MM from the input
				let (hh_opt, mm_opt) = if input.len() <= 2 {
					(input.parse::<u32>().ok(), Some(0u32))
				} else {
					let (h, m) = input.split_at(input.len() - 2);
					(h.parse::<u32>().ok(), m.parse::<u32>().ok())
				};

				if let (Some(hh), Some(mm)) = (hh_opt, mm_opt) {
					// Compose a concrete datetime string for today with zone offset.
					// Use the already-determined 'now' and settings.utc to select offset.
					let date_part =
						strtime::format("%F", &now).unwrap_or_else(|_| String::from("1970-01-01"));
					// If -u, force +00:00; otherwise use the local offset of 'now'.
					let offset = if settings.utc {
						String::from("+00:00")
					} else {
						strtime::format("%:z", &now).unwrap_or_default()
					};
					let composed = if offset.is_empty() {
						format!("{date_part} {hh:02}:{mm:02}")
					} else {
						format!("{date_part} {hh:02}:{mm:02} {offset}")
					};
					parse_date(composed, &now, DebugOptions::new(settings.debug, false))
				} else {
					// Fallback on parse failure of digits
					parse_date(input, &now, DebugOptions::new(settings.debug, true))
				}
			} else {
				parse_date(input, &now, DebugOptions::new(settings.debug, true))
			};

			let iter = std::iter::once(date);
			Box::new(iter)
		},
		// pi-uutils: `-f -` reads the context stdin, not the process stdin.
		DateSource::Stdin => parse_dates_from_reader(
			pi_uutils_ctx::stdin(),
			&now,
			DebugOptions::new(settings.debug, true),
		),
		DateSource::File(path) => {
			// pi-uutils: resolve the DATEFILE operand against the shell working
			// directory; `path` is kept for display.
			let resolved = pi_uutils_ctx::resolve(path);
			if resolved.is_dir() {
				return Err(USimpleError::new(
					2,
					format!("expected file, got directory {}", path.quote()),
				));
			}
			let file =
				File::open(&resolved).map_err_context(|| path.as_os_str().maybe_quote().to_string())?;
			parse_dates_from_reader(file, &now, DebugOptions::new(settings.debug, true))
		},
		DateSource::FileMtime(path) => {
			// pi-uutils: resolve the --reference FILE against the shell working
			// directory; `path` is kept for display.
			let metadata = std::fs::metadata(pi_uutils_ctx::resolve(path))
				.map_err_context(|| path.as_os_str().maybe_quote().to_string())?;
			let mtime = metadata.modified()?;
			let ts = Timestamp::try_from(mtime)
				.map_err(|_| USimpleError::new(1, "cannot set date".to_string()))?;
			// pi-uutils: process-global TZ lookup, as upstream.
			let date = ts.to_zoned(TimeZone::try_system().unwrap_or(TimeZone::UTC));
			let iter = std::iter::once(Ok(date));
			Box::new(iter)
		},
		DateSource::Resolution => {
			let resolution = get_clock_resolution();
			// pi-uutils: process-global TZ lookup, as upstream.
			let date = resolution.to_zoned(TimeZone::system());
			let iter = std::iter::once(Ok(date));
			Box::new(iter)
		},
		DateSource::Now => {
			let iter = std::iter::once(Ok(now.clone()));
			Box::new(iter)
		},
	};

	let format_string = make_format_string(&settings);
	// pi-uutils: buffered context stdout instead of the process stdout.
	let mut stdout = BufWriter::new(pi_uutils_ctx::stdout());

	// Format all the dates
	let config = Config::new().custom(PosixCustom::new()).lenient(true);
	for date in dates {
		// pi-uutils: a DATEFILE/stdin stream can be arbitrarily long; observe
		// host cancellation between lines.
		if pi_uutils_ctx::is_cancelled() {
			break;
		}
		match date {
			Ok(date) => {
				let date = if settings.utc {
					date.with_time_zone(TimeZone::UTC)
				} else {
					date
				};
				match format_date(&date, format_string, &config) {
					Ok(s) => writeln!(stdout, "{s}")
						.map_err(|e| USimpleError::new(1, format!("write error: {e}")))?,
					Err(e) => {
						let _ = stdout.flush();
						return Err(USimpleError::new(
							1,
							format!("invalid format '{format_string}' ({e})"),
						));
					},
				}
			},
			Err((input, _err)) => {
				let _ = stdout.flush();
				// pi-uutils: upstream `show!` — report the bad line to the
				// context stderr, record the failure exit code, and keep
				// processing the remaining lines.
				let _ = writeln!(pi_uutils_ctx::stderr(), "date: invalid date '{input}'");
				pi_uutils_ctx::set_exit_code(1);
			},
		}
	}

	stdout
		.flush()
		.map_err(|e| USimpleError::new(1, format!("write error: {e}")))?;
	Ok(())
}

pub fn uu_app() -> Command {
	Command::new("date")
		.version(uucore::crate_version!())
		.about("Print or set the system date and time")
		// pi-uutils: the localized usage blob's FORMAT reference table moved to
		// `after_help` below; the usage proper is just the two command lines.
		.override_usage(format_usage(
			"date [OPTION]... [+FORMAT]...\ndate [OPTION]... [MMDDhhmm[[CC]YY][.ss]]",
		))
		.after_help(FORMAT_HELP)
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_DATE)
				.short('d')
				.long(OPT_DATE)
				.value_name("STRING")
				.allow_hyphen_values(true)
				.overrides_with(OPT_DATE)
				.value_parser(clap::value_parser!(OsString))
				.help("display time described by STRING, not 'now'"),
		)
		.arg(
			Arg::new(OPT_FILE)
				.short('f')
				.long(OPT_FILE)
				.value_name("DATEFILE")
				.value_hint(clap::ValueHint::FilePath)
				.conflicts_with(OPT_DATE)
				.help("like --date; once for each line of DATEFILE"),
		)
		.arg(
			Arg::new(OPT_ISO_8601)
				.short('I')
				.long(OPT_ISO_8601)
				.value_name("FMT")
				.value_parser(ShortcutValueParser::new([DATE, HOURS, MINUTES, SECONDS, NS]))
				.num_args(0..=1)
				.default_missing_value(OPT_DATE)
				.help(
					"output date/time in ISO 8601 format.\nFMT='date' for date only (the \
					 default),\n'hours', 'minutes', 'seconds', or 'ns'\nfor date and time to the \
					 indicated precision.\nExample: 2006-08-14T02:34:56-06:00",
				),
		)
		.arg(
			Arg::new(OPT_RESOLUTION)
				.long(OPT_RESOLUTION)
				.conflicts_with_all([OPT_DATE, OPT_FILE])
				.overrides_with(OPT_RESOLUTION)
				.help("output the available resolution of timestamps\nExample: 0.000000001")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_RFC_EMAIL)
				.short('R')
				.long(OPT_RFC_EMAIL)
				.alias(OPT_RFC_2822)
				.alias(OPT_RFC_822)
				.overrides_with(OPT_RFC_EMAIL)
				.help(
					"output date and time in RFC 5322 format.\nExample: Mon, 14 Aug 2006 02:34:56 -0600",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_RFC_3339)
				.long(OPT_RFC_3339)
				.value_name("FMT")
				.value_parser(ShortcutValueParser::new([DATE, SECONDS, NS]))
				.help(
					"output date/time in RFC 3339 format.\nFMT='date', 'seconds', or 'ns'\nfor date \
					 and time to the indicated precision.\nExample: 2006-08-14 02:34:56-06:00",
				),
		)
		.arg(
			Arg::new(OPT_DEBUG)
				.long(OPT_DEBUG)
				.help("annotate the parsed date, and warn about questionable usage to stderr")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_REFERENCE)
				.short('r')
				.long(OPT_REFERENCE)
				.value_name("FILE")
				.value_hint(clap::ValueHint::AnyPath)
				.conflicts_with_all([OPT_DATE, OPT_FILE, OPT_RESOLUTION])
				.help("display the last modification time of FILE"),
		)
		.arg(
			Arg::new(OPT_SET)
				.short('s')
				.long(OPT_SET)
				.value_name("STRING")
				.allow_hyphen_values(true)
				// pi-uutils: the set-date capability is removed; the option is
				// still parsed so it fails with a clear message instead of a
				// clap "unexpected argument" error.
				.help("set time described by STRING (not supported by this builtin)"),
		)
		.arg(
			Arg::new(OPT_UNIVERSAL)
				.short('u')
				.long(OPT_UNIVERSAL)
				.visible_alias(OPT_UNIVERSAL_2)
				.alias("uct")
				.overrides_with(OPT_UNIVERSAL)
				.help("print or set Coordinated Universal Time (UTC)")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new(OPT_FORMAT).num_args(0..))
}

// pi-uutils: literalized en-US FORMAT reference from the `date-usage` locale
// blob, rendered as plain text for clap's after_help.
const FORMAT_HELP: &str = "\
FORMAT controls the output.  Interpreted sequences are:
  %%     a literal %
  %a     locale's abbreviated weekday name (e.g., Sun)
  %A     locale's full weekday name (e.g., Sunday)
  %b     locale's abbreviated month name (e.g., Jan)
  %B     locale's full month name (e.g., January)
  %c     locale's date and time (e.g., Thu Mar  3 23:05:25 2005)
  %C     century; like %Y, except omit last two digits (e.g., 20)
  %d     day of month (e.g., 01)
  %D     date; same as %m/%d/%y
  %e     day of month, space padded; same as %_d
  %F     full date; same as %Y-%m-%d
  %g     last two digits of year of ISO week number (see %G)
  %G     year of ISO week number (see %V); normally useful only with %V
  %h     same as %b
  %H     hour (00..23)
  %I     hour (01..12)
  %j     day of year (001..366)
  %k     hour, space padded ( 0..23); same as %_H
  %l     hour, space padded ( 1..12); same as %_I
  %m     month (01..12)
  %M     minute (00..59)
  %n     a newline
  %N     nanoseconds (000000000..999999999)
  %p     locale's equivalent of either AM or PM; blank if not known
  %P     like %p, but lower case
  %q     quarter of year (1..4)
  %r     locale's 12-hour clock time (e.g., 11:11:04 PM)
  %R     24-hour hour and minute; same as %H:%M
  %s     seconds since 1970-01-01 00:00:00 UTC
  %S     second (00..60)
  %t     a tab
  %T     time; same as %H:%M:%S
  %u     day of week (1..7); 1 is Monday
  %U     week number of year, with Sunday as first day of week (00..53)
  %V     ISO week number, with Monday as first day of week (01..53)
  %w     day of week (0..6); 0 is Sunday
  %W     week number of year, with Monday as first day of week (00..53)
  %x     locale's date representation (e.g., 03/03/2005)
  %X     locale's time representation (e.g., 23:30:30)
  %y     last two digits of year (00..99)
  %Y     year
  %z     +hhmm numeric time zone (e.g., -0400)
  %:z    +hh:mm numeric time zone (e.g., -04:00)
  %::z   +hh:mm:ss numeric time zone (e.g., -04:00:00)
  %:::z  numeric time zone with : to necessary precision (e.g., -04, +05:30)
  %Z     alphabetic time zone abbreviation (e.g., EDT)

By default, date pads numeric fields with zeroes.
The following optional flags may follow '%':
  - (hyphen) do not pad the field
  _ (underscore) pad with spaces
  0 (zero) pad with zeros
  ^ use upper case if possible
  # use opposite case if possible
After any flags comes an optional field width, as a decimal number;
then an optional modifier, which is either
  E to use the locale's alternate representations if available, or
  O to use the locale's alternate numeric symbols if available.

Examples:
  Convert seconds since the epoch (1970-01-01 UTC) to a date
    date --date='@2147483647'
  Show the time on the west coast of the US (use tzselect(1) to find TZ)
    TZ='America/Los_Angeles' date";

/// pi-uutils: upstream's `format_date_with_locale_aware_months` minus the
/// optional icu locale-aware month/day name substitution (the i18n-datetime
/// feature is not vendored, so no localization ever applies).
fn format_date(
	date: &Zoned,
	format_string: &str,
	config: &Config<PosixCustom>,
) -> Result<String, String> {
	// Check if format string has GNU modifiers (width/flags) and format if present
	if let Some(result) =
		format_modifiers::format_with_modifiers_if_present(date, format_string, config)
	{
		return result.map_err(|e| e.to_string());
	}

	let broken_down = BrokenDownTime::from(date);
	broken_down
		.to_string_with_config(config, format_string)
		.map_err(|e| e.to_string())
}

/// Return the appropriate format string for the given settings.
fn make_format_string(settings: &Settings) -> &str {
	match &settings.format {
		Format::Iso8601(fmt) => match fmt {
			Iso8601Format::Date => "%F",
			Iso8601Format::Hours => "%FT%H%:z",
			Iso8601Format::Minutes => "%FT%H:%M%:z",
			Iso8601Format::Seconds => "%FT%T%:z",
			Iso8601Format::Ns => "%FT%T,%N%:z",
		},
		Format::Rfc5322 => "%a, %d %h %Y %T %z",
		Format::Rfc3339(fmt) => match fmt {
			Rfc3339Format::Date => "%F",
			Rfc3339Format::Seconds => "%F %T%:z",
			Rfc3339Format::Ns => "%F %T.%N%:z",
		},
		Format::Resolution => "%s.%N",
		Format::Custom(fmt) => fmt,
		// pi-uutils: upstream derives the default format from the process
		// locale via setlocale(3)/nl_langinfo(3) (src/uu/date/src/locale.rs).
		// setlocale mutates process-global state, which a builtin must not do,
		// so upstream's 24-hour fallback format is used unconditionally.
		Format::Default => "%a %b %e %X %Z %Y",
	}
}

/// Timezone abbreviations with known fixed UTC offsets.
/// Checked first because the abbreviation encodes the exact offset
/// (e.g., EDT always means UTC-4, even in winter when New York observes EST).
/// Offset is in seconds to support half-hour zones like IST (UTC+5:30).
/// All other timezones (JST, CET, etc.) are dynamically resolved from IANA
/// database.
/* spell-checker: disable */
static FIXED_OFFSET_ABBREVIATIONS: &[(&str, i32)] = &[
	("UTC", 0),
	("GMT", 0),
	("MEST", 7200), // UTC+2 Middle European Summer Time
	// US timezones (GNU compatible)
	("PST", -28800), // UTC-8
	("PDT", -25200), // UTC-7
	("MST", -25200), // UTC-7
	("MDT", -21600), // UTC-6
	("CST", -21600), // UTC-6 (Ambiguous: US Central, not China/Cuba)
	("CDT", -18000), // UTC-5
	("EST", -18000), // UTC-5
	("EDT", -14400), // UTC-4
	// Indian Standard Time (Ambiguous: India vs Israel vs Ireland)
	("IST", 19800), // UTC+5:30
	// Australian timezones
	("AWST", 28800), // UTC+8
	("ACST", 34200), // UTC+9:30
	("ACDT", 37800), // UTC+10:30
	("AEST", 36000), // UTC+10
	("AEDT", 39600), // UTC+11
	// German timezones
	("MEZ", 3600),  // UTC+1
	("MESZ", 7200), // UTC+2
	// Asian timezones
	("KST", 32400), // UTC+9 Korean Standard Time
];
/* spell-checker: enable */

/// Lazy-loaded timezone abbreviation lookup map built from IANA database.
// pi-uutils: `LazyLock` instead of upstream's `OnceLock` + `get_or_init`.
static TZ_ABBREV_CACHE: LazyLock<HashMap<String, String>> = LazyLock::new(build_tz_abbrev_map);

/// Build timezone abbreviation lookup map from IANA database.
/// This is a fallback for abbreviations not covered by
/// FIXED_OFFSET_ABBREVIATIONS.
fn build_tz_abbrev_map() -> HashMap<String, String> {
	let mut map = HashMap::new();

	let tzdb = TimeZoneDatabase::from_env(); // spell-checker:disable-line
	// spell-checker:disable-next-line
	for tz_name in tzdb.available() {
		let tz_str = tz_name.as_str();
		// Use last component as potential abbreviation
		// e.g., "Pacific/Fiji" could map to "FIJI"
		if let Some(last_part) = tz_str.split('/').next_back() {
			let potential_abbrev = last_part.to_uppercase();
			// Only add if it looks like an abbreviation (2-5 uppercase chars)
			if potential_abbrev.len() >= 2
				&& potential_abbrev.len() <= 5
				&& potential_abbrev.chars().all(|c| c.is_ascii_uppercase())
			{
				map.entry(potential_abbrev)
					.or_insert_with(|| tz_str.to_string());
			}
		}
	}

	map
}

/// Get IANA timezone name for a given abbreviation.
/// Uses lazy-loaded cache with preferred mappings for disambiguation.
fn tz_abbrev_to_iana(abbrev: &str) -> Option<&str> {
	TZ_ABBREV_CACHE.get(abbrev).map(String::as_str)
}

/// Attempts to parse a date string that contains a timezone abbreviation (e.g.
/// "EST").
///
/// If an abbreviation is found and the date is parsable, returns `Some(Zoned)`.
/// Returns `None` if no abbreviation is detected or if parsing fails,
/// indicating that standard parsing should be attempted.
fn try_parse_with_abbreviation<S: AsRef<str>>(date_str: S, now: &Zoned) -> Option<Zoned> {
	let s = date_str.as_ref();

	// Look for timezone abbreviation at the end of the string
	// Pattern: ends with uppercase letters (2-5 chars)
	if let Some(last_word) = s.split_whitespace().last() {
		// Check if it's a potential timezone abbreviation (all uppercase, 2-5 chars)
		if last_word.len() >= 2
			&& last_word.len() <= 5
			&& last_word.chars().all(|c| c.is_ascii_uppercase())
		{
			let tz = if let Some(&(_, offset_secs)) = FIXED_OFFSET_ABBREVIATIONS
				.iter()
				.find(|(abbr, _)| *abbr == last_word)
			{
				Offset::from_seconds(offset_secs).ok().map(TimeZone::fixed)
			} else {
				tz_abbrev_to_iana(last_word).and_then(|name| TimeZone::get(name).ok())
			};

			if let Some(tz) = tz {
				let date_part = s.trim_end_matches(last_word).trim();
				// Parse in the target timezone so "10:30 EDT" means 10:30 in EDT
				if let Ok(parsed) = parse_datetime::parse_datetime_at_date(now.clone(), date_part) {
					let dt = parsed.datetime();
					if let Ok(zoned) = dt.to_zoned(tz) {
						return Some(zoned);
					}
				}
			}
		}
	}

	// No abbreviation found or couldn't resolve, return original
	None
}

/// Helper function to parse dates from a line-based reader (stdin or file)
///
/// Takes any `Read` source, reads it line by line, and parses each line as a
/// date. Returns a boxed iterator over the parse results.
fn parse_dates_from_reader<R: Read + 'static>(
	reader: R,
	now: &Zoned,
	dbg_opts: DebugOptions,
) -> Box<dyn Iterator<Item = Result<Zoned, (String, parse_datetime::ParseDateTimeError)>> + '_> {
	let lines = BufReader::new(reader).lines();
	Box::new(
		lines
			.map_while(Result::ok)
			.map(move |s| parse_date(s, now, dbg_opts)),
	)
}

/// Parse a `String` into a `DateTime`.
/// If it fails, return a tuple of the `String` along with its `ParseError`.
fn parse_date<S: AsRef<str> + Clone>(
	s: S,
	now: &Zoned,
	dbg_opts: DebugOptions,
) -> Result<Zoned, (String, parse_datetime::ParseDateTimeError)> {
	let input_str = s.as_ref();

	if dbg_opts.debug {
		let _ = writeln!(pi_uutils_ctx::stderr(), "date: input string: {input_str}");
	}

	// First, try to parse any timezone abbreviations
	if let Some(zoned) = try_parse_with_abbreviation(input_str, now) {
		if dbg_opts.debug {
			// pi-uutils: context stderr instead of `stderr().lock()`.
			let mut err = pi_uutils_ctx::stderr();
			let _ = writeln!(
				err,
				"date: parsed date part: (Y-M-D) {}",
				strtime::format("%Y-%m-%d", &zoned).unwrap_or_default()
			);
			let _ = writeln!(
				err,
				"date: parsed time part: {}",
				strtime::format("%H:%M:%S", &zoned).unwrap_or_default()
			);
			let tz_display = zoned.time_zone().iana_name().unwrap_or("system default");
			let _ = writeln!(err, "date: input timezone: {tz_display}");
		}
		return Ok(zoned);
	}

	match parse_datetime::parse_datetime_at_date(now.clone(), input_str) {
		// Convert to system timezone for display
		// (parse_datetime returns Zoned in the input's timezone)
		Ok(date) => {
			let result = date.timestamp().to_zoned(now.time_zone().clone());
			if dbg_opts.debug {
				// Show final parsed date and time
				// pi-uutils: context stderr instead of `stderr().lock()`.
				let mut err = pi_uutils_ctx::stderr();
				let _ = writeln!(
					err,
					"date: parsed date part: (Y-M-D) {}",
					strtime::format("%Y-%m-%d", &result).unwrap_or_default()
				);
				let _ = writeln!(
					err,
					"date: parsed time part: {}",
					strtime::format("%H:%M:%S", &result).unwrap_or_default()
				);

				// Show timezone information
				let _ = writeln!(err, "date: input timezone: system default");

				// Check if time component was specified, if not warn about midnight usage
				// Only warn for date-only inputs (no time specified), but not for epoch formats
				// (@N) or inputs that explicitly specify a time (containing ':')
				if dbg_opts.warn_midnight && !input_str.contains(':') && !input_str.contains('@') {
					// Input likely didn't specify a time, so midnight was assumed
					let time_str = strtime::format("%H:%M:%S", &result).unwrap_or_default();
					if time_str == "00:00:00" {
						let _ = writeln!(err, "date: warning: using midnight as starting time: 00:00:00");
					}
				}
			}
			Ok(result)
		},
		Err(e) => Err((input_str.into(), e)),
	}
}

#[cfg(not(any(unix, windows)))]
fn get_clock_resolution() -> Timestamp {
	unimplemented!("getting clock resolution not implemented (unsupported target)");
}

#[cfg(all(unix, not(target_os = "redox")))]
/// Returns the resolution of the system’s realtime clock.
///
/// # Panics
///
/// Panics if `clock_getres` fails. On a POSIX-compliant system this should not
/// occur, as `CLOCK_REALTIME` is required to be supported.
/// Failure would indicate a non-conforming or otherwise broken implementation.
fn get_clock_resolution() -> Timestamp {
	use rustix::time::{ClockId, clock_getres};

	let timespec = clock_getres(ClockId::Realtime);

	#[allow(clippy::unnecessary_cast, reason = "needed for 32 bit target")]
	Timestamp::constant(timespec.tv_sec as _, timespec.tv_nsec as _)
}

#[cfg(all(unix, target_os = "redox"))]
fn get_clock_resolution() -> Timestamp {
	// Redox OS does not support the posix clock_getres function, however
	// internally it uses a resolution of 1ns to represent timestamps.
	// https://gitlab.redox-os.org/redox-os/kernel/-/blob/master/src/time.rs
	Timestamp::constant(0, 1)
}

#[cfg(windows)]
fn get_clock_resolution() -> Timestamp {
	// Windows does not expose a system call for getting the resolution of the
	// clock, however the FILETIME struct returned by GetSystemTimeAsFileTime,
	// and GetSystemTimePreciseAsFileTime has a resolution of 100ns.
	// https://learn.microsoft.com/en-us/windows/win32/api/minwinbase/ns-minwinbase-filetime
	Timestamp::constant(0, 100)
}

// pi-uutils: upstream's `convert_for_set` and the `set_system_datetime`
// variants (clock_settime / SetSystemTime) are removed with the set-date
// capability.

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, io::Write, path::PathBuf, sync::Arc};

	use parking_lot::Mutex;
	use pi_uutils_ctx::ScopeIo;

	use super::*;

	fn run_in(cwd: PathBuf, args: Vec<&str>) -> (i32, String, String) {
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
			cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
		};

		let argv: Vec<OsString> = std::iter::once("date")
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
		let canon = std::fs::canonicalize(dir.path()).unwrap();
		(dir, canon)
	}

	// --- upstream unit tests (0.8.0) ---

	#[test]
	fn test_parse_military_timezone_with_offset() {
		// Valid cases: letter only, letter + digit, uppercase
		assert_eq!(parse_military_timezone_with_offset("m"), Some((12, DayDelta::Previous))); // UTC+12 -> 12:00 UTC
		assert_eq!(parse_military_timezone_with_offset("m9"), Some((21, DayDelta::Previous))); // 12 + 9 = 21
		assert_eq!(parse_military_timezone_with_offset("a5"), Some((4, DayDelta::Same))); // 23 + 5 = 28 % 24 = 4
		assert_eq!(parse_military_timezone_with_offset("z"), Some((0, DayDelta::Same))); // UTC+0 -> 00:00 UTC
		assert_eq!(parse_military_timezone_with_offset("M9"), Some((21, DayDelta::Previous))); // Uppercase works

		// Invalid cases: 'j' reserved, empty, too long, starts with digit
		assert_eq!(parse_military_timezone_with_offset("j"), None); // Reserved for local time
		assert_eq!(parse_military_timezone_with_offset(""), None); // Empty
		assert_eq!(parse_military_timezone_with_offset("m999"), None); // Too long
		assert_eq!(parse_military_timezone_with_offset("9m"), None); // Starts with digit
	}

	#[test]
	fn test_abbreviation_resolves_relative_date_against_now() {
		let now = "2025-03-15T20:00:00+00:00[UTC]".parse::<Zoned>().unwrap();
		let result =
			parse_date("yesterday 10:00 GMT", &now, DebugOptions::new(false, false)).unwrap();
		assert_eq!(result.date(), jiff::civil::date(2025, 3, 14));
	}

	#[test]
	fn test_strip_parenthesized_comments() {
		assert_eq!(strip_parenthesized_comments("hello"), "hello");
		assert_eq!(strip_parenthesized_comments("2026-01-05"), "2026-01-05");
		assert_eq!(strip_parenthesized_comments("("), "");
		assert_eq!(strip_parenthesized_comments("1(comment"), "1");
		assert_eq!(strip_parenthesized_comments("2026-01-05(this is a comment"), "2026-01-05");
		assert_eq!(strip_parenthesized_comments("2026(comment)-01-05"), "2026-01-05");
		assert_eq!(strip_parenthesized_comments("()"), "");
		assert_eq!(strip_parenthesized_comments("((foo)2026-01-05)"), "");

		// These cases test the balanced parentheses removal feature
		// which extends beyond what GNU date strictly supports
		assert_eq!(strip_parenthesized_comments("a(b)c"), "ac");
		assert_eq!(strip_parenthesized_comments("a(b)c(d)e"), "ace");
		assert_eq!(strip_parenthesized_comments("(a)(b)"), "");

		// When parentheses are unmatched, processing stops at the unmatched opening
		// paren
		assert_eq!(strip_parenthesized_comments("a(b)c(d"), "ac");

		// Additional edge cases for nested and complex parentheses
		assert_eq!(strip_parenthesized_comments("a(b(c)d)e"), "ae"); // Nested balanced
		assert_eq!(strip_parenthesized_comments("a(b(c)d"), "a"); // Nested unbalanced
		assert_eq!(strip_parenthesized_comments("a(b)c(d)e(f"), "ace"); // Multiple groups, last unmatched
	}

	// --- pi-uutils behavior contracts ---

	#[test]
	fn utc_date_string_formats_exactly() {
		let (code, stdout, stderr) =
			run_in(PathBuf::from("."), vec!["-u", "-d", "2026-01-02 03:04:05", "+%Y-%m-%dT%H:%M:%S"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "2026-01-02T03:04:05\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn epoch_input_round_trips_through_seconds_format() {
		let (code, stdout, stderr) =
			run_in(PathBuf::from("."), vec!["-u", "-d", "@1767323045", "+%s"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "1767323045\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn set_is_unsupported() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec!["--set", "2026-01-02 03:04:05"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "date: setting the date is not supported by this builtin\n");

		let (code, _, stderr) = run_in(PathBuf::from("."), vec!["-s", "now"]);
		assert_eq!(code, 1);
		assert!(stderr.contains("not supported by this builtin"));
	}

	#[test]
	fn datefile_relative_path_resolves_against_scope_cwd() {
		let (_dir, root) = canonical_tempdir();
		std::fs::write(root.join("dates.txt"), "2026-01-02 03:04:05\n@0\n").unwrap();

		// Relative operand + scope cwd differing from the process cwd: only the
		// call-site `pi_uutils_ctx::resolve` patch makes this find the file.
		let (code, stdout, stderr) = run_in(root, vec!["-u", "-f", "dates.txt", "+%F"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "2026-01-02\n1970-01-01\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn datefile_bad_line_reports_but_keeps_processing() {
		let (_dir, root) = canonical_tempdir();
		std::fs::write(root.join("dates.txt"), "foobarbaz\n@86400\n").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["-u", "-f", "dates.txt", "+%F"]);
		assert_eq!(code, 1, "a bad line must fail the invocation");
		assert_eq!(stdout, "1970-01-02\n", "good lines after a bad one still print");
		assert!(stderr.contains("invalid date 'foobarbaz'"), "stderr: {stderr}");
	}

	#[test]
	fn invalid_date_string_reports_and_fails() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec!["-d", "foobarbaz"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "date: invalid date 'foobarbaz'\n");
	}

	#[test]
	fn rfc_email_iso_and_rfc3339_formats() {
		let fixed = "2026-01-02 03:04:05";

		let (code, stdout, _) = run_in(PathBuf::from("."), vec!["-u", "-d", fixed, "-R"]);
		assert_eq!((code, stdout.as_str()), (0, "Fri, 02 Jan 2026 03:04:05 +0000\n"));

		let (code, stdout, _) = run_in(PathBuf::from("."), vec!["-u", "-d", fixed, "-Iseconds"]);
		assert_eq!((code, stdout.as_str()), (0, "2026-01-02T03:04:05+00:00\n"));

		let (code, stdout, _) =
			run_in(PathBuf::from("."), vec!["-u", "-d", fixed, "--rfc-3339=seconds"]);
		assert_eq!((code, stdout.as_str()), (0, "2026-01-02 03:04:05+00:00\n"));
	}

	#[test]
	fn reference_relative_path_resolves_against_scope_cwd() {
		let (_dir, root) = canonical_tempdir();
		std::fs::write(root.join("ref-file"), b"x").unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["-u", "-r", "ref-file", "+%s"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let secs: i64 = stdout.trim().parse().unwrap();
		let now = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap()
			.as_secs() as i64;
		assert!((now - secs).abs() < 60, "mtime epoch {secs} should be close to now {now}");

		// Missing file fails, naming the operand as typed.
		let (code, _, stderr) = run_in(root, vec!["-r", "missing-file"]);
		assert_eq!(code, 1);
		assert!(stderr.contains("missing-file"), "stderr: {stderr}");
	}

	#[test]
	fn format_operand_without_plus_is_rejected() {
		// With -d: GNU's "lacks a leading '+'" message.
		let (code, _, stderr) = run_in(PathBuf::from("."), vec!["-d", "2026-01-02", "%F"]);
		assert_eq!(code, 1);
		assert!(stderr.contains("lacks a leading '+'"), "stderr: {stderr}");

		// Without a date source: GNU treats the operand as an invalid date.
		let (code, _, stderr) = run_in(PathBuf::from("."), vec!["%F"]);
		assert_eq!(code, 1);
		assert!(stderr.contains("invalid date '%F'"), "stderr: {stderr}");
	}

	#[test]
	fn help_renders_to_scope_stdout() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec!["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("FORMAT controls the output"));
		assert_eq!(stderr, "");
	}
}

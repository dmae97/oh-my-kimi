// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

mod operation;
mod simd;
mod unicode_table;

use std::{
	ffi::OsString,
	io::{BufReader, Write},
};

use clap::{Arg, ArgAction, Command, value_parser};
use operation::{
	DeleteOperation, Sequence, SqueezeOperation, SymbolTranslator, TranslateOperation, flush_output,
	translate_input,
};
use pi_uutils_ctx::format_usage;
use simd::process_input;
use uucore::{
	display::Quotable,
	error::{UResult, UUsageError},
	os_str_as_bytes,
};

mod options {
	pub const COMPLEMENT: &str = "complement";
	pub const DELETE: &str = "delete";
	pub const SQUEEZE: &str = "squeeze-repeats";
	pub const TRUNCATE_SET1: &str = "truncate-set1";
	pub const SETS: &str = "sets";
}

/// pi-uutils: context-safe in-process entry point. `argv` includes the command
/// name; clap output and all utility diagnostics are written only to scoped
/// streams.
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

	match tr_main(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let _ = writeln!(pi_uutils_ctx::stderr(), "tr: {err}");
			if code == 0 { 1 } else { code }
		},
	}
}

fn tr_main(matches: &clap::ArgMatches) -> UResult<()> {
	let delete_flag = matches.get_flag(options::DELETE);
	let complement_flag = matches.get_flag(options::COMPLEMENT);
	let squeeze_flag = matches.get_flag(options::SQUEEZE);
	let truncate_set1_flag = matches.get_flag(options::TRUNCATE_SET1);

	let sets: Vec<_> = matches
		.get_many::<OsString>(options::SETS)
		.into_iter()
		.flatten()
		.map(ToOwned::to_owned)
		.collect();

	if sets.is_empty() {
		return Err(UUsageError::new(1, "missing operand"));
	}

	let sets_len = sets.len();
	if !(delete_flag || squeeze_flag) && sets_len == 1 {
		return Err(UUsageError::new(
			1,
			format!(
				"missing operand after {}\nTwo strings must be given when translating.",
				sets[0].quote()
			),
		));
	}

	if delete_flag && squeeze_flag && sets_len == 1 {
		return Err(UUsageError::new(
			1,
			format!(
				"missing operand after {}\nTwo strings must be given when deleting and squeezing.",
				sets[0].quote()
			),
		));
	}

	if sets_len > 1 {
		if delete_flag && !squeeze_flag {
			let operand = sets[1].quote();
			let message = if sets_len == 2 {
				format!(
					"extra operand {operand}\nOnly one string may be given when deleting without \
					 squeezing repeats."
				)
			} else {
				format!("extra operand {operand}")
			};
			return Err(UUsageError::new(1, message));
		}
		if sets_len > 2 {
			return Err(UUsageError::new(1, format!("extra operand {}", sets[2].quote())));
		}
	}

	if let Some(first) = sets.first() {
		let bytes = os_str_as_bytes(first)?;
		let trailing_backslashes = bytes
			.iter()
			.rev()
			.take_while(|&&byte| byte == b'\\')
			.count();
		if trailing_backslashes % 2 == 1 {
			let _ = writeln!(
				pi_uutils_ctx::stderr(),
				"tr: warning: an unescaped backslash at end of string is not portable"
			);
		}
	}

	let translating = !delete_flag && sets.len() > 1;
	let mut sets_iter = sets.iter().map(OsString::as_os_str);
	let (set1, set2) = Sequence::solve_set_characters(
		os_str_as_bytes(sets_iter.next().unwrap_or_default())?,
		os_str_as_bytes(sets_iter.next().unwrap_or_default())?,
		complement_flag,
		truncate_set1_flag && translating,
		translating,
	)?;

	// pi-uutils: replace process-global stdin/stdout with the invocation context.
	let mut input = BufReader::new(pi_uutils_ctx::stdin());
	let mut output = pi_uutils_ctx::stdout();

	if delete_flag {
		if squeeze_flag {
			let operation = DeleteOperation::new(set1).chain(SqueezeOperation::new(set2));
			translate_input(&mut input, &mut output, operation)?;
		} else {
			process_input(&mut input, &mut output, &DeleteOperation::new(set1))?;
		}
	} else if squeeze_flag {
		if sets_len == 1 {
			translate_input(&mut input, &mut output, SqueezeOperation::new(set1))?;
		} else {
			let operation =
				TranslateOperation::new(set1, set2.clone())?.chain(SqueezeOperation::new(set2));
			translate_input(&mut input, &mut output, operation)?;
		}
	} else {
		process_input(&mut input, &mut output, &TranslateOperation::new(set1, set2)?)?;
	}

	flush_output(&mut output)?;
	Ok(())
}

pub fn uu_app() -> Command {
	Command::new("tr")
		.version(env!("CARGO_PKG_VERSION"))
		.about("Translate or delete characters")
		.override_usage(format_usage("tr [OPTION]... SET1 [SET2]"))
		.after_help(
			"Translate, squeeze, and/or delete characters from standard input, writing to standard \
			 output.",
		)
		.infer_long_args(true)
		.trailing_var_arg(true)
		.arg(
			Arg::new(options::COMPLEMENT)
				.visible_short_alias('C')
				.short('c')
				.long(options::COMPLEMENT)
				.help("use the complement of SET1")
				.action(ArgAction::SetTrue)
				.overrides_with(options::COMPLEMENT),
		)
		.arg(
			Arg::new(options::DELETE)
				.short('d')
				.long(options::DELETE)
				.help("delete characters in SET1, do not translate")
				.action(ArgAction::SetTrue)
				.overrides_with(options::DELETE),
		)
		.arg(
			Arg::new(options::SQUEEZE)
				.long(options::SQUEEZE)
				.short('s')
				.help(
					"replace each sequence of a repeated character listed in the last specified SET \
					 with a single occurrence",
				)
				.action(ArgAction::SetTrue)
				.overrides_with(options::SQUEEZE),
		)
		.arg(
			Arg::new(options::TRUNCATE_SET1)
				.long(options::TRUNCATE_SET1)
				.short('t')
				.help("first truncate SET1 to length of SET2")
				.action(ArgAction::SetTrue)
				.overrides_with(options::TRUNCATE_SET1),
		)
		.arg(
			Arg::new(options::SETS)
				.num_args(1..)
				.value_parser(value_parser!(OsString)),
		)
}

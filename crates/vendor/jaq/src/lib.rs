//! Vendored, patched `jaq` CLI (jq-compatible JSON processor), wired to run
//! in-process as a shell builtin via [`pi_uutils_ctx`].
//!
//! Upstream: <https://github.com/01mf02/jaq>, tag `v2.3.0`,
//! commit `0ce6e86a5e038a623dc894ad5cc70aaa9142daf2` (MIT).
//!
//! Only the CLI crate (`jaq/`) is vendored; the interpreter libraries
//! (`jaq-core`, `jaq-std`, `jaq-json`) come from crates.io. Patches vs
//! upstream:
//! - `main()` is restructured as [`run`], returning the exit code instead of
//!   `ExitCode`/`Termination`; no `std::process::exit` anywhere.
//! - stdio goes through the [`pi_uutils_ctx`] streams; every file path operand
//!   resolves through `pi_uutils_ctx::resolve` against the shell's cwd.
//! - The ctx streams are never a tty, so `--color` auto mode always resolves to
//!   plain output; `-C/--color-output` still forces ANSI. Color state is
//!   thread-local (see `color` in this module) instead of yansi's global
//!   enable/disable, so concurrent invocations don't race.
//! - The mimalloc global allocator, env_logger, and the rustyline `repl` filter
//!   are stripped (binary-only / interactive-only).
//! - jaq-std's `env`, `halt`, `halt_error`, `debug`, and `stderr` natives are
//!   shadowed (first-match-wins in the compiler's native table) because the
//!   crates.io implementations call `std::process::exit`, read the host process
//!   environment, or log through the global `log` facade. See
//!   `filter::overrides`.

mod cli;
mod filter;
mod read;
mod write;

use core::fmt::{self, Display, Formatter};
use std::{
	io::{self, BufRead, Write},
	path::PathBuf,
};

use cli::Cli;
use filter::{FileReports, Filter};
use jaq_core::{Ctx, RcIter, load};
use jaq_json::Val;
use write::{print, with_stdout};

/// In-process builtin entry point. The host installs a [`pi_uutils_ctx`] scope
/// (stdio + working directory + environment) on a dedicated blocking thread,
/// then calls this with `argv[0]` = command name (`jq`).
pub fn run(argv: Vec<std::ffi::OsString>) -> i32 {
	color::init();
	color::set(false);
	filter::take_halt(); // clear leftover state from a prior scope on this thread

	let cli = match Cli::parse(argv) {
		Ok(cli) => cli,
		Err(e) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "Error: {e}");
			return 2;
		},
	};

	if cli.version {
		let _ = writeln!(
			pi_uutils_ctx::stdout(),
			"{} {}",
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION")
		);
		return 0;
	} else if cli.help {
		let _ = writeln!(pi_uutils_ctx::stdout(), "{}", include_str!("help.txt"));
		return 0;
	}

	// Upstream enables color when stdout is a terminal and NO_COLOR is unset.
	// The ctx streams are never a terminal, so auto mode is always plain;
	// only -C/--color-output (minus -M) forces ANSI.
	color::set(!cli.in_place && cli.color_if(|| false));

	let res = real_main(&cli);
	// `halt`/`halt_error` abort the filter run with a sentinel error; the
	// requested exit code wins over the error path below.
	if let Some(code) = filter::take_halt() {
		return code;
	}
	match res {
		Ok(exit) => exit,
		Err(e) => {
			color::set(cli.color_if(|| false));
			let _ = write!(pi_uutils_ctx::stderr(), "{e}");
			e.report()
		},
	}
}

/// Thread-local color toggle backing yansi's process-global condition.
///
/// `yansi::enable`/`disable` flip process-global state, which races when
/// several shell pipeline stages run jaq concurrently on different threads.
/// Instead, a process-global yansi condition (installed once) reads this
/// thread-local flag, giving each invocation its own color state.
mod color {
	use std::{cell::Cell, sync::Once};

	thread_local! {
		static COLOR: Cell<bool> = const { Cell::new(false) };
	}

	pub fn init() {
		static ONCE: Once = Once::new();
		ONCE.call_once(|| yansi::whenever(yansi::Condition(|| COLOR.with(Cell::get))));
	}

	pub fn set(on: bool) {
		COLOR.with(|c| c.set(on));
	}
}

fn real_main(cli: &Cli) -> Result<i32, Error> {
	if let Some(test_files) = &cli.run_tests {
		return Ok(match test_files.last() {
			Some(file) => {
				run_tests(io::BufReader::new(std::fs::File::open(pi_uutils_ctx::resolve(file))?))
			},
			None => run_tests(io::BufReader::new(pi_uutils_ctx::stdin())),
		});
	}

	let (vars, mut ctx): (Vec<String>, Vec<Val>) = binds(cli)?.into_iter().unzip();

	let (vals, filter) = match &cli.filter {
		None => (Vec::new(), Filter::default()),
		Some(filter) => {
			let (path, code) = match filter {
				cli::Filter::FromFile(path) => {
					(path.into(), std::fs::read_to_string(pi_uutils_ctx::resolve(path))?)
				},
				cli::Filter::Inline(filter) => ("<inline>".into(), filter.clone()),
			};
			filter::parse_compile(&path, &code, &vars, &cli.library_path).map_err(Error::Report)?
		},
	};
	ctx.extend(vals);

	let last = if cli.files.is_empty() {
		let inputs = read::buffered(cli, io::BufReader::new(pi_uutils_ctx::stdin()));
		with_stdout(|out| filter::run(cli, &filter, ctx, inputs, |v| print(out, cli, &v)))?
	} else {
		let mut last = None;
		for file in &cli.files {
			// Resolve the operand against the shell's cwd; all later path
			// operations (open, metadata, in-place temp+rename) use the
			// resolved path so nothing touches the host process cwd.
			let resolved = pi_uutils_ctx::resolve(file);
			let path = resolved.as_path();
			let file =
				read::load_file(path).map_err(|e| Error::Io(Some(path.display().to_string()), e))?;
			let inputs = read::slice(cli, &file);
			if cli.in_place {
				// create a temporary file where output is written to,
				// in the resolved target's directory so the final rename
				// stays on the same filesystem
				let location = path.parent().unwrap();
				let mut tmp = tempfile::Builder::new()
					.prefix("jaq")
					.tempfile_in(location)?;

				last = filter::run(cli, &filter, ctx.clone(), inputs, |output| {
					print(tmp.as_file_mut(), cli, &output)
				})?;

				// replace the input file with the temporary file
				std::mem::drop(file);
				let perms = std::fs::metadata(path)?.permissions();
				tmp.persist(path).map_err(Error::Persist)?;
				std::fs::set_permissions(path, perms)?;
			} else {
				last = with_stdout(|out| {
					filter::run(cli, &filter, ctx.clone(), inputs, |v| print(out, cli, &v))
				})?;
			}
		}
		last
	};

	if cli.exit_status {
		last.map_or_else(|| Err(Error::NoOutput), |b| if b { Ok(0) } else { Err(Error::FalseOrNull) })
	} else {
		Ok(0)
	}
}

fn binds(cli: &Cli) -> Result<Vec<(String, Val)>, Error> {
	let arg = cli.arg.iter().map(|(k, s)| {
		let s = s.to_owned();
		Ok((k.to_owned(), Val::Str(s.into())))
	});
	let argjson = cli.argjson.iter().map(|(k, s)| {
		use hifijson::token::Lex;
		let mut lexer = hifijson::SliceLexer::new(s.as_bytes());
		let err = |e| Error::Parse(format!("{e} (for value passed to `--argjson {k}`)"));
		Ok((k.to_owned(), lexer.exactly_one(Val::parse).map_err(err)?))
	});
	let rawfile = cli.rawfile.iter().map(|(k, path)| {
		let s = std::fs::read_to_string(pi_uutils_ctx::resolve(path))
			.map_err(|e| Error::Io(Some(format!("{path:?}")), e));
		Ok((k.to_owned(), Val::Str(s?.into())))
	});
	let slurpfile = cli.slurpfile.iter().map(|(k, path)| {
		let a = read::json_array(path).map_err(|e| Error::Io(Some(format!("{path:?}")), e));
		Ok((k.to_owned(), a?))
	});

	let positional = cli.args.iter().cloned().map(|s| Ok(Val::from(s)));
	let positional = positional.collect::<Result<Vec<_>, Error>>()?;

	let var_val = arg.chain(rawfile).chain(slurpfile).chain(argjson);
	let mut var_val = var_val.collect::<Result<Vec<_>, Error>>()?;

	var_val.push(("ARGS".to_string(), args(&positional, &var_val)));
	// the shell's exported environment, not the host process environment
	let env = pi_uutils_ctx::env_snapshot()
		.into_iter()
		.map(|(k, v)| (k.into(), Val::from(v)));
	var_val.push(("ENV".to_string(), Val::obj(env.collect())));

	Ok(var_val)
}

fn args(positional: &[Val], named: &[(String, Val)]) -> Val {
	let key = |k: &str| k.to_string().into();
	let positional = positional.iter().cloned();
	let named = named.iter().map(|(var, val)| (key(var), val.clone()));
	let obj = [(key("positional"), positional.collect()), (key("named"), Val::obj(named.collect()))];
	Val::obj(obj.into_iter().collect())
}

#[derive(Debug)]
enum Error {
	Io(Option<String>, io::Error),
	Report(Vec<FileReports>),
	Parse(String),
	Jaq(jaq_core::Error<Val>),
	Persist(tempfile::PersistError),
	FalseOrNull,
	NoOutput,
}

impl Display for Error {
	fn fmt(&self, f: &mut Formatter) -> fmt::Result {
		match self {
			Self::FalseOrNull | Self::NoOutput => Ok(()),
			Self::Io(prefix, e) => {
				write!(f, "Error: ")?;
				if let Some(p) = prefix {
					write!(f, "{p}: ")?;
				}
				writeln!(f, "{e}")
			},
			Self::Persist(e) => {
				writeln!(f, "Error: {e}")
			},
			Self::Report(reports) => reports.iter().try_for_each(|fr| write!(f, "{fr}")),
			Self::Parse(e) => writeln!(f, "Error: failed to parse: {e}"),
			Self::Jaq(e) => writeln!(f, "Error: {e}"),
		}
	}
}

impl Error {
	/// Upstream's `Termination` exit-code mapping, kept verbatim.
	fn report(&self) -> i32 {
		match self {
			Self::FalseOrNull => 1,
			Self::Io(..) | Self::Persist(_) => 2,
			Self::Report(_) => 3,
			Self::NoOutput => 4,
			Self::Parse(_) | Self::Jaq(_) => 5,
		}
	}
}

impl From<io::Error> for Error {
	fn from(e: io::Error) -> Self {
		Self::Io(None, e)
	}
}

fn run_test(test: load::test::Test<String>) -> Result<(Val, Val), Error> {
	let (ctx, filter) =
		filter::parse_compile(&PathBuf::new(), &test.filter, &[], &[]).map_err(Error::Report)?;

	let inputs = RcIter::new(Box::new(core::iter::empty()));
	let ctx = Ctx::new(ctx, &inputs);

	let json = |s: String| {
		use hifijson::token::Lex;
		hifijson::SliceLexer::new(s.as_bytes())
			.exactly_one(Val::parse)
			.map_err(read::invalid_data)
	};
	let input = json(test.input)?;
	let expect: Result<Val, _> = test.output.into_iter().map(json).collect();
	let obtain: Result<Val, _> = filter.run((ctx, input)).collect();
	Ok((expect?, obtain.map_err(Error::Jaq)?))
}

fn run_tests(read: impl BufRead) -> i32 {
	let lines = read.lines().map(Result::unwrap);
	let tests = load::test::Parser::new(lines);

	let (mut passed, mut total) = (0, 0);
	for test in tests {
		if pi_uutils_ctx::is_cancelled() {
			break;
		}
		let _ = writeln!(pi_uutils_ctx::stdout(), "Testing {}", test.filter);
		match run_test(test) {
			Err(e) => {
				let _ = writeln!(pi_uutils_ctx::stderr(), "{e:?}");
			},
			Ok((expect, obtain)) if expect != obtain => {
				let _ = writeln!(pi_uutils_ctx::stderr(), "expected {expect}, obtained {obtain}",);
			},
			Ok(_) => passed += 1,
		}
		total += 1;
	}

	let _ = writeln!(pi_uutils_ctx::stdout(), "{passed} out of {total} tests passed");

	i32::from(total > passed)
}

#[cfg(test)]
mod tests;

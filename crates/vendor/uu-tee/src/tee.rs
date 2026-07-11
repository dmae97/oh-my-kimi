// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{
	ffi::OsString,
	fs::{File, OpenOptions},
	io::{Error, ErrorKind, Read, Result, Write},
};

use uucore::display::Quotable;

mod cli;
pub use crate::cli::uu_app;
use crate::cli::{Options, OutputErrorMode, options};

/// Context-safe in-process entry point. `argv` includes the command name.
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

	let output_error = matches
		.get_one::<String>(options::OUTPUT_ERROR)
		.map(|value| match value.as_str() {
			"warn" => OutputErrorMode::Warn,
			"warn-nopipe" => OutputErrorMode::WarnNoPipe,
			"exit" => OutputErrorMode::Exit,
			"exit-nopipe" => OutputErrorMode::ExitNoPipe,
			_ => unreachable!("clap validates output-error"),
		})
		.or_else(|| {
			matches
				.get_flag(options::IGNORE_PIPE_ERRORS)
				.then_some(OutputErrorMode::WarnNoPipe)
		});
	let files = matches
		.get_many::<OsString>(options::FILE)
		.map(|values| values.cloned().collect())
		.unwrap_or_default();
	let opts = Options { append: matches.get_flag(options::APPEND), files, output_error };

	match tee(&opts) {
		Ok(()) => 0,
		Err(err) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "tee: {err}");
			1
		},
	}
}

fn tee(options: &Options) -> Result<()> {
	// pi-uutils: deliberately do not honor -i by installing a process-global
	// signal handler. The host owns signal policy and cancellation.
	let mut writers = Vec::with_capacity(options.files.len() + 1);
	writers.push(NamedWriter { name: OsString::from("standard output"), inner: Writer::Stdout });
	let mut had_open_errors = false;
	for name in &options.files {
		if name == "-" {
			writers
				.push(NamedWriter { name: OsString::from("standard output"), inner: Writer::Stdout });
			continue;
		}
		match open(name, options.append) {
			Ok(writer) => writers.push(writer),
			Err(err) => {
				let _ = writeln!(pi_uutils_ctx::stderr(), "tee: {}: {err}", name.maybe_quote());
				had_open_errors = true;
				if matches!(
					options.output_error.as_ref(),
					Some(OutputErrorMode::Exit | OutputErrorMode::ExitNoPipe)
				) {
					return Err(err);
				}
			},
		}
	}

	let mut output = MultiWriter::new(writers, options.output_error.clone());
	let copy_result = copy(pi_uutils_ctx::stdin(), &mut output);
	let flush_result = output.flush();
	if had_open_errors || copy_result.is_err() || flush_result.is_err() || output.error_occurred() {
		Err(
			copy_result
				.err()
				.or_else(|| flush_result.err())
				.unwrap_or_else(|| Error::other("output error")),
		)
	} else {
		Ok(())
	}
}

fn copy(mut input: impl Read, mut output: impl Write) -> Result<usize> {
	const FIRST_BUF_SIZE: usize = 8 * 1024;
	let mut buffer = [0_u8; FIRST_BUF_SIZE];
	let mut len = 0;
	loop {
		match input.read(&mut buffer) {
			Ok(0) => return Ok(len),
			Ok(received) => {
				output.write_all(&buffer[..received])?;
				output.flush()?;
				len += received;
			},
			Err(err) if err.kind() == ErrorKind::Interrupted => {},
			Err(err) => {
				let _ = writeln!(pi_uutils_ctx::stderr(), "tee: error reading standard input: {err}");
				return Err(err);
			},
		}
	}
}

fn open(name: &OsString, append: bool) -> Result<NamedWriter> {
	let path = pi_uutils_ctx::resolve(name);
	let mut options = OpenOptions::new();
	if append {
		options.append(true);
	} else {
		options.truncate(true);
	}
	let file = options.write(true).create(true).open(path)?;
	Ok(NamedWriter { inner: Writer::File(file), name: name.clone() })
}

struct MultiWriter {
	writers:           Vec<NamedWriter>,
	output_error_mode: Option<OutputErrorMode>,
	ignored_errors:    usize,
}

impl MultiWriter {
	fn new(writers: Vec<NamedWriter>, output_error_mode: Option<OutputErrorMode>) -> Self {
		Self { writers, output_error_mode, ignored_errors: 0 }
	}

	fn error_occurred(&self) -> bool {
		self.ignored_errors != 0
	}

	fn process(&mut self, flush: bool, buf: &[u8]) -> Result<()> {
		let mode = self.output_error_mode.clone();
		let mut aborted = None;
		let mut errors = 0;
		self.writers.retain_mut(|writer| {
			let result = if flush {
				writer.flush()
			} else {
				writer.write_all(buf)
			};
			match result {
				Ok(()) => true,
				Err(err) => {
					let is_pipe = err.kind() == ErrorKind::BrokenPipe;
					let report =
						matches!(mode.as_ref(), Some(OutputErrorMode::Warn | OutputErrorMode::Exit))
							|| !is_pipe;
					if report {
						let _ =
							writeln!(pi_uutils_ctx::stderr(), "tee: {}: {err}", writer.name.maybe_quote());
						errors += 1;
					}
					let exit = matches!(mode.as_ref(), Some(OutputErrorMode::Exit))
						|| (matches!(mode.as_ref(), Some(OutputErrorMode::ExitNoPipe)) && !is_pipe);
					if exit && aborted.is_none() {
						aborted = Some(err);
					}
					false
				},
			}
		});
		self.ignored_errors += errors;
		if let Some(err) = aborted {
			Err(err)
		} else if self.writers.is_empty() {
			Err(Error::other("all outputs failed"))
		} else {
			Ok(())
		}
	}
}

impl Write for MultiWriter {
	fn write(&mut self, buf: &[u8]) -> Result<usize> {
		self.process(false, buf)?;
		Ok(buf.len())
	}

	fn flush(&mut self) -> Result<()> {
		self.process(true, &[])
	}
}

enum Writer {
	File(File),
	Stdout,
}

impl Write for Writer {
	fn write(&mut self, buf: &[u8]) -> Result<usize> {
		match self {
			Self::File(file) => file.write(buf),
			Self::Stdout => pi_uutils_ctx::stdout().write(buf),
		}
	}

	fn flush(&mut self) -> Result<()> {
		match self {
			Self::File(file) => file.flush(),
			Self::Stdout => pi_uutils_ctx::stdout().flush(),
		}
	}
}

struct NamedWriter {
	inner: Writer,
	name:  OsString,
}

impl Write for NamedWriter {
	fn write(&mut self, buf: &[u8]) -> Result<usize> {
		self.inner.write(buf)
	}

	fn flush(&mut self) -> Result<()> {
		self.inner.flush()
	}
}

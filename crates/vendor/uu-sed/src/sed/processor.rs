// Process the files with the compiled scripts
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{borrow::Cow, cell::RefCell, path::PathBuf, rc::Rc};

use uucore::{
	display::Quotable,
	error::{FromIo, UResult},
};

use crate::sed::{
	command::{
		Address, AppendElement, Command, CommandData, InputAction, ProcessingContext, Transliteration,
	},
	error_handling::{ScriptLocation, input_runtime_error},
	fast_io::{IOChunk, LineReader, OutputBuffer},
	fast_regex::Regex,
	in_place::InPlace,
	named_writer,
};

/// Return the specified command variant or panic.
// Example: let path = extract_variant!(command, Path);
macro_rules! extract_variant {
	($cmd:expr, $variant:ident) => {
		match &$cmd.data {
			CommandData::$variant(inner) => inner,
			_ => panic!(concat!("Expected ", stringify!($variant), " command data")),
		}
	};
}

/// Return true if the passed address matches the current I/O context.
fn match_address(
	addr: &Address,
	reader: &mut LineReader,
	pattern: &mut IOChunk,
	context: &mut ProcessingContext,
	location: &ScriptLocation,
) -> UResult<bool> {
	match addr {
		Address::Re(re) => {
			let regex = re_or_saved_re(re.as_ref(), context, location)?;
			match regex.is_match(pattern) {
				Ok(result) => Ok(result),
				Err(e) => input_runtime_error(location, context, e.to_string()),
			}
		},

		Address::Line(lineno) => Ok(context.line_number == *lineno),

		// Recognize "$" as the last line of last file. This is consistent
		// with the original 7th Research Edition implementation:
		// https://github.com/dspinellis/unix-history-repo/blob/Research-V7/usr/src/cmd/sed/sed1.c#L665
		// The FreeBSD version checked for subsequent empty files, but this
		// can lead to destructive reads (e.g. from named pipes),
		// and is probably an overkill.
		Address::Last => Ok(reader.last_line()? && (context.last_file || context.separate)),

		_ => panic!("invalid address type in match_address"),
	}
}

#[allow(dead_code)]
/// Return true if the command applies to the given pattern.
fn applies(
	command: &mut Command,
	reader: &mut LineReader,
	pattern: &mut IOChunk,
	context: &mut ProcessingContext,
) -> UResult<bool> {
	let linenum = context.line_number;

	let result = if command.addr1.is_none() && command.addr2.is_none() {
		// No address
		Ok(true)
	} else if let Some(addr2) = &command.addr2 {
		// Two addresses
		if let Some(start) = command.start_line {
			// Range is already latched active.
			match addr2 {
				Address::RelLine(n) => {
					if linenum - start > *n {
						command.start_line = None;
						Ok(false)
					} else {
						Ok(true)
					}
				},
				Address::Line(n) => {
					// Special case: already ended
					if linenum > *n {
						command.start_line = None;
						Ok(false)
					} else {
						Ok(true)
					}
				},
				Address::StepMatch(step) => Ok((linenum - start).is_multiple_of(*step)),
				Address::StepEnd(step) => {
					// Inclusive end on multiple of step
					if linenum.is_multiple_of(*step) {
						command.start_line = None;
					}
					Ok(true)
				},
				_ => {
					if match_address(addr2, reader, pattern, context, &command.location)? {
						command.start_line = None;
						context.last_address = true;
					}
					Ok(true)
				},
			}
		} else if let Some(addr1) = &command.addr1 {
			// See if latch must start.
			if match_address(addr1, reader, pattern, context, &command.location)? {
				match addr2 {
					Address::Line(n) if linenum >= *n => {
						context.last_address = true;
					},
					Address::RelLine(n) if *n == 0 => {
						context.last_address = true;
					},
					_ => {
						command.start_line = Some(linenum);
					},
				}
				Ok(true)
			} else {
				Ok(false)
			}
		} else {
			Ok(false)
		}
	} else if let Some(addr1) = &command.addr1 {
		// Single address
		Ok(match_address(addr1, reader, pattern, context, &command.location)?)
	} else {
		// All allowed cases have been covered by the above logic.
		panic!("impossible address combination");
	};

	if command.non_select {
		result.map(|v| !v)
	} else {
		result
	}
}

/// Write the specified chunk to the output for a given processing context.
fn write_chunk(
	output: &mut OutputBuffer,
	context: &ProcessingContext,
	chunk: &IOChunk,
) -> std::io::Result<()> {
	output.write_chunk(chunk)?;

	if context.unbuffered {
		output.flush()?;
	}

	Ok(())
}

/// Return a reference to the current or the saved RE if the RE is None.
/// Update the saved RE to RE.
fn re_or_saved_re<'a>(
	regex: Option<&Regex>,
	context: &'a mut ProcessingContext,
	location: &ScriptLocation,
) -> UResult<&'a Regex> {
	if let Some(re) = regex {
		// First time we see this regex: clone it *once* into the context.
		context.saved_regex = Some(re.clone());
		// Return a reference into context.saved_regex.
		Ok(context.saved_regex.as_ref().unwrap())
	} else if let Some(ref saved_re) = context.saved_regex {
		// We already have one: just borrow it.
		Ok(saved_re)
	} else {
		input_runtime_error(location, context, "no previous regular expression")
	}
}

#[cfg(unix)]
fn shell_command(cmd: &str) -> std::process::Command {
	let mut c = std::process::Command::new("/bin/sh");
	c.arg("-c").arg(cmd);
	// Patched for pi-uutils-ctx embedding: run relative to the shell's cwd,
	// not the host process cwd. `output()` already keeps the child's stdio
	// away from the host's (stdin closed, stdout/stderr captured).
	c.current_dir(pi_uutils_ctx::cwd());
	c
}

#[cfg(windows)]
fn shell_command(cmd: &str) -> std::process::Command {
	let mut c = std::process::Command::new("cmd.exe");
	c.arg("/C").arg(cmd);
	// Patched for pi-uutils-ctx embedding: see the unix variant above.
	c.current_dir(pi_uutils_ctx::cwd());
	c
}

// Fallback if the target OS is neither Windows nor UNIX-like
#[cfg(not(any(unix, windows)))]
fn shell_command(_cmd: &str) -> std::process::Command {
	unimplemented!("the 'e' substitute flag requires a platform shell (/bin/sh or cmd.exe)");
}

/// Perform the specified RE replacement in the provided pattern space.
fn substitute(
	pattern: &mut IOChunk,
	command: &Command,
	context: &mut ProcessingContext,
	output: &mut OutputBuffer,
) -> UResult<()> {
	let sub = extract_variant!(command, Substitution);

	let mut count = 0;
	let mut last_end = 0;
	let mut result = String::new();
	let mut replaced = false;

	let mut text: Option<&str> = None;

	let regex = re_or_saved_re(sub.regex.as_ref(), context, &command.location)?;

	// The following let block allows a common input_runtime_error to be
	// called once in all cases, and most importantly, to finish the regex
	// mutable borrowing of context, so as to reuse context in the error call.
	let subst_result = match (sub.occurrence, sub.replacement.max_group_number) {
		(1, 0) => {
			// Example: s/foo/bar/: find() is enough.
			match regex.find(pattern) {
				Err(e) => Err(e),
				Ok(Some(m)) => {
					text = Some(pattern.as_str()?);
					result.push_str(&text.unwrap()[last_end..m.start()]);

					let replacement = sub.replacement.apply_match(&m);
					result.push_str(&replacement);
					replaced = true;
					last_end = m.end();
					Ok(())
				},
				Ok(None) => Ok(()), // No match
			}
		},

		(1, _) => {
			// Example: s/\(.\)\(.\)/\2\1/: captures() is enough.
			match regex.captures(pattern) {
				Err(e) => Err(e),
				Ok(Some(caps)) => {
					let m = caps.get(0)?.unwrap();
					text = Some(pattern.as_str()?);
					result.push_str(&text.unwrap()[last_end..m.start()]);

					let replacement = sub.replacement.apply_captures(command, &caps)?;
					result.push_str(&replacement);
					replaced = true;
					last_end = m.end();
					Ok(())
				},
				Ok(None) => Ok(()), // No match
			}
		},

		(..) => {
			// Example: s/(.)(.)/\2\1/3: captures_iter() is needed.
			// Iterate over multiple captures of the RE in the pattern.
			'captures: {
				for caps_result in regex.captures_iter(pattern)? {
					let caps = match caps_result {
						Ok(caps) => caps,
						Err(e) => break 'captures Err(e),
					};
					count += 1;

					let m = caps.get(0)?.unwrap();

					// Always write the unmatched text before this match.
					if text.is_none() {
						text = Some(pattern.as_str()?);
					}
					result.push_str(&text.unwrap()[last_end..m.start()]);

					if sub.occurrence == 0 || count == sub.occurrence {
						let replacement = sub.replacement.apply_captures(command, &caps)?;
						result.push_str(&replacement);
						replaced = true;
					} else {
						// Not the target match — leave the match unchanged.
						result.push_str(m.as_str());
					}

					last_end = m.end();

					// Early exit if only a specific occurrence,
					// (likely 1) needed replacing.
					if count == sub.occurrence {
						break 'captures Ok(());
					}
				}
				break 'captures Ok(());
			}
		},
	};

	// Handle errors.
	if let Err(e) = subst_result {
		return input_runtime_error(&command.location, context, e.to_string());
	}

	// Handle substitution success.
	if replaced {
		result.push_str(&text.unwrap()[last_end..]);

		pattern.set_to_string(result, pattern.is_newline_terminated());

		// Execute the pattern space as a shell command if the 'e' flag is set
		if sub.execute {
			let cmd_str = pattern.as_str()?.to_string();
			let output_bytes = shell_command(&cmd_str).output().map_err(|e| {
				input_runtime_error::<()>(
					&command.location,
					context,
					format!("failed to execute shell command: {e}"),
				)
				.unwrap_err()
			})?;
			let mut shell_out = String::from_utf8_lossy(&output_bytes.stdout).into_owned();
			if shell_out.ends_with("\r\n") {
				// On windows, both return carriage and newline characters are used
				shell_out.truncate(shell_out.len() - 2);
			} else if shell_out.ends_with('\n') {
				// Strip the trailing newline, as GNU sed does
				shell_out.pop();
			}
			pattern.set_to_string(shell_out, pattern.is_newline_terminated());
		}

		if sub.print_flag {
			write_chunk(output, context, pattern)?;
		}

		// Write to file if needed.
		if let Some(ref writer) = sub.write_file {
			writer.borrow_mut().write_line(pattern.as_str()?)?;
		}
		context.substitution_made = true;
	}

	Ok(())
}

/// Apply the specified transliteration in the provided pattern space.
fn transliterate(pattern: &mut IOChunk, trans: &Transliteration) -> UResult<()> {
	let text = pattern.as_str()?;
	let mut result = String::with_capacity(text.len());
	let mut replaced = false;

	// Perform the transliteration.
	for ch in text.chars() {
		let mapped = trans.lookup(ch);
		if mapped != ch {
			replaced = true;
		}
		result.push(mapped);
	}

	// Lazy replace.
	if replaced {
		pattern.set_to_string(result, pattern.is_newline_terminated());
	}

	Ok(())
}

/// Output any data queued for output at the end of the cycle.
fn flush_appends(output: &mut OutputBuffer, context: &mut ProcessingContext) -> UResult<()> {
	for elem in &context.append_elements {
		match elem {
			AppendElement::Text(text) => {
				output.write_str(&**text)?;
			},
			AppendElement::Path(path) => {
				output.copy_file(path)?;
			},
		}
	}
	context.append_elements.clear();
	Ok(())
}

/// List the passed pattern space in unambiguous form.
fn list(output: &mut OutputBuffer, line: &IOChunk, max_width: usize) -> UResult<()> {
	// Special case for an empty pattern space
	if line.is_empty() {
		if line.is_newline_terminated() {
			output.write_str("$\n")?;
		}
		return Ok(());
	}

	let line = line.as_str()?;
	let mut buff = String::new();
	let mut line_width = 0;

	for ch in line.chars() {
		if ch == '\n' {
			buff.push_str("$\n");
			output.write_str(&buff)?;
			line_width = 0;
			continue;
		}

		let mut char_buff = [0u8; 1];
		let out_str: Cow<str> = match ch {
			'\x07' => Cow::Borrowed(r"\a"),
			'\x08' => Cow::Borrowed(r"\b"),
			'\x0b' => Cow::Borrowed(r"\v"),
			'\x0c' => Cow::Borrowed(r"\f"),
			'\\' => Cow::Borrowed(r"\\"),
			'\r' => Cow::Borrowed(r"\r"),
			'\t' => Cow::Borrowed(r"\t"),
			c if c.is_ascii_control() => Cow::Owned(format!("\\{:03o}", ch as u8)),
			c if c == ' ' || c.is_ascii_graphic() => Cow::Borrowed(ch.encode_utf8(&mut char_buff)),
			c if (c as u32) <= 0xffff => Cow::Owned(format!("\\u{:04X}", c as u32)),
			_ => Cow::Owned(format!("\\U{:08X}", ch as u32)),
		};

		// See if folding is required before adding out_str and terminator.
		let out_len = out_str.len();
		if line_width + out_len + 1 > max_width {
			buff.push_str("\\\n");
			output.write_str(&buff)?;
			line_width = 0;
			buff.clear();
		}
		buff.push_str(out_str.as_ref());
		line_width += out_len;
	}

	if !buff.is_empty() {
		buff.push_str("$\n");
		output.write_str(buff)?;
	}
	Ok(())
}

/// Handle address 0 read at the beginning of each file.
fn process_address_0(
	commands: Option<Rc<RefCell<Command>>>,
	output: &mut OutputBuffer,
) -> UResult<()> {
	// Prescan for zero-address which must produce output
	// before any input line is read.
	{
		let mut current = commands;
		while let Some(cmd_rc) = current {
			let next = {
				let cmd = cmd_rc.borrow();

				if cmd.code == 'r' && matches!(cmd.addr1, Some(Address::Line(0))) && cmd.addr2.is_none()
				{
					let path = extract_variant!(cmd, Path);
					output.copy_file(path)?;
				}

				cmd.next.clone()
			};
			current = next;
		}
	}
	Ok(())
}

#[allow(clippy::cognitive_complexity)]
/// Process a single input file
fn process_file(
	commands: Option<Rc<RefCell<Command>>>,
	reader: &mut LineReader,
	output: &mut OutputBuffer,
	context: &mut ProcessingContext,
) -> UResult<()> {
	process_address_0(commands.clone(), output)?;

	// Loop over the input lines as pattern space.
	'lines: while let Some(mut pattern) = reader.get_line()? {
		// Patched for pi-uutils-ctx embedding: mmap-backed input never
		// touches the (cancel-aware) stdin reader, so poll the host cancel
		// flag here to keep long file runs abortable.
		if pi_uutils_ctx::is_cancelled() {
			break;
		}
		context.line_number += 1;
		context.substitution_made = false;
		// Set the script command from which to start.
		let mut current: Option<Rc<RefCell<Command>>> =
			if let Some(action) = context.input_action.take() {
				// Continue processing the `N` command.
				let current_line = pattern.as_str()?;
				let mut combined_lines = action.prepend;
				combined_lines.push('\n');
				combined_lines.push_str(current_line);

				pattern.set_to_string(combined_lines, pattern.is_newline_terminated());
				action.next_command
			} else {
				// Start from the script top.
				commands.clone()
			};

		// Loop over script commands.
		while let Some(command_rc) = current.take() {
			let mut command = command_rc.borrow_mut();

			if !applies(&mut command, reader, &mut pattern, context)? {
				// Advance to next command
				current.clone_from(&command.next);
				continue;
			}

			match command.code {
				'{' => {
					// Block begin; start processing the enclosed ones.
					let body = extract_variant!(command, BranchTarget);
					current.clone_from(body);
					continue;
				},
				'}' => {
					// Block end: continue with the block's patched next.
				},
				'a' => {
					// Write the text to standard output at a later point.
					let text = extract_variant!(command, Text);
					context
						.append_elements
						.push(AppendElement::Text(text.clone()));
				},
				'b' => {
					// Branch to the specified label or end if none is given.
					let target = extract_variant!(command, BranchTarget);
					if target.is_some() {
						// New command to execute
						current.clone_from(target);
						continue;
					}
					// Branch to the end of the script.
					break;
				},
				'c' => {
					// At range end replace pattern space with text and
					// start the next cycle.
					pattern.clear();
					if command.addr2.is_none() || context.last_address || reader.last_line()? {
						let text = extract_variant!(command, Text);
						output.write_str(text.as_ref())?;
					}
					break;
				},
				'd' => {
					// Delete the pattern space and start the next cycle.
					pattern.clear();
					break;
				},
				'D' => {
					// Delete up to \n and start a new cycle without new input.
					if let Some(pos) = pattern.as_str()?.find('\n') {
						let (s, _) = pattern.fields_mut()?;
						s.drain(..=pos);
						current.clone_from(&commands);
						continue;
					}
					// Same as d
					pattern.clear();
					break;
				},
				'g' => {
					// Replace pattern with the contents of the hold space.
					pattern.set_to_string(context.hold.content.clone(), context.hold.has_newline);
				},
				'G' => {
					// Append to pattern \n followed by hold space contents.
					let (pat_content, pat_has_newline) = pattern.fields_mut()?;
					pat_content.push('\n');
					pat_content.push_str(&context.hold.content);
					*pat_has_newline = context.hold.has_newline;
				},
				'h' => {
					// Replace hold with the contents of the pattern space.
					context.hold.content = pattern.as_str()?.to_string();
					context.hold.has_newline = pattern.is_newline_terminated();
				},
				'H' => {
					// Append to hold \n followed by pattern space contents.
					context.hold.content.push('\n');
					context.hold.content.push_str(pattern.as_str()?);
					context.hold.has_newline = pattern.is_newline_terminated();
				},
				'i' => {
					// Write text to standard output.
					let text = extract_variant!(command, Text);
					output.write_str(text.as_ref())?;
				},
				'l' => {
					let width = *extract_variant!(command, Number);
					list(output, &pattern, width)?;
				},
				'n' => {
					break;
				},
				'N' => {
					flush_appends(output, context)?;
					// Append to pattern `\n` and the next line
					// Rather than reading input here, which would result
					// in a double borrow on reader, modify the action
					// to perform when the next line is read.
					context.input_action = Some(InputAction {
						next_command: command.next.clone(),
						prepend:      pattern.as_str()?.to_string(),
					});
					continue 'lines;
				},
				'p' => {
					write_chunk(output, context, &pattern)?;
				},
				'P' => {
					let line = pattern.as_str()?;
					if let Some(pos) = line.find('\n') {
						output.write_str(&line[..=pos])?;
					} else {
						write_chunk(output, context, &pattern)?;
					}
				},
				'q' => {
					// Quit after printing the pattern space.
					pi_uutils_ctx::set_exit_code(*extract_variant!(command, Number) as i32);
					context.stop_processing = true;
					break;
				},
				'Q' => {
					// Quit immediatelly.
					pi_uutils_ctx::set_exit_code(*extract_variant!(command, Number) as i32);
					context.stop_processing = true;
					context.quiet = true;
					break;
				},
				'r' => {
					// Copy the file to standard output at a later point.
					let path = extract_variant!(command, Path);
					context
						.append_elements
						.push(AppendElement::Path(path.clone()));
				},
				's' => {
					substitute(&mut pattern, &command, context, output)?;
				},
				't' if !context.substitution_made => { /* Do nothing. */ },
				't' => {
					// Branch to the specified label or end if none is given
					// if a substitution was made since last cycle or t.
					let target = extract_variant!(command, BranchTarget);
					context.substitution_made = false;
					if target.is_some() {
						// New command to execute
						current.clone_from(target);
						continue;
					}
					// Branch to the end of the script.
					break;
				},
				'w' => {
					// Append the pattern space to the specified file.
					let writer = extract_variant!(command, NamedWriter);
					writer.borrow_mut().write_line(pattern.as_str()?)?;
				},
				'x' => {
					// Exchange the contents of the pattern and hold spaces.
					let (pat_content, pat_has_newline) = pattern.fields_mut()?;

					// Swap newline if hold space is logically non-empty.
					if !context.hold.content.is_empty() || context.hold.has_newline {
						std::mem::swap(pat_has_newline, &mut context.hold.has_newline);
					}
					std::mem::swap(pat_content, &mut context.hold.content);
				},
				'y' => {
					let trans = extract_variant!(command, Transliteration);
					transliterate(&mut pattern, trans)?;
				},
				'z' => {
					// Clear the pattern contents, but preserve newline state
					// so automatic printing still emits an empty record.
					let (pat_content, _) = pattern.fields_mut()?;
					pat_content.clear();
				},
				':' => {
					// Branch target; do nothing.
				},
				'=' => {
					// Output current line number.
					output.write_str(format!("{}\n", context.line_number))?;
				},
				// The compilation should supply only valid codes.
				_ => panic!("invalid command code"),
			} // match
			// Advance to next command.
			current.clone_from(&command.next);
		}

		if !context.quiet {
			write_chunk(output, context, &pattern)?;
		}

		flush_appends(output, context)?;

		if context.stop_processing {
			output.flush_pending_newline()?;
			break;
		}
	}

	// Handle any N command remains.
	if context.separate
		&& !context.quiet
		&& let Some(action) = context.input_action.take()
	{
		let mut pending = action.prepend;
		pending.push('\n');
		output.write_str(pending)?;
		if context.unbuffered {
			output.flush()?;
		}
	}

	Ok(())
}

/// Mark all address ranges non-active (and 0-starting ones as active).
fn reset_latched_address_ranges(range_commands: &mut [Rc<RefCell<Command>>]) {
	for cmd_rc in range_commands.iter() {
		let mut cmd = cmd_rc.borrow_mut();

		cmd.start_line =
            // Check for address-spec line 0 pre-latch extension.
            if let Some(addr1) = &cmd.addr1 && matches!(addr1, Address::Line(0)) {
                Some(0)
            } else {
                None
            };
	}
}

/// Process all input files
pub fn process_all_files(
	commands: Option<Rc<RefCell<Command>>>,
	files: Vec<PathBuf>,
	context: &mut ProcessingContext,
) -> UResult<()> {
	// Patched for pi-uutils-ctx embedding: the context streams are never a
	// terminal, so upstream's stdout-tty check for auto-unbuffered output is
	// dropped; `-u` alone controls flushing.

	let mut in_place = InPlace::new(context.clone());
	let last_file_index = files.len() - 1;

	for (index, path) in files.iter().enumerate() {
		context.last_file = index == last_file_index;
		let mut reader = LineReader::open(path)
			.map_err_context(|| format!("error opening input file {}", path.quote()))?;
		let output = in_place.begin(path)?;

		if context.separate || index == 0 {
			context.line_number = 0;
			reset_latched_address_ranges(&mut context.range_commands);

			// Reset hold space for separate file processing
			context.hold.content.clear();
			context.hold.has_newline = true;
		}

		context.input_name = path.quote().to_string();
		process_file(commands.clone(), &mut reader, output, context)?;

		// Handle any N command remains.
		if context.last_file
			&& !context.separate
			&& !context.quiet
			&& let Some(action) = context.input_action.take()
		{
			let mut pending = action.prepend;
			pending.push('\n');
			output.write_str(pending)?;
		}

		in_place.end()?;

		if context.stop_processing {
			break;
		}
	}

	// Flush all output files
	named_writer::flush_all()?;

	Ok(())
}

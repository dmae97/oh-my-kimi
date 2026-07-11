//! Provide the script contents line by line
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 Diomidis Spinellis
//
// This file is part of the uutils sed package.
// It is licensed under the MIT License.
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{
	fmt,
	fs::File,
	io::{BufRead, BufReader},
	path::PathBuf,
};

use uucore::{
	display::Quotable,
	error::{FromIo, UResult},
};

#[derive(Debug, PartialEq)]
/// The specification of a script: through a string or a file
pub enum ScriptValue {
	StringVal(String),
	PathVal(PathBuf),
}

#[derive(Debug)]
/// The provider of script lines across all specified scripts
/// Scripts can be specified to sed as files or as strings.
pub struct ScriptLineProvider {
	sources: Vec<ScriptValue>,
	state:   State,
}

/// Encapsulation of the script line provider's state
enum State {
	NotStarted, // Processing has not yet started
	Active {
		index:       usize,
		reader:      Box<dyn BufRead>, // Object on which read_line is called
		input_name:  String,           // Input description (path or script string)
		line_number: usize,            // Current line number
	},
	Done, // All scripts have been processed
}

impl ScriptLineProvider {
	/// Construct the script provider from the specified script sources
	pub fn new(sources: Vec<ScriptValue>) -> Self {
		Self { sources, state: State::NotStarted }
	}

	/// Return the currently processed script line number.
	pub fn get_line_number(&self) -> usize {
		match &self.state {
			State::Active { line_number, .. } => *line_number,
			_ => 0,
		}
	}

	/// Return the currently processed script descriptive name.
	pub fn get_input_name(&self) -> &str {
		match &self.state {
			State::Active { input_name, .. } => input_name.as_str(),
			_ => "",
		}
	}

	/// Return the next script line to process across all scripts.
	pub fn next_line(&mut self) -> UResult<Option<String>> {
		let mut line = String::new();

		loop {
			let advance = match &mut self.state {
				State::NotStarted => Some(0),
				State::Active { index, reader, line_number, .. } => {
					line.clear();
					let bytes = reader.read_line(&mut line)?;
					if bytes == 0 {
						Some(*index + 1) // finished reading this source
					} else {
						*line_number += 1;
						// Remove trailing newline
						if line.ends_with('\n') {
							line.pop();
						}
						return Ok(Some(line));
					}
				},
				State::Done => {
					return Ok(None);
				},
			};

			if let Some(next_index) = advance {
				self.advance_source(next_index)?;
			}
		}
	}

	// Move to the next available script source.
	fn advance_source(&mut self, next_index: usize) -> UResult<()> {
		if next_index >= self.sources.len() {
			self.state = State::Done;
			return Ok(());
		}

		match &self.sources[next_index] {
			ScriptValue::StringVal(s) => {
				let cursor = std::io::Cursor::new(s.clone());
				self.state = State::Active {
					index:       next_index,
					reader:      Box::new(BufReader::new(cursor)),
					input_name:  format!("<script argument {}>", next_index + 1),
					line_number: 0,
				};
			},
			ScriptValue::PathVal(p) => {
				if p.to_string_lossy() == "-" {
					self.state = State::Active {
						index:       next_index,
						reader:      Box::new(BufReader::new(pi_uutils_ctx::stdin())),
						input_name:  "<stdin>".to_string(),
						line_number: 0,
					};
				} else {
					// Patched for pi-uutils-ctx embedding: resolve `-f`
					// script files against the shell working directory.
					let file = File::open(pi_uutils_ctx::resolve(p))
						.map_err_context(|| format!("error opening script file {}", p.quote()))?;
					self.state = State::Active {
						index:       next_index,
						reader:      Box::new(BufReader::new(file)),
						input_name:  p.to_string_lossy().to_string(),
						line_number: 0,
					};
				}
			},
		}

		Ok(())
	}
}

impl fmt::Debug for State {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			State::NotStarted => f.debug_struct("NotStarted").finish(),
			State::Done => f.debug_struct("Done").finish(),
			State::Active { index, input_name, line_number, .. } => f
				.debug_struct("Active")
				.field("index", index)
				.field("input_name", input_name)
				.field("line_number", line_number)
				.field("reader", &"<BufRead>")
				.finish(),
		}
	}
}

#[cfg(test)]
impl ScriptLineProvider {
	pub fn with_active_state(input_name: &str, line_number: usize) -> Self {
		Self {
			sources: vec![],
			state:   State::Active {
				input_name: input_name.to_string(),
				line_number,
				index: 0,
				reader: Box::new(BufReader::new(pi_uutils_ctx::stdin())),
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use std::io::Write;

	use tempfile::NamedTempFile;

	use super::*;

	#[test]
	fn test_string_source() {
		let input = vec![
			ScriptValue::StringVal("line one\nline two\n".to_string()),
			ScriptValue::StringVal("line three".to_string()),
		];
		let mut provider = ScriptLineProvider::new(input);

		let mut lines = Vec::new();
		while let Some(line) = provider.next_line().unwrap() {
			lines.push(line.trim_end().to_string());
		}

		assert_eq!(lines, vec!["line one", "line two", "line three"]);
	}

	#[test]
	fn test_file_source() {
		let mut temp_file = NamedTempFile::new().unwrap();
		writeln!(temp_file, "file line 1").unwrap();
		writeln!(temp_file, "file line 2").unwrap();

		let input = vec![ScriptValue::PathVal(temp_file.path().to_path_buf())];
		let mut provider = ScriptLineProvider::new(input);

		let mut lines = Vec::new();
		while let Some(line) = provider.next_line().unwrap() {
			lines.push(line.trim_end().to_string());
		}

		assert_eq!(lines, vec!["file line 1", "file line 2"]);
	}

	#[test]
	fn test_mixed_source() {
		let mut temp_file = NamedTempFile::new().unwrap();
		writeln!(temp_file, "file line 1").unwrap();
		writeln!(temp_file, "file line 2").unwrap();
		let temp_file2 = NamedTempFile::new().unwrap();

		let input = vec![
			ScriptValue::PathVal(temp_file.path().to_path_buf()),
			ScriptValue::StringVal("script line 1".to_string()),
			ScriptValue::PathVal(temp_file.path().to_path_buf()),
			ScriptValue::StringVal(String::new()),
			ScriptValue::PathVal(temp_file2.path().to_path_buf()),
			ScriptValue::StringVal("other script line 1".to_string()),
		];
		let mut provider = ScriptLineProvider::new(input);

		let mut lines = Vec::new();
		while let Some(line) = provider.next_line().unwrap() {
			lines.push(line.trim_end().to_string());
		}

		assert_eq!(lines, vec![
			"file line 1",
			"file line 2",
			"script line 1",
			"file line 1",
			"file line 2",
			"other script line 1",
		]);
	}

	#[test]
	fn test_getters() {
		let input = vec![
			ScriptValue::StringVal("l1\nl2\n".to_string()),
			ScriptValue::StringVal("l3".to_string()),
		];
		let mut provider = ScriptLineProvider::new(input);

		if let Some(line) = provider.next_line().unwrap() {
			assert_eq!(line.trim(), "l1");
			assert_eq!(provider.get_line_number(), 1);
			assert_eq!(provider.get_input_name(), "<script argument 1>");
		} else {
			panic!("Expected a line");
		}

		if let Some(line) = provider.next_line().unwrap() {
			assert_eq!(line.trim(), "l2");
			assert_eq!(provider.get_line_number(), 2);
			assert_eq!(provider.get_input_name(), "<script argument 1>");
		} else {
			panic!("Expected a line");
		}

		if let Some(line) = provider.next_line().unwrap() {
			assert_eq!(line.trim(), "l3");
			assert_eq!(provider.get_line_number(), 1);
			assert_eq!(provider.get_input_name(), "<script argument 2>");
		} else {
			panic!("Expected a line");
		}
	}
}

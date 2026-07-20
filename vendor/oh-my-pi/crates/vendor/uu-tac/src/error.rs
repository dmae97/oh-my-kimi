// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.
//! Errors returned by tac during processing of a file.

// pi-uutils: vendored from uutils/coreutils 0.8.0; `translate!` strings are
// literalized with the en-US locale text.

use std::ffi::OsString;

use thiserror::Error;
use uucore::{
	display::Quotable,
	error::{UError, strip_errno},
};

#[derive(Debug, Error)]
pub enum TacError {
	/// A regular expression given by the user is invalid.
	#[error("invalid regular expression: {0}")]
	InvalidRegex(regex::Error),
	/// An error opening a file for reading.
	///
	/// The parameters are the name of the file and the underlying
	/// [`std::io::Error`] that caused this error.
	#[error("failed to open {} for reading: {}", .0.quote(), strip_errno(.1))]
	OpenError(OsString, std::io::Error),
	/// An error reading the contents of a file or stdin.
	///
	/// The parameters are the name of the file and the underlying
	/// [`std::io::Error`] that caused this error.
	#[error("{}: read error: {}", .0.maybe_quote(), strip_errno(.1))]
	ReadError(OsString, std::io::Error),
	/// An error writing the (reversed) contents of a file or stdin.
	///
	/// The parameter is the underlying [`std::io::Error`] that caused
	/// this error.
	#[error("failed to write to stdout: {}", strip_errno(.0))]
	WriteError(std::io::Error),
}

impl UError for TacError {
	fn code(&self) -> i32 {
		1
	}
}

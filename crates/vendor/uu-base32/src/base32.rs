// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

pub mod base_common;

use std::{ffi::OsString, io::Write};

use clap::Command;
use uucore::encoding::Format;

/// pi-uutils: safe in-process entry point using invocation-scoped streams.
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
	let result = base_common::Config::from(&matches).and_then(|config| {
		let mut input = base_common::get_input(&config)?;
		base_common::handle_input(&mut input, Format::Base32, config)
	});
	match result {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let _ = writeln!(pi_uutils_ctx::stderr(), "base32: {err}");
			if code == 0 { 1 } else { code }
		},
	}
}

pub fn uu_app() -> Command {
	base_common::base_app(
		"encode/decode data and print to standard output\nWith no FILE, or when FILE is -, read \
		 standard input.\n\nThe data are encoded as described for the base32 alphabet in RFC \
		 4648.\nWhen decoding, the input may contain newlines in addition to the bytes of the \
		 formal base32 alphabet. Use --ignore-garbage to attempt to recover from any other \
		 non-alphabet bytes in the encoded stream."
			.into(),
		"base32 [OPTION]... [FILE]".into(),
	)
	.name("base32")
}

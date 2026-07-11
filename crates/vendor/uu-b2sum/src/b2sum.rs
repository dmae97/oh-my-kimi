// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) algo

// pi-uutils: Patched for in-process embedding via the shared
// `uu-checksum-common` crate, which redirects all standard stream I/O and file
// resolution through `pi-uutils-ctx`.

use std::ffi::OsString;

use clap::Command;
use uucore::checksum::{AlgoKind, BlakeLength, parse_blake_length};

pub fn run(argv: Vec<OsString>) -> i32 {
	let calculate_blake2b_length =
		|s: &str| parse_blake_length(AlgoKind::Blake2b, BlakeLength::String(s));
	uu_checksum_common::run_standalone_with_length(
		"b2sum",
		AlgoKind::Blake2b,
		uu_app(),
		argv,
		calculate_blake2b_length,
	)
}

#[inline]
pub fn uu_app() -> Command {
	uu_checksum_common::standalone_checksum_app_with_length(
		"Print or check BLAKE2b (512-bit) checksums.",
		"b2sum [OPTION]... [FILE]...",
	)
	.name("b2sum")
}

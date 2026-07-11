// Copyright 2021 Collabora, Ltd.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

//! Vendored, patched `xargs` from uutils/findutils, wired to run in-process as
//! a brush shell builtin via [`pi_uutils_ctx`].
//!
//! Upstream: <https://github.com/uutils/findutils>, tag `0.8.0`,
//! commit `b94b5f0122b918e33de59776f264761fec5fa94a`.

pub mod xargs;

/// In-process builtin entry point. The host installs a [`pi_uutils_ctx`] scope
/// (stdio + working directory + environment) on a dedicated blocking thread,
/// then calls this.
///
/// Unlike findutils' real `main` (which `std::process::exit`s on the result of
/// `xargs_main`), this returns the exit code so it is safe to run inside the
/// long-lived host shell process. Items are read from the context stdin,
/// output is routed through the context streams, `-a` operands resolve
/// against the shell working dir, and child processes run in the shell
/// working dir with the shell's exported environment and captured stdio.
pub fn run(argv: Vec<std::ffi::OsString>) -> i32 {
	// findutils' `xargs_main` is fundamentally `&[&str]`-based — upstream's
	// real `main` builds it straight from `std::env::args()`, so lossy UTF-8
	// conversion matches the existing upstream behavior for arguments.
	let args: Vec<String> = argv
		.iter()
		.map(|a| a.to_string_lossy().into_owned())
		.collect();
	let mut strs: Vec<&str> = args.iter().map(String::as_str).collect();
	// `xargs_main` treats argv[0] as the program name and skips it. The host
	// always supplies it; guard against an empty argv to avoid an index panic.
	if strs.is_empty() {
		strs.push("xargs");
	}
	xargs::xargs_main(&strs)
}

#[cfg(test)]
mod tests;

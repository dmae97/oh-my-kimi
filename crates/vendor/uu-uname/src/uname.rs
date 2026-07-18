// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (API) nodename osname sysname (options) mnrsv mnrsvo

// pi-uutils: vendored from uutils/coreutils 0.8.0 and patched to run in-process
// as a shell builtin. Output goes to the context stdout (upstream's
// `println_verbatim` writes to the process stdout), `translate!` strings are
// literalized, and the entry point no longer calls `std::process::exit`.

use std::{
	ffi::{OsStr, OsString},
	io::Write,
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use pi_uutils_ctx::format_usage;
use platform_info::{PlatformInfo, PlatformInfoAPI, UNameAPI};
use uucore::error::{UResult, USimpleError};

pub mod options {
	pub static ALL: &str = "all";
	pub static KERNEL_NAME: &str = "kernel-name";
	pub static NODENAME: &str = "nodename";
	pub static KERNEL_VERSION: &str = "kernel-version";
	pub static KERNEL_RELEASE: &str = "kernel-release";
	pub static MACHINE: &str = "machine";
	pub static PROCESSOR: &str = "processor";
	pub static HARDWARE_PLATFORM: &str = "hardware-platform";
	pub static OS: &str = "operating-system";
}

pub struct UNameOutput {
	pub kernel_name:       Option<OsString>,
	pub nodename:          Option<OsString>,
	pub kernel_release:    Option<OsString>,
	pub kernel_version:    Option<OsString>,
	pub machine:           Option<OsString>,
	pub os:                Option<OsString>,
	pub processor:         Option<OsString>,
	pub hardware_platform: Option<OsString>,
}

impl UNameOutput {
	fn display(&self) -> OsString {
		[
			self.kernel_name.as_ref(),
			self.nodename.as_ref(),
			self.kernel_release.as_ref(),
			self.kernel_version.as_ref(),
			self.machine.as_ref(),
			self.processor.as_ref(),
			self.hardware_platform.as_ref(),
			self.os.as_ref(),
		]
		.into_iter()
		.flatten()
		.map(OsString::as_os_str)
		.collect::<Vec<_>>()
		.join(OsStr::new(" "))
	}

	pub fn new(opts: &Options) -> UResult<Self> {
		let uname = PlatformInfo::new()
			.map_err(|_e| USimpleError::new(1, "cannot get system name".to_string()))?;
		let none = !(opts.all
			|| opts.kernel_name
			|| opts.nodename
			|| opts.kernel_release
			|| opts.kernel_version
			|| opts.machine
			|| opts.os
			|| opts.processor
			|| opts.hardware_platform);

		let kernel_name = (opts.kernel_name || opts.all || none).then(|| uname.sysname().to_owned());

		let nodename = (opts.nodename || opts.all).then(|| uname.nodename().to_owned());

		let kernel_release = (opts.kernel_release || opts.all).then(|| uname.release().to_owned());

		let kernel_version = (opts.kernel_version || opts.all).then(|| uname.version().to_owned());

		let machine = (opts.machine || opts.all).then(|| uname.machine().to_owned());

		let os = (opts.os || opts.all).then(|| uname.osname().to_owned());

		// This option is unsupported on modern Linux systems
		// See: https://lists.gnu.org/archive/html/bug-coreutils/2005-09/msg00063.html
		let processor = opts.processor.then(|| "unknown".into());

		// This option is unsupported on modern Linux systems
		// See: https://lists.gnu.org/archive/html/bug-coreutils/2005-09/msg00063.html
		let hardware_platform = opts.hardware_platform.then(|| "unknown".into());

		Ok(Self {
			kernel_name,
			nodename,
			kernel_release,
			kernel_version,
			machine,
			os,
			processor,
			hardware_platform,
		})
	}
}

pub struct Options {
	pub all:               bool,
	pub kernel_name:       bool,
	pub nodename:          bool,
	pub kernel_version:    bool,
	pub kernel_release:    bool,
	pub machine:           bool,
	pub processor:         bool,
	pub hardware_platform: bool,
	pub os:                bool,
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
	match uname_main(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let msg = err.to_string();
			if !msg.is_empty() {
				let _ = writeln!(pi_uutils_ctx::stderr(), "uname: {msg}");
			}
			if code == 0 { 1 } else { code }
		},
	}
}

fn uname_main(matches: &ArgMatches) -> UResult<()> {
	let options = Options {
		all:               matches.get_flag(options::ALL),
		kernel_name:       matches.get_flag(options::KERNEL_NAME),
		nodename:          matches.get_flag(options::NODENAME),
		kernel_release:    matches.get_flag(options::KERNEL_RELEASE),
		kernel_version:    matches.get_flag(options::KERNEL_VERSION),
		machine:           matches.get_flag(options::MACHINE),
		processor:         matches.get_flag(options::PROCESSOR),
		hardware_platform: matches.get_flag(options::HARDWARE_PLATFORM),
		os:                matches.get_flag(options::OS),
	};
	let output = UNameOutput::new(&options)?;
	// pi-uutils: replacement for upstream's `println_verbatim` — writes the
	// output bytes verbatim to the context stdout instead of the process
	// stdout.
	let mut out = pi_uutils_ctx::stdout();
	out.write_all(uucore::os_str_as_bytes(output.display().as_os_str())?)
		.and_then(|()| out.write_all(b"\n"))
		.and_then(|()| out.flush())
		.map_err(|e| USimpleError::new(1, e.to_string()))?;
	Ok(())
}

pub fn uu_app() -> Command {
	Command::new("uname")
		.version(uucore::crate_version!())
		.about("Print certain system information.\nWith no OPTION, same as -s.")
		.override_usage(format_usage("uname [OPTION]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(options::ALL)
				.short('a')
				.long(options::ALL)
				.help("Behave as though all of the options -mnrsvo were specified.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::KERNEL_NAME)
				.short('s')
				.long(options::KERNEL_NAME)
				.alias("sysname") // Obsolescent option in GNU uname
				.help("print the kernel name.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NODENAME)
				.short('n')
				.long(options::NODENAME)
				.help(
					"print the nodename (the nodename may be a name that the system is known by to a \
					 communications network).",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::KERNEL_RELEASE)
				.short('r')
				.long(options::KERNEL_RELEASE)
				.alias("release") // Obsolescent option in GNU uname
				.help("print the operating system release.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::KERNEL_VERSION)
				.short('v')
				.long(options::KERNEL_VERSION)
				.help("print the operating system version.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::MACHINE)
				.short('m')
				.long(options::MACHINE)
				.help("print the machine hardware name.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::OS)
				.short('o')
				.long(options::OS)
				.help("print the operating system name.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::PROCESSOR)
				.short('p')
				.long(options::PROCESSOR)
				.help("print the processor type (non-portable)")
				.action(ArgAction::SetTrue)
				.hide(true),
		)
		.arg(
			Arg::new(options::HARDWARE_PLATFORM)
				.short('i')
				.long(options::HARDWARE_PLATFORM)
				.help("print the hardware platform (non-portable)")
				.action(ArgAction::SetTrue)
				.hide(true),
		)
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, io::Write, path::PathBuf, sync::Arc};

	use parking_lot::Mutex;
	use pi_uutils_ctx::ScopeIo;

	use super::*;

	fn run_in(args: Vec<&str>) -> (i32, String, String) {
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
			stdin:                 Box::new(std::io::empty()),
			stdin_fd:              None,
			stdin_is_search_input: false,
			stdout:                Box::new(SharedWriter { buf: stdout_buf.clone() }),
			stderr:                Box::new(SharedWriter { buf: stderr_buf.clone() }),
			cwd:                   PathBuf::from("."),
			env:                   HashMap::new(),
			cancel:                Arc::new(std::sync::atomic::AtomicBool::new(false)),
		};

		let argv: Vec<OsString> = std::iter::once("uname")
			.chain(args)
			.map(OsString::from)
			.collect();

		let code = pi_uutils_ctx::scope(io, || run(argv));

		let out_str = String::from_utf8(stdout_buf.lock().clone()).unwrap();
		let err_str = String::from_utf8(stderr_buf.lock().clone()).unwrap();

		(code, out_str, err_str)
	}

	#[test]
	fn kernel_name_matches_platform() {
		let (code, stdout, stderr) = run_in(vec!["-s"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		#[cfg(target_os = "macos")]
		assert_eq!(stdout, "Darwin\n");
		#[cfg(target_os = "linux")]
		assert_eq!(stdout, "Linux\n");
		#[cfg(not(any(target_os = "macos", target_os = "linux")))]
		assert!(stdout.trim_end().len() > 0);
	}

	#[test]
	fn no_options_defaults_to_kernel_name() {
		let (code, bare, _) = run_in(vec![]);
		let (_, with_s, _) = run_in(vec!["-s"]);
		assert_eq!(code, 0);
		assert_eq!(bare, with_s);
	}

	#[test]
	fn all_contains_kernel_name_and_more() {
		let (code, all, stderr) = run_in(vec!["-a"]);
		let (_, kernel, _) = run_in(vec!["-s"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		let kernel = kernel.trim_end();
		assert!(all.starts_with(kernel), "-a output {all:?} must start with {kernel:?}");
		assert!(all.trim_end().len() > kernel.len(), "-a must print more fields than -s");
	}

	#[test]
	fn processor_prints_unknown() {
		let (code, stdout, stderr) = run_in(vec!["-p"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "unknown\n", ""));
	}
}

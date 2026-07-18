// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore hashset Addrs addrs

// pi-uutils: vendored from uutils/coreutils 0.8.0 and patched to run in-process
// as a shell builtin. The set-hostname path is removed entirely (a NAME operand
// is rejected with an "unsupported" error instead of calling `hostname::set`,
// so the `hostname` crate's "set" feature is dropped), all output is routed
// through the context streams, `translate!` strings are literalized, and the
// entry point no longer calls `std::process::exit`.

#[cfg(not(any(target_os = "freebsd", target_os = "openbsd")))]
use std::net::ToSocketAddrs;
use std::{collections::hash_set::HashSet, ffi::OsString, io::Write, str};

use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};
#[cfg(any(target_os = "freebsd", target_os = "openbsd"))]
use dns_lookup::lookup_host;
use pi_uutils_ctx::format_usage;
use uucore::error::{FromIo, UResult, USimpleError};

static OPT_DOMAIN: &str = "domain";
static OPT_IP_ADDRESS: &str = "ip-address";
static OPT_FQDN: &str = "fqdn";
static OPT_SHORT: &str = "short";
static OPT_HOST: &str = "host";

#[cfg(windows)]
mod wsa {
	use std::io;

	use windows_sys::Win32::Networking::WinSock::{WSACleanup, WSADATA, WSAStartup};

	pub(super) struct WsaHandle(());

	pub(super) fn start() -> io::Result<WsaHandle> {
		let mut data = std::mem::MaybeUninit::<WSADATA>::uninit();
		let err = unsafe { WSAStartup(0x0202, data.as_mut_ptr()) };
		if err == 0 {
			Ok(WsaHandle(()))
		} else {
			Err(io::Error::from_raw_os_error(err))
		}
	}

	impl Drop for WsaHandle {
		fn drop(&mut self) {
			// This possibly returns an error but we can't handle it
			let _ = unsafe { WSACleanup() };
		}
	}
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
	match hostname_main(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let msg = err.to_string();
			if !msg.is_empty() {
				let _ = writeln!(pi_uutils_ctx::stderr(), "hostname: {msg}");
			}
			if code == 0 { 1 } else { code }
		},
	}
}

fn hostname_main(matches: &ArgMatches) -> UResult<()> {
	#[cfg(windows)]
	let _handle = wsa::start().map_err_context(|| "failed to start Winsock".to_string())?;

	match matches.get_one::<OsString>(OPT_HOST) {
		None => display_hostname(matches),
		// pi-uutils: setting the process-global hostname from inside a shell
		// builtin is refused (upstream calls `hostname::set` here).
		Some(_host) => Err(USimpleError::new(
			1,
			"setting the hostname is not supported by this builtin".to_string(),
		)),
	}
}

pub fn uu_app() -> Command {
	Command::new("hostname")
		.version(uucore::crate_version!())
		.about("Display or set the system's host name.")
		.override_usage(format_usage("hostname [OPTION]... [HOSTNAME]"))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_DOMAIN)
				.short('d')
				.long("domain")
				.overrides_with_all([OPT_DOMAIN, OPT_IP_ADDRESS, OPT_FQDN, OPT_SHORT])
				.help("Display the name of the DNS domain if possible")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_IP_ADDRESS)
				.short('i')
				.long("ip-address")
				.overrides_with_all([OPT_DOMAIN, OPT_IP_ADDRESS, OPT_FQDN, OPT_SHORT])
				.help("Display the network address(es) of the host")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_FQDN)
				.short('f')
				.long("fqdn")
				.overrides_with_all([OPT_DOMAIN, OPT_IP_ADDRESS, OPT_FQDN, OPT_SHORT])
				.help("Display the FQDN (Fully Qualified Domain Name) (default)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SHORT)
				.short('s')
				.long("short")
				.overrides_with_all([OPT_DOMAIN, OPT_IP_ADDRESS, OPT_FQDN, OPT_SHORT])
				.help("Display the short hostname (the portion before the first dot) if possible")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_HOST)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::Hostname),
		)
}

fn display_hostname(matches: &ArgMatches) -> UResult<()> {
	let hostname = hostname::get()
		.map_err_context(|| "failed to get hostname".to_owned())?
		.to_string_lossy()
		.into_owned();

	// pi-uutils: all output below goes to the context stdout instead of the
	// process stdout.
	let mut out = pi_uutils_ctx::stdout();

	if matches.get_flag(OPT_IP_ADDRESS) {
		let addresses;

		#[cfg(not(any(target_os = "freebsd", target_os = "openbsd")))]
		{
			let hostname = hostname + ":1";
			let addrs = hostname
				.to_socket_addrs()
				.map_err_context(|| "failed to resolve socket addresses".to_owned())?;
			addresses = addrs;
		}

		// DNS reverse lookup via "hostname:1" does not work on FreeBSD and OpenBSD
		// use dns-lookup crate instead
		#[cfg(any(target_os = "freebsd", target_os = "openbsd"))]
		{
			let addrs: Vec<std::net::IpAddr> = lookup_host(hostname.as_str())
				.map_err_context(|| "failed to lookup hostname".to_owned())?
				.collect();
			addresses = addrs;
		}

		let mut hashset = HashSet::new();
		let mut output = String::new();
		for addr in addresses {
			// XXX: not sure why this is necessary...
			if !hashset.contains(&addr) {
				let mut ip = addr.to_string();
				if ip.ends_with(":1") {
					let len = ip.len();
					ip.truncate(len - 2);
				}
				output.push_str(&ip);
				output.push(' ');
				hashset.insert(addr);
			}
		}
		let len = output.len();
		if len > 0 {
			writeln!(out, "{}", &output[0..len - 1])?;
		}

		Ok(())
	} else {
		if matches.get_flag(OPT_SHORT) || matches.get_flag(OPT_DOMAIN) {
			let mut it = hostname.char_indices().filter(|&ci| ci.1 == '.');
			if let Some(ci) = it.next() {
				if matches.get_flag(OPT_SHORT) {
					writeln!(out, "{}", &hostname[0..ci.0])?;
				} else {
					writeln!(out, "{}", &hostname[ci.0 + 1..])?;
				}
			} else if matches.get_flag(OPT_SHORT) {
				writeln!(out, "{hostname}")?;
			}
			return Ok(());
		}

		writeln!(out, "{hostname}")?;

		Ok(())
	}
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

		let argv: Vec<OsString> = std::iter::once("hostname")
			.chain(args)
			.map(OsString::from)
			.collect();

		let code = pi_uutils_ctx::scope(io, || run(argv));

		let out_str = String::from_utf8(stdout_buf.lock().clone()).unwrap();
		let err_str = String::from_utf8(stderr_buf.lock().clone()).unwrap();

		(code, out_str, err_str)
	}

	#[test]
	fn bare_invocation_prints_hostname() {
		let (code, stdout, stderr) = run_in(vec![]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert!(stdout.ends_with('\n'));
		assert!(!stdout.trim_end().is_empty());
	}

	#[test]
	fn set_attempt_is_rejected() {
		let (code, stdout, stderr) = run_in(vec!["new-name.example.com"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "hostname: setting the hostname is not supported by this builtin\n");
	}

	#[test]
	fn short_is_dotless_prefix_of_full_hostname() {
		let (code, short, stderr) = run_in(vec!["-s"]);
		let (_, full, _) = run_in(vec![]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		let short = short.trim_end();
		assert!(!short.contains('.'), "-s must strip everything after the first dot");
		assert!(full.trim_end().starts_with(short));
	}

	#[test]
	fn fqdn_flag_matches_default_display() {
		// -f is the default display mode; it must print the same name as the
		// bare invocation, not attempt any set path.
		let (code, fqdn, stderr) = run_in(vec!["-f"]);
		let (_, bare, _) = run_in(vec![]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(fqdn, bare);
	}
}

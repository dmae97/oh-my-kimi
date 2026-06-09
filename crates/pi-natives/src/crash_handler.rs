//! Native crash diagnostics.
//!
//! Installs Rust-side panic and allocation-error hooks the first time the
//! native module loads, so any crash inside `pi-natives` writes an actionable
//! record (thread, payload, backtrace) to disk and to stderr before the host
//! process exits.
//!
//! Without these hooks, Bun receives only the bare
//! `memory allocation of N bytes failed` line and aborts with no stack —
//! see issue #2211 ("Windows crash: Rust allocator failure after tasklist.exe
//! popup"). The hooks do not change the abort behavior (the cdylib release
//! profile uses `panic = "abort"`); they make the next crash diagnosable.
//!
//! Notes:
//! - Backtraces are captured via [`Backtrace::force_capture`], so they work
//!   regardless of `RUST_BACKTRACE`.
//! - The crash log path mirrors the JS side: `<home>/<PI_CONFIG_DIR>/logs/`
//!   (defaulting to `~/.omp/logs/`).
//! - Hook installation is idempotent across repeated module loads.

use std::{
	alloc::Layout,
	backtrace::Backtrace,
	ffi::OsStr,
	fmt::Write as _,
	fs::{self, OpenOptions},
	io::Write as _,
	path::{Path, PathBuf},
	process,
	sync::Once,
	thread,
	time::{SystemTime, UNIX_EPOCH},
};

/// Default directory name for OMP's per-user state (overridable via
/// `PI_CONFIG_DIR`, matching `packages/utils/src/dirs.ts`).
const DEFAULT_CONFIG_DIR: &str = ".omp";

static INSTALL: Once = Once::new();

/// Install the panic and allocation-error hooks. Idempotent.
pub fn install() {
	INSTALL.call_once(|| {
		let prev_panic = std::panic::take_hook();
		std::panic::set_hook(Box::new(move |info| {
			let report = format_panic_report(info);
			persist(&report, CrashKind::Panic);
			prev_panic(info);
		}));

		std::alloc::set_alloc_error_hook(|layout| {
			let report = format_alloc_report(layout);
			persist(&report, CrashKind::Alloc);
			// Preserve the default handler's externally observable behavior:
			// print the canonical OOM line and abort. The crash record is the
			// only thing we add; we never silently swallow OOM.
			let _ = writeln!(std::io::stderr(), "memory allocation of {} bytes failed", layout.size());
			process::abort();
		});
	});
}

#[derive(Clone, Copy)]
enum CrashKind {
	Panic,
	Alloc,
}

impl CrashKind {
	const fn as_str(self) -> &'static str {
		match self {
			Self::Panic => "panic",
			Self::Alloc => "alloc",
		}
	}
}

fn format_panic_report(info: &std::panic::PanicHookInfo<'_>) -> String {
	let bt = Backtrace::force_capture();
	let location = info
		.location()
		.map_or_else(|| String::from("<unknown>"), |l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
	let mut out = report_header(CrashKind::Panic);
	let _ = writeln!(out, "location: {location}");
	let _ = writeln!(out, "message:  {}", panic_payload(info.payload()));
	let _ = writeln!(out, "backtrace:\n{bt}");
	out
}

fn format_alloc_report(layout: Layout) -> String {
	// Capturing a backtrace allocates. If the global allocator is in a state
	// where small allocations keep failing this will recurse into the hook —
	// `Backtrace::force_capture` swallows the secondary failure internally and
	// returns an empty backtrace, which is still strictly more useful than the
	// nothing the default handler prints.
	let bt = Backtrace::force_capture();
	let mut out = report_header(CrashKind::Alloc);
	let _ = writeln!(out, "size:      {} bytes", layout.size());
	let _ = writeln!(out, "alignment: {} bytes", layout.align());
	let _ = writeln!(out, "backtrace:\n{bt}");
	out
}

fn report_header(kind: CrashKind) -> String {
	let thread_name = thread::current().name().unwrap_or("<unnamed>").to_owned();
	let now_ms = unix_millis();
	format!(
		"pi-natives {kind} crash\n\
		 pid:       {pid}\n\
		 thread:    {thread_name}\n\
		 timestamp: {now_ms} (unix ms)\n",
		kind = kind.as_str(),
		pid = process::id(),
	)
}

fn panic_payload(payload: &(dyn std::any::Any + Send)) -> String {
	if let Some(s) = payload.downcast_ref::<&'static str>() {
		(*s).to_owned()
	} else if let Some(s) = payload.downcast_ref::<String>() {
		s.clone()
	} else {
		String::from("<non-string panic payload>")
	}
}

fn persist(report: &str, kind: CrashKind) {
	// Echo to stderr unconditionally so the user still sees something even
	// when the file write fails (read-only home, missing $HOME, etc.).
	let _ = writeln!(std::io::stderr(), "{report}");

	let Some(path) = crash_log_path(kind) else {
		return;
	};
	if let Some(parent) = path.parent() {
		let _ = fs::create_dir_all(parent);
	}
	if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
		let _ = f.write_all(report.as_bytes());
		let _ = f.flush();
		let _ = f.sync_data();
		let _ = writeln!(std::io::stderr(), "pi-natives crash report written to {}", path.display());
	}
}

fn crash_log_path(kind: CrashKind) -> Option<PathBuf> {
	let dir = logs_dir()?;
	Some(build_crash_log_path(&dir, kind, process::id(), unix_millis()))
}

fn build_crash_log_path(dir: &Path, kind: CrashKind, pid: u32, now_ms: u128) -> PathBuf {
	dir.join(format!("native-{}-{pid}-{now_ms}.log", kind.as_str()))
}

fn logs_dir() -> Option<PathBuf> {
	Some(resolve_logs_dir(&home_dir()?, std::env::var_os("PI_CONFIG_DIR").as_deref()))
}

fn resolve_logs_dir(home: &Path, config_dir_override: Option<&OsStr>) -> PathBuf {
	let config_dir = config_dir_override.filter(|s| !s.is_empty()).unwrap_or_else(|| OsStr::new(DEFAULT_CONFIG_DIR));
	// Honor an absolute PI_CONFIG_DIR if the user set one; otherwise treat
	// the value as a child of `$HOME` (matches `getConfigDirName()`).
	let base = if Path::new(config_dir).is_absolute() { PathBuf::from(config_dir) } else { home.join(config_dir) };
	base.join("logs")
}

fn home_dir() -> Option<PathBuf> {
	#[cfg(unix)]
	{
		std::env::var_os("HOME").map(PathBuf::from)
	}
	#[cfg(windows)]
	{
		if let Some(profile) = std::env::var_os("USERPROFILE") {
			return Some(PathBuf::from(profile));
		}
		let drive = std::env::var_os("HOMEDRIVE")?;
		let path = std::env::var_os("HOMEPATH")?;
		let mut combined = drive;
		combined.push(path);
		Some(PathBuf::from(combined))
	}
}

fn unix_millis() -> u128 {
	SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn alloc_report_contains_size_alignment_and_backtrace() {
		let layout = Layout::from_size_align(7714, 8).unwrap();
		let report = format_alloc_report(layout);
		assert!(report.contains("pi-natives alloc crash"), "report missing header: {report}");
		assert!(report.contains("size:      7714 bytes"), "report missing size: {report}");
		assert!(report.contains("alignment: 8 bytes"), "report missing alignment: {report}");
		assert!(report.contains("backtrace:"), "report missing backtrace section: {report}");
		assert!(report.contains(&format!("pid:       {}", process::id())), "report missing pid: {report}");
		assert!(report.contains("thread:"), "report missing thread: {report}");
	}

	#[test]
	fn panic_payload_handles_str_string_and_other() {
		let static_str: Box<dyn std::any::Any + Send> = Box::new("static panic");
		assert_eq!(panic_payload(&*static_str), "static panic");

		let owned: Box<dyn std::any::Any + Send> = Box::new(String::from("owned panic"));
		assert_eq!(panic_payload(&*owned), "owned panic");

		let other: Box<dyn std::any::Any + Send> = Box::new(42u32);
		assert_eq!(panic_payload(&*other), "<non-string panic payload>");
	}

	#[test]
	fn resolve_logs_dir_defaults_under_dot_omp() {
		let dir = resolve_logs_dir(Path::new("/tmp/pi-natives-test-home"), None);
		assert_eq!(dir, PathBuf::from("/tmp/pi-natives-test-home/.omp/logs"));
	}

	#[test]
	fn resolve_logs_dir_honors_relative_pi_config_dir() {
		let dir = resolve_logs_dir(Path::new("/tmp/pi-natives-test-home"), Some(OsStr::new(".omp-dev")));
		assert_eq!(dir, PathBuf::from("/tmp/pi-natives-test-home/.omp-dev/logs"));
	}

	#[test]
	fn resolve_logs_dir_honors_absolute_pi_config_dir() {
		let dir = resolve_logs_dir(
			Path::new("/tmp/pi-natives-test-home"),
			Some(OsStr::new("/var/tmp/pi-natives-state")),
		);
		assert_eq!(dir, PathBuf::from("/var/tmp/pi-natives-state/logs"));
	}

	#[test]
	fn resolve_logs_dir_ignores_empty_pi_config_dir() {
		let dir = resolve_logs_dir(Path::new("/tmp/pi-natives-test-home"), Some(OsStr::new("")));
		assert_eq!(dir, PathBuf::from("/tmp/pi-natives-test-home/.omp/logs"));
	}

	#[test]
	fn build_crash_log_path_tags_kind_and_pid() {
		let dir = Path::new("/tmp/pi-natives-test-home/.omp/logs");
		let panic_log = build_crash_log_path(dir, CrashKind::Panic, 4242, 1_700_000_000_000);
		assert_eq!(panic_log, PathBuf::from("/tmp/pi-natives-test-home/.omp/logs/native-panic-4242-1700000000000.log"));
		let alloc_log = build_crash_log_path(dir, CrashKind::Alloc, 99, 1);
		assert_eq!(alloc_log, PathBuf::from("/tmp/pi-natives-test-home/.omp/logs/native-alloc-99-1.log"));
	}
}

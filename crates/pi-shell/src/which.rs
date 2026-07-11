//! In-process `which` builtin backed by brush's PATH-search helpers.
//!
//! Follows which(1) (GNU/debianutils) semantics: each name operand is looked
//! up in the shell's `PATH`; the first match is printed (all matches with
//! `-a`). Lookup failures are silent; the exit status is 0 when every name
//! was found and 1 when any name was missing.

use std::{
	ffi::OsString,
	io::{self, Write},
	path::{Path, PathBuf},
};

use brush_core::{
	Error,
	builtins::{BoxFuture, ContentOptions, ContentType, Registration},
	commands::{CommandArg, ExecutionContext},
	extensions::ShellExtensions,
	openfiles::{OpenFile, OpenFiles, null},
	pathsearch,
	results::ExecutionResult,
	sys,
};
use clap::{Parser, error::ErrorKind};

#[derive(Parser, Debug)]
#[command(name = "which", about = "Locate a command's executable in the shell's PATH")]
struct WhichCli {
	/// Print all matching executables in PATH, not just the first.
	#[arg(short = 'a', long = "all")]
	all: bool,

	/// Command names to locate.
	#[arg(value_name = "name")]
	names: Vec<String>,
}

/// Creates the `which` shell builtin registration.
pub fn which_builtin<SE: ShellExtensions>() -> Registration<SE> {
	fn execute<SE: ShellExtensions>(
		context: ExecutionContext<'_, SE>,
		args: Vec<CommandArg>,
	) -> BoxFuture<'_, Result<ExecutionResult, Error>> {
		Box::pin(std::future::ready(Ok(run_which(context, args))))
	}

	Registration {
		execute_func: execute::<SE>,
		content_func: which_content,
		disabled: false,
		special_builtin: false,
		declaration_builtin: false,
		transparent_background_wrapper: false,
	}
}

fn run_which<SE: ShellExtensions>(
	context: ExecutionContext<'_, SE>,
	args: Vec<CommandArg>,
) -> ExecutionResult {
	let mut stdout = context
		.try_fd(OpenFiles::STDOUT_FD)
		.unwrap_or_else(null_sink);
	let mut stderr = context
		.try_fd(OpenFiles::STDERR_FD)
		.unwrap_or_else(null_sink);
	let cwd = context.shell.working_dir().to_path_buf();
	let path_var = context
		.shell
		.env_str("PATH")
		.map(std::borrow::Cow::into_owned)
		.unwrap_or_default();
	let argv: Vec<OsString> = args
		.iter()
		.map(|arg| OsString::from(arg.to_string()))
		.collect();

	let cli = match WhichCli::try_parse_from(argv) {
		Ok(cli) => cli,
		Err(err) => {
			let rendered = err.to_string();
			let code = match err.kind() {
				ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => {
					let _ = write!(stdout, "{rendered}");
					0
				},
				_ => {
					let _ = write!(stderr, "{rendered}");
					2
				},
			};
			return ExecutionResult::new(code);
		},
	};

	let mut all_found = true;
	for name in &cli.names {
		let matches = find_matches(name, &path_var, &cwd, cli.all);
		if matches.is_empty() {
			// which(1) reports missing names via the exit status only.
			all_found = false;
		}
		for path in matches {
			let _ = writeln!(stdout, "{}", path.display());
		}
	}

	ExecutionResult::new(u8::from(!all_found))
}

/// Collects the executable matches for a single `which` name operand.
///
/// A name containing a path separator is checked directly against `cwd`
/// (yielding at most one match); otherwise each `PATH` entry — with relative
/// and empty entries resolved against `cwd` — is probed in `PATH` order.
/// Returns only the first match unless `all` is set. Windows `PATHEXT`
/// resolution is handled by [`brush_core::sys::fs::resolve_executable`].
fn find_matches(name: &str, path_var: &str, cwd: &Path, all: bool) -> Vec<PathBuf> {
	if sys::fs::contains_path_separator(name) {
		let candidate = cwd.join(name);
		if candidate.is_dir() {
			return Vec::new();
		}
		return sys::fs::resolve_executable(candidate).into_iter().collect();
	}

	let dirs = sys::fs::split_paths(path_var).map(|dir| {
		if dir.as_os_str().is_empty() {
			// POSIX: an empty PATH entry names the current directory.
			cwd.to_path_buf()
		} else if dir.is_relative() {
			cwd.join(dir)
		} else {
			dir
		}
	});

	let mut found = pathsearch::search_for_executable(dirs, name);
	if all {
		found.collect()
	} else {
		found.next().into_iter().collect()
	}
}

fn null_sink() -> OpenFile {
	null().unwrap_or_else(|_| OpenFile::from(io::stdout()))
}

#[allow(
	clippy::unnecessary_wraps,
	reason = "signature must match brush's CommandContentFunc fn pointer"
)]
fn which_content(
	_name: &str,
	_content_type: ContentType,
	_options: &ContentOptions,
) -> Result<String, Error> {
	Ok("which: which [-a] name [name ...]\n".to_string())
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
	use std::{
		env, fs,
		os::unix::fs::PermissionsExt,
		path::PathBuf,
		sync::atomic::{AtomicUsize, Ordering},
		time::{SystemTime, UNIX_EPOCH},
	};

	use super::find_matches;

	static COUNTER: AtomicUsize = AtomicUsize::new(0);

	/// Creates a fresh, canonicalized temp directory (macOS `/var` is a
	/// symlink; canonicalizing keeps constructed and probed paths identical).
	fn temp_root(tag: &str) -> PathBuf {
		let nanos = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map_or(0, |d| d.as_nanos());
		let root = env::temp_dir().join(format!(
			"pi-shell-which-{tag}-{}-{}-{}",
			std::process::id(),
			nanos,
			COUNTER.fetch_add(1, Ordering::Relaxed),
		));
		fs::create_dir_all(&root).expect("temp dir should be created");
		fs::canonicalize(&root).expect("temp dir should canonicalize")
	}

	fn place_file(dir: &std::path::Path, name: &str, executable: bool) -> PathBuf {
		let path = dir.join(name);
		fs::write(&path, b"#!/bin/sh\n").expect("file should be written");
		let mode = if executable { 0o755 } else { 0o644 };
		fs::set_permissions(&path, fs::Permissions::from_mode(mode))
			.expect("permissions should be set");
		path
	}

	#[test]
	fn finds_only_executable_files() {
		let dir = temp_root("exec-only");
		let tool = place_file(&dir, "tool", true);
		place_file(&dir, "blob", false);
		let path_var = dir.display().to_string();

		assert_eq!(find_matches("tool", &path_var, &dir, false), vec![tool]);
		assert!(find_matches("blob", &path_var, &dir, false).is_empty());
		assert!(find_matches("missing", &path_var, &dir, false).is_empty());
	}

	#[test]
	fn all_flag_returns_matches_in_path_order() {
		let dir_a = temp_root("all-a");
		let dir_b = temp_root("all-b");
		let tool_a = place_file(&dir_a, "tool", true);
		let tool_b = place_file(&dir_b, "tool", true);
		let path_var = format!("{}:{}", dir_a.display(), dir_b.display());
		let cwd = temp_root("all-cwd");

		assert_eq!(find_matches("tool", &path_var, &cwd, true), vec![tool_a.clone(), tool_b]);
		// Without -a only the first PATH entry's match is returned.
		assert_eq!(find_matches("tool", &path_var, &cwd, false), vec![tool_a]);
	}

	#[test]
	fn name_with_separator_resolves_against_cwd() {
		let cwd = temp_root("slash");
		let bin = cwd.join("bin");
		fs::create_dir_all(&bin).expect("bin dir should be created");
		let tool = place_file(&bin, "tool", true);
		place_file(&bin, "blob", false);

		// PATH is irrelevant for names containing a separator.
		assert_eq!(find_matches("bin/tool", "", &cwd, false), vec![tool]);
		assert!(find_matches("bin/blob", "", &cwd, false).is_empty());
		// A directory is never a match, even with execute bits set.
		assert!(find_matches("./bin", "", &cwd, false).is_empty());
	}

	#[test]
	fn relative_path_entries_resolve_against_cwd() {
		let cwd = temp_root("rel-entry");
		let bin = cwd.join("bin");
		fs::create_dir_all(&bin).expect("bin dir should be created");
		let tool = place_file(&bin, "tool", true);

		assert_eq!(find_matches("tool", "bin", &cwd, false), vec![tool]);
	}
}

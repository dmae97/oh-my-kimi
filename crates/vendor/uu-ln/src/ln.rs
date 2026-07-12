// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) srcpath targetpath EEXIST

// pi-uutils: vendored from uutils/coreutils 0.8.0 and patched to run in-process
// as a shell builtin. Every filesystem syscall resolves its path operand
// against the shell working directory via `pi_uutils_ctx::resolve` AT THE CALL
// SITE, while the original operands are kept for display/error messages (GNU
// prints operands as typed) — and, crucially, for the CONTENT of symbolic
// links, which stays exactly as typed like GNU ln (only the location where the
// link is created gets resolved). All process-global stdio and the `-i` prompt
// are routed through `pi_uutils_ctx`, `translate!` strings are literalized, and
// the entry point no longer calls `std::process::exit`.

#[cfg(any(unix, target_os = "redox"))]
use std::os::unix::fs::symlink;
#[cfg(windows)]
use std::os::windows::fs::{symlink_dir, symlink_file};
use std::{
	borrow::Cow,
	collections::HashSet,
	ffi::OsString,
	fs,
	io::Write,
	path::{Path, PathBuf},
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use pi_uutils_ctx::format_usage;
use thiserror::Error;
use uucore::{
	backup_control::{self, BackupMode},
	display::Quotable,
	error::{FromIo, UError, UResult, USimpleError, strip_errno},
	fs::{
		MissingHandling, ResolveMode, canonicalize, make_path_relative_to, paths_refer_to_same_file,
	},
};

pub struct Settings {
	overwrite:      OverwriteMode,
	backup:         BackupMode,
	suffix:         OsString,
	symbolic:       bool,
	relative:       bool,
	logical:        bool,
	target_dir:     Option<PathBuf>,
	no_target_dir:  bool,
	no_dereference: bool,
	verbose:        bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OverwriteMode {
	NoClobber,
	Interactive,
	Force,
}

// pi-uutils: the `translate!` message templates are literalized with the
// en-US strings from upstream's locales/en-US.ftl.
#[derive(Error, Debug)]
enum LnError {
	#[error("target {} is not a directory", _0.quote())]
	TargetIsNotADirectory(PathBuf),

	#[error("")]
	SomeLinksFailed,

	#[error("{} and {} are the same file", _0.quote(), _1.quote())]
	SameFile(PathBuf, PathBuf),

	#[error("missing destination file operand after {}", _0.quote())]
	MissingDestination(PathBuf),

	#[error("extra operand {}\nTry '{} --help' for more information.", _0.quote(), _1)]
	ExtraOperand(OsString, String),

	#[error("{}: hard link not allowed for directory", _0.to_string_lossy())]
	FailedToCreateHardLinkDir(PathBuf),
}

impl UError for LnError {
	fn code(&self) -> i32 {
		1
	}
}

mod options {
	pub const FORCE: &str = "force";
	//pub const DIRECTORY: &str = "directory";
	pub const INTERACTIVE: &str = "interactive";
	pub const NO_DEREFERENCE: &str = "no-dereference";
	pub const SYMBOLIC: &str = "symbolic";
	pub const LOGICAL: &str = "logical";
	pub const PHYSICAL: &str = "physical";
	pub const TARGET_DIRECTORY: &str = "target-directory";
	pub const NO_TARGET_DIRECTORY: &str = "no-target-directory";
	pub const RELATIVE: &str = "relative";
	pub const VERBOSE: &str = "verbose";
}

static ARG_FILES: &str = "files";

/// pi-uutils: replacement for uucore's `show_error!` — writes the diagnostic
/// to the context stderr instead of the process-global one. Errors that render
/// to an empty message (e.g. [`LnError::SomeLinksFailed`]) print nothing
/// rather than a dangling "ln: " prefix.
fn show_error(msg: impl std::fmt::Display) {
	let rendered = msg.to_string();
	if !rendered.is_empty() {
		let _ = writeln!(pi_uutils_ctx::stderr(), "ln: {rendered}");
	}
}

/// pi-uutils: replacement for uucore's `read_yes`, reading from the context
/// stdin one byte at a time (no buffering) so consecutive prompts don't
/// over-read into a later prompt's input. Returns true when the first character
/// of the line is `y`/`Y`.
fn read_yes() -> bool {
	use std::io::Read as _;
	let mut stdin = pi_uutils_ctx::stdin();
	let mut buf = [0u8; 1];
	let mut first = None;
	loop {
		match stdin.read(&mut buf) {
			Ok(0) => break, // EOF
			Ok(_) => {
				if buf[0] == b'\n' {
					break;
				}
				if first.is_none() {
					first = Some(buf[0]);
				}
			},
			Err(_) => return false,
		}
	}
	matches!(first, Some(b'y' | b'Y'))
}

/// pi-uutils: replacement for uucore's `prompt_yes!` — writes
/// "ln: \<prompt\> " to the context stderr, then reads the answer from the
/// context stdin.
fn prompt_yes(prompt: impl std::fmt::Display) -> bool {
	let mut err = pi_uutils_ctx::stderr();
	let _ = write!(err, "ln: {prompt} ");
	let _ = err.flush();
	read_yes()
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
	match ln_main(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			// pi-uutils: `SomeLinksFailed` renders to an empty message
			// (upstream prints the per-file diagnostics as it goes); don't
			// emit a dangling "ln: " prefix for it.
			let msg = err.to_string();
			if !msg.is_empty() {
				let _ = writeln!(pi_uutils_ctx::stderr(), "ln: {msg}");
			}
			if code == 0 { 1 } else { code }
		},
	}
}

fn ln_main(matches: &ArgMatches) -> UResult<()> {
	/* the list of files */

	let paths: Vec<PathBuf> = matches
		.get_many::<OsString>(ARG_FILES)
		.unwrap()
		.map(PathBuf::from)
		.collect();

	let symbolic = matches.get_flag(options::SYMBOLIC);

	let overwrite_mode = if matches.get_flag(options::FORCE) {
		OverwriteMode::Force
	} else if matches.get_flag(options::INTERACTIVE) {
		OverwriteMode::Interactive
	} else {
		OverwriteMode::NoClobber
	};

	let backup_mode = backup_control::determine_backup_mode(matches)?;
	let backup_suffix = backup_control::determine_backup_suffix(matches);

	// When we have "-L" or "-L -P", false otherwise
	let logical = matches.get_flag(options::LOGICAL);

	let settings = Settings {
		overwrite: overwrite_mode,
		backup: backup_mode,
		suffix: OsString::from(backup_suffix),
		symbolic,
		logical,
		relative: matches.get_flag(options::RELATIVE),
		target_dir: matches
			.get_one::<OsString>(options::TARGET_DIRECTORY)
			.map(PathBuf::from),
		no_target_dir: matches.get_flag(options::NO_TARGET_DIRECTORY),
		no_dereference: matches.get_flag(options::NO_DEREFERENCE),
		verbose: matches.get_flag(options::VERBOSE),
	};

	exec(&paths[..], &settings)
}

pub fn uu_app() -> Command {
	let after_help = format!(
		"In the 1st form, create a link to TARGET with the name LINK_NAME.\nIn the 2nd form, create \
		 a link to TARGET in the current directory.\nIn the 3rd and 4th forms, create links to each \
		 TARGET in DIRECTORY.\nCreate hard links by default, symbolic links with --symbolic.\nBy \
		 default, each destination (name of new link) should not already exist.\nWhen creating hard \
		 links, each TARGET must exist. Symbolic links\ncan hold arbitrary text; if later resolved, \
		 a relative link is\ninterpreted in relation to its parent directory.\n\n{}",
		backup_control::BACKUP_CONTROL_LONG_HELP
	);

	Command::new("ln")
		.version(uucore::crate_version!())
		.about("Make links between files.")
		.override_usage(format_usage(
			"ln [OPTION]... [-T] TARGET LINK_NAME\nln [OPTION]... TARGET\nln [OPTION]... TARGET... \
			 DIRECTORY\nln [OPTION]... -t DIRECTORY TARGET...",
		))
		.infer_long_args(true)
		.after_help(after_help)
		.arg(backup_control::arguments::backup())
		.arg(backup_control::arguments::backup_no_args())
		/*.arg(
			Arg::new(options::DIRECTORY)
				.short('d')
				.long(options::DIRECTORY)
				.help("allow users with appropriate privileges to attempt to make hard links to directories")
		)*/
		.arg(
			Arg::new(options::FORCE)
				.short('f')
				.long(options::FORCE)
				.help("remove existing destination files")
				.overrides_with(options::INTERACTIVE)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::INTERACTIVE)
				.short('i')
				.long(options::INTERACTIVE)
				.help("prompt whether to remove existing destination files")
				.overrides_with(options::FORCE)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_DEREFERENCE)
				.short('n')
				.long(options::NO_DEREFERENCE)
				.help("treat LINK_NAME as a normal file if it is a\nsymbolic link to a directory")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::LOGICAL)
				.short('L')
				.long(options::LOGICAL)
				.help("follow TARGETs that are symbolic links")
				.overrides_with(options::PHYSICAL)
				.action(ArgAction::SetTrue),
		)
		.arg(
			// Not implemented yet
			Arg::new(options::PHYSICAL)
				.short('P')
				.long(options::PHYSICAL)
				.help("make hard links directly to symbolic links")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SYMBOLIC)
				.short('s')
				.long(options::SYMBOLIC)
				.help("make symbolic links instead of hard links")
				// override added for https://github.com/uutils/coreutils/issues/2359
				.overrides_with(options::SYMBOLIC)
				.action(ArgAction::SetTrue),
		)
		.arg(backup_control::arguments::suffix())
		.arg(
			Arg::new(options::TARGET_DIRECTORY)
				.short('t')
				.long(options::TARGET_DIRECTORY)
				.help("specify the DIRECTORY in which to create the links")
				.value_name("DIRECTORY")
				.value_hint(clap::ValueHint::DirPath)
				.value_parser(clap::value_parser!(OsString))
				.conflicts_with(options::NO_TARGET_DIRECTORY),
		)
		.arg(
			Arg::new(options::NO_TARGET_DIRECTORY)
				.short('T')
				.long(options::NO_TARGET_DIRECTORY)
				.help("treat LINK_NAME as a normal file always")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::RELATIVE)
				.short('r')
				.long(options::RELATIVE)
				.help("create symbolic links relative to link location")
				.requires(options::SYMBOLIC)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::VERBOSE)
				.short('v')
				.long(options::VERBOSE)
				.help("print name of each linked file")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.value_hint(clap::ValueHint::AnyPath)
				.value_parser(clap::value_parser!(OsString))
				.required(true)
				.num_args(1..),
		)
}

fn exec(files: &[PathBuf], settings: &Settings) -> UResult<()> {
	// Handle cases where we create links in a directory first.
	if let Some(target_path) = &settings.target_dir {
		// 4th form: a directory is specified by -t.
		return link_files_in_dir(files, target_path, settings);
	}
	if !settings.no_target_dir {
		if files.len() == 1 {
			// 2nd form: the target directory is the current directory.
			return link_files_in_dir(files, &PathBuf::from("."), settings);
		}
		let last_file = &PathBuf::from(files.last().unwrap());
		// pi-uutils: probe the destination via the resolved path.
		if files.len() > 2 || pi_uutils_ctx::resolve(last_file).is_dir() {
			// 3rd form: create links in the last argument.
			return link_files_in_dir(&files[0..files.len() - 1], last_file, settings);
		}
	}

	// 1st form. Now there should be only two operands, but if -T is
	// specified we may have a wrong number of operands.
	if files.len() == 1 {
		return Err(LnError::MissingDestination(files[0].clone()).into());
	}
	if files.len() > 2 {
		// pi-uutils: `uucore::execution_phrase()` reads the process argv,
		// which is the host shell's; the builtin is always invoked as "ln".
		return Err(LnError::ExtraOperand(files[2].clone().into(), "ln".to_string()).into());
	}
	assert!(!files.is_empty());

	link(&files[0], &files[1], settings)
}

#[allow(clippy::cognitive_complexity)]
fn link_files_in_dir(files: &[PathBuf], target_dir: &Path, settings: &Settings) -> UResult<()> {
	// pi-uutils: resolved target directory for every syscall below; the
	// operand keeps its as-typed spelling for display and link-name building.
	let target_dir_fs = pi_uutils_ctx::resolve(target_dir);
	if !target_dir_fs.is_dir() {
		return Err(LnError::TargetIsNotADirectory(target_dir.to_owned()).into());
	}
	// remember the linked destinations for further usage
	let mut linked_destinations: HashSet<PathBuf> = HashSet::with_capacity(files.len());

	let mut all_successful = true;
	for srcpath in files {
		let targetpath = if settings.no_dereference && target_dir_fs.is_symlink() {
			let remove_target = || {
				// In that case, we don't want to do link resolution
				// We need to clean the target
				if target_dir_fs.is_file()
					&& let Err(e) = fs::remove_file(&target_dir_fs)
				{
					show_error(format_args!("Could not update {}: {e}", target_dir.quote()));
				}
				#[cfg(windows)]
				if target_dir_fs.is_dir() {
					// Not sure why but on Windows, the symlink can be
					// considered as a dir
					// See test_ln::test_symlink_no_deref_dir
					if let Err(e) = fs::remove_dir(&target_dir_fs) {
						show_error(format_args!("Could not update {}: {e}", target_dir.quote()));
					}
				}
			};
			match settings.overwrite {
				OverwriteMode::NoClobber => {},
				OverwriteMode::Interactive => {
					if prompt_yes(format_args!("replace {}?", target_dir.quote())) {
						remove_target();
					}
				},
				OverwriteMode::Force => {
					remove_target();
				},
			}
			target_dir.to_path_buf()
		} else if let Some(name) = srcpath.as_os_str().to_str() {
			match Path::new(name).file_name() {
				Some(basename) => target_dir.join(basename),
				// This can be None only for "." or "..". Trying
				// to create a link with such name will fail with
				// EEXIST, which agrees with the behavior of GNU
				// coreutils.
				None => target_dir.join(name),
			}
		} else {
			show_error(format_args!("cannot stat {}: No such file or directory", srcpath.quote()));
			all_successful = false;
			continue;
		};

		if linked_destinations.contains(&targetpath) {
			// If the target file was already created in this ln call, do not overwrite
			show_error(format_args!(
				"will not overwrite just-created {} with {}",
				targetpath.quote(),
				srcpath.quote()
			));
			all_successful = false;
		} else if let Err(e) = link(srcpath, &targetpath, settings) {
			show_error(format_args!("{e}"));
			all_successful = false;
		}

		linked_destinations.insert(targetpath.clone());
	}
	if all_successful {
		Ok(())
	} else {
		Err(LnError::SomeLinksFailed.into())
	}
}

fn relative_path<'a>(src: &'a Path, dst: &Path) -> Cow<'a, Path> {
	// pi-uutils: canonicalize from the resolved operands so `-r` computes the
	// link text against the shell working directory (uucore's canonicalize
	// would otherwise fall back to the process cwd for relative paths).
	if let Ok(src_abs) =
		canonicalize(pi_uutils_ctx::resolve(src), MissingHandling::Missing, ResolveMode::Physical)
		&& let Ok(dst_abs) = canonicalize(
			pi_uutils_ctx::resolve(dst.parent().unwrap()),
			MissingHandling::Missing,
			ResolveMode::Physical,
		) {
		return make_path_relative_to(src_abs, dst_abs).into();
	}
	src.into()
}

#[allow(clippy::cognitive_complexity)]
fn link(src: &Path, dst: &Path, settings: &Settings) -> UResult<()> {
	let mut backup_path = None;
	let source: Cow<'_, Path> = if settings.relative {
		relative_path(src, dst)
	} else {
		src.into()
	};

	// pi-uutils: resolved counterparts of both operands for every filesystem
	// syscall below. `src`/`dst`/`source` keep the as-typed spelling for
	// display — and `source` is what gets stored as the symlink CONTENT, so it
	// must never be resolved.
	let src_fs = pi_uutils_ctx::resolve(src);
	let dst_fs = pi_uutils_ctx::resolve(dst);

	if dst_fs.is_symlink() || dst_fs.exists() {
		// pi-uutils: probe numbered backups from the resolved destination so
		// the directory scan hits the shell's working directory.
		backup_path = backup_control::get_backup_path(settings.backup, &dst_fs, &settings.suffix);
		if settings.backup == BackupMode::Existing && !settings.symbolic {
			// when ln --backup f f, it should detect that it is the same file
			if paths_refer_to_same_file(&src_fs, &dst_fs, true) {
				return Err(LnError::SameFile(src.to_owned(), dst.to_owned()).into());
			}
		}
		if let Some(p) = &backup_path {
			fs::rename(&dst_fs, p).map_err_context(|| format!("cannot backup {}", dst.quote()))?;
		}
		match settings.overwrite {
			OverwriteMode::NoClobber => {},
			OverwriteMode::Interactive => {
				if !prompt_yes(format_args!("replace {}?", dst.quote())) {
					return Err(LnError::SomeLinksFailed.into());
				}

				let _ = fs::remove_file(&dst_fs);
				// In case of error, don't do anything
			},
			OverwriteMode::Force => {
				if !dst_fs.is_symlink() && paths_refer_to_same_file(&src_fs, &dst_fs, true) {
					// Even in force overwrite mode, verify we are not targeting the same entry and
					// return a SameFile error if so
					let same_entry = match (
						canonicalize(&src_fs, MissingHandling::Missing, ResolveMode::Physical),
						canonicalize(&dst_fs, MissingHandling::Missing, ResolveMode::Physical),
					) {
						(Ok(src), Ok(dst)) => src == dst,
						_ => true,
					};
					if same_entry {
						return Err(LnError::SameFile(src.to_owned(), dst.to_owned()).into());
					}
				}
				let _ = fs::remove_file(&dst_fs);
				// In case of error, don't do anything
			},
		}
	}

	let res: UResult<()> = if settings.symbolic {
		// pi-uutils: the link is created at the resolved location, but its
		// content (`source`) stays exactly as typed, like GNU ln. uucore's
		// io-error conversion renders EEXIST as "Already exists"; format the
		// GNU-style diagnostic ("failed to create symbolic link 'x': File
		// exists") from the raw OS error instead.
		symlink(&source, &dst_fs).map_err(|e| {
			USimpleError::new(
				1,
				format!("failed to create symbolic link {}: {}", dst.quote(), strip_errno(&e)),
			)
		})
	} else {
		// pi-uutils: hard links dereference their target, so the resolved
		// source is what the syscalls get.
		let source_fs = pi_uutils_ctx::resolve(&source);
		let p = if settings.logical && source_fs.is_symlink() {
			fs::canonicalize(&source_fs)
				.map_err_context(|| format!("failed to access {}", source.quote()))?
		} else {
			source_fs
		};
		match fs::hard_link(&p, &dst_fs) {
			Ok(()) => Ok(()),
			Err(_) if p.is_dir() => {
				Err(LnError::FailedToCreateHardLinkDir(source.to_path_buf()).into())
			},
			// pi-uutils: same GNU-style rendering as the symlink arm (uucore
			// would print "Already exists" for EEXIST).
			Err(e) => Err(USimpleError::new(
				1,
				format!(
					"failed to create hard link {} => {}: {}",
					source.quote(),
					dst.quote(),
					strip_errno(&e)
				),
			)),
		}
	};

	if let Err(e) = res {
		if let Some(p) = &backup_path {
			fs::rename(p, &dst_fs).map_err_context(|| format!("cannot backup {}", dst.quote()))?;
		}
		return Err(e);
	}

	if settings.verbose {
		// pi-uutils: verbose output goes to the context stdout.
		let mut out = pi_uutils_ctx::stdout();
		write!(out, "{} -> {}", dst.quote(), source.quote())?;
		match backup_path {
			Some(path) => {
				// pi-uutils: `path` derives from the resolved (absolute)
				// destination; rebuild a display path from the operand for
				// the verbose message.
				let backup_display = match (dst.parent(), path.file_name()) {
					(Some(parent), Some(name)) if !parent.as_os_str().is_empty() => parent.join(name),
					(_, Some(name)) => PathBuf::from(name),
					_ => path.clone(),
				};
				writeln!(out, " (backup: {})", backup_display.quote())?;
			},
			None => writeln!(out)?,
		}
	}
	Ok(())
}

#[cfg(windows)]
pub fn symlink<P1: AsRef<Path>, P2: AsRef<Path>>(src: P1, dst: P2) -> std::io::Result<()> {
	// pi-uutils: the dir/file probe resolves the target against the shell
	// working directory (upstream consults the process cwd); the stored link
	// content is still the caller's as-typed `src`.
	if pi_uutils_ctx::resolve(src.as_ref()).is_dir() {
		symlink_dir(src, dst)
	} else {
		symlink_file(src, dst)
	}
}

#[cfg(target_os = "wasi")]
fn symlink<P1: AsRef<Path>, P2: AsRef<Path>>(_src: P1, _dst: P2) -> std::io::Result<()> {
	Err(std::io::Error::new(
		std::io::ErrorKind::Unsupported,
		"symlinks not supported on this platform",
	))
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, io::Write, path::PathBuf, sync::Arc};

	use parking_lot::Mutex;
	use pi_uutils_ctx::ScopeIo;

	use super::*;

	fn run_with_stdin(cwd: PathBuf, args: Vec<&str>, stdin: &[u8]) -> (i32, String, String) {
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
			stdin: Box::new(std::io::Cursor::new(stdin.to_vec())),
			stdin_fd: None,
			stdin_is_search_input: false,
			stdout: Box::new(SharedWriter { buf: stdout_buf.clone() }),
			stderr: Box::new(SharedWriter { buf: stderr_buf.clone() }),
			cwd,
			env: HashMap::new(),
			cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
		};

		let argv: Vec<OsString> = std::iter::once("ln")
			.chain(args)
			.map(OsString::from)
			.collect();

		let code = pi_uutils_ctx::scope(io, || run(argv));

		let out_str = String::from_utf8(stdout_buf.lock().clone()).unwrap();
		let err_str = String::from_utf8(stderr_buf.lock().clone()).unwrap();

		(code, out_str, err_str)
	}

	fn run_in(cwd: PathBuf, args: Vec<&str>) -> (i32, String, String) {
		run_with_stdin(cwd, args, b"")
	}

	/// Canonicalized temp dir (macOS tempdirs live behind /var -> /private/var,
	/// which canonicalizing code paths would otherwise expand mid-assertion).
	fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let canon = fs::canonicalize(dir.path()).unwrap();
		(dir, canon)
	}

	#[cfg(unix)]
	#[test]
	fn symlink_relative_operands_create_in_scope_cwd_with_literal_content() {
		let (_dir, root) = canonical_tempdir();

		// Relative operands + scope cwd differing from the process cwd: only
		// the call-site `pi_uutils_ctx::resolve` patch places the link in the
		// tempdir — while the CONTENT must stay exactly as typed.
		let (code, stdout, stderr) = run_in(root.clone(), vec!["-s", "target", "link"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));

		let link = root.join("link");
		assert!(link.is_symlink(), "link must be created inside the scope cwd");
		assert_eq!(fs::read_link(&link).unwrap(), PathBuf::from("target"));
	}

	#[cfg(unix)]
	#[test]
	fn hard_link_shares_inode() {
		use std::os::unix::fs::MetadataExt;

		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a"), b"payload").unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["a", "b"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));

		assert_eq!(fs::read(root.join("b")).unwrap(), b"payload");
		assert_eq!(fs::metadata(root.join("a")).unwrap().nlink(), 2);
		assert_eq!(
			fs::metadata(root.join("a")).unwrap().ino(),
			fs::metadata(root.join("b")).unwrap().ino()
		);
	}

	#[cfg(unix)]
	#[test]
	fn existing_destination_without_force_fails_with_file_exists() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("link"), b"old").unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["-s", "target", "link"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "ln: failed to create symbolic link 'link': File exists\n");
		assert_eq!(fs::read(root.join("link")).unwrap(), b"old", "destination must be untouched");
	}

	#[cfg(unix)]
	#[test]
	fn force_overwrites_existing_destination() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("link"), b"old").unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["-sf", "target", "link"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert_eq!(fs::read_link(root.join("link")).unwrap(), PathBuf::from("target"));
	}

	#[cfg(unix)]
	#[test]
	fn verbose_symlink_prints_mapping_to_stdout() {
		let (_dir, root) = canonical_tempdir();

		let (code, stdout, stderr) = run_in(root, vec!["-sv", "target", "link"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "'link' -> 'target'\n");
		assert_eq!(stderr, "");
	}

	#[cfg(unix)]
	#[test]
	fn interactive_prompt_reads_ctx_stdin() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("link"), b"old").unwrap();

		// Decline: destination untouched, some-links-failed exit code, no
		// dangling "ln: " diagnostic beyond the prompt itself.
		let (code, stdout, stderr) =
			run_with_stdin(root.clone(), vec!["-si", "target", "link"], b"n\n");
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "ln: replace 'link'? ");
		assert!(!root.join("link").is_symlink());

		// Accept: existing file is replaced by the symlink.
		let (code, _, stderr) = run_with_stdin(root.clone(), vec!["-si", "target", "link"], b"y\n");
		assert_eq!(code, 0);
		assert_eq!(stderr, "ln: replace 'link'? ");
		assert_eq!(fs::read_link(root.join("link")).unwrap(), PathBuf::from("target"));
	}

	#[cfg(unix)]
	#[test]
	fn relative_flag_computes_link_text_against_scope_cwd() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("target"), b"x").unwrap();
		fs::create_dir(root.join("sub")).unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["-sr", "target", "sub/link"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert_eq!(fs::read_link(root.join("sub").join("link")).unwrap(), PathBuf::from("../target"));
	}

	#[cfg(unix)]
	#[test]
	fn target_directory_flag_places_links_in_directory() {
		let (_dir, root) = canonical_tempdir();
		fs::create_dir(root.join("d")).unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), vec!["-s", "-t", "d", "x"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert_eq!(fs::read_link(root.join("d").join("x")).unwrap(), PathBuf::from("x"));
	}

	#[test]
	fn missing_destination_is_an_error() {
		let (_dir, root) = canonical_tempdir();

		let (code, stdout, stderr) = run_in(root, vec!["-T", "only"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(
			stderr.contains("missing destination file operand after 'only'"),
			"stderr was: {stderr:?}"
		);
	}

	#[test]
	fn help_renders_to_scope_stdout() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec!["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("Make links between files."));
		assert_eq!(stderr, "");
	}
}

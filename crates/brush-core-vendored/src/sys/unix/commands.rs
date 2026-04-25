//! Command execution utilities.

use std::io;
pub use std::os::unix::process::{CommandExt, ExitStatusExt};

use command_fds::{CommandFdExt, FdMapping};

use crate::{ShellFd, error, openfiles};

/// Extension trait for injecting file descriptors into commands.
pub trait CommandFdInjectionExt {
	/// Injects the given open files as file descriptors into the command.
	///
	/// # Arguments
	///
	/// * `open_files` - A mapping of child file descriptors to open files.
	fn inject_fds(
		&mut self,
		open_files: impl Iterator<Item = (ShellFd, openfiles::OpenFile)>,
	) -> Result<(), error::Error>;
}

impl CommandFdInjectionExt for std::process::Command {
	fn inject_fds(
		&mut self,
		open_files: impl Iterator<Item = (ShellFd, openfiles::OpenFile)>,
	) -> Result<(), error::Error> {
		let fd_mappings = open_files
			.map(|(child_fd, open_file)| FdMapping {
				child_fd,
				parent_fd: open_file.into_owned_fd().unwrap(),
			})
			.collect();
		self
			.fd_mappings(fd_mappings)
			.map_err(|_e| error::ErrorKind::ChildCreationFailure)?;

		Ok(())
	}
}

/// Extension trait for arranging for commands to take the foreground.
pub trait CommandFgControlExt {
	/// Arranges for the command to take the foreground when it is executed.
	fn take_foreground(&mut self);
}

impl CommandFgControlExt for std::process::Command {
	fn take_foreground(&mut self) {
		// SAFETY:
		// This arranges for a provided function to run in the context of
		// the forked process before it exec's the target command. In general,
		// rust can't guarantee safety of code running in such a context.
		unsafe {
			self.pre_exec(setup_process_before_exec);
		}
	}
}

fn setup_process_before_exec() -> Result<(), io::Error> {
	use crate::sys;

	sys::terminal::move_self_to_foreground().map_err(io::Error::other)?;
	Ok(())
}

/// Extension trait for detaching a command from the parent's controlling terminal.
pub trait CommandSessionExt {
	/// Arranges for the command to run in a new POSIX session with no
	/// controlling terminal. This prevents the child from being able to steal
	/// terminal foreground from the parent (e.g. via `tcsetpgrp(/dev/tty)` in
	/// `zsh -i`-style init paths) and ensures `/dev/tty` access in the child
	/// fails fast instead of suspending the child via SIGTTIN/SIGTTOU.
	fn detach_session(&mut self);
}

impl CommandSessionExt for std::process::Command {
	fn detach_session(&mut self) {
		// SAFETY:
		// pre_exec runs in the forked child between fork and exec. We only call
		// `setsid(2)`, which is async-signal-safe.
		unsafe {
			self.pre_exec(detach_session_before_exec);
		}
	}
}

fn detach_session_before_exec() -> Result<(), io::Error> {
	// `setsid` creates a new session and process group, dissociating from any
	// controlling terminal inherited from the parent.
	//
	// EPERM means we are already a session leader; this can't normally happen
	// for a freshly forked child, but we tolerate it defensively so the spawn
	// is never broken by a transient state.
	match nix::unistd::setsid() {
		Ok(_) => Ok(()),
		Err(nix::errno::Errno::EPERM) => Ok(()),
		Err(errno) => Err(io::Error::from_raw_os_error(errno as i32)),
	}
}
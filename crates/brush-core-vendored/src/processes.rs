//! Process management

use std::io::Write;

use tokio_util::sync::CancellationToken;

use crate::{error, openfiles::OpenFile, sys};

struct CompletionMarker {
	output:            OpenFile,
	end_marker_prefix: String,
	end_marker_suffix: String,
}

/// Tracks a child process being awaited.
pub struct ChildProcess {
    /// If available, the process ID of the child.
    pid: Option<sys::process::ProcessId>,
    /// Child process handle kept alive for cancellation/termination.
    child: sys::process::Child,
    /// Tracks whether this process has already been reaped.
    reaped: bool,
    completion_marker: Option<CompletionMarker>,
}

impl ChildProcess {
    /// Wraps a child process and its future.
    pub fn new(pid: Option<sys::process::ProcessId>, child: sys::process::Child) -> Self {
        Self { pid, child, reaped: false, completion_marker: None }
    }

    /// Returns the process's ID.
    pub const fn pid(&self) -> Option<sys::process::ProcessId> {
        self.pid
    }

    pub(crate) fn set_completion_marker(
        &mut self,
        output: OpenFile,
        end_marker_prefix: String,
        end_marker_suffix: String,
    ) {
        self.completion_marker =
            Some(CompletionMarker { output, end_marker_prefix, end_marker_suffix });
    }

    /// Waits for the process to exit.
    ///
    /// If a cancellation token is provided and triggered, the process will be killed.
    pub async fn wait(
        &mut self,
        cancel_token: Option<CancellationToken>,
    ) -> Result<ProcessWaitResult, error::Error> {
        #[allow(unused_mut, reason = "only mutated on some platforms")]
        let mut sigtstp = sys::signal::tstp_signal_listener()?;
        #[allow(unused_mut, reason = "only mutated on some platforms")]
        let mut sigchld = sys::signal::chld_signal_listener()?;

        let cancelled = async {
            match &cancel_token {
                Some(token) => token.cancelled().await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(cancelled);

        #[allow(clippy::ignored_unit_patterns)]
        loop {
            let status = {
                let wait_future = self.child.wait();
                tokio::pin!(wait_future);
                tokio::select! {
                    status = &mut wait_future => Some(status),
                    _ = &mut cancelled => None,
                    _ = sigtstp.recv() => return Ok(ProcessWaitResult::Stopped),
                    _ = sigchld.recv() => {
                        if sys::signal::poll_for_stopped_children()? {
                            return Ok(ProcessWaitResult::Stopped);
                        }
                        continue;
                    },
                    _ = sys::signal::await_ctrl_c() => {
                        // SIGINT got thrown. Handle it and continue looping. The child should
                        // have received it as well, and either handled it or ended up getting
                        // terminated (in which case we'll see the child exit).
                        continue;
                    },
                }
            };

            return match status {
                Some(status) => {
                    let status = status?;
                    let marker_exit_code = completion_exit_code(&status);
                    self.reaped = true;
                    self.write_completion_marker(marker_exit_code);
                    Ok(ProcessWaitResult::Completed(output_from_status(status)))
                }
                None => {
                    if self.child.kill().await.is_ok() {
                        self.reaped = true;
                    } else if let Ok(Some(_)) = self.child.try_wait() {
                        self.reaped = true;
                    }
                    self.write_completion_marker(130);
                    Ok(ProcessWaitResult::Cancelled)
                }
            };
        }
    }

    fn write_completion_marker(&mut self, exit_code: i32) {
        if let Some(mut marker) = self.completion_marker.take() {
            let _ = write!(
                marker.output,
                "{}{}{}",
                marker.end_marker_prefix, exit_code, marker.end_marker_suffix
            );
            let _ = marker.output.flush();
        }
    }

    /// Sends a kill signal and attempts a synchronous reap if still running.
    fn kill(&mut self) {
        if self.reaped {
            return;
        }

        if let Ok(Some(_)) = self.child.try_wait() {
            self.reaped = true;
            return;
        }
        let _ = self.child.start_kill();
        if let Ok(Some(_)) = self.child.try_wait() {
            self.reaped = true;
    }
    }

    pub(crate) fn poll(&mut self) -> Option<Result<std::process::Output, error::Error>> {
        match self.child.try_wait() {
            Ok(Some(status)) => {
                self.reaped = true;
                Some(Ok(output_from_status(status)))
            }
            Ok(None) => None,
            Err(err) => Some(Err(err.into())),
        }
    }
}

impl Drop for ChildProcess {
    fn drop(&mut self) {
        // Ensure we don't leak zombie processes.
        self.kill();
    }
}

fn output_from_status(status: std::process::ExitStatus) -> std::process::Output {
    std::process::Output { status, stdout: Vec::new(), stderr: Vec::new() }
}

fn completion_exit_code(status: &std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt as _;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }

    127
}

/// Represents the result of waiting for an executing process.
pub enum ProcessWaitResult {
    /// The process completed.
    Completed(std::process::Output),
    /// The process stopped and has not yet completed.
    Stopped,
    /// The process was killed due to cancellation.
    Cancelled,
}

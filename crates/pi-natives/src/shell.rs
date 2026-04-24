//! Brush-based shell execution exported via N-API.
//!
//! # Overview
//! Executes shell commands in a non-interactive brush-core shell, streaming
//! output back to JavaScript via a threadsafe callback.
//!
//! # Example
//! ```ignore
//! const shell = new natives.Shell();
//! const result = await shell.run({ command: "ls" }, (chunk) => {
//!   console.log(chunk);
//! });
//! ```

#[cfg(windows)]
use std::collections::HashSet;
use std::{
	collections::HashMap,
	fs,
	io::{self, Write},
	str,
	sync::Arc,
	time::Duration,
};

#[cfg(windows)]
mod windows;

mod minimizer;

use brush_builtins::{BuiltinSet, default_builtins};
use brush_core::{
	CreateOptions, ExecutionContext, ExecutionControlFlow, ExecutionExitCode, ExecutionResult,
	ProcessGroupPolicy, Shell as BrushShell, ShellValue, ShellVariable, builtins,
	env::EnvironmentScope,
	openfiles::{self, OpenFile, OpenFiles},
};
use clap::Parser;
use napi::{
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
	tokio::{
		self,
		sync::{Mutex as TokioMutex, mpsc},
		time,
	},
};
use napi_derive::napi;
#[cfg(not(unix))]
use tokio::io::AsyncReadExt as _;
use tokio_util::sync::CancellationToken;
#[cfg(windows)]
use windows::configure_windows_path;

use crate::task;

const TERM_SIGNAL: i32 = 15;
const KILL_SIGNAL: i32 = 9;

struct ShellSessionCore {
	shell: BrushShell,
}

#[derive(Clone, Default)]
struct ShellAbortState(Arc<TokioMutex<Option<task::AbortToken>>>);

impl ShellAbortState {
	async fn set(&self, abort_token: task::AbortToken) {
		*self.0.lock().await = Some(abort_token);
	}

	async fn clear(&self) {
		*self.0.lock().await = None;
	}

	async fn abort(&self) {
		let abort_token = self.0.lock().await.clone();
		if let Some(abort_token) = abort_token {
			abort_token.abort(task::AbortReason::Signal);
		}
	}
}

#[derive(Clone)]
struct ShellConfig {
	session_env:   Option<HashMap<String, String>>,
	snapshot_path: Option<String>,
	minimizer:     Option<minimizer::MinimizerConfig>,
}

/// Options for configuring a persistent shell session.
#[napi(object)]
pub struct ShellOptions {
	/// Environment variables to apply once per session.
	pub session_env:   Option<HashMap<String, String>>,
	/// Optional snapshot file to source on session creation.
	pub snapshot_path: Option<String>,
	/// Optional per-command output minimizer configuration.
	pub minimizer:     Option<minimizer::MinimizerOptions>,
}

/// Options for running a shell command (internal, lifetime-free).
struct ShellRunConfig {
	/// Command string to execute in the shell.
	command:   String,
	/// Working directory for the command.
	cwd:       Option<String>,
	/// Environment variables to apply for this command only.
	env:       Option<HashMap<String, String>>,
	/// Resolved output minimizer config for this command.
	minimizer: Option<minimizer::MinimizerConfig>,
}

/// Options for running a shell command.
#[napi(object)]
pub struct ShellRunOptions<'env> {
	/// Command string to execute in the shell.
	pub command:    String,
	/// Working directory for the command.
	pub cwd:        Option<String>,
	/// Environment variables to apply for this command only.
	pub env:        Option<HashMap<String, String>>,
	/// Timeout in milliseconds before cancelling the command.
	pub timeout_ms: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:     Option<Unknown<'env>>,
}

/// Telemetry for a single minimization, surfaced when the minimizer
/// actually rewrote the command's output. The session layer is expected to
/// persist `original_text` via its `ArtifactManager` and splice the
/// resulting `artifact://<id>` reference into whatever is shown to the
/// agent.
#[napi(object)]
pub struct MinimizerResult {
	/// Dispatch label produced by the minimizer (e.g. `"git"`,
	/// `"pipeline:gradle"`, `"pipeline+builtin"`).
	pub filter:        String,
	/// The full original capture, before minimization.
	pub original_text: String,
	/// Captured byte length before minimization.
	pub input_bytes:   u32,
	/// Byte length of the minimized text the consumer received.
	pub output_bytes:  u32,
}

/// Result of running a shell command.
#[napi(object)]
pub struct ShellRunResult {
	/// Exit code when the command completes normally.
	pub exit_code: Option<i32>,
	/// Whether the command was cancelled via abort.
	pub cancelled: bool,
	/// Whether the command timed out before completion.
	pub timed_out: bool,
	/// When the minimizer rewrote the captured output, this carries the
	/// original buffer + telemetry so the session layer can persist it as
	/// an artifact and splice an `artifact://<id>` reference into the
	/// minimized text shown to the agent. `None` when nothing was rewritten.
	pub minimized: Option<MinimizerResult>,
}

/// Persistent brush-core shell session.
#[napi]
pub struct Shell {
	session:     Arc<TokioMutex<Option<ShellSessionCore>>>,
	abort_state: ShellAbortState,
	config:      ShellConfig,
}

#[napi]
impl Shell {
	#[napi(constructor)]
	/// Create a new shell session from optional configuration.
	///
	/// The options set session-scoped environment variables and a snapshot path.
	pub fn new(options: Option<ShellOptions>) -> Self {
		let config = match options {
			None => ShellConfig { session_env: None, snapshot_path: None, minimizer: None },
			Some(opt) => {
				let minimizer = opt
					.minimizer
					.as_ref()
					.map(minimizer::MinimizerConfig::from_options);
				ShellConfig {
					session_env: opt.session_env,
					snapshot_path: opt.snapshot_path,
					minimizer,
				}
			},
		};
		Self {
			session: Arc::new(TokioMutex::new(None)),
			abort_state: ShellAbortState::default(),
			config,
		}
	}

	/// Run a shell command using the provided options.
	///
	/// The `on_chunk` callback receives streamed stdout/stderr output. Returns
	/// the exit code when the command completes, or flags when cancelled or
	/// timed out.
	#[napi]
	pub fn run<'e>(
		&self,
		env: &'e Env,
		options: ShellRunOptions<'e>,
		#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
		on_chunk: Option<ThreadsafeFunction<String>>,
	) -> Result<PromiseRaw<'e, ShellRunResult>> {
		let ct = task::CancelToken::new(options.timeout_ms, options.signal);
		let session = self.session.clone();
		let abort_state = self.abort_state.clone();
		let config = self.config.clone();

		let run_config = ShellRunConfig {
			command:   options.command,
			cwd:       options.cwd,
			env:       options.env,
			minimizer: config.minimizer.clone(),
		};

		task::future(env, "shell.run", async move {
			run_shell_session(session, abort_state, config, run_config, on_chunk, ct).await
		})
	}

	/// Abort all running commands for this shell session.
	///
	/// Returns `Ok(())` even when no commands are running.
	#[napi]
	pub async fn abort(&self) -> Result<()> {
		self.abort_state.abort().await;
		Ok(())
	}
}

/// Run a shell command within a persistent session.
async fn run_shell_session(
	session: Arc<TokioMutex<Option<ShellSessionCore>>>,
	abort_state: ShellAbortState,
	config: ShellConfig,
	run_config: ShellRunConfig,
	on_chunk: Option<ThreadsafeFunction<String>>,
	mut ct: task::CancelToken,
) -> Result<ShellRunResult> {
	let tokio_cancel = CancellationToken::new();

	let mut run_task = tokio::spawn({
		let session = session.clone();
		let abort_state = abort_state.clone();
		let tokio_cancel = tokio_cancel.clone();
		let at = ct.emplace_abort_token();
		async move {
			let mut session_guard = session.lock().await;

			let session = match &mut *session_guard {
				Some(session) => session,
				None => session_guard.insert(create_session(&config).await?),
			};
			abort_state.set(at).await;
			run_shell_command(session, &run_config, on_chunk, tokio_cancel).await
		}
	});

	let res = tokio::select! {
		res = &mut run_task => res,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			let graceful = time::timeout(Duration::from_secs(2), &mut run_task).await;
			if graceful.is_err() {
				run_task.abort();
				let _ = run_task.await;
			}
			abort_state.clear().await;
			// Use try_lock to avoid deadlocking if another task holds the session.
			// If we can't acquire the lock, the session will be cleaned up when the
			// holding task finishes.
			if let Ok(mut guard) = session.try_lock() {
				*guard = None;
			}
			return Ok(ShellRunResult {
				exit_code: None,
				cancelled: matches!(reason, task::AbortReason::Signal),
				timed_out: matches!(reason, task::AbortReason::Timeout),
				minimized: None,
			});
		}
	};
	let res =
		res.unwrap_or_else(|e| Err(Error::from_reason(format!("Shell execution task failed: {e}"))));
	abort_state.clear().await;

	let keepalive = res.as_ref().is_ok_and(|pair| session_keepalive(&pair.0));
	if !keepalive {
		*session.lock().await = None;
	}
	let (exec, minimized) = res?;
	Ok(ShellRunResult {
		exit_code: Some(exit_code(&exec)),
		cancelled: false,
		timed_out: false,
		minimized,
	})
}

/// Options for executing a shell command via brush-core.
#[napi(object)]
pub struct ShellExecuteOptions<'env> {
	/// Command string to execute in the shell.
	pub command:       String,
	/// Working directory for the command.
	pub cwd:           Option<String>,
	/// Environment variables to apply for this command only.
	pub env:           Option<HashMap<String, String>>,
	/// Environment variables to apply once per session.
	pub session_env:   Option<HashMap<String, String>>,
	/// Timeout in milliseconds before cancelling the command.
	pub timeout_ms:    Option<u32>,
	/// Optional snapshot file to source on session creation.
	pub snapshot_path: Option<String>,
	/// Optional per-command output minimizer configuration.
	pub minimizer:     Option<minimizer::MinimizerOptions>,
	/// Abort signal for cancelling the operation.
	pub signal:        Option<Unknown<'env>>,
}

/// Result of executing a shell command via brush-core.
#[napi(object)]
pub struct ShellExecuteResult {
	/// Exit code when the command completes normally.
	pub exit_code: Option<i32>,
	/// Whether the command was cancelled via abort.
	pub cancelled: bool,
	/// Whether the command timed out before completion.
	pub timed_out: bool,
	/// See [`ShellRunResult::minimized`].
	pub minimized: Option<MinimizerResult>,
}

/// Execute a brush shell command.
///
/// Creates a fresh session for each call. The `on_chunk` callback receives
/// streamed stdout/stderr output. Returns the exit code when the command
/// completes, or flags when cancelled or timed out.
#[napi]
pub fn execute_shell<'env>(
	env: &'env Env,
	options: ShellExecuteOptions<'env>,
	#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
	on_chunk: Option<ThreadsafeFunction<String>>,
) -> Result<PromiseRaw<'env, ShellExecuteResult>> {
	let minimizer = options
		.minimizer
		.as_ref()
		.map(minimizer::MinimizerConfig::from_options);
	let config = ShellConfig {
		session_env:   options.session_env,
		snapshot_path: options.snapshot_path,
		minimizer:     minimizer.clone(),
	};
	let run_config =
		ShellRunConfig { command: options.command, cwd: options.cwd, env: options.env, minimizer };

	let ct = task::CancelToken::new(options.timeout_ms, options.signal);
	task::future(env, "shell.execute", async move {
		run_shell_oneshot(config, run_config, on_chunk, ct).await
	})
}

/// Run a shell command in a fresh session (one-shot execution).
async fn run_shell_oneshot(
	config: ShellConfig,
	run_config: ShellRunConfig,
	on_chunk: Option<ThreadsafeFunction<String>>,
	ct: task::CancelToken,
) -> Result<ShellExecuteResult> {
	let tokio_cancel = CancellationToken::new();

	let mut task = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		async move {
			let mut session = create_session(&config).await?;
			run_shell_command(&mut session, &run_config, on_chunk, tokio_cancel).await
		}
	});

	let run_result = tokio::select! {
		result = &mut task => result,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			let graceful = time::timeout(Duration::from_secs(2), &mut task).await;
			if graceful.is_err() {
				task.abort();
				let _ = task.await;
			}
			return Ok(ShellExecuteResult {
				exit_code: None,
				cancelled: matches!(reason, task::AbortReason::Signal),
				timed_out: matches!(reason, task::AbortReason::Timeout),
				minimized: None,
			})
		},
	};

	let res = run_result
		.unwrap_or_else(|e| Err(Error::from_reason(format!("Shell execution task failed: {e}"))));

	let (exec, minimized) = res?;
	Ok(ShellExecuteResult {
		exit_code: Some(exit_code(&exec)),
		cancelled: false,
		timed_out: false,
		minimized,
	})
}

fn null_file() -> Result<OpenFile> {
	openfiles::null().map_err(|err| Error::from_reason(format!("Failed to create null file: {err}")))
}

const fn exit_code(result: &ExecutionResult) -> i32 {
	match result.exit_code {
		ExecutionExitCode::Success => 0,
		ExecutionExitCode::GeneralError => 1,
		ExecutionExitCode::InvalidUsage => 2,
		ExecutionExitCode::Unimplemented => 99,
		ExecutionExitCode::CannotExecute => 126,
		ExecutionExitCode::NotFound => 127,
		ExecutionExitCode::Interrupted => 130,
		ExecutionExitCode::Custom(code) => code as i32,
	}
}

#[cfg(windows)]
const fn normalize_env_key(key: &str) -> &str {
	if key.eq_ignore_ascii_case("PATH") {
		"PATH"
	} else {
		key
	}
}

#[cfg(not(windows))]
const fn normalize_env_key(key: &str) -> &str {
	key
}

#[cfg(windows)]
fn merge_path_values(existing: &str, incoming: &str) -> String {
	let mut merged = Vec::new();
	let mut seen = HashSet::new();
	push_unique_paths(&mut merged, &mut seen, existing);
	push_unique_paths(&mut merged, &mut seen, incoming);

	std::env::join_paths(merged.iter())
		.map_or_else(|_| merged.join(";"), |paths| paths.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn push_unique_paths(merged: &mut Vec<String>, seen: &mut HashSet<String>, value: &str) {
	for segment in std::env::split_paths(value) {
		let segment_str = segment.to_string_lossy().into_owned();
		let normalized = normalize_path_segment(&segment_str);
		if normalized.is_empty() {
			continue;
		}
		if seen.insert(normalized) {
			merged.push(segment_str);
		}
	}
}

#[cfg(windows)]
fn normalize_path_segment(segment: &str) -> String {
	let trimmed = segment.trim().trim_matches('"');
	if trimmed.is_empty() {
		return String::new();
	}

	let mut normalized = std::path::PathBuf::new();
	for component in std::path::Path::new(trimmed).components() {
		normalized.push(component.as_os_str());
	}

	normalized.to_string_lossy().to_ascii_lowercase()
}

#[cfg(not(windows))]
fn merge_path_values(_existing: &str, incoming: &str) -> String {
	incoming.to_string()
}

async fn create_session(config: &ShellConfig) -> Result<ShellSessionCore> {
	let create_options = CreateOptions {
		interactive: false,
		login: false,
		no_profile: true,
		no_rc: true,
		do_not_inherit_env: true,
		builtins: default_builtins(BuiltinSet::BashMode),
		..Default::default()
	};

	let mut shell = BrushShell::new(create_options)
		.await
		.map_err(|err| Error::from_reason(format!("Failed to initialize shell: {err}")))?;

	if let Some(exec_builtin) = shell.builtin_mut("exec") {
		exec_builtin.disabled = true;
	}
	if let Some(suspend_builtin) = shell.builtin_mut("suspend") {
		suspend_builtin.disabled = true;
	}
	shell.register_builtin("sleep", builtins::builtin::<SleepCommand>());
	shell.register_builtin("timeout", builtins::builtin::<TimeoutCommand>());

	let mut merged_path: Option<String> = None;
	for (key, value) in std::env::vars() {
		let normalized_key = normalize_env_key(&key);
		if should_skip_env_var(normalized_key) {
			continue;
		}
		if normalized_key == "PATH" {
			merged_path = Some(match merged_path {
				Some(existing) => merge_path_values(&existing, &value),
				None => value,
			});
			continue;
		}
		let mut var = ShellVariable::new(ShellValue::String(value));
		var.export();
		shell
			.env
			.set_global(normalized_key, var)
			.map_err(|err| Error::from_reason(format!("Failed to set env: {err}")))?;
	}

	#[cfg(windows)]
	if merged_path.is_none()
		&& let Some(value) = std::env::var_os("Path").or_else(|| std::env::var_os("PATH"))
	{
		merged_path = Some(value.to_string_lossy().into_owned());
	}

	if let Some(path_value) = merged_path {
		let mut var = ShellVariable::new(ShellValue::String(path_value));
		var.export();
		shell
			.env
			.set_global("PATH", var)
			.map_err(|err| Error::from_reason(format!("Failed to set env: {err}")))?;
	}

	if let Some(env) = config.session_env.as_ref() {
		for (key, value) in env {
			let normalized_key = normalize_env_key(key);
			if should_skip_env_var(normalized_key) {
				continue;
			}
			let mut var = ShellVariable::new(ShellValue::String(value.clone()));
			var.export();
			shell
				.env
				.set_global(normalized_key, var)
				.map_err(|err| Error::from_reason(format!("Failed to set env: {err}")))?;
		}
	}

	#[cfg(windows)]
	configure_windows_path(&mut shell)?;

	if let Some(snapshot_path) = config.snapshot_path.as_ref() {
		source_snapshot(&mut shell, snapshot_path).await?;
	}

	Ok(ShellSessionCore { shell })
}

async fn source_snapshot(shell: &mut BrushShell, snapshot_path: &str) -> Result<()> {
	let mut params = shell.default_exec_params();
	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, null_file()?);
	params.set_fd(OpenFiles::STDERR_FD, null_file()?);

	let escaped = snapshot_path.replace('\'', "'\\''");
	let command = format!("source '{escaped}'");
	shell
		.run_string(command, &params)
		.await
		.map_err(|err| Error::from_reason(format!("Failed to source snapshot: {err}")))?;
	Ok(())
}

async fn run_shell_command(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	on_chunk: Option<ThreadsafeFunction<String>>,
	cancel_token: CancellationToken,
) -> Result<(ExecutionResult, Option<MinimizerResult>)> {
	if let Some(cwd) = options.cwd.as_deref() {
		session
			.shell
			.set_working_dir(cwd)
			.map_err(|err| Error::from_reason(format!("Failed to set cwd: {err}")))?;
	}

	let (reader_file, writer_file) = pipe_to_files("output")?;

	let stdout_file = OpenFile::from(
		writer_file
			.try_clone()
			.map_err(|err| Error::from_reason(format!("Failed to clone pipe: {err}")))?,
	);
	let stderr_file = OpenFile::from(writer_file);

	let mut params = session.shell.default_exec_params();
	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
	params.set_fd(OpenFiles::STDERR_FD, stderr_file);
	params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
	params.set_cancel_token(cancel_token.clone());

	let mut env_scope_pushed = false;
	if let Some(env) = options.env.as_ref() {
		session.shell.env.push_scope(EnvironmentScope::Command);
		env_scope_pushed = true;
		for (key, value) in env {
			let normalized_key = normalize_env_key(key);
			if should_skip_env_var(normalized_key) {
				continue;
			}
			let mut var = ShellVariable::new(ShellValue::String(value.clone()));
			var.export();
			if let Err(err) = session
				.shell
				.env
				.add(normalized_key, var, EnvironmentScope::Command)
			{
				let _ = session.shell.env.pop_scope(EnvironmentScope::Command);
				return Err(Error::from_reason(format!("Failed to set env: {err}")));
			}
		}
	}

	let should_minimize = if let Some(config) = options.minimizer.as_ref() {
		minimizer::engine::should_minimize(&options.command, config)
	} else {
		false
	};
	let max_capture_bytes = if let Some(config) = options.minimizer.as_ref() {
		config.max_capture_bytes as usize
	} else {
		0
	};

	let reader_cancel = CancellationToken::new();
	let (activity_tx, mut activity_rx) = mpsc::channel::<()>(1);
	let (reader_callback, final_callback) = if should_minimize {
		(None, on_chunk)
	} else {
		(on_chunk, None)
	};
	let mut reader_handle = tokio::spawn({
		let reader_cancel = reader_cancel.clone();
		async move {
			if should_minimize {
				let output =
					read_output_buffered(reader_file, reader_cancel, activity_tx, max_capture_bytes)
						.await;
				Result::<OutputRead>::Ok(OutputRead::Buffered(output))
			} else {
				Box::pin(read_output(reader_file, reader_callback, reader_cancel, activity_tx)).await;
				Result::<OutputRead>::Ok(OutputRead::Streaming)
			}
		}
	});
	let cancel_bridge = tokio::spawn({
		let cancel_token = cancel_token.clone();
		let reader_cancel = reader_cancel.clone();
		async move {
			cancel_token.cancelled().await;
			reader_cancel.cancel();
		}
	});
	let result = session
		.shell
		.run_string(options.command.clone(), &params)
		.await;

	if cancel_token.is_cancelled() {
		terminate_background_jobs(&session.shell);
	}

	if env_scope_pushed {
		session
			.shell
			.env
			.pop_scope(EnvironmentScope::Command)
			.map_err(|err| Error::from_reason(format!("Failed to pop env scope: {err}")))?;
	}

	drop(params);

	// The foreground command can complete while background jobs keep the
	// stdout/stderr pipe open. Don't hang forever waiting for EOF; drain output
	// for a short period, then cancel.
	const POST_EXIT_IDLE: Duration = Duration::from_millis(250);
	const POST_EXIT_MAX: Duration = Duration::from_secs(2);
	const READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);

	let mut reader_finished = false;
	let mut reader_output = None;
	let mut idle_timer = Box::pin(time::sleep(POST_EXIT_IDLE));
	let mut max_timer = Box::pin(time::sleep(POST_EXIT_MAX));

	loop {
		tokio::select! {
			res = &mut reader_handle => {
				if let Ok(Ok(output)) = res {
					reader_output = Some(output);
				}
				reader_finished = true;
				break;
			}
			msg = activity_rx.recv() => {
				if msg.is_none() {
					break;
				}
				idle_timer.as_mut().reset(time::Instant::now() + POST_EXIT_IDLE);
			}
			() = &mut idle_timer => break,
			() = &mut max_timer => break,
		}
	}

	if !reader_finished {
		reader_cancel.cancel();
		if let Ok(res) = time::timeout(READER_SHUTDOWN_TIMEOUT, &mut reader_handle).await {
			if let Ok(output) = res
				&& let Ok(output) = output
			{
				reader_output = Some(output);
			}
		} else {
			reader_handle.abort();
			let _ = reader_handle.await;
		}
	}
	cancel_bridge.abort();
	let _ = cancel_bridge.await;

	let result =
		result.map_err(|err| Error::from_reason(format!("Shell execution failed: {err}")))?;
	let mut minimized_out: Option<MinimizerResult> = None;
	if let Some(OutputRead::Buffered(output)) = reader_output
		&& let Some(config) = options.minimizer.as_ref()
	{
		if output.exceeded {
			emit_chunk(&output.text, final_callback.as_ref());
		} else {
			let minimized =
				minimizer::apply(&options.command, &output.text, exit_code(&result), config);
			emit_chunk(&minimized.text, final_callback.as_ref());
			if minimized.changed
				&& let Some(original) = minimized.original_text
			{
				minimized_out = Some(MinimizerResult {
					filter:        minimized.filter.to_string(),
					original_text: original,
					input_bytes:   u32::try_from(minimized.input_bytes).unwrap_or(u32::MAX),
					output_bytes:  u32::try_from(minimized.text.len()).unwrap_or(u32::MAX),
				});
			}
		}
	}
	Ok((result, minimized_out))
}

#[cfg(unix)]
fn terminate_background_jobs(shell: &BrushShell) {
	if shell.jobs.jobs.is_empty() {
		return;
	}
	let mut pgids = Vec::new();
	let mut pids = Vec::new();
	for job in &shell.jobs.jobs {
		if let Some(pgid) = job.process_group_id()
			&& !pgids.contains(&pgid)
		{
			pgids.push(pgid);
		}
		if let Some(pid) = job.representative_pid()
			&& !pids.contains(&pid)
		{
			pids.push(pid);
		}
	}
	if pgids.is_empty() && pids.is_empty() {
		return;
	}

	for &pgid in &pgids {
		let _ = crate::ps::kill_process_group(pgid, TERM_SIGNAL);
	}
	for &pid in &pids {
		let _ = crate::ps::kill_tree(pid, TERM_SIGNAL);
	}

	tokio::spawn(async move {
		time::sleep(Duration::from_millis(500)).await;
		for pid in pgids {
			let _ = crate::ps::kill_process_group(pid, KILL_SIGNAL);
		}
		for pid in pids {
			let _ = crate::ps::kill_tree(pid, KILL_SIGNAL);
		}
	});
}

#[cfg(windows)]
fn terminate_background_jobs(shell: &BrushShell) {
	if shell.jobs.jobs.is_empty() {
		return;
	}
	let mut pids = Vec::new();
	for job in &shell.jobs.jobs {
		if let Some(pid) = job.representative_pid()
			&& !pids.contains(&pid)
		{
			pids.push(pid);
		}
	}
	if pids.is_empty() {
		return;
	}

	for &pid in &pids {
		let _ = crate::ps::kill_tree(pid, TERM_SIGNAL);
	}

	tokio::spawn(async move {
		time::sleep(Duration::from_millis(500)).await;
		for pid in pids {
			let _ = crate::ps::kill_tree(pid, KILL_SIGNAL);
		}
	});
}

fn should_skip_env_var(key: &str) -> bool {
	if key.starts_with("BASH_FUNC_") && key.ends_with("%%") {
		return true;
	}

	matches!(
		key,
		"BASH_ENV"
			| "ENV"
			| "HISTFILE"
			| "HISTTIMEFORMAT"
			| "HISTCMD"
			| "PS0"
			| "PS1"
			| "PS2"
			| "PS4"
			| "BRUSH_PS_ALT"
			| "READLINE_LINE"
			| "READLINE_POINT"
			| "BRUSH_VERSION"
			| "BASH"
			| "BASHOPTS"
			| "BASH_ALIASES"
			| "BASH_ARGV0"
			| "BASH_CMDS"
			| "BASH_SOURCE"
			| "BASH_SUBSHELL"
			| "BASH_VERSINFO"
			| "BASH_VERSION"
			| "SHELLOPTS"
			| "SHLVL"
			| "SHELL"
			| "COMP_WORDBREAKS"
			| "DIRSTACK"
			| "EPOCHREALTIME"
			| "EPOCHSECONDS"
			| "FUNCNAME"
			| "GROUPS"
			| "IFS"
			| "LINENO"
			| "MACHTYPE"
			| "OSTYPE"
			| "OPTERR"
			| "OPTIND"
			| "PIPESTATUS"
			| "PPID"
			| "PWD"
			| "OLDPWD"
			| "RANDOM"
			| "SRANDOM"
			| "SECONDS"
			| "UID"
			| "EUID"
			| "HOSTNAME"
			| "HOSTTYPE"
	)
}

const fn session_keepalive(result: &ExecutionResult) -> bool {
	match result.next_control_flow {
		ExecutionControlFlow::Normal => true,
		ExecutionControlFlow::BreakLoop { .. } => false,
		ExecutionControlFlow::ContinueLoop { .. } => false,
		ExecutionControlFlow::ReturnFromFunctionOrScript => false,
		ExecutionControlFlow::ExitShell => false,
	}
}

enum OutputRead {
	Streaming,
	Buffered(BufferedOutput),
}

struct BufferedOutput {
	text:     String,
	exceeded: bool,
}

async fn read_output(
	reader: fs::File,
	on_chunk: Option<ThreadsafeFunction<String>>,
	cancel_token: CancellationToken,
	activity: mpsc::Sender<()>,
) {
	const REPLACEMENT: &str = "\u{FFFD}";
	const BUF: usize = 65536;
	let mut buf = vec![0u8; BUF + 4]; // +4 for max UTF-8 char
	let mut it = 0;

	#[cfg(unix)]
	let Ok(reader) = register_nonblocking_pipe(reader) else {
		return;
	};
	#[cfg(not(unix))]
	let reader = tokio::fs::File::from_std(reader);
	#[cfg(not(unix))]
	tokio::pin!(reader);

	loop {
		#[cfg(unix)]
		let n = {
			let Ok(mut readiness) = (tokio::select! {
				ready = reader.readable() => ready,
				() = cancel_token.cancelled() => break,
			}) else {
				break;
			};
			match readiness.try_io(|inner| read_nonblocking(inner.get_ref(), &mut buf[it..BUF])) {
				Ok(Ok(0)) => break,
				Ok(Ok(n)) => n,
				Ok(Err(e)) if e.kind() == io::ErrorKind::Interrupted => continue,
				Ok(Err(_)) => break,
				Err(_would_block) => continue,
			}
		};
		#[cfg(not(unix))]
		let n = {
			let read_future = reader.read(&mut buf[it..BUF]);
			tokio::pin!(read_future);
			match tokio::select! {
				res = &mut read_future => res,
				() = cancel_token.cancelled() => break,
			} {
				Ok(0) => break, // EOF
				Ok(n) => n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		if n > 0 {
			let _ = activity.try_send(());
		}
		it += n;

		// Consume as much of `pending` as is decodable *right now*.
		while it > 0 {
			let pending = &buf[..it];
			match str::from_utf8(pending) {
				Ok(text) => {
					emit_chunk(text, on_chunk.as_ref());
					it = 0;
					break;
				},
				Err(err) => {
					let p = err.valid_up_to();
					if p > 0 {
						// SAFETY: [..p] is guaranteed valid UTF-8 by valid_up_to().
						let text = unsafe { str::from_utf8_unchecked(&pending[..p]) };
						emit_chunk(text, on_chunk.as_ref());
						// copy p..it to the beginning of the buffer
						buf.copy_within(p..it, 0);
						it -= p;
					}

					match err.error_len() {
						Some(p) => {
							// Invalid byte sequence: emit replacement and drop those bytes.
							emit_chunk(REPLACEMENT, on_chunk.as_ref());
							// copy p..it to the beginning of the buffer
							buf.copy_within(p..it, 0);
							it -= p;
							// continue loop in case more bytes remain after the
							// invalid sequence
						},
						None => {
							// Incomplete UTF-8 sequence at end: keep bytes for next read.
							break;
						},
					}
				},
			}
		}
	}

	// Flush whatever is left at EOF (including an incomplete final sequence).
	for chunk in buf[..it].utf8_chunks() {
		let valid = chunk.valid();
		if !valid.is_empty() {
			emit_chunk(valid, on_chunk.as_ref());
		}
		if !chunk.invalid().is_empty() {
			emit_chunk(REPLACEMENT, on_chunk.as_ref());
		}
	}
}

async fn read_output_buffered(
	reader: fs::File,
	cancel_token: CancellationToken,
	activity: mpsc::Sender<()>,
	max_capture_bytes: usize,
) -> BufferedOutput {
	const BUF: usize = 65536;
	let mut buf = vec![0u8; BUF];
	let mut captured = Vec::new();
	let mut exceeded = false;

	#[cfg(unix)]
	let Ok(reader) = register_nonblocking_pipe(reader) else {
		return BufferedOutput { text: String::new(), exceeded: true };
	};
	#[cfg(not(unix))]
	let reader = tokio::fs::File::from_std(reader);
	#[cfg(not(unix))]
	tokio::pin!(reader);

	loop {
		#[cfg(unix)]
		let n = {
			let Ok(mut readiness) = (tokio::select! {
				ready = reader.readable() => ready,
				() = cancel_token.cancelled() => break,
			}) else {
				break;
			};
			match readiness.try_io(|inner| read_nonblocking(inner.get_ref(), &mut buf)) {
				Ok(Ok(0)) => break,
				Ok(Ok(n)) => n,
				Ok(Err(e)) if e.kind() == io::ErrorKind::Interrupted => continue,
				Ok(Err(_)) => break,
				Err(_would_block) => continue,
			}
		};
		#[cfg(not(unix))]
		let n = {
			let read_future = reader.read(&mut buf);
			tokio::pin!(read_future);
			match tokio::select! {
				res = &mut read_future => res,
				() = cancel_token.cancelled() => break,
			} {
				Ok(0) => break,
				Ok(n) => n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		if n > 0 {
			let _ = activity.try_send(());
		}
		if captured.len().saturating_add(n) > max_capture_bytes {
			exceeded = true;
		}
		captured.extend_from_slice(&buf[..n]);
	}

	BufferedOutput { text: String::from_utf8_lossy(&captured).into_owned(), exceeded }
}

#[cfg(unix)]
fn register_nonblocking_pipe(reader: fs::File) -> io::Result<tokio::io::unix::AsyncFd<fs::File>> {
	set_nonblocking(&reader)?;
	tokio::io::unix::AsyncFd::new(reader)
}

#[cfg(unix)]
fn set_nonblocking<T: std::os::fd::AsRawFd>(file: &T) -> io::Result<()> {
	let fd = file.as_raw_fd();
	// SAFETY: `fd` is owned by `file` and remains valid for the duration of
	// these `fcntl` calls.
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
	if flags < 0 {
		return Err(io::Error::last_os_error());
	}
	if flags & libc::O_NONBLOCK != 0 {
		return Ok(());
	}

	// SAFETY: `fd` remains valid here and we are only toggling `O_NONBLOCK`.
	let result = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
	if result < 0 {
		Err(io::Error::last_os_error())
	} else {
		Ok(())
	}
}

#[cfg(unix)]
fn read_nonblocking<T: std::os::fd::AsRawFd>(file: &T, buf: &mut [u8]) -> io::Result<usize> {
	// SAFETY: `buf` is writable for `buf.len()` bytes, and the raw fd obtained
	// from `file` stays valid for the duration of the syscall.
	let read = unsafe { libc::read(file.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
	if read < 0 {
		Err(io::Error::last_os_error())
	} else {
		Ok(read as usize)
	}
}

fn emit_chunk(text: &str, callback: Option<&ThreadsafeFunction<String>>) {
	if let Some(callback) = callback {
		callback.call(Ok(text.to_string()), ThreadsafeFunctionCallMode::NonBlocking);
	}
}

fn pipe_to_files(label: &str) -> Result<(fs::File, fs::File)> {
	let (r, w) = os_pipe::pipe()
		.map_err(|err| Error::from_reason(format!("Failed to create {label} pipe: {err}")))?;

	#[cfg(unix)]
	let (r, w): (fs::File, fs::File) = {
		use std::os::unix::io::{FromRawFd, IntoRawFd};
		let r = r.into_raw_fd();
		let w = w.into_raw_fd();
		// SAFETY: We just obtained these fds from os_pipe and own them exclusively.
		unsafe { (FromRawFd::from_raw_fd(r), FromRawFd::from_raw_fd(w)) }
	};

	#[cfg(windows)]
	let (r, w): (fs::File, fs::File) = {
		use std::os::windows::io::{FromRawHandle, IntoRawHandle};
		let r = r.into_raw_handle();
		let w = w.into_raw_handle();
		// SAFETY: We just obtained these handles from os_pipe and own them exclusively.
		unsafe { (FromRawHandle::from_raw_handle(r), FromRawHandle::from_raw_handle(w)) }
	};

	Ok((r, w))
}

#[derive(Parser)]
#[command(disable_help_flag = true)]
struct SleepCommand {
	#[arg(required = true)]
	durations: Vec<String>,
}

impl builtins::Command for SleepCommand {
	type Error = brush_core::Error;

	fn execute(
		&self,
		context: ExecutionContext<'_>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let durations = self.durations.clone();
		async move {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			let mut total = Duration::from_millis(0);
			for duration in &durations {
				let Some(parsed) = parse_duration(duration) else {
					let _ = writeln!(context.stderr(), "sleep: invalid time interval '{duration}'");
					return Ok(ExecutionResult::new(1));
				};
				total += parsed;
			}
			let sleep = time::sleep(total);
			tokio::pin!(sleep);
			if let Some(cancel_token) = context.cancel_token() {
				tokio::select! {
					() = &mut sleep => Ok(ExecutionResult::success()),
					() = cancel_token.cancelled() => Ok(ExecutionExitCode::Interrupted.into()),
				}
			} else {
				sleep.await;
				Ok(ExecutionResult::success())
			}
		}
	}
}

#[derive(Parser)]
#[command(disable_help_flag = true)]
struct TimeoutCommand {
	#[arg(required = true)]
	duration: String,
	#[arg(required = true, num_args = 1.., trailing_var_arg = true)]
	command:  Vec<String>,
}

impl builtins::Command for TimeoutCommand {
	type Error = brush_core::Error;

	fn execute(
		&self,
		context: ExecutionContext<'_>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let duration = self.duration.clone();
		let command = self.command.clone();
		async move {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			let Some(timeout) = parse_duration(&duration) else {
				let _ = writeln!(context.stderr(), "timeout: invalid time interval '{duration}'");
				return Ok(ExecutionResult::new(125));
			};
			if command.is_empty() {
				let _ = writeln!(context.stderr(), "timeout: missing command");
				return Ok(ExecutionResult::new(125));
			}

			let child_cancel = CancellationToken::new();
			let mut params = context.params.clone();
			params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
			params.set_cancel_token(child_cancel.clone());

			let mut command_line = String::new();
			for (idx, arg) in command.iter().enumerate() {
				if idx > 0 {
					command_line.push(' ');
				}
				command_line.push_str(&quote_arg(arg));
			}

			let cancel_token = context.cancel_token();
			let run_future = context.shell.run_string(command_line, &params);
			tokio::pin!(run_future);

			if let Some(cancel_token) = cancel_token {
				tokio::select! {
					result = &mut run_future => result,
					() = time::sleep(timeout) => {
						child_cancel.cancel();
						// Wait briefly for the child to exit after cancellation.
						let _ = time::timeout(Duration::from_secs(2), &mut run_future).await;
						Ok(ExecutionResult::new(124))
					},
					() = cancel_token.cancelled() => {
						child_cancel.cancel();
						Ok(ExecutionExitCode::Interrupted.into())
					},
				}
			} else {
				tokio::select! {
					result = &mut run_future => result,
					() = time::sleep(timeout) => {
						child_cancel.cancel();
						// Wait briefly for the child to exit after cancellation.
						let _ = time::timeout(Duration::from_secs(2), &mut run_future).await;
						Ok(ExecutionResult::new(124))
					},
				}
			}
		}
	}
}
fn parse_duration(input: &str) -> Option<Duration> {
	let trimmed = input.trim();
	if trimmed.is_empty() {
		return None;
	}
	let (number, multiplier) = match trimmed.chars().last()? {
		's' => (&trimmed[..trimmed.len() - 1], 1.0),
		'm' => (&trimmed[..trimmed.len() - 1], 60.0),
		'h' => (&trimmed[..trimmed.len() - 1], 3600.0),
		'd' => (&trimmed[..trimmed.len() - 1], 86400.0),
		ch if ch.is_ascii_alphabetic() => return None,
		_ => (trimmed, 1.0),
	};
	let value = number.parse::<f64>().ok()?;
	if value.is_sign_negative() {
		return None;
	}
	let millis = value * multiplier * 1000.0;
	if !millis.is_finite() || millis < 0.0 {
		return None;
	}
	Some(Duration::from_millis(millis.round() as u64))
}

fn quote_arg(arg: &str) -> String {
	if arg.is_empty() {
		return "''".to_string();
	}
	let safe = arg
		.chars()
		.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '+'));
	if safe {
		return arg.to_string();
	}
	let escaped = arg.replace('\'', "'\"'\"'");
	format!("'{escaped}'")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[tokio::test]
	async fn abort_state_signals_cancel_token() {
		let abort_state = ShellAbortState::default();
		let mut cancel_token = task::CancelToken::default();
		let abort_token = cancel_token.emplace_abort_token();

		abort_state.set(abort_token).await;
		abort_state.abort().await;

		let reason = time::timeout(Duration::from_millis(100), cancel_token.wait())
			.await
			.expect("cancel token should be signalled");
		assert!(matches!(reason, task::AbortReason::Signal));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn read_output_stops_when_cancelled_before_pipe_eof() {
		let (reader, _writer) = pipe_to_files("test").expect("test pipe should be created");
		let cancel = CancellationToken::new();
		let (activity_tx, _activity_rx) = mpsc::channel(1);
		let handle = tokio::spawn(read_output(reader, None, cancel.clone(), activity_tx));

		time::sleep(Duration::from_millis(10)).await;
		cancel.cancel();

		time::timeout(Duration::from_millis(100), handle)
			.await
			.expect("reader task should stop after cancellation")
			.expect("reader task should not panic");
	}
}

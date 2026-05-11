//! Runtime-agnostic brush shell execution.

use std::{
	collections::{HashMap, HashSet},
	fs,
	future::Future,
	io::{self, Read, Write},
	str,
	sync::{Arc, mpsc as std_mpsc},
	time::Duration,
};

use anyhow::{Error, Result};
use brush_builtins::{BuiltinSet, default_builtins};
use brush_core::{
	ExecutionContext, ExecutionControlFlow, ExecutionExitCode, ExecutionResult, ProcessGroupPolicy,
	ProfileLoadBehavior, RcLoadBehavior, Shell as BrushShell, ShellValue, ShellVariable, SourceInfo,
	builtins,
	env::EnvironmentScope,
	openfiles::{self, OpenFile, OpenFiles},
};
use clap::Parser;
use portable_pty::{Child, CommandBuilder, PtySize, native_pty_system};
#[cfg(not(unix))]
use tokio::io::AsyncReadExt as _;
use tokio::{
	sync::{Mutex as TokioMutex, mpsc},
	time,
};
use tokio_util::sync::CancellationToken;

#[cfg(windows)]
use crate::windows::configure_windows_path;
use crate::{
	cancel::{AbortReason, AbortToken, CancelToken},
	minimizer, process,
};

struct ShellSessionCore {
	shell: BrushShell,
}

#[derive(Clone, Default)]
struct ShellAbortState(Arc<TokioMutex<Option<AbortToken>>>);

impl ShellAbortState {
	async fn set(&self, abort_token: AbortToken) {
		*self.0.lock().await = Some(abort_token);
	}

	async fn clear(&self) {
		*self.0.lock().await = None;
	}

	async fn abort(&self) {
		let abort_token = self.0.lock().await.clone();
		if let Some(abort_token) = abort_token {
			abort_token.abort(AbortReason::Signal);
		}
	}
}

#[derive(Clone)]
struct ShellConfig {
	session_env:   Option<HashMap<String, String>>,
	snapshot_path: Option<String>,
	minimizer:     Option<minimizer::MinimizerConfig>,
}

#[derive(Debug, Clone, Default)]
pub struct ShellOptions {
	pub session_env:   Option<HashMap<String, String>>,
	pub snapshot_path: Option<String>,
	pub minimizer:     Option<minimizer::MinimizerOptions>,
}

struct ShellRunConfig {
	command:   String,
	cwd:       Option<String>,
	env:       Option<HashMap<String, String>>,
	pty:       bool,
	minimizer: Option<minimizer::MinimizerConfig>,
}

#[derive(Debug, Clone, Default)]
pub struct ShellRunOptions {
	pub command:    String,
	pub cwd:        Option<String>,
	pub env:        Option<HashMap<String, String>>,
	pub pty:        bool,
	pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MinimizerResult {
	pub filter:        String,
	pub text:          String,
	pub original_text: String,
	pub input_bytes:   u32,
	pub output_bytes:  u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ShellRunResult {
	pub exit_code: Option<i32>,
	pub cancelled: bool,
	pub timed_out: bool,
	pub minimized: Option<MinimizerResult>,
}

#[derive(Debug, Clone, Default)]
pub struct ShellExecuteOptions {
	pub command:       String,
	pub cwd:           Option<String>,
	pub env:           Option<HashMap<String, String>>,
	pub session_env:   Option<HashMap<String, String>>,
	pub timeout_ms:    Option<u32>,
	pub snapshot_path: Option<String>,
	pub minimizer:     Option<minimizer::MinimizerOptions>,
	pub pty:           bool,
}

pub type ShellExecuteResult = ShellRunResult;

const PTY_DEFAULT_COLS: u16 = 120;
const PTY_DEFAULT_ROWS: u16 = 40;
const PTY_LOOP_INTERVAL: Duration = Duration::from_millis(16);
const PTY_POST_CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_millis(300);
const PTY_POST_EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(300);
const PTY_FINAL_READER_DRAIN_TIMEOUT: Duration = Duration::from_millis(50);
const PTY_READER_EVENTS_PER_TICK: usize = 256;

struct PtyShellConfig {
	command:           String,
	cwd:               String,
	env:               Vec<(String, String)>,
	capture_output:    bool,
	max_capture_bytes: usize,
}

struct PtyShellOutput {
	exit_code: i32,
	output:    Option<BufferedOutput>,
}

enum PtyReaderEvent {
	Chunk(String),
	Done,
}

struct CaptureState {
	text:      String,
	exceeded:  bool,
	max_bytes: usize,
}

pub struct Shell {
	session:     Arc<TokioMutex<Option<ShellSessionCore>>>,
	abort_state: ShellAbortState,
	config:      ShellConfig,
}

impl Shell {
	#[must_use]
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

	pub async fn run(
		&self,
		options: ShellRunOptions,
		on_chunk: Option<mpsc::UnboundedSender<String>>,
		mut cancel_token: CancelToken,
	) -> Result<ShellRunResult> {
		let run_config = ShellRunConfig {
			command:   options.command,
			cwd:       options.cwd,
			env:       options.env,
			pty:       options.pty,
			minimizer: self.config.minimizer.clone(),
		};
		run_shell_session(
			self.session.clone(),
			self.abort_state.clone(),
			self.config.clone(),
			run_config,
			on_chunk,
			&mut cancel_token,
		)
		.await
	}

	pub async fn abort(&self) {
		self.abort_state.abort().await;
	}
}

pub async fn execute_shell(
	options: ShellExecuteOptions,
	on_chunk: Option<mpsc::UnboundedSender<String>>,
	cancel_token: CancelToken,
) -> Result<ShellExecuteResult> {
	let minimizer = options
		.minimizer
		.as_ref()
		.map(minimizer::MinimizerConfig::from_options);
	let config = ShellConfig {
		session_env:   options.session_env,
		snapshot_path: options.snapshot_path,
		minimizer:     minimizer.clone(),
	};
	let run_config = ShellRunConfig {
		command: options.command,
		cwd: options.cwd,
		env: options.env,
		pty: options.pty,
		minimizer,
	};
	run_shell_oneshot(config, run_config, on_chunk, cancel_token).await
}

async fn run_shell_session(
	session: Arc<TokioMutex<Option<ShellSessionCore>>>,
	abort_state: ShellAbortState,
	config: ShellConfig,
	run_config: ShellRunConfig,
	on_chunk: Option<mpsc::UnboundedSender<String>>,
	ct: &mut CancelToken,
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
			*session.lock().await = None;
			return Ok(ShellRunResult {
				exit_code: None,
				cancelled: matches!(reason, AbortReason::Signal),
				timed_out: matches!(reason, AbortReason::Timeout),
				minimized: None,
			});
		}
	};
	let res =
		res.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
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

async fn run_shell_oneshot(
	config: ShellConfig,
	run_config: ShellRunConfig,
	on_chunk: Option<mpsc::UnboundedSender<String>>,
	ct: CancelToken,
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
				cancelled: matches!(reason, AbortReason::Signal),
				timed_out: matches!(reason, AbortReason::Timeout),
				minimized: None,
			});
		},
	};

	let res = run_result
		.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	let (exec, minimized) = res?;
	Ok(ShellExecuteResult {
		exit_code: Some(exit_code(&exec)),
		cancelled: false,
		timed_out: false,
		minimized,
	})
}

fn null_file() -> Result<OpenFile> {
	openfiles::null().map_err(|err| Error::msg(format!("Failed to create null file: {err}")))
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
		ExecutionExitCode::BrokenPipe => 141,
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
	let mut shell = BrushShell::builder()
		.do_not_inherit_env(true)
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.builtins(default_builtins(BuiltinSet::BashMode))
		.build()
		.await
		.map_err(|err| Error::msg(format!("Failed to initialize shell: {err}")))?;

	if let Some(exec_builtin) = shell.builtin_mut("exec") {
		exec_builtin.disabled = true;
	}
	if let Some(suspend_builtin) = shell.builtin_mut("suspend") {
		suspend_builtin.disabled = true;
	}
	shell.register_builtin("sleep", builtins::builtin::<SleepCommand, _>());
	shell.register_builtin("timeout", builtins::builtin::<TimeoutCommand, _>());

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
			.env_mut()
			.set_global(normalized_key, var)
			.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
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
			.env_mut()
			.set_global("PATH", var)
			.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
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
				.env_mut()
				.set_global(normalized_key, var)
				.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
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
	let source_info = SourceInfo::from("pi-natives:snapshot");
	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, null_file()?);
	params.set_fd(OpenFiles::STDERR_FD, null_file()?);

	let escaped = snapshot_path.replace('\'', "'\\''");
	let command = format!("source '{escaped}'");
	shell
		.run_string(command, &source_info, &params)
		.await
		.map_err(|err| Error::msg(format!("Failed to source snapshot: {err}")))?;
	Ok(())
}

async fn run_shell_command(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	on_chunk: Option<mpsc::UnboundedSender<String>>,
	cancel_token: CancellationToken,
) -> Result<(ExecutionResult, Option<MinimizerResult>)> {
	if let Some(cwd) = options.cwd.as_deref() {
		session
			.shell
			.set_working_dir(cwd)
			.map_err(|err| Error::msg(format!("Failed to set cwd: {err}")))?;
	}

	let mut env_scope_pushed = false;
	if let Some(env) = options.env.as_ref() {
		session
			.shell
			.env_mut()
			.push_scope(EnvironmentScope::Command);
		env_scope_pushed = true;
		for (key, value) in env {
			let normalized_key = normalize_env_key(key);
			if should_skip_env_var(normalized_key) {
				continue;
			}
			let mut var = ShellVariable::new(ShellValue::String(value.clone()));
			var.export();
			if let Err(err) =
				session
					.shell
					.env_mut()
					.add(normalized_key, var, EnvironmentScope::Command)
			{
				let _ = session.shell.env_mut().pop_scope(EnvironmentScope::Command);
				return Err(Error::msg(format!("Failed to set env: {err}")));
			}
		}
	}

	let minimizer_mode = if let Some(config) = options.minimizer.as_ref() {
		minimizer::engine::mode_for(&options.command, config)
	} else {
		minimizer::engine::MinimizerMode::None
	};
	let should_minimize = !matches!(minimizer_mode, minimizer::engine::MinimizerMode::None);
	let max_capture_bytes = if let Some(config) = options.minimizer.as_ref() {
		config.max_capture_bytes as usize
	} else {
		0
	};

	if options.pty {
		let result = run_pty_shell_command(
			session,
			options,
			on_chunk,
			cancel_token,
			minimizer_mode,
			max_capture_bytes,
		)
		.await;
		if env_scope_pushed {
			session
				.shell
				.env_mut()
				.pop_scope(EnvironmentScope::Command)
				.map_err(|err| Error::msg(format!("Failed to pop env scope: {err}")))?;
		}
		return result;
	}

	let (reader_file, writer_file) = pipe_to_files("output")?;

	let stdout_file = OpenFile::from(
		writer_file
			.try_clone()
			.map_err(|err| Error::msg(format!("Failed to clone pipe: {err}")))?,
	);
	let stderr_file = OpenFile::from(writer_file);

	let mut params = session.shell.default_exec_params();
	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
	params.set_fd(OpenFiles::STDERR_FD, stderr_file);
	params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
	params.set_cancel_token(cancel_token.clone());
	let baseline_descendants = process::current_descendant_pids();
	let tracked_targets = Arc::new(TokioMutex::new(process::TerminationTargets::new()));
	let tracking_cancel = CancellationToken::new();
	let tracker_handle = tokio::spawn({
		let baseline_descendants = baseline_descendants.clone();
		let tracked_targets = Arc::clone(&tracked_targets);
		let tracking_cancel = tracking_cancel.clone();
		async move {
			loop {
				{
					let mut targets = tracked_targets.lock().await;
					process::add_new_descendants(&mut targets, &baseline_descendants);
				}
				tokio::select! {
					() = tracking_cancel.cancelled() => break,
					() = time::sleep(Duration::from_millis(50)) => {}
				}
			}
		}
	});
	let reader_cancel = CancellationToken::new();
	let (activity_tx, mut activity_rx) = mpsc::channel::<()>(1);
	// Stream every raw chunk to the caller live, regardless of whether
	// minimization is enabled. When minimization actually transforms the
	// output, we propagate the replacement text via `MinimizerResult.text`
	// so the caller can swap their accumulated buffer for the minimized
	// version without losing intermediate progress updates.
	let reader_callback = on_chunk;
	let mut reader_handle = tokio::spawn({
		let reader_cancel = reader_cancel.clone();
		async move {
			if should_minimize {
				let output = read_output_buffered(
					reader_file,
					reader_callback,
					reader_cancel,
					activity_tx,
					max_capture_bytes,
				)
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
	let process_cancel_bridge = tokio::spawn({
		let cancel_token = cancel_token.clone();
		let baseline_descendants = baseline_descendants.clone();
		let tracked_targets = Arc::clone(&tracked_targets);
		async move {
			cancel_token.cancelled().await;
			{
				let mut targets = tracked_targets.lock().await;
				process::add_new_descendants(&mut targets, &baseline_descendants);
				targets.signal(process::TERM_SIGNAL);
			}
			time::sleep(Duration::from_millis(500)).await;
			tracked_targets.lock().await.signal(process::KILL_SIGNAL);
		}
	});
	let source_info = SourceInfo::from("pi-natives:command");
	let result = session
		.shell
		.run_string(options.command.clone(), &source_info, &params)
		.await;

	if cancel_token.is_cancelled() {
		terminate_background_jobs(&session.shell, &baseline_descendants);
	}

	if env_scope_pushed {
		session
			.shell
			.env_mut()
			.pop_scope(EnvironmentScope::Command)
			.map_err(|err| Error::msg(format!("Failed to pop env scope: {err}")))?;
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
	process_cancel_bridge.abort();
	let _ = process_cancel_bridge.await;
	tracking_cancel.cancel();
	let _ = tracker_handle.await;

	let result = result.map_err(|err| Error::msg(format!("Shell execution failed: {err}")))?;
	let mut minimized_out: Option<MinimizerResult> = None;
	if let Some(OutputRead::Buffered(output)) = reader_output
		&& let Some(config) = options.minimizer.as_ref()
		&& !output.exceeded
	{
		let minimized = match minimizer_mode {
			minimizer::engine::MinimizerMode::WholeCommand => {
				minimizer::apply(&options.command, &output.text, exit_code(&result), config)
			},
			minimizer::engine::MinimizerMode::None => {
				minimizer::MinimizerOutput::passthrough(&output.text)
			},
		};
		if minimized.changed
			&& let Some(original) = minimized.original_text
		{
			let output_bytes = u32::try_from(minimized.text.len()).unwrap_or(u32::MAX);
			minimized_out = Some(MinimizerResult {
				filter: minimized.filter.to_string(),
				text: minimized.text,
				original_text: original,
				input_bytes: u32::try_from(minimized.input_bytes).unwrap_or(u32::MAX),
				output_bytes,
			});
		}
	}
	Ok((result, minimized_out))
}

async fn run_pty_shell_command(
	session: &ShellSessionCore,
	options: &ShellRunConfig,
	on_chunk: Option<mpsc::UnboundedSender<String>>,
	cancel_token: CancellationToken,
	minimizer_mode: minimizer::engine::MinimizerMode,
	max_capture_bytes: usize,
) -> Result<(ExecutionResult, Option<MinimizerResult>)> {
	let pty_config = PtyShellConfig {
		command: options.command.clone(),
		cwd: session.shell.working_dir().to_string_lossy().into_owned(),
		env: exported_env(&session.shell),
		capture_output: !matches!(minimizer_mode, minimizer::engine::MinimizerMode::None),
		max_capture_bytes,
	};

	let pty_output = tokio::task::spawn_blocking(move || {
		run_pty_shell_command_sync(pty_config, on_chunk, cancel_token)
	})
	.await
	.map_err(|err| Error::msg(format!("PTY execution task failed: {err}")))??;

	let result = execution_result_from_exit_code(pty_output.exit_code);
	let minimized_out = pty_output.output.and_then(|output| {
		minimize_buffered_output(
			&options.command,
			output,
			pty_output.exit_code,
			options.minimizer.as_ref(),
			minimizer_mode,
		)
	});
	Ok((result, minimized_out))
}

fn run_pty_shell_command_sync(
	config: PtyShellConfig,
	on_chunk: Option<mpsc::UnboundedSender<String>>,
	cancel_token: CancellationToken,
) -> Result<PtyShellOutput> {
	let pty_system = native_pty_system();
	let pair = pty_system
		.openpty(PtySize {
			rows:         PTY_DEFAULT_ROWS,
			cols:         PTY_DEFAULT_COLS,
			pixel_width:  0,
			pixel_height: 0,
		})
		.map_err(|err| Error::msg(format!("Failed to open PTY: {err}")))?;

	let mut cmd = CommandBuilder::new("sh");
	cmd.arg("-lc");
	cmd.arg(&config.command);
	cmd.cwd(config.cwd.as_str());
	cmd.env_clear();
	for (key, value) in &config.env {
		cmd.env(key, value);
	}

	let mut child = pair
		.slave
		.spawn_command(cmd)
		.map_err(|err| Error::msg(format!("Failed to spawn PTY command: {err}")))?;
	drop(pair.slave);

	let master = pair.master;
	let mut reader = master
		.try_clone_reader()
		.map_err(|err| Error::msg(format!("Failed to create PTY reader: {err}")))?;
	let (reader_tx, reader_rx) = std_mpsc::channel::<PtyReaderEvent>();
	let reader_thread = std::thread::spawn(move || read_pty_output(&mut reader, reader_tx));

	let child_pid = child
		.process_id()
		.and_then(|value| i32::try_from(value).ok());
	#[cfg(unix)]
	let process_group_id = master.process_group_leader().filter(|pgid| *pgid > 0);
	#[cfg(not(unix))]
	let process_group_id: Option<i32> = None;

	let mut capture = config.capture_output.then(|| CaptureState {
		text:      String::new(),
		exceeded:  false,
		max_bytes: config.max_capture_bytes,
	});
	let mut reader_done = false;
	let mut exit_code: Option<i32> = None;
	let mut terminate_requested = false;
	let mut reader_drain_deadline = None;

	while exit_code.is_none() || !reader_done {
		if !terminate_requested && cancel_token.is_cancelled() {
			terminate_pty_processes(&mut child, child_pid, process_group_id);
			terminate_requested = true;
			reader_drain_deadline = Some(std::time::Instant::now() + PTY_POST_CANCEL_DRAIN_TIMEOUT);
		}

		drain_pty_reader_events(&reader_rx, on_chunk.as_ref(), &mut capture, &mut reader_done);

		if exit_code.is_none()
			&& let Some(status) = child
				.try_wait()
				.map_err(|err| Error::msg(format!("Failed checking PTY status: {err}")))?
		{
			exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
			if !reader_done && reader_drain_deadline.is_none() {
				reader_drain_deadline = Some(std::time::Instant::now() + PTY_POST_EXIT_DRAIN_TIMEOUT);
			}
		}

		if let Some(deadline) = reader_drain_deadline
			&& std::time::Instant::now() >= deadline
		{
			break;
		}

		if exit_code.is_none() || !reader_done {
			let wait_duration = reader_drain_deadline.map_or(PTY_LOOP_INTERVAL, |deadline| {
				deadline
					.saturating_duration_since(std::time::Instant::now())
					.min(PTY_LOOP_INTERVAL)
			});
			match reader_rx.recv_timeout(wait_duration) {
				Ok(event) => {
					handle_pty_reader_event(event, on_chunk.as_ref(), &mut capture, &mut reader_done)
				},
				Err(std_mpsc::RecvTimeoutError::Timeout) => {},
				Err(std_mpsc::RecvTimeoutError::Disconnected) => reader_done = true,
			}
		}
	}

	if exit_code.is_none() {
		if terminate_requested {
			if let Some(status) = child
				.try_wait()
				.map_err(|err| Error::msg(format!("Failed checking PTY status: {err}")))?
			{
				exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
			}
		} else {
			let status = child
				.wait()
				.map_err(|err| Error::msg(format!("Failed waiting PTY process: {err}")))?;
			exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
		}
	}

	drop(master);
	if !reader_done {
		let finalize_deadline = std::time::Instant::now() + PTY_FINAL_READER_DRAIN_TIMEOUT;
		while std::time::Instant::now() < finalize_deadline {
			let wait_duration = finalize_deadline
				.saturating_duration_since(std::time::Instant::now())
				.min(Duration::from_millis(5));
			match reader_rx.recv_timeout(wait_duration) {
				Ok(event) => {
					handle_pty_reader_event(event, on_chunk.as_ref(), &mut capture, &mut reader_done)
				},
				Err(std_mpsc::RecvTimeoutError::Timeout) => {},
				Err(std_mpsc::RecvTimeoutError::Disconnected) => {
					reader_done = true;
					break;
				},
			}
		}
	}
	if reader_done {
		let _ = reader_thread.join();
	}

	Ok(PtyShellOutput {
		exit_code: exit_code.unwrap_or(1),
		output:    capture.map(CaptureState::finish),
	})
}

fn exported_env(shell: &BrushShell) -> Vec<(String, String)> {
	shell
		.env()
		.iter_exported()
		.filter_map(|(key, value)| {
			value
				.value()
				.try_get_cow_str(shell)
				.map(|value| (key.clone(), value.into_owned()))
		})
		.collect()
}

fn execution_result_from_exit_code(exit_code: i32) -> ExecutionResult {
	let code = u8::try_from(exit_code).unwrap_or(if exit_code < 0 { 1 } else { u8::MAX });
	ExecutionResult::new(code)
}

fn minimize_buffered_output(
	command: &str,
	output: BufferedOutput,
	exit_code: i32,
	config: Option<&minimizer::MinimizerConfig>,
	minimizer_mode: minimizer::engine::MinimizerMode,
) -> Option<MinimizerResult> {
	let config = config.filter(|_| !output.exceeded)?;
	let minimized = match minimizer_mode {
		minimizer::engine::MinimizerMode::WholeCommand => {
			minimizer::apply(command, &output.text, exit_code, config)
		},
		minimizer::engine::MinimizerMode::None => {
			minimizer::MinimizerOutput::passthrough(&output.text)
		},
	};
	if !minimized.changed {
		return None;
	}
	let original = minimized.original_text?;
	let output_bytes = u32::try_from(minimized.text.len()).unwrap_or(u32::MAX);
	Some(MinimizerResult {
		filter: minimized.filter.to_string(),
		text: minimized.text,
		original_text: original,
		input_bytes: u32::try_from(minimized.input_bytes).unwrap_or(u32::MAX),
		output_bytes,
	})
}

fn terminate_pty_processes(
	child: &mut Box<dyn Child + Send + Sync>,
	child_pid: Option<i32>,
	process_group_id: Option<i32>,
) {
	let mut targets = process::TerminationTargets::new();
	if let Some(pgid) = process_group_id {
		targets.add_pgid(pgid);
	}
	if let Some(pid) = child_pid {
		targets.add_pid(pid);
	}
	targets.signal(process::TERM_SIGNAL);
	let _ = child.kill();
	targets.signal(process::KILL_SIGNAL);
}

fn drain_pty_reader_events(
	reader_rx: &std_mpsc::Receiver<PtyReaderEvent>,
	on_chunk: Option<&mpsc::UnboundedSender<String>>,
	capture: &mut Option<CaptureState>,
	reader_done: &mut bool,
) {
	for _ in 0..PTY_READER_EVENTS_PER_TICK {
		match reader_rx.try_recv() {
			Ok(event) => handle_pty_reader_event(event, on_chunk, capture, reader_done),
			Err(std_mpsc::TryRecvError::Empty) => break,
			Err(std_mpsc::TryRecvError::Disconnected) => {
				*reader_done = true;
				break;
			},
		}
	}
}

fn handle_pty_reader_event(
	event: PtyReaderEvent,
	on_chunk: Option<&mpsc::UnboundedSender<String>>,
	capture: &mut Option<CaptureState>,
	reader_done: &mut bool,
) {
	match event {
		PtyReaderEvent::Chunk(chunk) => {
			if let Some(capture) = capture.as_mut() {
				capture.push(&chunk);
			}
			if let Some(on_chunk) = on_chunk {
				let _ = on_chunk.send(chunk);
			}
		},
		PtyReaderEvent::Done => *reader_done = true,
	}
}

fn read_pty_output(reader: &mut Box<dyn Read + Send>, reader_tx: std_mpsc::Sender<PtyReaderEvent>) {
	const REPLACEMENT: &str = "\u{FFFD}";
	const BUF: usize = 65536;
	let mut buf = vec![0_u8; BUF + 4];
	let mut it = 0;
	loop {
		match reader.read(&mut buf[it..BUF]) {
			Ok(0) => break,
			Ok(n) => {
				it += n;
				while it > 0 {
					let pending = &buf[..it];
					match str::from_utf8(pending) {
						Ok(text) => {
							let _ = reader_tx.send(PtyReaderEvent::Chunk(text.to_string()));
							it = 0;
							break;
						},
						Err(err) => {
							let valid_up_to = err.valid_up_to();
							if valid_up_to > 0 {
								if let Ok(text) = str::from_utf8(&pending[..valid_up_to]) {
									let _ = reader_tx.send(PtyReaderEvent::Chunk(text.to_string()));
								}
								buf.copy_within(valid_up_to..it, 0);
								it -= valid_up_to;
							}
							match err.error_len() {
								Some(invalid_len) => {
									let _ = reader_tx.send(PtyReaderEvent::Chunk(REPLACEMENT.to_string()));
									let drop_len = invalid_len.min(it);
									buf.copy_within(drop_len..it, 0);
									it -= drop_len;
								},
								None => break,
							}
						},
					}
				}
			},
			Err(_) => break,
		}
	}
	for chunk in buf[..it].utf8_chunks() {
		let valid = chunk.valid();
		if !valid.is_empty() {
			let _ = reader_tx.send(PtyReaderEvent::Chunk(valid.to_string()));
		}
		if !chunk.invalid().is_empty() {
			let _ = reader_tx.send(PtyReaderEvent::Chunk(REPLACEMENT.to_string()));
		}
	}
	let _ = reader_tx.send(PtyReaderEvent::Done);
}

impl CaptureState {
	fn push(&mut self, chunk: &str) {
		if self.exceeded {
			return;
		}
		if self.text.len().saturating_add(chunk.len()) > self.max_bytes {
			self.exceeded = true;
			self.text.clear();
			return;
		}
		self.text.push_str(chunk);
	}

	fn finish(self) -> BufferedOutput {
		BufferedOutput { text: self.text, exceeded: self.exceeded }
	}
}

fn terminate_background_jobs(shell: &BrushShell, baseline_descendants: &HashSet<i32>) {
	let mut targets = process::TerminationTargets::new();
	for job in &shell.jobs().jobs {
		if let Some(pgid) = job.process_group_id() {
			targets.add_pgid(pgid);
		}
		if let Some(pid) = job.representative_pid() {
			targets.add_pid(pid);
		}
	}
	if targets.is_empty() {
		process::add_new_descendants(&mut targets, baseline_descendants);
	}
	if targets.is_empty() {
		return;
	}

	targets.signal(process::TERM_SIGNAL);
	tokio::spawn(async move {
		time::sleep(Duration::from_millis(500)).await;
		targets.signal(process::KILL_SIGNAL);
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
	on_chunk: Option<mpsc::UnboundedSender<String>>,
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
	on_chunk: Option<mpsc::UnboundedSender<String>>,
	cancel_token: CancellationToken,
	activity: mpsc::Sender<()>,
	max_capture_bytes: usize,
) -> BufferedOutput {
	const REPLACEMENT: &str = "\u{FFFD}";
	const BUF: usize = 65536;
	let mut buf = vec![0u8; BUF];
	let mut captured = Vec::new();
	let mut exceeded = false;
	// Pending bytes from a prior read that ended mid-UTF-8 sequence. We hold
	// them back so we emit only valid UTF-8 to the streaming callback while
	// still capturing every byte into `captured` for post-processing.
	let mut pending = Vec::<u8>::new();

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
		// Once `exceeded`, the post-process minimizer is bypassed (see the
		// `!output.exceeded` gate at the call site), so further appends just
		// grow `captured` without serving any purpose. Stop accumulating to
		// bound peak memory on commands that produce very large output.
		if !exceeded {
			if captured.len().saturating_add(n) > max_capture_bytes {
				exceeded = true;
			} else {
				captured.extend_from_slice(&buf[..n]);
			}
		}

		// Stream whatever is validly decodable *right now* to the callback,
		// carrying incomplete trailing UTF-8 bytes over to the next iteration.
		if let Some(cb) = on_chunk.as_ref() {
			pending.extend_from_slice(&buf[..n]);
			while !pending.is_empty() {
				match str::from_utf8(&pending) {
					Ok(text) => {
						emit_chunk(text, Some(cb));
						pending.clear();
						break;
					},
					Err(err) => {
						let p = err.valid_up_to();
						if p > 0 {
							// SAFETY: [..p] is valid UTF-8 per valid_up_to().
							let text = unsafe { str::from_utf8_unchecked(&pending[..p]) };
							emit_chunk(text, Some(cb));
							pending.drain(..p);
						}
						match err.error_len() {
							Some(skip) => {
								emit_chunk(REPLACEMENT, Some(cb));
								pending.drain(..skip);
							},
							None => break,
						}
					},
				}
			}
		}
	}

	// Flush any trailing bytes the streaming decoder held back at EOF.
	if let Some(cb) = on_chunk.as_ref() {
		for chunk in pending.utf8_chunks() {
			let valid = chunk.valid();
			if !valid.is_empty() {
				emit_chunk(valid, Some(cb));
			}
			if !chunk.invalid().is_empty() {
				emit_chunk(REPLACEMENT, Some(cb));
			}
		}
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

fn emit_chunk(text: &str, callback: Option<&mpsc::UnboundedSender<String>>) {
	if let Some(callback) = callback {
		let _ = callback.send(text.to_string());
	}
}

fn pipe_to_files(label: &str) -> Result<(fs::File, fs::File)> {
	let (r, w) =
		os_pipe::pipe().map_err(|err| Error::msg(format!("Failed to create {label} pipe: {err}")))?;

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

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
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

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
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
			let source_info = SourceInfo::from("pi-natives:timeout");
			let run_future = context
				.shell
				.run_string(command_line, &source_info, &params);
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

	/// Truth-table coverage for `brush_core::commands::child_session_action`.
	///
	/// Lives in `pi-natives` because the brush-core crate is excluded from the
	/// workspace (vendored upstream) and cannot be tested standalone — its tokio
	/// dependency only resolves the `net` feature via feature-unification with
	/// other workspace members.
	mod child_session_action {
		use brush_core::commands::{ChildSessionAction, child_session_action};

		/// Interactive brush, leading its own pgroup, terminal stdin: foreground.
		#[test]
		fn interactive_with_terminal_stdin_takes_foreground() {
			assert_eq!(child_session_action(true, true, false), ChildSessionAction::TakeForeground,);
			// Terminal foregrounding wins even when this is the first stage of a
			// pipeline; no detach is attempted.
			assert_eq!(child_session_action(true, true, true), ChildSessionAction::TakeForeground,);
		}

		/// Brush leading a new pgroup with non-terminal stdin detaches only when
		/// it is not part of a multi-command pipeline. Pipeline leaders must stay
		/// in the parent session so later stages can join their process group.
		#[test]
		fn non_terminal_stdin_leading_new_pgroup_detaches_unless_pipeline() {
			assert_eq!(child_session_action(true, false, false), ChildSessionAction::DetachSession,);
			assert_eq!(child_session_action(true, false, true), ChildSessionAction::None,);
		}

		/// Non-interactive brush, terminal stdin, no pipeline: nothing to do.
		#[test]
		fn non_interactive_with_terminal_stdin_does_nothing() {
			assert_eq!(child_session_action(false, true, false), ChildSessionAction::None,);
		}

		/// Non-interactive brush, terminal stdin, joining a pipeline pgroup:
		/// nothing to do (parent already wired pgroup membership).
		#[test]
		fn non_interactive_terminal_stdin_in_pipeline_does_nothing() {
			assert_eq!(child_session_action(false, true, true), ChildSessionAction::None,);
		}

		/// **Embedded host bug fix.** Non-interactive brush, non-terminal stdin,
		/// no pipeline pgroup: detach so the child cannot SIGTTIN/SIGTTOU the
		/// host. This is the case that regressed before this fix and is the
		/// motivating bug for PR #895.
		#[test]
		fn embedded_host_with_non_terminal_stdin_detaches() {
			assert_eq!(child_session_action(false, false, false), ChildSessionAction::DetachSession,);
		}

		/// **Pipeline carve-out.** Non-interactive brush, non-terminal stdin
		/// (pipe), and a multi-command pipeline: MUST NOT detach. For the first
		/// external stage, `setsid()` puts the process-group leader into a
		/// different session, so later stages fail to join its group with
		/// EPERM. For later stages, `setsid()` would either fail with EPERM or
		/// move the child into a new session, breaking the pipeline's shared
		/// process group and job-control signal propagation.
		#[test]
		fn pipeline_stage_does_not_detach() {
			assert_eq!(child_session_action(false, false, true), ChildSessionAction::None,);
		}
	}

	/// End-to-end verification that brush, when embedded as a non-interactive
	/// library (`interactive: false`, exactly what `create_session` produces),
	/// spawns external commands in a **separate session** from the host.
	///
	/// The truth-table tests in `child_session_action` cover the decision in
	/// isolation. This test covers the wiring: it boots a real `BrushShell`,
	/// runs a child that prints its PID then sleeps, and asks the kernel for
	/// that PID's session via `getsid(2)` while the child is still alive.
	/// Pre-fix (`new_pg=false` skipped `detach_session`), the child inherited
	/// the host's session, so `getsid(child_pid) == getsid(0)`. Post-fix,
	/// `setsid` ran and the child is its own session leader
	/// (`getsid(child_pid) == child_pid`).
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn embedded_external_command_runs_in_its_own_session() {
		use std::io::Read as _;

		// SAFETY: `getsid(0)` only queries the current process session; the return
		// value is checked.
		let host_sid = unsafe { libc::getsid(0) };
		assert!(host_sid > 0, "getsid(0) failed: {}", std::io::Error::last_os_error());

		// Build the same kind of session pi-natives uses in production.
		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");

		// Output pipe shared between the brush child and a concurrent reader. The
		// reader runs on a blocking thread because `os_pipe` reads are blocking.
		let (mut reader, writer) = pipe_to_files("e2e").expect("pipe");
		let stdout_file = OpenFile::from(writer.try_clone().expect("clone"));
		let stderr_file = OpenFile::from(writer);

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
		params.set_fd(OpenFiles::STDERR_FD, stderr_file);

		// (pid_tx, pid_rx) — reader task signals the test as soon as it has the PID.
		let (pid_tx, pid_rx) = tokio::sync::oneshot::channel::<i32>();
		let reader_handle = tokio::task::spawn_blocking(move || {
			let mut buf = Vec::new();
			// Read just enough to capture the PID line. The child sleeps after
			// printing so the pipe will not back-pressure.
			let mut chunk = [0u8; 64];
			let mut pid_tx = Some(pid_tx);
			while let Ok(n) = reader.read(&mut chunk)
				&& n > 0
			{
				buf.extend_from_slice(&chunk[..n]);
				if pid_tx.is_some()
					&& let Some(line_end) = buf.iter().position(|&byte| byte == b'\n')
					&& let Ok(line) = std::str::from_utf8(&buf[..line_end])
					&& let Ok(pid) = line.trim().parse::<i32>()
				{
					let _ = pid_tx
						.take()
						.expect("pid sender should be present")
						.send(pid);
				}
			}
			buf
		});

		// Run brush in the background so we can call `getsid(child_pid)` while
		// the child is still alive.
		let shell_handle = tokio::spawn(async move {
			let source_info = SourceInfo::from("pi-natives:test");
			// `printf '%d\n' "$$"` then `sleep 0.5`. Long enough for our `getsid`.
			let exec = session
				.shell
				.run_string("/bin/sh -c 'printf \"%d\\n\" \"$$\"; sleep 0.5'", &source_info, &params)
				.await
				.expect("run_string");
			drop(params);
			(session, exec)
		});

		let child_pid = time::timeout(Duration::from_secs(5), pid_rx)
			.await
			.expect("timed out waiting for child PID")
			.expect("reader closed pid channel without sending");
		assert!(child_pid > 0, "got non-positive child pid: {child_pid}");

		// Snapshot the child's session ID immediately, while the child is still
		// in `sleep`. POSIX guarantees `getsid` against a live PID returns the
		// session of that process.
		// SAFETY: `child_pid` is a positive PID from the child; errors are reported via
		// the checked return value.
		let child_sid = unsafe { libc::getsid(child_pid) };
		assert!(
			child_sid > 0,
			"getsid({child_pid}) failed: {} (child may have already exited)",
			std::io::Error::last_os_error(),
		);

		// Drain the brush task and the pipe reader.
		let (_session, exec) = time::timeout(Duration::from_secs(5), shell_handle)
			.await
			.expect("shell timed out")
			.expect("shell task panicked");
		assert!(
			matches!(exec.exit_code, ExecutionExitCode::Success),
			"unexpected exit: {}",
			exit_code(&exec),
		);
		let _ = time::timeout(Duration::from_secs(2), reader_handle).await;

		assert_ne!(
			child_sid, host_sid,
			"child PID {child_pid} inherited host session {host_sid}; setsid() did not run — the \
			 embedded-host bug is back",
		);
		assert_eq!(
			child_sid, child_pid,
			"child PID {child_pid} should be its own session leader after setsid",
		);
	}

	#[tokio::test]
	async fn abort_state_signals_cancel_token() {
		let abort_state = ShellAbortState::default();
		let mut cancel_token = CancelToken::default();
		let abort_token = cancel_token.emplace_abort_token();

		abort_state.set(abort_token).await;
		abort_state.abort().await;

		let reason = time::timeout(Duration::from_millis(100), cancel_token.wait())
			.await
			.expect("cancel token should be signalled");
		assert!(matches!(reason, AbortReason::Signal));
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

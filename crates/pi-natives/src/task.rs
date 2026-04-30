//! Blocking work scheduling for N-API exports.
//!
//! # Overview
//! Runs CPU-bound or blocking Rust work on libuv's thread pool via napi's
//! `Task` trait, with profiling and cancellation support.
//!
//! # Cancellation
//! Pass a `CancelToken` to blocking tasks. Work must check
//! `CancelToken::heartbeat()` periodically to respect cancellation.
//!
//! # Profiling
//! Samples are always collected into a circular buffer. Call
//! `get_work_profile()` to retrieve the last N seconds of data.
//!
//! # Usage
//! ```ignore
//! use crate::work::{blocking_task, CancelToken};
//!
//! #[napi]
//! fn my_heavy_work(signal: Option<AbortSignal>) -> AsyncTask<impl Task<...>> {
//!     let ct = CancelToken::new(None, signal);
//!     blocking_task("my_work", ct, |ct| {
//!         ct.heartbeat()?;
//!         // ... heavy computation ...
//!         Ok(result)
//!     })
//! }
//! ```

use std::{
	future::Future,
	sync::{
		Arc, Weak,
		atomic::{AtomicU8, Ordering},
	},
	time::{Duration, Instant},
};

use napi::{Env, Error, Result, Task, bindgen_prelude::*};
use tokio::sync::Notify;

use crate::prof::profile_region;

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation
// ─────────────────────────────────────────────────────────────────────────────

/// Reason for task abortion.
#[derive(Debug, Clone, Copy)]
#[repr(u8)]
pub enum AbortReason {
	Unknown = 1,
	Timeout = 2,
	Signal  = 3,
	User    = 4,
}

impl TryFrom<u8> for AbortReason {
	type Error = ();

	fn try_from(value: u8) -> std::result::Result<Self, ()> {
		match value {
			0 => Err(()),
			2 => Ok(Self::Timeout),
			3 => Ok(Self::Signal),
			4 => Ok(Self::User),
			_ => Ok(Self::Unknown),
		}
	}
}

#[derive(Default)]
struct Flag {
	reason:   AtomicU8,
	notifier: Notify,
}

impl Flag {
	fn cause(&self) -> Option<AbortReason> {
		self.reason.load(Ordering::Relaxed).try_into().ok()
	}

	async fn wait(&self) -> AbortReason {
		if let Some(reason) = self.cause() {
			return reason;
		}
		let notifier = self.notifier.notified();
		if let Some(reason) = self.cause() {
			return reason;
		}
		notifier.await;
		self.cause().unwrap_or(AbortReason::Unknown)
	}

	fn abort(&self, reason: AbortReason) {
		let old = self.reason.swap(reason as u8, Ordering::SeqCst);
		if old == 0 {
			self.notifier.notify_waiters();
		}
	}
}

/// Token for cooperative cancellation of blocking work.
///
/// Call `heartbeat()` periodically inside long-running work to check for
/// cancellation requests from timeouts or abort signals.
#[derive(Clone, Default)]
pub struct CancelToken {
	deadline: Option<Instant>,
	flag:     Option<Arc<Flag>>,
}

impl From<()> for CancelToken {
	fn from((): ()) -> Self {
		Self::default()
	}
}

impl CancelToken {
	/// Create a new cancel token from optional timeout and abort signal.
	pub fn new(timeout_ms: Option<u32>, signal: Option<Unknown>) -> Self {
		let mut result = Self::default();
		if let Some(signal) = signal.and_then(|s| AbortSignal::from_unknown(s).ok()) {
			let flag = Arc::new(Flag::default());
			signal.on_abort({
				let weak = Arc::downgrade(&flag);
				move || {
					if let Some(flag) = weak.upgrade() {
						flag.abort(AbortReason::Signal);
					}
				}
			});
			result.flag = Some(flag);
		}
		if let Some(timeout_ms) = timeout_ms {
			result.deadline = Some(Instant::now() + Duration::from_millis(timeout_ms as u64));
		}
		result
	}

	/// Check if cancellation has been requested.
	///
	/// Returns `Ok(())` if work should continue, or an error if cancelled.
	/// Call this periodically in long-running loops.
	pub fn heartbeat(&self) -> Result<()> {
		if let Some(flag) = &self.flag
			&& let Some(reason) = flag.cause()
		{
			return Err(Error::from_reason(format!("Aborted: {reason:?}")));
		}
		if let Some(deadline) = self.deadline
			&& deadline < Instant::now()
		{
			return Err(Error::from_reason("Aborted: Timeout"));
		}
		Ok(())
	}

	/// Wait for the cancel token to be aborted.
	pub async fn wait(&self) -> AbortReason {
		let flag = self.flag.as_ref();
		if let Some(flag) = flag.and_then(|f| f.cause()) {
			return flag;
		}
		let fflag = async {
			let Some(flag) = self.flag.as_ref() else {
				return std::future::pending().await;
			};
			flag.wait().await
		};

		let fttl = async {
			let Some(ttl) = self.deadline else {
				return std::future::pending().await;
			};
			tokio::time::sleep_until(ttl.into()).await;
			AbortReason::Timeout
		};

		let fuser = async {
			if tokio::signal::ctrl_c().await.is_err() {
				return std::future::pending().await;
			}
			AbortReason::User
		};

		tokio::select! {
			reason = fflag => reason,
			reason = fttl => reason,
			reason = fuser => reason,
		}
	}

	/// Get an abort token for external cancellation.
	pub fn abort_token(&self) -> AbortToken {
		AbortToken(self.flag.as_ref().map(Arc::downgrade))
	}

	/// Emplaces a cancel token if there is none, returns the abort token.
	pub fn emplace_abort_token(&mut self) -> AbortToken {
		AbortToken(Some(Arc::downgrade(self.flag.get_or_insert_default())))
	}

	/// Check if already aborted (non-blocking).
	pub fn aborted(&self) -> bool {
		if let Some(flag) = &self.flag
			&& flag.cause().is_some()
		{
			return true;
		}
		if let Some(deadline) = self.deadline
			&& deadline < Instant::now()
		{
			return true;
		}
		false
	}
}

/// Token for requesting cancellation from outside the task.
#[derive(Clone, Default)]
pub struct AbortToken(Option<Weak<Flag>>);

impl AbortToken {
	/// Request cancellation of the associated task.
	pub fn abort(&self, reason: AbortReason) {
		if let Some(flag) = &self.0
			&& let Some(flag) = flag.upgrade()
		{
			flag.abort(reason);
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocking Task - libuv thread pool integration
// ─────────────────────────────────────────────────────────────────────────────

/// Task that runs blocking work on libuv's thread pool with profiling.
///
/// This implements napi's `Task` trait, running `compute()` on a libuv worker
/// thread and `resolve()` on the main JS thread.
pub struct Blocking<T>
where
	T: Send + 'static,
{
	tag:          &'static str,
	cancel_token: CancelToken,
	work:         Option<Box<dyn FnOnce(CancelToken) -> Result<T> + Send>>,
}

impl<T> Task for Blocking<T>
where
	T: ToNapiValue + Send + 'static + TypeName,
{
	type JsValue = T;
	type Output = T;

	fn compute(&mut self) -> Result<Self::Output> {
		let _guard = profile_region(self.tag);
		let work = self
			.work
			.take()
			.ok_or_else(|| Error::from_reason("BlockingTask: work already consumed"))?;
		work(self.cancel_token.clone())
	}

	fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
		Ok(output)
	}
}

pub type Promise<T> = AsyncTask<Blocking<T>>;

/// Create an `AsyncTask` that runs blocking work on libuv's thread pool.
///
/// Returns `AsyncTask<BlockingTask<T>>` which can be returned directly from
/// `#[napi]` functions - it becomes `Promise<T>` on the JS side.
///
/// # Arguments
/// - `tag`: Profiling tag for this work (appears in flamegraphs)
/// - `cancel_token`: Token for cooperative cancellation
/// - `work`: Closure that performs the blocking work
///
/// # Example
/// ```ignore
/// #[napi]
/// fn heavy_computation(signal: Option<AbortSignal>) -> AsyncTask<impl Task<...>> {
///     let ct = CancelToken::new(None, signal);
///     blocking_task("heavy_computation", ct, |ct| {
///         for i in 0..1000 {
///             ct.heartbeat()?; // Check for cancellation
///             // ... do work ...
///         }
///         Ok(result)
///     })
/// }
/// ```
pub fn blocking<T, F>(
	tag: &'static str,
	cancel_token: impl Into<CancelToken>,
	work: F,
) -> AsyncTask<Blocking<T>>
where
	F: FnOnce(CancelToken) -> Result<T> + Send + 'static,
	T: ToNapiValue + TypeName + Send + 'static,
{
	AsyncTask::new(Blocking { tag, cancel_token: cancel_token.into(), work: Some(Box::new(work)) })
}

// ─────────────────────────────────────────────────────────────────────────────
// Async Task - Tokio runtime integration
// ─────────────────────────────────────────────────────────────────────────────

/// Run an async task on Tokio's runtime with profiling.
///
/// Use this for operations that need to `.await` (async I/O, `select!`, etc.).
/// For CPU-bound blocking work, use [`blocking_task`] instead.
///
/// # Arguments
/// - `env`: N-API environment (needed for `spawn_future`)
/// - `tag`: Profiling tag for this work
/// - `work`: Async closure that performs the work
///
/// # Example
/// ```ignore
/// #[napi]
/// fn run_async_io<'e>(env: &'e Env) -> Result<PromiseRaw<'e, String>> {
///     async_task(env, "async_io", async move {
///         let data = fetch_data().await?;
///         Ok(data)
///     })
/// }
/// ```
pub fn future<'env, T, Fut>(
	env: &'env Env,
	tag: &'static str,
	work: Fut,
) -> Result<PromiseRaw<'env, T>>
where
	Fut: Future<Output = Result<T>> + Send + 'static,
	T: ToNapiValue + Send + 'static,
{
	env.spawn_future(async move {
		let _guard = profile_region(tag);
		work.await
	})
}

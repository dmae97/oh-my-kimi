//! Test-only helpers shared across `pi-natives` unit tests.
//!
//! Any state exposed here MUST be gated on `#[cfg(test)]` — it does not ship
//! in release builds.

use std::sync::{Mutex, MutexGuard};

/// Global mutex serializing tests that mutate the process-wide
/// [`std::panic`] hook.
///
/// [`std::panic::set_hook`] / [`take_hook`](std::panic::take_hook) act on a
/// single hook shared by every thread in the process. The default Rust test
/// harness runs tests in parallel, so two tests calling
/// `take_hook` + `set_hook(noop)` on their own threads can interleave: the
/// second `take_hook` captures the first test's noop, and when the drops run
/// in the opposite order the noop is restored as the global hook — silently
/// muting crash diagnostics for every later test in the crate. Serializing
/// the whole take → set → run → restore window across every hook-mutating
/// test in this crate eliminates that race.
///
/// [`take_hook`]: std::panic::take_hook
static PANIC_HOOK_MUTEX: Mutex<()> = Mutex::new(());

/// Acquire the process-global panic-hook lock. Hold the returned guard for the
/// entire take → set → run → restore window.
///
/// Recovers from mutex poisoning (a prior test panicked while holding the
/// lock) so a single failing test does not cascade into every later test
/// panicking on `Mutex::lock`.
pub fn lock_panic_hook() -> MutexGuard<'static, ()> {
	PANIC_HOOK_MUTEX
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner())
}

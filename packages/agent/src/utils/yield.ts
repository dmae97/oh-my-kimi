/**
 * Cooperative yield utility for preventing Bun event-loop busy-wait.
 *
 * ## Root Cause
 *
 * Bun 1.3.x (JavaScriptCore) event loop busy-waits (spins in userspace)
 * when the only pending work is an unresolved Promise — even if there are
 * active I/O watchers (stdin, child process pipes, etc.).  The event loop
 * continuously polls for microtask resolution instead of blocking in
 * `epoll_wait`, consuming ~100% of a CPU core.
 *
 * This affects any `await` on a never-resolved Promise, including:
 * - `Promise.withResolvers()` used for user input callbacks
 * - `await proc.exited` for long-running child processes
 * - Agent loop iterations waiting for the next tool call
 *
 * ## Fix
 *
 * A recurring `setInterval` keeps the event loop sleeping in `epoll_wait`.
 * The `EventLoopKeepalive` class and `keepaliveWhile()` wrapper provide a
 * clean way to install and clean up this keepalive timer.
 *
 * The older `yieldIfDue()` and `ExponentialYield` approaches (compensated
 * sleep loops) are retained for the agent-loop hot-path where Promises
 * resolve frequently and the keepalive alone is insufficient.
 */

import { scheduler } from "node:timers/promises";

// ---------------------------------------------------------------------------
// EventLoopKeepalive — the primary fix for idle-state busy-wait
// ---------------------------------------------------------------------------

export class EventLoopKeepalive {
	#tmr = setInterval(() => {}, 86_400_000).unref();
	[Symbol.dispose](): void {
		clearInterval(this.#tmr);
	}
}

// ---------------------------------------------------------------------------
// yieldIfDue — retained for agent-loop hot-path
// ---------------------------------------------------------------------------

const YIELD_SLEEP_MS = 20;
const YIELD_INTERVAL_MS = 50;

/**
 * Wall-clock timestamp of the last completed yield. Module-level so that
 * tight loops sharing this helper collectively respect the gate, not just
 * one caller at a time.
 */
let lastYieldAt = 0;

/**
 * Sleep for at least `ms` milliseconds of wall-clock time.
 * Retries the wait if it returns prematurely (which can happen when napi
 * callbacks wake the event loop via `uv_async_send`). When `signal` is
 * provided, the wait is cancellable and silently returns on abort instead
 * of throwing — callers race against another promise that decides what to
 * do next.
 */
async function sleepAtLeast(ms: number, signal?: AbortSignal): Promise<void> {
	const start = performance.now();
	let remaining = ms;
	while (remaining > 0) {
		if (signal?.aborted) return;
		try {
			await scheduler.wait(remaining, { signal });
		} catch (err) {
			if ((err as { name?: string })?.name === "AbortError") return;
			throw err;
		}
		remaining = ms - (performance.now() - start);
	}
}

/**
 * Yield to the Bun event loop, sleeping for at least 20 ms — but at most
 * once every {@link YIELD_INTERVAL_MS}. Callers in hot paths can invoke
 * this freely; only the slow path actually sleeps.
 */
export async function yieldIfDue(): Promise<void> {
	const now = Date.now();
	if (now - lastYieldAt < YIELD_INTERVAL_MS) return;
	await sleepAtLeast(YIELD_SLEEP_MS);
	lastYieldAt = Date.now();
}

// ---------------------------------------------------------------------------
// ExponentialYield — retained for bash-executor long waits
// ---------------------------------------------------------------------------

const EXP_DEFAULT_MIN_MS = 20;
const EXP_DEFAULT_MAX_MS = 10_000;
const EXP_DEFAULT_MULTIPLIER = 2;

export class ExponentialYield {
	#currentMs: number;
	readonly #minMs: number;
	readonly #maxMs: number;
	readonly #multiplier: number;

	constructor(opts?: { minMs?: number; maxMs?: number; multiplier?: number }) {
		this.#minMs = opts?.minMs ?? EXP_DEFAULT_MIN_MS;
		this.#maxMs = opts?.maxMs ?? EXP_DEFAULT_MAX_MS;
		this.#multiplier = opts?.multiplier ?? EXP_DEFAULT_MULTIPLIER;
		this.#currentMs = this.#minMs;
	}

	notifyActivity(): void {
		this.#currentMs = this.#minMs;
	}

	async sleep(signal?: AbortSignal): Promise<number> {
		const ms = this.#currentMs;
		await sleepAtLeast(ms, signal);
		this.#currentMs = Math.min(this.#currentMs * this.#multiplier, this.#maxMs);
		return ms;
	}

	/**
	 * Race `racers` against an exponentially-backed-off cooperative yield.
	 * The losing sleep is cancelled as soon as a racer settles, so no stray
	 * timers keep the event loop alive past the racer's resolution.
	 */
	async race<T>(racers: Array<Promise<T>>): Promise<T> {
		const racer = Promise.race(racers);
		const controller = new AbortController();
		try {
			const yieldMarker = Symbol("exp-yield");
			for (;;) {
				const result = await Promise.race<T | typeof yieldMarker>([
					racer,
					this.sleep(controller.signal).then(() => yieldMarker as T | typeof yieldMarker),
				]);
				if (result !== yieldMarker) {
					this.notifyActivity();
					return result;
				}
			}
		} finally {
			controller.abort();
		}
	}
}

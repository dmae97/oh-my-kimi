/**
 * Cooperative yield utility for preventing Bun event-loop busy-wait.
 *
 * Bun 1.3.x (JavaScriptCore) does not automatically yield to the kernel when
 * the microtask queue is continuously non-empty.  In long-running agent loops
 * (LLM streaming, tool execution) this causes ~100% CPU usage even when the
 * process is simply waiting for I/O.
 *
 * `yieldIfDue()` uses a compensated sleep that retries `Bun.sleep()` until
 * the requested wall-clock duration has actually elapsed.  This is necessary
 * because napi callbacks (e.g. `Shell.run` chunk callbacks via `uv_async_send`)
 * can wake the event loop prematurely, causing `Bun.sleep(N)` to return after
 * only ~1–2 ms regardless of N.
 *
 * The minimum effective sleep is ~20 ms per yield; at ~30 yield calls/second
 * this gives 600 ms/second of kernel sleep → ~40% CPU under active load.
 */

const YIELD_SLEEP_MS = 20;

/**
 * Sleep for at least `ms` milliseconds of wall-clock time.
 * Retries `Bun.sleep()` if it returns prematurely (which can happen when
 * napi callbacks wake the event loop via `uv_async_send`).
 */
async function sleepAtLeast(ms: number): Promise<void> {
	const start = performance.now();
	let remaining = ms;
	while (remaining > 0) {
		await Bun.sleep(remaining);
		remaining = ms - (performance.now() - start);
	}
}

/** Yield to the Bun event loop, sleeping for at least 20 ms. */
export async function yieldIfDue(): Promise<void> {
	await sleepAtLeast(YIELD_SLEEP_MS);
}

// --- ExponentialYield ---

const EXP_DEFAULT_MIN_MS = 20;
const EXP_DEFAULT_MAX_MS = 10_000;
const EXP_DEFAULT_MULTIPLIER = 2;

export class ExponentialYield {
	private currentMs: number;
	private readonly minMs: number;
	private readonly maxMs: number;
	private readonly multiplier: number;

	constructor(opts?: { minMs?: number; maxMs?: number; multiplier?: number }) {
		this.minMs = opts?.minMs ?? EXP_DEFAULT_MIN_MS;
		this.maxMs = opts?.maxMs ?? EXP_DEFAULT_MAX_MS;
		this.multiplier = opts?.multiplier ?? EXP_DEFAULT_MULTIPLIER;
		this.currentMs = this.minMs;
	}

	notifyActivity(): void {
		this.currentMs = this.minMs;
	}

	async sleep(): Promise<number> {
		const ms = this.currentMs;
		await sleepAtLeast(ms);
		this.currentMs = Math.min(this.currentMs * this.multiplier, this.maxMs);
		return ms;
	}

	async race<T>(racers: Array<Promise<T>>): Promise<T> {
		const yieldMarker = Symbol("exp-yield");
		for (;;) {
			const result = await Promise.race<T | typeof yieldMarker>([
				Promise.race(racers),
				this.sleep().then(() => yieldMarker as T | typeof yieldMarker),
			]);
			if (result !== yieldMarker) {
				this.notifyActivity();
				return result;
			}
		}
	}
}
/**
 * Inactivity watchdog for eval cells.
 *
 * A cell's `timeout` is treated as an *idle* budget rather than a hard
 * wall-clock deadline: the watchdog aborts {@link signal} (with a
 * `TimeoutError` reason, matching `AbortSignal.timeout`) only once `idleMs`
 * elapses with no {@link bump}. Every progress signal re-arms it, so a
 * long-running fanout that keeps reporting progress (e.g. `agent()` status
 * updates, `log()`/`phase()`) never trips the timeout, while a genuinely
 * stalled cell still gets interrupted.
 *
 * The timer self-reschedules instead of being torn down and recreated on every
 * bump, so a high-frequency stream of bumps (sub-second agent progress) costs
 * one timestamp write per event rather than churning a timer each time.
 */
export class IdleTimeout {
	readonly #controller = new AbortController();
	readonly #idleMs: number;
	/** Absolute time (epoch ms) at which inactivity is considered to have expired. */
	#deadlineMs: number;
	#timer: NodeJS.Timeout | undefined;
	#settled = false;

	constructor(idleMs: number) {
		this.#idleMs = Math.max(1, Math.floor(idleMs));
		this.#deadlineMs = Date.now() + this.#idleMs;
		this.#arm(this.#idleMs);
	}

	/** Aborts with a `TimeoutError` reason once the inactivity budget is exhausted. */
	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	/** Configured inactivity budget in milliseconds. */
	get idleMs(): number {
		return this.#idleMs;
	}

	/** Record activity, pushing the inactivity deadline forward by `idleMs`. */
	bump(): void {
		if (this.#settled) return;
		this.#deadlineMs = Date.now() + this.#idleMs;
	}

	/** Stop the watchdog. Safe to call multiple times. */
	dispose(): void {
		if (this.#settled) return;
		this.#settled = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	[Symbol.dispose](): void {
		this.dispose();
	}

	#arm(delayMs: number): void {
		const timer = setTimeout(() => this.#onExpire(), Math.max(0, delayMs));
		// Never keep the event loop alive for the watchdog itself.
		timer.unref?.();
		this.#timer = timer;
	}

	#onExpire(): void {
		if (this.#settled) return;
		const remainingMs = this.#deadlineMs - Date.now();
		if (remainingMs > 0) {
			// A bump moved the deadline forward after this timer was armed; wait
			// out the remaining window instead of firing early.
			this.#arm(remainingMs);
			return;
		}
		this.#settled = true;
		this.#timer = undefined;
		this.#controller.abort(new DOMException(`Idle for ${Math.round(this.#idleMs / 1000)}s`, "TimeoutError"));
	}
}

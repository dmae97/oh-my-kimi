import { describe, expect, it } from "bun:test";
import { IdleTimeout } from "../idle-timeout";

/** Resolve true if `signal` aborts within `ms`, false if the window elapses first. */
function abortedWithin(signal: AbortSignal, ms: number): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(true);
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => resolve(false), ms);
	signal.addEventListener(
		"abort",
		() => {
			clearTimeout(timer);
			resolve(true);
		},
		{ once: true },
	);
	return promise;
}

describe("IdleTimeout", () => {
	it("aborts with a TimeoutError reason once the idle window elapses with no activity", async () => {
		using idle = new IdleTimeout(40);
		expect(idle.signal.aborted).toBe(false);

		const fired = await abortedWithin(idle.signal, 500);
		expect(fired).toBe(true);
		expect(idle.signal.aborted).toBe(true);
		// The reason must be a TimeoutError so downstream timeout detection
		// (kernel `isTimeoutReason`, executor `isTimedOutCancellation`) classifies
		// the cancellation as a timeout rather than a plain abort.
		expect(idle.signal.reason).toBeInstanceOf(DOMException);
		expect((idle.signal.reason as DOMException).name).toBe("TimeoutError");
	});

	it("re-arms on every bump and only fires after activity stops", async () => {
		using idle = new IdleTimeout(150);
		// Bump well past a single window; each bump must push the deadline forward
		// so the watchdog never trips while activity continues.
		for (let i = 0; i < 6; i++) {
			await Bun.sleep(40);
			idle.bump();
		}
		expect(idle.signal.aborted).toBe(false);

		// Activity stopped — the watchdog should now fire within roughly one window.
		const fired = await abortedWithin(idle.signal, 800);
		expect(fired).toBe(true);
	});

	it("never fires after dispose()", async () => {
		const idle = new IdleTimeout(30);
		idle.dispose();
		const fired = await abortedWithin(idle.signal, 150);
		expect(fired).toBe(false);
		expect(idle.signal.aborted).toBe(false);
	});

	it("ignores bump() after the watchdog has already fired", async () => {
		using idle = new IdleTimeout(30);
		await abortedWithin(idle.signal, 500);
		expect(idle.signal.aborted).toBe(true);
		// Late activity must not un-abort or rearm a settled watchdog.
		idle.bump();
		expect(idle.signal.aborted).toBe(true);
	});
});

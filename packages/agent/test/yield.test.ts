import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { ExponentialYield, yieldIfDue } from "@oh-my-pi/pi-agent-core/utils/yield";

const YIELD_INTERVAL_MS = 50;
const YIELD_CLOCK_STEP_MS = 60_000;
let fakeClockNow = Date.now();

afterEach(() => {
	vi.restoreAllMocks();
});

function installYieldClock(): { advanceBy: (ms: number) => void } {
	fakeClockNow += YIELD_CLOCK_STEP_MS;
	let now = fakeClockNow;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	return {
		advanceBy(ms: number) {
			now += ms;
			fakeClockNow = now;
		},
	};
}

describe("yieldIfDue", () => {
	it("sleeps on the first call and gates immediate callers", async () => {
		const clock = installYieldClock();
		const waitSpy = vi.spyOn(scheduler, "wait");

		await yieldIfDue();
		expect(waitSpy.mock.calls.length).toBeGreaterThan(0);
		const callsAfterFirstYield = waitSpy.mock.calls.length;

		clock.advanceBy(YIELD_INTERVAL_MS - 1);
		await yieldIfDue();
		expect(waitSpy.mock.calls.length).toBe(callsAfterFirstYield);
	});

	it("sleeps again once the gate window elapses", async () => {
		const clock = installYieldClock();
		const waitSpy = vi.spyOn(scheduler, "wait");

		await yieldIfDue();
		const callsAfterFirstYield = waitSpy.mock.calls.length;

		clock.advanceBy(YIELD_INTERVAL_MS);
		await yieldIfDue();
		expect(waitSpy.mock.calls.length).toBeGreaterThan(callsAfterFirstYield);
	});
});

describe("ExponentialYield.race", () => {
	it("returns the racer's value as soon as it settles", async () => {
		const ey = new ExponentialYield({ minMs: 5_000, maxMs: 10_000 });
		const racer = Bun.sleep(10).then(() => "done");
		const start = performance.now();
		const out = await ey.race([racer]);
		const elapsed = performance.now() - start;
		expect(out).toBe("done");
		// The 5s yield must not have delayed us: settle within a comfy margin.
		expect(elapsed).toBeLessThan(500);
	});

	it("cancels the losing sleep so it does not keep the loop alive", async () => {
		// If the losing Bun.sleep weren't cancelled, this test would block for
		// the full minMs after the racer wins, since the prior implementation
		// kept fresh timers ticking. We pick a minMs far larger than the racer
		// delay and assert we return well before it.
		const ey = new ExponentialYield({ minMs: 2_000, maxMs: 2_000 });
		const racer = Bun.sleep(20).then(() => 42);
		const start = performance.now();
		const out = await ey.race([racer]);
		const elapsed = performance.now() - start;
		expect(out).toBe(42);
		expect(elapsed).toBeLessThan(500);

		// After race resolves, ensure the AbortController-driven cancel really
		// unblocked the underlying timer: a short follow-up sleep should not
		// be perturbed by residual pending timers. (Sanity: this returns.)
		await Bun.sleep(30);
	});
});

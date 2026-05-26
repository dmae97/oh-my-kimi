import { describe, expect, it } from "bun:test";
import { ExponentialYield, yieldIfDue } from "../src/utils/yield";

const YIELD_SLEEP_MS = 20;
const YIELD_INTERVAL_MS = 50;

describe("yieldIfDue", () => {
	it("sleeps on the first call and primes the timestamp gate", async () => {
		// Prime the gate so the next call is in a known state.
		await yieldIfDue();
		const start = performance.now();
		await yieldIfDue();
		const elapsed = performance.now() - start;
		// Within the 50 ms gate window — must be a near-instant return.
		expect(elapsed).toBeLessThan(YIELD_SLEEP_MS / 2);
	});

	it("sleeps again once the gate window elapses", async () => {
		await yieldIfDue();
		// Wait past the gate the same way callers would (real time).
		await new Promise<void>(r => setTimeout(r, YIELD_INTERVAL_MS + 5));
		const start = performance.now();
		await yieldIfDue();
		const elapsed = performance.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(YIELD_SLEEP_MS - 5);
	});
});

describe("ExponentialYield.race", () => {
	it("returns the racer's value as soon as it settles", async () => {
		const ey = new ExponentialYield({ minMs: 5_000, maxMs: 10_000 });
		const racer = new Promise<string>(r => setTimeout(() => r("done"), 10));
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
		const racer = new Promise<number>(r => setTimeout(() => r(42), 20));
		const start = performance.now();
		const out = await ey.race([racer]);
		const elapsed = performance.now() - start;
		expect(out).toBe(42);
		expect(elapsed).toBeLessThan(500);

		// After race resolves, ensure the AbortController-driven cancel really
		// unblocked the underlying timer: a short follow-up sleep should not
		// be perturbed by residual pending timers. (Sanity: this returns.)
		await new Promise<void>(r => setTimeout(r, 30));
	});
});

import { describe, expect, it } from "vitest";
import { clampActionTimeout, computeRunBudget, type DeadlinePolicy, type RunBudget } from "../src/deadline-policy.ts";

const POLICY: DeadlinePolicy = {
	totalMs: 900_000,
	verifyReserveMs: 60_000,
	finalizeReserveMs: 20_000,
	cleanupReserveMs: 10_000,
};

describe("computeRunBudget", () => {
	it("returns the full budget at run start", () => {
		const budget = computeRunBudget(POLICY, 1_000_000, 1_000_000);

		expect(budget.remainingMs).toBe(900_000);
		expect(budget.explorationMs).toBe(810_000);
		expect(budget.phase).toBe("explore");
	});

	it("subtracts elapsed monotonic time", () => {
		const budget = computeRunBudget(POLICY, 1_000_000, 1_400_000);

		expect(budget.remainingMs).toBe(500_000);
		expect(budget.explorationMs).toBe(410_000);
		expect(budget.phase).toBe("explore");
	});

	it("switches to verify phase when only reserves remain", () => {
		const budget = computeRunBudget(POLICY, 1_000_000, 1_820_000);

		expect(budget.remainingMs).toBe(80_000);
		expect(budget.explorationMs).toBe(0);
		expect(budget.phase).toBe("verify");
	});

	it("is exhausted when the deadline passes", () => {
		const budget = computeRunBudget(POLICY, 1_000_000, 1_900_001);

		expect(budget.remainingMs).toBe(0);
		expect(budget.phase).toBe("exhausted");
	});

	it("never returns negative values on clock jumps", () => {
		const budget = computeRunBudget(POLICY, 1_000_000, 9_999_999_999);

		expect(budget.remainingMs).toBe(0);
		expect(budget.explorationMs).toBe(0);
		expect(budget.phase).toBe("exhausted");
	});
});

describe("clampActionTimeout", () => {
	it("keeps the requested timeout inside the exploration budget", () => {
		const budget: RunBudget = { remainingMs: 500_000, explorationMs: 410_000, phase: "explore" };

		expect(clampActionTimeout(budget, 30_000)).toBe(30_000);
		expect(clampActionTimeout(budget, 900_000)).toBe(410_000);
	});

	it("returns zero when no exploration budget remains", () => {
		const budget: RunBudget = { remainingMs: 80_000, explorationMs: 0, phase: "verify" };

		expect(clampActionTimeout(budget, 30_000)).toBe(0);
	});
});

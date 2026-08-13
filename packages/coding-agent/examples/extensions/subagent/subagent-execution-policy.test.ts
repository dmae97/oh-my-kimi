import { describe, expect, it } from "vitest";
import { exceedsParallelTaskLimit, resolveSubagentExecutionPolicy } from "./deadline-budget.ts";

describe("subagent execution policy", () => {
	it("keeps the bounded defaults outside Ultra", () => {
		const policy = resolveSubagentExecutionPolicy("high", 12);

		expect(policy).toEqual({ unbounded: false, maxParallelTasks: 8, concurrency: 4 });
		expect(exceedsParallelTaskLimit(policy, 9)).toBe(true);
	});

	it("removes task, concurrency, and deadline limits in Ultra", () => {
		const policy = resolveSubagentExecutionPolicy("ultra", 12);

		expect(policy).toEqual({ unbounded: true, maxParallelTasks: undefined, concurrency: 12 });
		expect(exceedsParallelTaskLimit(policy, 12)).toBe(false);
	});

	it("keeps the Ultra deadline bounded when an execution budget is explicit", () => {
		// Given an Ultra subagent call with an explicit wall-clock budget
		// When its execution policy is resolved
		const policy = resolveSubagentExecutionPolicy("ultra", 12, true);

		// Then only the deadline remains bounded; Ultra still removes task and concurrency limits
		expect(policy).toEqual({ unbounded: false, maxParallelTasks: undefined, concurrency: 12 });
	});
});

import { describe, expect, it } from "bun:test";
import type { GoalModeState } from "../../goals/state";
import type { UsageStatistics } from "../../session/session-manager";
import type { ToolSession } from "../../tools";
import { runEvalBudget } from "../budget-bridge";

function makeSession(parts: { goal?: GoalModeState; usage?: UsageStatistics }): ToolSession {
	return {
		getGoalModeState: parts.goal ? () => parts.goal : undefined,
		getUsageStatistics: parts.usage ? () => parts.usage as UsageStatistics : undefined,
	} as unknown as ToolSession;
}

function goalState(extra: Partial<GoalModeState["goal"]>): GoalModeState {
	return {
		enabled: true,
		mode: "active",
		goal: {
			id: "g1",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			...extra,
		},
	} as GoalModeState;
}

function usage(output: number): UsageStatistics {
	return { input: 0, output, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 };
}

describe("runEvalBudget", () => {
	it("reads tokenBudget/tokensUsed when Goal Mode is enabled", async () => {
		const session = makeSession({ goal: goalState({ tokenBudget: 100000, tokensUsed: 4200 }) });
		expect(await runEvalBudget({}, { session })).toEqual({ total: 100000, spent: 4200 });
	});

	it("returns null total when Goal Mode has no tokenBudget", async () => {
		const session = makeSession({ goal: goalState({ tokenBudget: undefined, tokensUsed: 1234 }) });
		expect(await runEvalBudget({}, { session })).toEqual({ total: null, spent: 1234 });
	});

	it("falls back to session output tokens when Goal Mode is absent", async () => {
		const session = makeSession({ usage: usage(777) });
		expect(await runEvalBudget({}, { session })).toEqual({ total: null, spent: 777 });
	});

	it("returns zero spent when neither getter is present", async () => {
		const session = makeSession({});
		expect(await runEvalBudget({}, { session })).toEqual({ total: null, spent: 0 });
	});
});

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runToolCallWithTimeout, type ToolLateSettlement } from "../src/tool-timeout.ts";
import type { AgentToolResult } from "../src/types.ts";

type RaceEvent = "real" | "timeout" | "abort";
type RealOutcome = "resolved" | "rejected";

const ORDERS: readonly (readonly [RaceEvent, RaceEvent, RaceEvent])[] = [
	["real", "timeout", "abort"],
	["real", "abort", "timeout"],
	["timeout", "real", "abort"],
	["timeout", "abort", "real"],
	["abort", "real", "timeout"],
	["abort", "timeout", "real"],
];

function timing(order: readonly RaceEvent[], event: RaceEvent): number {
	return (order.indexOf(event) + 1) * 10;
}

function errorResult(error: unknown): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		details: {},
	};
}

async function flushMicrotasks(rounds = 6): Promise<void> {
	for (let index = 0; index < rounds; index++) await Promise.resolve();
}

describe("tool settlement race properties", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("commits exactly one terminal disposition and never upgrades abort or timeout to completion", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(...ORDERS),
				fc.constantFrom<RealOutcome>("resolved", "rejected"),
				async (order, realOutcome) => {
					const controller = new AbortController();
					const lateSettlements: ToolLateSettlement[] = [];
					const realAt = timing(order, "real");
					const timeoutAt = timing(order, "timeout");
					const abortAt = timing(order, "abort");

					const pending = runToolCallWithTimeout({
						toolCallId: "property-call",
						toolName: "property-tool",
						timeoutMs: timeoutAt,
						signal: controller.signal,
						start: () =>
							new Promise<AgentToolResult<unknown>>((resolve, reject) => {
								setTimeout(() => {
									if (realOutcome === "resolved") {
										resolve({
											content: [{ type: "text", text: "real completion" }],
											details: { source: "real" },
										});
									} else {
										reject(new Error("real failure"));
									}
								}, realAt);
							}),
						emitUpdate: () => undefined,
						emitLateSettlement: (settlement) => void lateSettlements.push(settlement),
						toErrorResult: errorResult,
					});
					setTimeout(() => controller.abort(), abortAt);

					await vi.advanceTimersByTimeAsync(40);
					const committed = await pending;
					await flushMicrotasks();

					const winner = order[0];
					if (winner === "real") {
						expect(committed.terminalDisposition).toBeUndefined();
						expect(committed.isError).toBe(realOutcome === "rejected");
						expect(lateSettlements).toEqual([]);
						return;
					}

					const expectedDisposition = winner === "abort" ? "aborted" : "timeout";
					expect(committed.terminalDisposition).toBe(expectedDisposition);
					expect(committed.isError).toBe(true);
					expect(committed.result.details).toMatchObject({ omk: { disposition: expectedDisposition } });
					expect(Object.isFrozen(committed.result)).toBe(true);
					expect(lateSettlements).toEqual([
						{
							toolCallId: "property-call",
							toolName: "property-tool",
							disposition: expectedDisposition,
							outcome: realOutcome,
						},
					]);
				},
			),
			{ numRuns: 120, seed: 0x0fc52026 },
		);
	});
});

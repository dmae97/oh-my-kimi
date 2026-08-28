import { describe, expect, it } from "vitest";
import {
	createPromptSettlementState,
	type PromptSettlementSignal,
	reducePromptSettlement,
	resolvePromptSettlementOutcome,
	settlePromptIfReady,
	shouldEmitPromptSettled,
} from "../src/core/prompt-settlement.ts";

function terminalState(overrides: Partial<Parameters<typeof shouldEmitPromptSettled>[0]> = {}) {
	return {
		...reducePromptSettlement(createPromptSettlementState("run-1", 1_000), {
			kind: "terminal",
			outcome: "completed",
		}),
		...overrides,
	};
}

describe("prompt settlement reducer (§16)", () => {
	it("maps typed terminal outcomes without letting a stale completion hide failure", () => {
		expect(resolvePromptSettlementOutcome("completed", "completed")).toBe("completed");
		expect(resolvePromptSettlementOutcome("completed", "user_abort")).toBe("aborted");
		expect(resolvePromptSettlementOutcome("completed", "provider_abort")).toBe("aborted");
		expect(resolvePromptSettlementOutcome("completed", "provider_refusal")).toBe("failed");
		expect(resolvePromptSettlementOutcome("failed", "completed")).toBe("failed");
		expect(resolvePromptSettlementOutcome("completed", undefined)).toBe("completed");
	});

	it("emits only when every §16.4 condition holds", () => {
		expect(shouldEmitPromptSettled(terminalState())).toBe(true);
		expect(shouldEmitPromptSettled(terminalState({ activeProviderAttempts: 1 }))).toBe(false);
		expect(shouldEmitPromptSettled(terminalState({ activeTools: 1 }))).toBe(false);
		expect(shouldEmitPromptSettled(terminalState({ activeShards: 1 }))).toBe(false);
		expect(shouldEmitPromptSettled(terminalState({ activeChildren: 1 }))).toBe(false);
		expect(shouldEmitPromptSettled(terminalState({ queuedContinuations: 1 }))).toBe(false);
		expect(shouldEmitPromptSettled(terminalState({ emitted: true }))).toBe(false);
		expect(shouldEmitPromptSettled(createPromptSettlementState("run-1", 1_000))).toBe(false);
	});

	it("builds the §16.3 event with duration and latches emitted", () => {
		const { state, event } = settlePromptIfReady(terminalState(), 3_500);
		expect(event).toEqual({ type: "prompt_settled", promptRunId: "run-1", outcome: "completed", durationMs: 2_500 });
		expect(state.emitted).toBe(true);
		expect(settlePromptIfReady(state, 4_000).event).toBeNull();
	});

	it("keeps the first terminal outcome and clamps counters at zero", () => {
		let state = createPromptSettlementState("run-1", 0);
		state = reducePromptSettlement(state, { kind: "terminal", outcome: "failed", terminationKind: "provider" });
		state = reducePromptSettlement(state, { kind: "terminal", outcome: "completed" });
		expect(state.terminal).toEqual({ outcome: "failed", terminationKind: "provider" });
		state = reducePromptSettlement(state, { kind: "tool", delta: -1 });
		expect(state.activeTools).toBe(0);
	});

	it("property 11 (§23.2 seed 0x0fc52026): one event sequence emits at most once", () => {
		const random = mulberry32(0x0fc52026);
		const kinds = ["provider_attempt", "tool", "shard", "child", "continuation"] as const;
		for (let i = 0; i < 200; i++) {
			let state = createPromptSettlementState(`run-${i}`, 0);
			let emitted = 0;
			const steps = 5 + Math.floor(random() * 20);
			for (let step = 0; step < steps; step++) {
				const roll = random();
				const signal: PromptSettlementSignal =
					roll < 0.75
						? { kind: kinds[Math.floor(random() * kinds.length)], delta: random() < 0.5 ? 1 : -1 }
						: { kind: "terminal", outcome: "completed" };
				state = reducePromptSettlement(state, signal);
				const settled = settlePromptIfReady(state, step);
				state = settled.state;
				if (settled.event !== null) emitted += 1;
			}
			expect(emitted).toBeLessThanOrEqual(1);
			if (emitted === 1) expect(state.emitted).toBe(true);
		}
	});

	it("property 12 (§23.2): a queued continuation always blocks settlement", () => {
		const random = mulberry32(0x0fc52026 ^ 0xff);
		for (let i = 0; i < 200; i++) {
			const state = terminalState({ queuedContinuations: 1 + Math.floor(random() * 3) });
			expect(shouldEmitPromptSettled(state)).toBe(false);
			expect(settlePromptIfReady(state, 10).event).toBeNull();
		}
	});
});

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

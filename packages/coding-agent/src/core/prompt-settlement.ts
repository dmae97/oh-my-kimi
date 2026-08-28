import type { SessionTerminationKind } from "./session-termination.ts";

/**
 * Prompt settlement coordinator (OMK v0.97.x roadmap §16, M4/PR6).
 *
 * `agent_end` is NOT final (§16.1): provider retries, compaction retries,
 * durable-goal continuations, steering/follow-up queues, shards, and child
 * subagents may still run. `prompt_settled` fires only when the reducer's
 * §16.4 conditions all hold, exactly once per promptRunId. Consumers (the
 * M4 completion sound, notifications) must treat it as a UX signal, never a
 * correctness signal (§3 non-goals).
 *
 * The reducer is a pure function over immutable state (§16.5). Shard and child
 * counters are reserved in the contract, but no production signal call sites
 * wire them yet; any future live M5/M6 path must add those calls before use.
 */

export type PromptSettlementOutcome = "completed" | "failed" | "aborted";

/** §16.2 prompt run identity. */
export interface PromptRunRef {
	readonly promptRunId: string;
	readonly sessionId: string;
	readonly startedAt: string;
	readonly lineageId?: string;
}

/** §16.3 settlement contract. */
export interface PromptSettledEvent {
	readonly type: "prompt_settled";
	readonly promptRunId: string;
	readonly outcome: PromptSettlementOutcome;
	readonly durationMs: number;
	readonly terminationKind?: string;
}

/** §16.5 coordinator state. */
export interface PromptSettlementState {
	readonly promptRunId: string;
	readonly startedAtEpochMs: number;
	readonly activeProviderAttempts: number;
	readonly activeTools: number;
	readonly activeShards: number;
	readonly activeChildren: number;
	readonly queuedContinuations: number;
	readonly terminal?: {
		readonly outcome: PromptSettlementOutcome;
		readonly terminationKind?: string;
	};
	readonly emitted: boolean;
}

export type PromptSettlementSignal =
	| { readonly kind: "provider_attempt"; readonly delta: 1 | -1 }
	| { readonly kind: "tool"; readonly delta: 1 | -1 }
	| { readonly kind: "shard"; readonly delta: 1 | -1 }
	| { readonly kind: "child"; readonly delta: 1 | -1 }
	| { readonly kind: "continuation"; readonly delta: 1 | -1 }
	| { readonly kind: "terminal"; readonly outcome: PromptSettlementOutcome; readonly terminationKind?: string }
	| { readonly kind: "emitted" };

/** Map the final typed termination onto the prompt UX outcome. */
export function resolvePromptSettlementOutcome(
	fallback: PromptSettlementOutcome,
	terminationKind: SessionTerminationKind | undefined,
): PromptSettlementOutcome {
	if (terminationKind === "user_abort" || terminationKind === "provider_abort") return "aborted";
	if (fallback !== "completed") return fallback;
	if (terminationKind === undefined || terminationKind === "completed") return "completed";
	return "failed";
}

export function createPromptSettlementState(promptRunId: string, startedAtEpochMs: number): PromptSettlementState {
	return {
		promptRunId,
		startedAtEpochMs,
		activeProviderAttempts: 0,
		activeTools: 0,
		activeShards: 0,
		activeChildren: 0,
		queuedContinuations: 0,
		emitted: false,
	};
}

/** Pure reducer (§16.5). Counters clamp at zero; terminal and emitted are latching. */
export function reducePromptSettlement(
	state: PromptSettlementState,
	signal: PromptSettlementSignal,
): PromptSettlementState {
	switch (signal.kind) {
		case "provider_attempt":
			return { ...state, activeProviderAttempts: clampCount(state.activeProviderAttempts + signal.delta) };
		case "tool":
			return { ...state, activeTools: clampCount(state.activeTools + signal.delta) };
		case "shard":
			return { ...state, activeShards: clampCount(state.activeShards + signal.delta) };
		case "child":
			return { ...state, activeChildren: clampCount(state.activeChildren + signal.delta) };
		case "continuation":
			return { ...state, queuedContinuations: clampCount(state.queuedContinuations + signal.delta) };
		case "terminal":
			// First terminal outcome wins; later reclassification never flips it (§15.3).
			if (state.terminal !== undefined) {
				return state;
			}
			return { ...state, terminal: { outcome: signal.outcome, terminationKind: signal.terminationKind } };
		case "emitted":
			return { ...state, emitted: true };
		default: {
			const exhaustive: never = signal;
			return exhaustive;
		}
	}
}

/** §16.4: every condition must hold before `prompt_settled` may emit. */
export function shouldEmitPromptSettled(state: PromptSettlementState): boolean {
	return (
		state.terminal !== undefined &&
		!state.emitted &&
		state.activeProviderAttempts === 0 &&
		state.activeTools === 0 &&
		state.activeShards === 0 &&
		state.activeChildren === 0 &&
		state.queuedContinuations === 0
	);
}

/**
 * Build the event when (and only when) §16.4 holds, marking the state
 * emitted so the same sequence can never yield a second event.
 */
export function settlePromptIfReady(
	state: PromptSettlementState,
	nowEpochMs: number,
): { readonly state: PromptSettlementState; readonly event: PromptSettledEvent | null } {
	if (!shouldEmitPromptSettled(state) || state.terminal === undefined) {
		return { state, event: null };
	}
	const event: PromptSettledEvent = {
		type: "prompt_settled",
		promptRunId: state.promptRunId,
		outcome: state.terminal.outcome,
		durationMs: Math.max(0, nowEpochMs - state.startedAtEpochMs),
		...(state.terminal.terminationKind !== undefined ? { terminationKind: state.terminal.terminationKind } : {}),
	};
	return { state: reducePromptSettlement(state, { kind: "emitted" }), event };
}

function clampCount(value: number): number {
	return Math.max(0, value);
}

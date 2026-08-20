import type { DurableGoalStatus } from "./durable-goal.ts";

export interface GoalContinuationInput {
	readonly status: DurableGoalStatus;
	readonly completedRounds: number;
	readonly maxRounds: number;
	readonly hasQueuedMessages: boolean;
}

export interface GoalContinuationDecision {
	readonly continue: boolean;
	readonly reason: "active-goal" | "queued" | "not-active" | "round-limit";
}

export function decideGoalContinuation(input: GoalContinuationInput): GoalContinuationDecision {
	if (input.hasQueuedMessages) return { continue: true, reason: "queued" };
	if (input.status !== "active") return { continue: false, reason: "not-active" };
	if (input.completedRounds >= input.maxRounds) return { continue: false, reason: "round-limit" };
	return { continue: true, reason: "active-goal" };
}

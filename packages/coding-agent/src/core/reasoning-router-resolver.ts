/**
 * Shared resolver core for the v4 reasoning router: canonical task-class ->
 * ThinkingLevel rule table, lane-step adjustment, ladder-index clamping, and
 * bounded bias/hint/escalation resolution logic.
 *
 * Deterministic, side-effect-free: no clock, randomness, or I/O.
 */

import type { ThinkingLevel } from "omk-agent-core";

/** The 7-class union used by the v4 classifier. */
export type ReasoningTaskClass = "trivial" | "simple-edit" | "code-gen" | "debug" | "refactor" | "review" | "plan";

/** The 6-lane union used by the v4 classifier. */
export type ReasoningLane = "planner" | "security" | "explorer" | "coder" | "reviewer" | "tester";

/** Reasoning ladder used for targets and clamping. Intentionally excludes "off". */
export const REASONING_LADDER: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Static rule table: task class -> recommended ThinkingLevel (before lane adjustment, bias, hint, escalation, and clamping). */
export const TASK_CLASS_THINKING_LEVELS: Readonly<Record<ReasoningTaskClass, ThinkingLevel>> = {
	trivial: "minimal",
	"simple-edit": "low",
	"code-gen": "medium",
	debug: "high",
	refactor: "high",
	review: "high",
	plan: "xhigh",
};

/** Lane adjustment in ladder steps: planner/security escalate, explorer de-escalates. */
export const LANE_STEP: Readonly<Partial<Record<ReasoningLane, 1 | -1>>> = {
	planner: 1,
	security: 1,
	explorer: -1,
};

/** Maximum magnitude of the learning/consult bias (ladder steps). */
export const BIAS_MAX = 2;
/** Confidence floor at which an override hint is fused into the target. */
export const HINT_CONFIDENCE_THRESHOLD = 0.7;

function clampToLadderIndex(index: number): number {
	return Math.max(0, Math.min(index, REASONING_LADDER.length - 1));
}

/**
 * Clamp a target ladder index to capability: the highest level in
 * `availableLevels` that is <= the target; if no available level is at/below
 * the target, return the lowest available reasoning level. Never invents a
 * level outside `availableLevels`. `"off"` is only returned when
 * `availableLevels` is empty (callers are expected to bypass the router
 * entirely for models with `reasoning: false`).
 */
export function clampToAvailable(targetIndex: number, availableLevels: readonly ThinkingLevel[]): ThinkingLevel {
	const availableOnLadder = REASONING_LADDER.filter((level) => availableLevels.includes(level));
	if (availableOnLadder.length === 0) {
		return availableLevels[0] ?? "off";
	}
	for (let i = targetIndex; i >= 0; i--) {
		const candidate = REASONING_LADDER[i];
		if (availableOnLadder.includes(candidate)) return candidate;
	}
	return availableOnLadder[0];
}

/**
 * Canonical resolver core for v4.
 *
 * Pipeline: base rule table -> lane step -> bounded bias [-BIAS_MAX,+BIAS_MAX]
 * -> optional hint fusion (bounded ±BIAS_MAX steps toward hint.level, only
 * when hint.confidence >= HINT_CONFIDENCE_THRESHOLD) -> non-negative
 * escalationSteps bump -> clamp to availableLevels.
 */
export function resolveThinkingLevelCore(
	taskClass: ReasoningTaskClass,
	availableLevels: readonly ThinkingLevel[],
	laneType: ReasoningLane | undefined,
	bias: number,
	hint: { level: ThinkingLevel; confidence: number } | null,
	escalationSteps: number,
): ThinkingLevel {
	const baseIndex = REASONING_LADDER.indexOf(TASK_CLASS_THINKING_LEVELS[taskClass]);
	const laneStep = laneType ? (LANE_STEP[laneType] ?? 0) : 0;
	const biasClamped = Math.max(-BIAS_MAX, Math.min(BIAS_MAX, bias));
	let targetIndex = clampToLadderIndex(baseIndex + laneStep + biasClamped);

	if (hint !== null && hint.confidence >= HINT_CONFIDENCE_THRESHOLD) {
		const hintIndex = REASONING_LADDER.indexOf(hint.level);
		if (hintIndex >= 0) {
			const delta = hintIndex - targetIndex;
			const step = Math.max(-BIAS_MAX, Math.min(BIAS_MAX, delta));
			targetIndex = clampToLadderIndex(targetIndex + step);
		}
	}

	if (escalationSteps > 0) {
		targetIndex = clampToLadderIndex(targetIndex + escalationSteps);
	}

	return clampToAvailable(targetIndex, availableLevels);
}

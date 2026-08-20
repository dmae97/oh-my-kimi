import { isVisionRouteModel } from "omk-agent-core";
import type { AssistantMessage } from "omk-ai";
import { isContextOverflow } from "omk-ai";

/**
 * Gates that run before any compaction evaluation. A message is skipped when
 * compaction is disabled, when an aborted turn should not trigger it, or when
 * the message predates the latest compaction boundary (stale usage/errors must
 * not retrigger compaction right after one finished).
 */
export function shouldSkipCompactionCheck(input: {
	readonly enabled: boolean;
	readonly skipAbortedCheck: boolean;
	readonly stopReason: string;
	readonly messageTimestamp: number;
	readonly latestCompactionTimestamp?: number;
}): boolean {
	if (!input.enabled) return true;
	if (input.skipAbortedCheck && input.stopReason === "aborted") return true;
	return input.latestCompactionTimestamp !== undefined && input.messageTimestamp <= input.latestCompactionTimestamp;
}

/**
 * An overflow only counts as this session's own when the failing message came
 * from the session model — or from the auto-routed vision model while the
 * session model is text-only. Overflow from a model the user switched away
 * from must not trigger compaction for the current one.
 */
export function isSessionModelOverflow(input: {
	readonly message: AssistantMessage;
	readonly contextWindow: number;
	readonly sessionProvider?: string;
	readonly sessionModelId?: string;
	readonly sessionInputs?: readonly string[];
}): boolean {
	const sameModel =
		input.sessionProvider !== undefined &&
		input.sessionModelId !== undefined &&
		input.message.provider === input.sessionProvider &&
		input.message.model === input.sessionModelId;
	const visionRouteOverflow =
		input.sessionProvider !== undefined &&
		!(input.sessionInputs ?? []).includes("image") &&
		isVisionRouteModel({ provider: input.message.provider, id: input.message.model });
	if (!sameModel && !visionRouteOverflow) return false;
	return isContextOverflow(input.message, input.contextWindow);
}

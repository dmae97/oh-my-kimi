import type { AssistantMessage } from "omk-ai";
import { isContextOverflow } from "omk-ai";
import {
	isContentSafetyStopMessage,
	isQuotaExhaustionMessage,
	isTransientProviderErrorMessage,
} from "./provider-resilience.ts";

/**
 * Pure retry/failover decisions for agent-turn provider errors.
 * Context overflow is never retryable here — compaction owns that path.
 * Quota exhaustion is retryable so the failover chain can save the turn.
 */
export function isRetryableAssistantError(message: AssistantMessage, contextWindow: number): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	if (isContextOverflow(message, contextWindow)) return false;
	if (isQuotaExhaustionMessage(message.errorMessage)) return true;
	return isTransientProviderErrorMessage(message.errorMessage);
}

/**
 * Next attempt number within the retry budget, or undefined when retry is
 * disabled or the budget is exhausted. The caller's completed-attempt count
 * stays unchanged when undefined is returned.
 */
export function retryBudgetForAssistantError(message: AssistantMessage, configuredMaxRetries: number): number {
	if (configuredMaxRetries <= 0) return 0;
	return isContentSafetyStopMessage(message.errorMessage) ? Math.min(1, configuredMaxRetries) : configuredMaxRetries;
}

export function nextRetryAttempt(input: {
	readonly enabled: boolean;
	readonly completedAttempts: number;
	readonly maxRetries: number;
}): number | undefined {
	if (!input.enabled) return undefined;
	const attempt = input.completedAttempts + 1;
	return attempt > input.maxRetries ? undefined : attempt;
}

/** Same-model retry backs off exponentially; a failed-over retry starts fast. */
export function computeRetryDelayMs(baseDelayMs: number, attempt: number, failoverOccurred: boolean): number {
	return failoverOccurred ? Math.min(400, baseDelayMs) : baseDelayMs * 2 ** (attempt - 1);
}

/**
 * Errors that justify an immediate model switch instead of a same-model retry:
 * safety-stop false positives and billing/quota exhaustion. Both mean the
 * current model cannot finish this turn.
 */
export function isFailoverTriggerError(errorMessage: string | undefined): boolean {
	return isContentSafetyStopMessage(errorMessage) || isQuotaExhaustionMessage(errorMessage);
}

/** Bookkeeping key for the per-turn refused/failed model set. */
export function failoverModelKey(provider: string, id: string): string {
	return `${provider}/${id}`;
}

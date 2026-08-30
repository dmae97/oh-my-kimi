import type { RetryCallbacks, RetryPolicy } from "omk-ai";

export type SummarizationOperation = "compaction" | "branch_summary";

export interface RetryScheduledEvent {
	readonly type: "retry_scheduled";
	readonly operation: SummarizationOperation;
	readonly attempt: number;
	readonly maxAttempts: number;
	readonly delayMs: number;
	readonly errorMessage: string;
}

export interface RetryAttemptStartEvent {
	readonly type: "retry_attempt_start";
	readonly operation: SummarizationOperation;
	readonly attempt: number;
}

export interface RetryFinishedEvent {
	readonly type: "retry_finished";
	readonly operation: SummarizationOperation;
	readonly success: boolean;
	readonly attempt: number;
	readonly finalError?: string;
}

export type SummarizationRetryEvent = RetryScheduledEvent | RetryAttemptStartEvent | RetryFinishedEvent;

/** Build retry policy/callbacks without coupling the leaf module to harness event types. */
export function createSummarizationRetry(
	operation: SummarizationOperation,
	policy: RetryPolicy | undefined,
	emit: (event: SummarizationRetryEvent) => Promise<void> | void,
): { readonly retry: RetryPolicy | undefined; readonly callbacks: RetryCallbacks } {
	let scheduledAttempt = 0;
	return {
		retry: policy,
		callbacks: {
			onRetryScheduled: async (attempt, maxAttempts, delayMs, errorMessage) => {
				scheduledAttempt = attempt;
				await emit({ type: "retry_scheduled", operation, attempt, maxAttempts, delayMs, errorMessage });
			},
			onRetryAttemptStart: async () => {
				await emit({ type: "retry_attempt_start", operation, attempt: scheduledAttempt });
			},
			onRetryFinished: async (success, attempt, finalError) => {
				await emit({ type: "retry_finished", operation, success, attempt, finalError });
			},
		},
	};
}

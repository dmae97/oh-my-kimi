/**
 * Bounded retries for an empty assistant completion.
 *
 * Some providers — and especially flaky OpenAI-/Anthropic-compatible gateways —
 * intermittently return a benign terminal stop carrying no content and no usage
 * (e.g. a single OpenAI `delta: {}` + `finish_reason: "stop"` chunk). Delivered
 * as-is the agent loop has nothing to act on and silently halts mid-task, so the
 * request must be retried instead of surfaced.
 *
 * This wraps a single-attempt provider stream and re-invokes it (a fresh request
 * with its own message state) when an attempt produces no meaningful content.
 * Only a stream that streamed nothing meaningful is retried: the moment any
 * text/thinking/tool delta is forwarded the attempt is committed, so live
 * streaming (including thinking) is never delayed, retried, or duplicated.
 *
 * Mirrors the Gemini empty-response policy in `google-shared` (which keeps its
 * own integrated loop) and is shared by the OpenAI-completions and
 * Anthropic-messages providers.
 */
import { scheduler } from "node:timers/promises";
import type { AssistantMessage, AssistantMessageEvent, Context } from "../types";
import { AssistantMessageEventStream } from "./event-stream";

export const MAX_EMPTY_COMPLETION_RETRIES = 2;
export const EMPTY_COMPLETION_BASE_DELAY_MS = 500;

const NON_WHITESPACE_RE = /\S/;

/**
 * Whether a completed assistant message carries content worth delivering: a tool
 * call or any non-whitespace text. An empty/whitespace-only message — or one
 * that only ever produced thinking — is the "empty response" failure.
 */
export function hasVisibleAssistantContent(message: AssistantMessage): boolean {
	for (const block of message.content) {
		if (block.type === "toolCall") return true;
		if (block.type === "text" && NON_WHITESPACE_RE.test(block.text)) return true;
	}
	return false;
}

/** A streamed event that delivers content worth committing the attempt for. */
function isMeaningfulCompletionEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		case "toolcall_start":
		case "toolcall_end":
			return true;
		default:
			return false;
	}
}

interface EmptyCompletionRetryOptions {
	signal?: AbortSignal;
	providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Wrap a single-attempt provider stream with bounded empty-completion retries.
 * `attempt` MUST create a fresh request (and its own output message) on each
 * call so a retry never inherits stale metadata from an empty attempt.
 */
export function withEmptyCompletionRetry<M, O extends EmptyCompletionRetryOptions>(
	model: M,
	context: Context,
	options: O | undefined,
	attempt: (model: M, context: Context, options?: O) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const signal = options?.signal;
	void (async () => {
		for (let emptyAttempt = 0; ; emptyAttempt++) {
			const inner = attempt(model, context, options);
			const buffered: AssistantMessageEvent[] = [];
			let committed = false;
			let terminal: AssistantMessageEvent | undefined;
			const flush = (): void => {
				for (const event of buffered) outer.push(event);
				buffered.length = 0;
			};
			try {
				for await (const event of inner) {
					if (event.type === "done" || event.type === "error") {
						terminal = event;
						break;
					}
					// Buffer pre-content events (start/*_start) so an empty attempt can
					// be discarded; commit the moment real content streams.
					if (!committed && !isMeaningfulCompletionEvent(event)) {
						buffered.push(event);
						continue;
					}
					committed = true;
					flush();
					outer.push(event);
					if (outer.done) return;
				}
			} catch (error) {
				flush();
				outer.fail(error);
				return;
			}

			// Retry only a genuinely degenerate completion: a normal stop that
			// produced no visible content AND billed no output tokens (the flaky
			// gateway signature — charged nothing, returned nothing). A stop that
			// reports output tokens spent its budget somewhere (e.g. thinking) and
			// is left alone.
			const message = terminal?.type === "done" ? terminal.message : undefined;
			const isRetryableEmpty =
				!committed &&
				message !== undefined &&
				message.stopReason === "stop" &&
				!message.errorMessage &&
				(message.usage?.output ?? 0) <= 0 &&
				!hasVisibleAssistantContent(message);

			if (isRetryableEmpty && emptyAttempt < MAX_EMPTY_COMPLETION_RETRIES && !signal?.aborted) {
				const delayMs = EMPTY_COMPLETION_BASE_DELAY_MS * 2 ** emptyAttempt;
				try {
					if (options?.providerRetryWait) await options.providerRetryWait(delayMs, signal);
					else await scheduler.wait(delayMs, { signal });
				} catch (waitError) {
					// Aborted during backoff: deliver the empty result rather than hang.
					// Any other wait failure is a real error and must surface.
					flush();
					if (signal?.aborted) {
						if (terminal) outer.push(terminal);
					} else {
						outer.fail(waitError);
					}
					return;
				}
				// Discard the buffered `start` from this empty attempt and retry.
				continue;
			}

			flush();
			if (terminal) {
				outer.push(terminal);
			} else if (!outer.done) {
				try {
					outer.end(await inner.result());
				} catch (error) {
					outer.fail(error);
				}
			}
			return;
		}
	})();
	return outer;
}

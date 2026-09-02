/**
 * Failure-text to `SessionTerminationCause` classification.
 *
 * This is the layer *below* `session-termination.ts`: that module turns a cause
 * into a kind/phase/next-action record, while this one decides which cause a
 * provider error, a preflight rejection, or a thrown runtime error represents.
 *
 * The functions are pure so the ordering can be pinned by direct tests. Ordering
 * is load-bearing in two places that are easy to regress:
 *
 *   - quota/billing exhaustion is matched *before* the generic 401/403 auth
 *     patterns, because `403 ... usage limit for this billing cycle` is
 *     transient per cycle and must fail over instead of terminating as auth;
 *   - upstream 5xx/dropped streams are matched *before* the protocol fallback,
 *     so guidance points at retry/model-switch rather than transcript sanitize.
 */

import { type AssistantMessage, isContextOverflow } from "omk-ai";
import {
	isClaudeCodeVersionTooOldMessage,
	isQuotaExhaustionMessage,
	isUpstreamUnavailableMessage,
} from "./provider-resilience.ts";
import { redactSensitiveText } from "./redaction.ts";
import { MAX_SESSION_TERMINATION_MESSAGE_LENGTH, type SessionTerminationCause } from "./session-termination.ts";

/**
 * Errno codes that mean a write could not be durably completed. Anything else
 * (a missing path, for example) is not evidence of a persistence fault.
 */
const PERSISTENCE_ERRNO_CODES: ReadonlySet<string> = new Set([
	"EACCES",
	"EDQUOT",
	"EFBIG",
	"EIO",
	"EISDIR",
	"EMFILE",
	"ENFILE",
	"ENOSPC",
	"EPERM",
	"EROFS",
]);

/**
 * Normalize a free-text failure message for the termination record: redact
 * secret-shaped content, drop NUL bytes, and bound the length.
 */
export function terminationMessage(value: string | undefined, fallback: string): string {
	const redacted = redactSensitiveText(value?.trim() || fallback)
		.replace(/\0/g, "")
		.slice(0, MAX_SESSION_TERMINATION_MESSAGE_LENGTH);
	return redacted || fallback;
}

/** Classify a failed provider turn from the assistant message it produced. */
export function providerFailureCause(message: AssistantMessage, contextWindow: number): SessionTerminationCause {
	const text = message.errorMessage ?? "";
	if (isContextOverflow(message, contextWindow)) {
		return { area: "provider", code: "context_overflow" };
	}
	// Fable/Claude often emit stop_reason=refusal on benign turns (false positive).
	// Match broadly so we never mislabel these as provider.protocol.
	if (
		/stop_reason\s*=\s*(refusal|sensitive)|content\/safety stop|safety stop|provider\.refusal|kind=provider_refusal/i.test(
			text,
		)
	) {
		return { area: "provider", code: "refusal" };
	}
	// A stale spoofed Claude Code version against a newer model's gate is a client
	// configuration fault, not a transcript-shape one: it must not inherit the
	// retryable protocol default at the bottom of this function.
	if (isClaudeCodeVersionTooOldMessage(text)) {
		return { area: "configuration", code: "invalid" };
	}
	// Quota/billing exhaustion is checked BEFORE the generic 401/403 auth
	// patterns: "403 ... usage limit for this billing cycle" is transient per
	// cycle and must fail over, not terminate the turn as an auth error.
	if (isQuotaExhaustionMessage(text) || /rate.?limit|too many requests|429/i.test(text)) {
		return { area: "provider", code: "rate_limit" };
	}
	if (/auth|unauthori[sz]ed|forbidden|invalid.?api.?key|no api key|401|403|\/login/i.test(text)) {
		return { area: "provider", code: "auth" };
	}
	// Gateway/upstream 5xx and dropped streams are transport failures, not
	// transcript-shape problems. Classify as network so the guidance points to
	// retry/model-switch instead of the protocol sanitize path.
	if (isUpstreamUnavailableMessage(text)) {
		return { area: "provider", code: "network" };
	}
	// Kimi/K3 + OpenAI-compat: orphan tool results after dropped error assistants.
	// Sanitize-and-retry (transform-messages drops orphans), not a hard tool fatal.
	if (/tool_call_id\s+is\s+not\s+found|tool_call_id\s+not\s+found|unknown\s+tool_call_id/i.test(text)) {
		return { area: "provider", code: "protocol" };
	}
	if (/tool.+timed? out|tool.+timeout/i.test(text)) return { area: "tool", code: "timeout" };
	if (/\btool\b/i.test(text) && !/tool_call_id/i.test(text)) return { area: "tool", code: "fatal" };
	if (/network|fetch failed|connection|socket|websocket|timed? out|timeout|dns|econn|^terminated$/i.test(text)) {
		return { area: "provider", code: "network" };
	}
	return { area: "provider", code: "protocol" };
}

/**
 * Classify a preflight rejection raised before the provider was called.
 * `hasModel` is false when no model is selected for the session.
 */
export function preflightFailureCause(message: string, hasModel: boolean): SessionTerminationCause {
	if (!hasModel || /no model|model selected|model is required/i.test(message)) {
		return { area: "configuration", code: "invalid" };
	}
	if (isQuotaExhaustionMessage(message)) {
		return { area: "provider", code: "rate_limit" };
	}
	if (/auth|api key|unauthori[sz]ed|forbidden|401|403|\/login/i.test(message)) {
		return { area: "provider", code: "auth" };
	}
	if (isUpstreamUnavailableMessage(message)) {
		return { area: "provider", code: "network" };
	}
	if (/context.+overflow|context window|too many tokens/i.test(message)) {
		return { area: "provider", code: "context_overflow" };
	}
	if (/duplicate.?result/i.test(message)) return { area: "transcript", code: "duplicate_result" };
	if (/orphan.?result/i.test(message)) return { area: "transcript", code: "orphan_result" };
	if (/duplicate.?call/i.test(message)) return { area: "transcript", code: "duplicate_call_id" };
	if (/transcript|missing.?result/i.test(message)) return { area: "transcript", code: "missing_result" };
	if (/compaction/i.test(message)) return { area: "compaction", code: "failed" };
	if (/fsync/i.test(message)) return { area: "persistence", code: "fsync_failed" };
	if (/lock/i.test(message)) return { area: "persistence", code: "lock_failed" };
	if (/append|persist|write/i.test(message)) return { area: "persistence", code: "append_failed" };
	if (/tool/i.test(message)) return { area: "tool", code: "fatal" };
	return { area: "internal", code: "unclassified" };
}

/** Classify a value thrown out of the session runtime itself. */
export function runtimeFailureCause(error: unknown): SessionTerminationCause {
	const code = typeof error === "object" && error !== null && "code" in error ? Reflect.get(error, "code") : undefined;
	if (typeof code === "string" && PERSISTENCE_ERRNO_CODES.has(code)) {
		return { area: "persistence", code: "append_failed" };
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/compaction.+stale|session changed during compaction/i.test(message)) {
		return { area: "compaction", code: "stale" };
	}
	if (/compaction/i.test(message)) return { area: "compaction", code: "failed" };
	return { area: "internal", code: "unclassified" };
}

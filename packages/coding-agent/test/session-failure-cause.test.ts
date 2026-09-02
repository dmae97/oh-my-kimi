import type { AssistantMessage } from "omk-ai";
import { describe, expect, it } from "vitest";
import {
	preflightFailureCause,
	providerFailureCause,
	runtimeFailureCause,
	terminationMessage,
} from "../src/core/session-failure-cause.ts";

/**
 * Characterization tests for the failure-text -> SessionTerminationCause layer
 * extracted from AgentSession. These lock the classification order, which is
 * load-bearing: quota/billing must win over the generic 401/403 auth patterns,
 * and upstream 5xx must classify as network rather than protocol.
 */

function assistantError(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage,
	} as unknown as AssistantMessage;
}

describe("terminationMessage", () => {
	it("falls back when the value is empty or whitespace", () => {
		expect(terminationMessage(undefined, "fallback")).toBe("fallback");
		expect(terminationMessage("", "fallback")).toBe("fallback");
		expect(terminationMessage("   ", "fallback")).toBe("fallback");
	});

	it("trims, strips NUL bytes, and caps at 512 characters", () => {
		expect(terminationMessage("  boom  ", "fallback")).toBe("boom");
		expect(terminationMessage("a\0b", "fallback")).toBe("ab");
		expect(terminationMessage("x".repeat(600), "fallback")).toHaveLength(512);
	});

	it("redacts secret-shaped content before it reaches the termination record", () => {
		const redacted = terminationMessage("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "fallback");
		expect(redacted).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
	});
});

describe("providerFailureCause", () => {
	it("classifies context overflow ahead of every text pattern", () => {
		const message = assistantError("prompt is too long: 250000 tokens > 200000 maximum");
		expect(providerFailureCause(message, 200_000)).toEqual({ area: "provider", code: "context_overflow" });
	});

	it("classifies refusal/safety stops as provider.refusal", () => {
		expect(providerFailureCause(assistantError("stop_reason=refusal"), 0)).toEqual({
			area: "provider",
			code: "refusal",
		});
		expect(providerFailureCause(assistantError("content/safety stop observed"), 0)).toEqual({
			area: "provider",
			code: "refusal",
		});
	});

	it("prefers quota exhaustion over the generic 403 auth pattern", () => {
		const message = assistantError("403 Forbidden: you have hit your usage limit for this billing cycle");
		expect(providerFailureCause(message, 0)).toEqual({ area: "provider", code: "rate_limit" });
	});

	it("classifies plain auth failures as provider.auth", () => {
		expect(providerFailureCause(assistantError("401 unauthorized: invalid api key"), 0)).toEqual({
			area: "provider",
			code: "auth",
		});
	});

	it("classifies upstream 5xx as network, not protocol", () => {
		expect(providerFailureCause(assistantError("502 Bad Gateway"), 0)).toEqual({
			area: "provider",
			code: "network",
		});
	});

	it("classifies orphan tool_call_id as a recoverable protocol fault", () => {
		expect(providerFailureCause(assistantError("tool_call_id is not found"), 0)).toEqual({
			area: "provider",
			code: "protocol",
		});
	});

	it("classifies a stale Claude Code client version as a configuration fault", () => {
		// Left to the protocol default this reads as retryable and advertises the
		// orphan tool_call_id sanitize path — wrong on both counts for a permanent
		// client-version rejection.
		const error =
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.75 does not support this model; version 2.1.251 or newer is required.","details":{"error_code":"claude_code_version_too_old"}}}';

		expect(providerFailureCause(assistantError(error), 0)).toEqual({ area: "configuration", code: "invalid" });
	});

	it("separates tool timeout from tool fatal", () => {
		expect(providerFailureCause(assistantError("tool timed out after 30s"), 0)).toEqual({
			area: "tool",
			code: "timeout",
		});
		expect(providerFailureCause(assistantError("tool crashed"), 0)).toEqual({ area: "tool", code: "fatal" });
	});

	it("defaults to provider.protocol when nothing matches", () => {
		expect(providerFailureCause(assistantError("something entirely unexpected"), 0)).toEqual({
			area: "provider",
			code: "protocol",
		});
	});
});

describe("preflightFailureCause", () => {
	it("treats a missing model as a configuration fault", () => {
		expect(preflightFailureCause("anything at all", false)).toEqual({ area: "configuration", code: "invalid" });
		expect(preflightFailureCause("no model selected", true)).toEqual({ area: "configuration", code: "invalid" });
	});

	it("classifies transcript-shape faults distinctly", () => {
		expect(preflightFailureCause("duplicate result block", true)).toEqual({
			area: "transcript",
			code: "duplicate_result",
		});
		expect(preflightFailureCause("orphan result block", true)).toEqual({
			area: "transcript",
			code: "orphan_result",
		});
		expect(preflightFailureCause("duplicate call id", true)).toEqual({
			area: "transcript",
			code: "duplicate_call_id",
		});
		expect(preflightFailureCause("transcript is missing a result", true)).toEqual({
			area: "transcript",
			code: "missing_result",
		});
	});

	it("classifies persistence faults by specificity", () => {
		expect(preflightFailureCause("fsync failed", true)).toEqual({ area: "persistence", code: "fsync_failed" });
		expect(preflightFailureCause("lock is held", true)).toEqual({ area: "persistence", code: "lock_failed" });
		expect(preflightFailureCause("append failed", true)).toEqual({ area: "persistence", code: "append_failed" });
	});

	it("falls through to internal.unclassified", () => {
		expect(preflightFailureCause("wat", true)).toEqual({ area: "internal", code: "unclassified" });
	});
});

describe("runtimeFailureCause", () => {
	it("maps write-side errno codes to persistence.append_failed", () => {
		for (const code of [
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
		]) {
			expect(runtimeFailureCause(Object.assign(new Error("write"), { code }))).toEqual({
				area: "persistence",
				code: "append_failed",
			});
		}
	});

	it("does not treat an unrelated errno as persistence", () => {
		expect(runtimeFailureCause(Object.assign(new Error("nope"), { code: "ENOENT" }))).toEqual({
			area: "internal",
			code: "unclassified",
		});
	});

	it("separates stale compaction from failed compaction", () => {
		expect(runtimeFailureCause(new Error("session changed during compaction"))).toEqual({
			area: "compaction",
			code: "stale",
		});
		expect(runtimeFailureCause(new Error("compaction blew up"))).toEqual({ area: "compaction", code: "failed" });
	});

	it("stringifies non-Error throws before matching", () => {
		expect(runtimeFailureCause("compaction went sideways")).toEqual({ area: "compaction", code: "failed" });
		expect(runtimeFailureCause(undefined)).toEqual({ area: "internal", code: "unclassified" });
	});
});

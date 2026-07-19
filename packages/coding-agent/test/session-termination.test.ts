import { describe, expect, it } from "vitest";
import {
	classifySessionTermination,
	formatSessionTermination,
	MAX_SESSION_TERMINATION_MESSAGE_LENGTH,
	type SessionSideEffects,
	type SessionTerminationCause,
	type SessionTerminationKind,
	type SessionTerminationSource,
} from "../src/core/session-termination.ts";

const NOW = "2026-07-15T00:00:00.000Z";

function classify(
	cause: SessionTerminationCause,
	options: {
		source?: SessionTerminationSource;
		sideEffects?: SessionSideEffects;
	} = {},
) {
	return classifySessionTermination({
		sessionId: "session-1",
		runId: "run-1",
		timestamp: NOW,
		source: options.source ?? "observed",
		message: "Pre-redacted diagnostic",
		cause,
		sideEffects: options.sideEffects ?? "none",
	});
}

describe("classifySessionTermination", () => {
	const cases: Array<{
		cause: SessionTerminationCause;
		kind: SessionTerminationKind;
		source?: SessionTerminationSource;
	}> = [
		{ cause: { area: "completed" }, kind: "completed" },
		{ cause: { area: "user", code: "abort" }, kind: "user_abort" },
		{ cause: { area: "provider", code: "abort" }, kind: "provider_abort" },
		{ cause: { area: "provider", code: "auth" }, kind: "provider_auth" },
		{ cause: { area: "provider", code: "rate_limit" }, kind: "provider_rate_limit" },
		{ cause: { area: "provider", code: "network" }, kind: "provider_network" },
		{ cause: { area: "provider", code: "protocol" }, kind: "provider_protocol" },
		{ cause: { area: "provider", code: "context_overflow" }, kind: "context_overflow" },
		{ cause: { area: "tool", code: "timeout" }, kind: "tool_timeout" },
		{ cause: { area: "tool", code: "fatal" }, kind: "tool_fatal" },
		{ cause: { area: "compaction", code: "failed" }, kind: "compaction" },
		{ cause: { area: "persistence", code: "fsync_failed" }, kind: "persistence" },
		{ cause: { area: "process", code: "signal", signal: "SIGTERM" }, kind: "process_signal" },
		{
			cause: { area: "process", code: "crash" },
			kind: "process_crash",
			source: "inferred_on_resume",
		},
		{ cause: { area: "transcript", code: "duplicate_result" }, kind: "transcript_invalid" },
		{ cause: { area: "configuration", code: "invalid" }, kind: "configuration" },
		{ cause: { area: "internal", code: "unclassified" }, kind: "internal_error" },
	];

	it.each(cases)("classifies $kind with stable metadata", ({ cause, kind, source }) => {
		const termination = classify(cause, { source });
		expect(termination.schemaVersion).toBe(1);
		expect(termination.kind).toBe(kind);
		expect(termination.timestamp).toBe(NOW);
		expect(termination.causeCode).toMatch(/^[a-z_]+\.[a-z_]+$/);
		expect(Object.isFrozen(termination)).toBe(true);
	});

	it("Given provider_auth, When formatted, Then it preserves the diagnostic and stable recovery fields", () => {
		const termination = classifySessionTermination({
			sessionId: "session-1",
			runId: "run-auth",
			timestamp: NOW,
			source: "observed",
			message: "Authentication expired before the request.",
			cause: { area: "provider", code: "auth" },
			sideEffects: "none",
			provider: "anthropic",
			model: "claude-test",
		});

		const rendered = formatSessionTermination(termination);

		expect(rendered).toContain("message=Authentication expired before the request.");
		expect(rendered).toContain("kind=provider_auth");
		expect(rendered).toContain("provider/model=anthropic/claude-test");
		expect(rendered).toContain("retryable=false");
		expect(rendered).toContain("cause=provider.auth");
		expect(rendered).toContain("next=Run /login anthropic");
		expect(rendered).toContain("run=run-auth");
		expect(rendered).not.toContain("stack");
	});

	it("only marks side-effect-free transient provider failures safe for automatic retry", () => {
		expect(classify({ area: "provider", code: "network" }).safeToAutoRetry).toBe(true);
		expect(classify({ area: "provider", code: "rate_limit" }).safeToAutoRetry).toBe(true);
		expect(classify({ area: "provider", code: "network" }, { sideEffects: "possible" }).safeToAutoRetry).toBe(false);
		expect(classify({ area: "tool", code: "timeout" }).retryable).toBe(true);
		expect(classify({ area: "tool", code: "timeout" }).safeToAutoRetry).toBe(false);
		expect(classify({ area: "process", code: "crash" }, { source: "inferred_on_resume" }).safeToAutoRetry).toBe(
			false,
		);
	});

	it("preserves only bounded structured metadata", () => {
		const termination = classifySessionTermination({
			sessionId: "session-1",
			runId: "run-1",
			timestamp: NOW,
			source: "observed",
			message: "Provider throttled the request",
			cause: { area: "provider", code: "rate_limit" },
			sideEffects: "none",
			retryAfterMs: 500,
			provider: "openai",
			model: "gpt-test",
		});
		expect(termination).toMatchObject({
			phase: "provider",
			causeCode: "provider.rate_limit",
			retryable: true,
			safeToAutoRetry: true,
			retryAfterMs: 500,
			provider: "openai",
			model: "gpt-test",
		});
		expect(termination).not.toHaveProperty("cause");
	});

	it("rejects NUL, oversized, and credential-shaped messages instead of redacting them", () => {
		const base = {
			sessionId: "session-1",
			runId: "run-1",
			timestamp: NOW,
			source: "observed" as const,
			cause: { area: "internal", code: "unclassified" } as const,
			sideEffects: "none" as const,
		};
		expect(() => classifySessionTermination({ ...base, message: "bad\0message" })).toThrow("NUL");
		expect(() =>
			classifySessionTermination({ ...base, message: "x".repeat(MAX_SESSION_TERMINATION_MESSAGE_LENGTH + 1) }),
		).toThrow("pre-redacted");
		expect(() => classifySessionTermination({ ...base, message: "api_key=supersecretvalue123" })).toThrow(
			"credential-shaped",
		);
		expect(() => classifySessionTermination({ ...base, message: "Authorization: Bearer secretvalue123" })).toThrow(
			"credential-shaped",
		);
		for (const message of [
			"api_key=x",
			'password="two words"',
			'"access-token": "short value"',
			"token=x",
			"OPENAI_API_KEY=ok",
		]) {
			expect(() => classifySessionTermination({ ...base, message })).toThrow("credential-shaped");
		}
	});

	it("rejects C0 and DEL controls in every identifier", () => {
		const base = {
			sessionId: "session-1",
			runId: "run-1",
			timestamp: NOW,
			source: "observed" as const,
			message: "Pre-redacted diagnostic",
			cause: { area: "internal", code: "unclassified" } as const,
			sideEffects: "none" as const,
			provider: "provider",
			model: "model",
			toolCallId: "tool-call",
			toolName: "tool",
		};
		const identifiers = ["sessionId", "runId", "provider", "model", "toolCallId", "toolName"] as const;
		for (const field of identifiers) {
			for (const control of ["\u0001", "\u001f", "\u007f"]) {
				expect(() => classifySessionTermination({ ...base, [field]: `bad${control}id` })).toThrow("C0 or DEL");
			}
		}
	});

	it("rejects raw errors and unbounded cause codes", () => {
		expect(() => classifySessionTermination(new Error("raw provider body") as never)).toThrow("bounded structured");
		expect(() =>
			classifySessionTermination({
				sessionId: "session-1",
				runId: "run-1",
				timestamp: NOW,
				source: "observed",
				message: "Pre-redacted diagnostic",
				cause: { area: "provider", code: "made_up" } as never,
				sideEffects: "none",
			}),
		).toThrow("bounded structured termination cause");
	});

	it("rejects nondeterministic or impossible metadata", () => {
		expect(() =>
			classifySessionTermination({
				sessionId: "session-1",
				runId: "run-1",
				timestamp: "today",
				source: "observed",
				message: "Pre-redacted diagnostic",
				cause: { area: "internal", code: "unclassified" },
				sideEffects: "none",
			}),
		).toThrow("canonical ISO-8601");
		expect(() => classify({ area: "process", code: "crash" })).toThrow("inferred_on_resume");
		expect(() =>
			classifySessionTermination({
				sessionId: "session-1",
				runId: "run-1",
				timestamp: NOW,
				source: "observed",
				message: "Pre-redacted diagnostic",
				cause: { area: "provider", code: "rate_limit" },
				sideEffects: "none",
				retryAfterMs: -1,
			}),
		).toThrow("retryAfterMs");
	});
});

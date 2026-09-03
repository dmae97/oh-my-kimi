import fc from "fast-check";
import type { AssistantMessage } from "omk-ai";
import { describe, expect, it } from "vitest";
import {
	classifyAssistantOutcome,
	classifyAttemptFailure,
	classifyAttemptOutcome,
	combineBoundaryErrors,
	isExplicitAbortError,
	normalizeHarnessError,
	resolveOperationFailure,
	resolveOperationOutcome,
} from "../../src/harness/operation-outcome.ts";
import { AgentHarnessError, BranchSummaryError, CompactionError, SessionError } from "../../src/harness/types.ts";

/**
 * Unit coverage for the pure outcome/error tables. The integration suites pin
 * these rules end to end; this file pins them in isolation so a precedence
 * regression is attributable to one leaf module.
 */

function assistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	} as AssistantMessage;
}

function abortError(): Error {
	const error = new Error("aborted");
	error.name = "AbortError";
	return error;
}

describe("isExplicitAbortError", () => {
	it("recognizes only errors that are an abort, never a plain failure", () => {
		expect(isExplicitAbortError(abortError())).toBe(true);
		expect(isExplicitAbortError(new CompactionError("aborted", "compaction aborted"))).toBe(true);
		expect(isExplicitAbortError(new BranchSummaryError("aborted", "summary aborted"))).toBe(true);
		expect(isExplicitAbortError(new CompactionError("summarization_failed", "boom"))).toBe(false);
		expect(isExplicitAbortError(new Error("boom"))).toBe(false);
		expect(isExplicitAbortError("aborted")).toBe(false);
	});
});

describe("classifyAttemptOutcome and classifyAssistantOutcome", () => {
	it("treats an overflow as a recoverable attempt outcome, not an attempt failure", () => {
		const overflow = assistantMessage({ stopReason: "error", errorMessage: "prompt is too long: 200000 tokens" });
		expect(classifyAttemptOutcome(overflow, undefined)).toBe("overflow");
		expect(classifyAttemptOutcome(assistantMessage({ stopReason: "error", errorMessage: "boom" }), undefined)).toBe(
			"failed",
		);
		expect(classifyAttemptOutcome(assistantMessage({ stopReason: "aborted" }), undefined)).toBe("aborted");
		expect(classifyAttemptOutcome(assistantMessage({ stopReason: "stop" }), undefined)).toBe("completed");
	});

	it("classifies a thrown attempt body as aborted only for an explicit abort", () => {
		expect(classifyAttemptFailure(abortError())).toBe("aborted");
		expect(classifyAttemptFailure(new CompactionError("aborted", "compaction aborted"))).toBe("aborted");
		expect(classifyAttemptFailure(new Error("boom"))).toBe("failed");
	});

	it("classifies the operation from the final assistant message", () => {
		expect(classifyAssistantOutcome(assistantMessage({ stopReason: "aborted" }))).toEqual({ status: "aborted" });
		expect(classifyAssistantOutcome(assistantMessage({ stopReason: "error", errorMessage: "boom" }))).toEqual({
			status: "failed",
			code: "provider",
			message: "boom",
		});
		expect(classifyAssistantOutcome(assistantMessage({ stopReason: "stop" }))).toBeUndefined();
	});
});

describe("resolveOperationOutcome precedence", () => {
	const base = {
		signalAborted: false,
		result: undefined,
		bodyError: undefined,
		flushError: undefined,
		classifyResult: undefined,
		fallbackCode: "unknown" as const,
	};

	it("orders flush failure > body failure > explicit abort > classified result > raised signal > completed", () => {
		expect(
			resolveOperationOutcome({ ...base, bodyError: new Error("body"), flushError: new Error("flush") }),
		).toEqual({
			status: "failed",
			code: "session",
			message: "flush",
		});
		expect(
			resolveOperationOutcome({ ...base, bodyError: new SessionError("storage", "disk"), signalAborted: true }),
		).toEqual({
			status: "failed",
			code: "session",
			message: "disk",
		});
		expect(resolveOperationOutcome({ ...base, bodyError: abortError() })).toEqual({ status: "aborted" });
		expect(
			resolveOperationOutcome({
				...base,
				signalAborted: true,
				result: "provider-error",
				classifyResult: () => ({ status: "failed", code: "provider", message: "x" }),
			}),
		).toEqual({ status: "failed", code: "provider", message: "x" });
		expect(resolveOperationOutcome({ ...base, signalAborted: true, result: "ok" })).toEqual({ status: "aborted" });
		expect(resolveOperationOutcome({ ...base, result: "ok" })).toEqual({ status: "completed" });
	});

	it("keeps the recorded outcome code equal to the rejection code for a pre-classified flush failure", () => {
		// A synchronous coordinator reentry during the final flush is already an
		// AgentHarnessError("invalid_state"). The public promise rejects with that
		// code, so the settled outcome must not relabel it as a storage failure.
		const flushError = new AgentHarnessError(
			"invalid_state",
			"Session persistence cannot synchronously reenter itself",
		);
		const outcome = resolveOperationOutcome({ ...base, flushError });
		const failure = resolveOperationFailure({
			bodyError: undefined,
			flushError,
			settleError: undefined,
			fallbackCode: "unknown",
		});
		expect(failure?.code).toBe("invalid_state");
		expect(outcome).toEqual({ status: "failed", code: "invalid_state", message: flushError.message });
	});
});

describe("combineBoundaryErrors", () => {
	it("returns nothing, the single error untouched, or one aggregate classified by the primary", () => {
		expect(combineBoundaryErrors([undefined, undefined], "boundary", "hook")).toBeUndefined();
		const only = new SessionError("storage", "flush");
		expect(combineBoundaryErrors([undefined, only], "boundary", "hook")).toBe(only);
		const listener = new Error("listener");
		const combined = combineBoundaryErrors([listener, undefined, only], "boundary", "hook");
		expect(combined).toBeInstanceOf(AgentHarnessError);
		expect(combined).toMatchObject({ code: "hook", message: "boundary" });
		expect(((combined as AgentHarnessError).cause as AggregateError).errors).toEqual([listener, only]);
	});
});

describe("resolveOperationFailure", () => {
	it("returns undefined on success and the normalized body error otherwise", () => {
		expect(
			resolveOperationFailure({
				bodyError: undefined,
				flushError: undefined,
				settleError: undefined,
				fallbackCode: "unknown",
			}),
		).toBeUndefined();
		const failure = resolveOperationFailure({
			bodyError: new CompactionError("summarization_failed", "boom"),
			flushError: undefined,
			settleError: undefined,
			fallbackCode: "unknown",
		});
		expect(failure).toMatchObject({ code: "compaction", message: "boom" });
	});

	it("aggregates every concurrent cause while keeping the primary classification", () => {
		const bodyError = new Error("body");
		const flushError = new SessionError("storage", "flush");
		const settleError = new Error("settled listener");
		const bodyAndFlush = resolveOperationFailure({
			bodyError,
			flushError,
			settleError: undefined,
			fallbackCode: "unknown",
		});
		expect(bodyAndFlush).toMatchObject({ code: "session" });
		expect(bodyAndFlush).toBeInstanceOf(AgentHarnessError);
		if (bodyAndFlush === undefined) throw new Error("unreachable: body+flush failure must reject");
		expect((bodyAndFlush.cause as AggregateError).errors).toEqual([bodyError, flushError]);
		const bodyAndSettle = resolveOperationFailure({
			bodyError,
			flushError: undefined,
			settleError,
			fallbackCode: "unknown",
		});
		expect(bodyAndSettle).toMatchObject({ code: "unknown" });
		if (bodyAndSettle === undefined) throw new Error("unreachable: body+settle failure must reject");
		expect((bodyAndSettle.cause as AggregateError).errors).toEqual([bodyError, settleError]);
		expect(
			resolveOperationFailure({ bodyError: undefined, flushError: undefined, settleError, fallbackCode: "unknown" }),
		).toMatchObject({ code: "hook", message: "settled listener" });
	});

	/** Outcome inputs for this block: no classified result, no raised signal. */
	function outcomeOf(input: { bodyError?: unknown; flushError?: unknown }) {
		return resolveOperationOutcome({
			signalAborted: false,
			result: "ok",
			bodyError: input.bodyError,
			flushError: input.flushError,
			classifyResult: undefined,
			fallbackCode: "unknown",
		});
	}

	function aggregateCauses(failure: AgentHarnessError | undefined): readonly unknown[] {
		if (failure === undefined) throw new Error("unreachable: this combination must reject");
		return (failure.cause as AggregateError).errors;
	}

	it("keeps the outcome code equal to the rejection code when flush and settle fail together", () => {
		// The classification source is the flush, so the recorded outcome is a session
		// failure. The rejection must carry that same code even though the operation's
		// own fallback code is something else, and must still expose both causes.
		const flushError = new Error("flush");
		const settleError = new Error("settled listener");
		const outcome = outcomeOf({ flushError });
		const failure = resolveOperationFailure({
			bodyError: undefined,
			flushError,
			settleError,
			fallbackCode: "hook",
		});
		expect(outcome).toEqual({ status: "failed", code: "session", message: "flush" });
		expect(failure?.code).toBe("session");
		expect(aggregateCauses(failure)).toEqual([flushError, settleError]);
	});

	it("keeps the outcome code equal to the rejection code when body, flush and settle all fail", () => {
		// A pre-classified flush failure outranks the body for the code, while the
		// cause order stays body, flush, settle so every stage remains reachable.
		const bodyError = new Error("body");
		const flushError = new AgentHarnessError("invalid_state", "reentry");
		const settleError = new Error("settled listener");
		const outcome = outcomeOf({ bodyError, flushError });
		const failure = resolveOperationFailure({ bodyError, flushError, settleError, fallbackCode: "unknown" });
		expect(outcome).toEqual({ status: "failed", code: "invalid_state", message: "reentry" });
		expect(failure?.code).toBe("invalid_state");
		expect(aggregateCauses(failure)).toEqual([bodyError, flushError, settleError]);
	});

	it("property: every failed outcome rejects with exactly the outcome code", () => {
		const errorArb = fc.oneof(
			fc.constant(undefined),
			fc.constant(new Error("plain")),
			fc.constant(new SessionError("storage", "session")),
			fc.constant(new AgentHarnessError("invalid_state", "reentry")),
			fc.constant(new CompactionError("aborted", "abort")),
		);
		fc.assert(
			fc.property(
				errorArb,
				errorArb,
				errorArb,
				fc.boolean(),
				(bodyError, flushError, settleError, signalAborted) => {
					const outcome = resolveOperationOutcome({
						signalAborted,
						result: "ok",
						bodyError,
						flushError,
						classifyResult: undefined,
						fallbackCode: "unknown",
					});
					const failure = resolveOperationFailure({ bodyError, flushError, settleError, fallbackCode: "unknown" });
					// A failed outcome always has a public rejection, and the two codes agree.
					if (outcome.status === "failed") {
						expect(failure).toBeDefined();
						expect(failure?.code).toBe(outcome.code);
					}
					// A settle-only failure records no failure outcome but still rejects as a hook.
					if (bodyError === undefined && flushError === undefined) {
						const expectedCode =
							settleError === undefined ? "none" : normalizeHarnessError(settleError, "hook").code;
						expect(failure?.code ?? "none").toBe(expectedCode);
					}
					// Every concurrent cause stays reachable, in body, flush, settle order.
					const present = [bodyError, flushError, settleError].filter((error) => error !== undefined);
					if (present.length > 1) {
						expect(aggregateCauses(failure)).toEqual(present);
					} else if (present.length === 1) {
						expect(failure?.cause ?? failure).toBe(present[0]);
					}
				},
			),
			{ numRuns: 1000 },
		);
	});
});

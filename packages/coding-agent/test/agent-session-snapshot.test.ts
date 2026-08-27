import type { AgentMessage } from "omk-agent-core";
import { describe, expect, it } from "vitest";
import { createImmutableMessageSnapshot } from "../src/core/agent-session-snapshot.ts";

/**
 * Characterization tests for the finalized-message snapshot contract extracted
 * from AgentSession. The contract exists because SessionManager persists these
 * values as JSON: anything that would not survive a JSON round-trip, or that
 * could mutate after persistence, must be rejected rather than silently lost.
 */

const snapshot = (value: unknown): AgentMessage => createImmutableMessageSnapshot(value as AgentMessage);

describe("createImmutableMessageSnapshot", () => {
	it("deep-clones so later mutation of the source cannot reach the snapshot", () => {
		const source = { role: "assistant", content: [{ type: "text", text: "before" }] };
		const result = snapshot(source) as unknown as typeof source;
		source.content[0]!.text = "after";
		expect(result.content[0]!.text).toBe("before");
	});

	it("deep-freezes the result", () => {
		const result = snapshot({ role: "assistant", content: [{ type: "text", text: "x" }] }) as unknown as {
			content: Array<{ text: string }>;
		};
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.content)).toBe(true);
		expect(Object.isFrozen(result.content[0])).toBe(true);
	});

	it("preserves shared references as shared, without infinite recursion", () => {
		const shared = { type: "text", text: "shared" };
		const result = snapshot({ role: "assistant", content: [shared, shared] }) as unknown as {
			content: unknown[];
		};
		expect(result.content[0]).toBe(result.content[1]);
	});

	it("keeps undefined as ordinary optional message data", () => {
		const result = snapshot({ role: "assistant", provider: undefined }) as unknown as Record<string, unknown>;
		expect("provider" in result).toBe(true);
		expect(result.provider).toBeUndefined();
	});

	it("rejects values that would not survive JSON persistence", () => {
		expect(() => snapshot({ n: Number.NaN })).toThrow(/non-finite number/);
		expect(() => snapshot({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite number/);
		expect(() => snapshot({ n: 1n })).toThrow(/bigint/);
		expect(() => snapshot({ fn: () => undefined })).toThrow(/function/);
		expect(() => snapshot({ s: Symbol("s") })).toThrow(/symbol/);
	});

	it("rejects cycles rather than overflowing the stack", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => snapshot(cyclic)).toThrow(/cyclic/);
	});

	it("rejects class instances and other non-plain objects", () => {
		expect(() => snapshot({ when: new Date() })).toThrow(/non-plain/);
		expect(() => snapshot({ re: /x/ })).toThrow(/non-plain/);
		expect(() => snapshot({ m: new Map() })).toThrow(/non-plain/);
	});

	it("rejects accessors, symbol keys, and non-index array properties", () => {
		const withAccessor = Object.defineProperty({}, "a", { get: () => 1, enumerable: true });
		expect(() => snapshot(withAccessor)).toThrow(/accessor or non-enumerable/);

		expect(() => snapshot({ [Symbol("k")]: 1 })).toThrow(/symbol-keyed/);

		const taggedArray = Object.assign([1, 2], { extra: "nope" });
		expect(() => snapshot({ items: taggedArray })).toThrow(/arrays may only contain indexed values/);
	});

	it("accepts a null-prototype object as plain", () => {
		const bare = Object.create(null) as Record<string, unknown>;
		bare.text = "ok";
		expect(() => snapshot({ block: bare })).not.toThrow();
	});
});

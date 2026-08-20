import { describe, expect, it } from "vitest";
import { classifyPromptCacheTransition } from "../src/core/prompt-cache.ts";

describe("classifyPromptCacheTransition", () => {
	it("treats a missing next key as a bypass, recording a break only when a key existed", () => {
		expect(classifyPromptCacheTransition(undefined, undefined)).toEqual({ kind: "bypass", recordBreak: false });
		expect(classifyPromptCacheTransition("a", undefined)).toEqual({ kind: "bypass", recordBreak: true });
	});

	it("treats a first key as establishment, not change", () => {
		expect(classifyPromptCacheTransition(undefined, "a")).toEqual({ kind: "first", recordBreak: false });
	});

	it("treats an identical key as stable", () => {
		expect(classifyPromptCacheTransition("a", "a")).toEqual({ kind: "same", recordBreak: false });
	});

	it("treats a different key as a break with a change counter", () => {
		expect(classifyPromptCacheTransition("a", "b")).toEqual({ kind: "changed", recordBreak: true });
	});
});

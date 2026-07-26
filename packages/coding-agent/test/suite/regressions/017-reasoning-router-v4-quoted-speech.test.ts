/**
 * Goal 016/M3+M5 regression: quoted-speech and filler-prefix robustness.
 *
 * Evidence: scripts/reasoning-router/mine-hard-negatives.ts found 58 M3 +
 * 15 M5 failures. Two bounded fixes:
 *   1. maskQuotedImperativesV4 — double-quoted spans that read as imperatives
 *      (reported speech) cannot fire whole-prompt evidence; quoted nouns and
 *      objects are preserved.
 *   2. stripNonImperativePrefixV4 — quoted-speech attribution and labeled
 *      filler (background:/context:/note:) are stripped before ^-anchored
 *      leading-intent tests, like the existing politeness-prefix strip.
 */
import { describe, expect, it } from "vitest";
import { classifyTaskV4 } from "../../../src/core/reasoning-router-v4.ts";

describe("reasoning-router v4 goal-016 quoted-speech + prefix robustness", () => {
	it.each([
		['my teammate said "implement it" but actually: bump the version to 1.2.3', "simple-edit"],
		['my teammate said "review it" but actually: fix the typo in the README title', "simple-edit"],
		['the ticket says "refactor everything" but actually: implement a rate limiter', "code-gen"],
		['pm wrote "debug this later" but actually: review this diff', "review"],
	])("quoted imperative does not override the real request: %s", (prompt, expected) => {
		expect(classifyTaskV4({ prompt }).taskClass).toBe(expected);
	});

	it.each([
		['fix the "undefined" crash in the parser', "debug"],
		['trace the "null pointer" panic in the worker', "debug"],
		['update the "Getting Started" headline', "simple-edit"],
	])("quoted nouns/objects keep their evidence: %s", (prompt, expected) => {
		expect(classifyTaskV4({ prompt }).taskClass).toBe(expected);
	});

	it("masking never changes behavior vs the unquoted equivalent", () => {
		// Same prompt with and without quotes must classify identically when the
		// quoted span is a noun phrase, not an imperative.
		const unquoted = classifyTaskV4({ prompt: "fix the undefined crash in the parser" });
		const quoted = classifyTaskV4({ prompt: 'fix the "undefined" crash in the parser' });
		expect(quoted.taskClass).toBe(unquoted.taskClass);
	});

	it.each([
		[
			"background: the repo is a medium-size typescript monorepo with bun workspaces. bump the version to 1.2.3",
			"simple-edit",
		],
		["context: we ship nightly. implement a rate limiter for the public API", "code-gen"],
		["note: the diff is attached. review this diff", "review"],
	])("labeled filler prefix does not kill the leading intent: %s", (prompt, expected) => {
		expect(classifyTaskV4({ prompt }).taskClass).toBe(expected);
	});

	it("does not strip intent from a prompt that starts with the filler words as content", () => {
		// "note" used as a verb/object, not a label prefix, must not be eaten.
		const verdict = classifyTaskV4({ prompt: "note the breaking change in the changelog" });
		expect(verdict.taskClass).not.toBe("trivial");
	});

	it("is deterministic across repeated calls on prefixed prompts", () => {
		const prompt = 'my teammate said "implement it" but actually: bump the version to 1.2.3';
		expect(classifyTaskV4({ prompt })).toEqual(classifyTaskV4({ prompt }));
	});
});

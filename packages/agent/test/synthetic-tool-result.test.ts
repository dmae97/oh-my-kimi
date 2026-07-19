import { describe, expect, it } from "vitest";
import { createSyntheticToolResult } from "../src/index.ts";

describe("createSyntheticToolResult", () => {
	it("builds a deeply frozen aborted result message and envelope", () => {
		const value = createSyntheticToolResult("a", "echo", "Operation aborted", 123);
		expect(value).toMatchObject({
			toolName: "echo",
			details: {
				omk: {
					schema: "tool-result/v2",
					synthetic: true,
					disposition: "aborted",
					reason: "Operation aborted",
					executionStarted: false,
				},
			},
			timestamp: 123,
		});
		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(value.content)).toBe(true);
		expect(Object.isFrozen(value.content[0])).toBe(true);
		expect(Object.isFrozen(value.details)).toBe(true);
		expect(Object.isFrozen((value.details as { omk: object }).omk)).toBe(true);
	});

	it("supports an explicit skipped disposition for an intentionally unstarted call", () => {
		const skipped = createSyntheticToolResult("a", "echo", "skipped by policy", 123, "skipped");
		expect((skipped.details as { omk: { disposition: string; executionStarted: boolean } }).omk).toMatchObject({
			disposition: "skipped",
			executionStarted: false,
		});
	});
});

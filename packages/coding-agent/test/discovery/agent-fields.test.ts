import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { parseAgentFields } from "../../src/discovery/helpers";

describe("parseAgentFields", () => {
	test("parses blocking from boolean frontmatter", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			blocking: true,
		});

		expect(fields).toBeDefined();
		expect(fields?.blocking).toBe(true);
	});

	test("parses blocking from string frontmatter", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			blocking: "false",
		});

		expect(fields).toBeDefined();
		expect(fields?.blocking).toBe(false);
	});

	test("ignores invalid blocking values", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			blocking: "sometimes",
		});

		expect(fields).toBeDefined();
		expect(fields?.blocking).toBeUndefined();
	});
	test("parses legacy thinking key", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			thinking: "medium",
		});

		expect(fields).toBeDefined();
		expect(fields?.thinkingLevel).toBe(Effort.Medium);
	});

	test("prefers thinking-level over legacy thinking", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			thinking: "minimal",
			thinkingLevel: Effort.High,
		});

		expect(fields?.thinkingLevel).toBe(Effort.High);
	});

	test("lowercases tool names", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			tools: ["Read", "Search"],
		});

		expect(fields?.tools).toEqual(["read", "search", "yield"]);
	});
});

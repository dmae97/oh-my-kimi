/**
 * Contract: /dump tool catalog renders parameters as JSON Schema.
 *
 * Tools carry live Zod v4 schemas; the dump formatter must convert them to
 * the wire JSON Schema (same shape providers receive) instead of enumerating
 * the schema instance's internals (`def`, `shape`, stringified methods).
 * Legacy plain JSON-Schema parameters still pass through with TypeBox
 * bookkeeping fields stripped.
 */
import { describe, expect, it } from "bun:test";
import { formatSessionDumpText } from "@oh-my-pi/pi-coding-agent/session/session-dump-format";
import { z } from "zod/v4";

describe("formatSessionDumpText tool parameters", () => {
	it("renders Zod schemas as wire JSON Schema, not schema internals", () => {
		const out = formatSessionDumpText({
			messages: [],
			tools: [
				{
					name: "web_search",
					description: "Searches the web.",
					parameters: z.object({
						query: z.string().describe("search query"),
						recency: z.enum(["day", "week"]).optional(),
					}),
				},
			],
		});

		expect(out).toContain('<parameter name="type">object</parameter>');
		expect(out).toContain('"query":{"type":"string","description":"search query"}');
		expect(out).toContain('<parameter name="required">["query"]</parameter>');
		// Zod instance internals must never leak into the dump.
		expect(out).not.toContain('name="def"');
		expect(out).not.toContain('name="shape"');
		expect(out).not.toContain(">undefined</parameter>");
	});

	it("passes plain JSON-Schema parameters through, stripping TypeBox fields", () => {
		const out = formatSessionDumpText({
			messages: [],
			tools: [
				{
					name: "legacy",
					description: "Legacy tool.",
					parameters: {
						type: "object",
						properties: { path: { type: "string", "TypeBox.Kind": "String" } },
						required: ["path"],
					},
				},
			],
		});

		expect(out).toContain('<parameter name="type">object</parameter>');
		expect(out).toContain('"path":{"type":"string"}');
		expect(out).not.toContain("TypeBox.");
	});
});

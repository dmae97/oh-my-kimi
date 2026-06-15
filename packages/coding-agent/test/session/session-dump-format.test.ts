/**
 * Contract: /dump renders the tool catalog through the shared AI inventory
 * renderer — a simplified TypeScript signature (derived from the wire JSON
 * Schema) plus each tool's examples in the model's native tool-call syntax.
 *
 * Tools carry live Zod v4 schemas; the dump must surface a readable signature
 * (not the schema instance's internals) and must include examples, which the
 * previous `<parameter>`-per-key JSON Schema dump dropped entirely.
 */
import { describe, expect, it } from "bun:test";
import type { Model, Usage } from "@oh-my-pi/pi-ai";
import { formatSessionDumpText } from "@oh-my-pi/pi-coding-agent/session/session-dump-format";
import { z } from "zod/v4";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const HARMONY_MODEL = { provider: "openai", id: "gpt-5", name: "GPT-5" } as Model;

describe("formatSessionDumpText tool parameters", () => {
	it("renders Zod schemas as a TypeScript signature, not schema internals", () => {
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

		expect(out).toContain("# Tool: web_search");
		expect(out).toContain("Parameters: {");
		expect(out).toContain("/** search query */");
		expect(out).toContain("query: string;");
		expect(out).toContain('recency?: "day" | "week";');
		// Live Zod instance internals must never leak into the dump.
		expect(out).not.toContain("_zod");
		expect(out).not.toContain("ZodObject");
		// Tool params are no longer emitted as XML <parameter> elements.
		expect(out).not.toContain('<parameter name="type">');
	});

	it("passes plain JSON-Schema parameters through to a TypeScript signature", () => {
		const out = formatSessionDumpText({
			messages: [],
			tools: [
				{
					name: "legacy",
					description: "Legacy tool.",
					parameters: {
						type: "object",
						properties: { path: { type: "string", description: "a path" } },
						required: ["path"],
					},
				},
			],
		});

		expect(out).toContain("# Tool: legacy");
		expect(out).toContain("/** a path */");
		expect(out).toContain("path: string;");
	});

	it("includes tool examples in the model's native syntax", () => {
		const out = formatSessionDumpText({
			messages: [],
			tools: [
				{
					name: "find",
					description: "Finds files.",
					parameters: z.object({ paths: z.array(z.string()) }),
					examples: [{ call: { paths: ["src/**/*.ts"] } }],
				},
			],
		});

		expect(out).toContain("## Available Tools");
		expect(out).toContain("<examples>");
		expect(out).toContain('<invoke name="find">');
	});

	it("renders message history with the model dialect turn envelope", () => {
		const out = formatSessionDumpText({
			model: HARMONY_MODEL,
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi." }],
					api: "mock",
					provider: "mock",
					model: "mock",
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 2,
				},
			],
		});

		expect(out).toContain("## Transcript");
		expect(out).toContain("<|start|>user<|message|>Hello<|end|>");
		expect(out).toContain("<|start|>assistant<|channel|>final<|message|>Hi.<|end|>");
		expect(out).not.toContain("## Assistant");
	});
});

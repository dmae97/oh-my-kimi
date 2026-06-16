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
});

describe("formatSessionDumpText markdown-headings transcript", () => {
	it("renders the main /dump transcript with legacy markdown role headings, not native envelopes", () => {
		const out = formatSessionDumpText({
			model: HARMONY_MODEL,
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Reading." },
						{
							type: "toolCall",
							id: "c1",
							name: "read",
							arguments: { _i: "Reading the file", path: "src/foo.ts" },
						},
					],
					api: "mock",
					provider: "mock",
					model: "mock",
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "read",
					content: [{ type: "text", text: "file body" }],
					isError: false,
					timestamp: 3,
				},
			],
		});

		// Legacy per-message markdown headings (the pre-16.x /dump shape the user wants back).
		expect(out).toContain("## User");
		expect(out).toContain("## Assistant");
		expect(out).toContain("### Tool Result: read");
		expect(out).toContain("### Tool Call: read");
		expect(out).toContain("path: src/foo.ts");
		// The `_i` intent renders as a `//` comment under the heading, never inside the YAML args.
		expect(out).toContain("// Reading the file");
		expect(out).not.toContain("_i:");
		// Tool calls render as a readable heading + YAML, never the <invoke>/<parameter> XML.
		expect(out).not.toContain("<invoke ");
		expect(out).not.toContain("<parameter ");
		expect(out).toContain("file body");
		// The 16.x native-dialect transcript wrapper and envelopes must be gone.
		expect(out).not.toContain("## Transcript");
		expect(out).not.toContain("<|start|>");
	});

	it("does not nest a thinking block that already carries a literal <thinking> envelope (#2700)", () => {
		const out = formatSessionDumpText({
			messages: [
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "<thinking>\nCheck the logs.\n</thinking>" }],
					api: "mock",
					provider: "mock",
					model: "mock",
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 1,
				},
			],
		});

		expect(out).toContain("<thinking>\nCheck the logs.\n</thinking>");
		expect(out).not.toContain("<thinking>\n<thinking>");
	});

	it("renders sibling thinking blocks split by a tool call without nesting envelopes", () => {
		const out = formatSessionDumpText({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "<thinking>\nfirst\n</thinking>" },
						{ type: "toolCall", id: "c1", name: "read", arguments: { path: "f.ts" } },
						{ type: "thinking", thinking: "<thinking>\nsecond\n</thinking>" },
					],
					api: "mock",
					provider: "mock",
					model: "mock",
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 1,
				},
			],
		});

		// Each block is unwrapped then re-wrapped independently — never nested.
		expect(out).toContain("<thinking>\nfirst\n</thinking>");
		expect(out).toContain("<thinking>\nsecond\n</thinking>");
		expect(out).not.toContain("<thinking>\n<thinking>");
	});
});

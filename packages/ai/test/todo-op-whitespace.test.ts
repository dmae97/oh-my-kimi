import { describe, expect, it } from "bun:test";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { z } from "zod/v4";

describe("Tool argument whitespace normalization", () => {
	it("trims trailing whitespace from enum strings before validation", () => {
		const tool: Tool = {
			name: "todo",
			description: "",
			parameters: z.object({
				op: z.enum(["append", "done", "drop", "init", "rm", "start", "view"]),
				items: z.array(z.string()).optional(),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-todo-op-newline",
			name: "todo",
			arguments: { op: "init\n", items: ["Fix RNG divergence"] },
		});

		expect(result).toEqual({ op: "init", items: ["Fix RNG divergence"] });
	});

	it("strips trailing newlines from path fields on read-like tools", () => {
		const tool: Tool = {
			name: "read",
			description: "",
			parameters: z.object({
				path: z.string(),
				offset: z.number().optional(),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-read-path-newline",
			name: "read",
			arguments: { path: "examples/multi_observation.py:36-55\n" },
		});

		expect(result).toEqual({ path: "examples/multi_observation.py:36-55" });
	});

	it("strips trailing whitespace from every entry in a path array", () => {
		const tool: Tool = {
			name: "search",
			description: "",
			parameters: z.object({
				pattern: z.string(),
				paths: z.array(z.string()),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-search-paths-newline",
			name: "search",
			arguments: {
				pattern: "TODO",
				paths: ["src/foo.ts\n", "src/bar.ts "],
			},
		});

		expect(result).toEqual({
			pattern: "TODO",
			paths: ["src/foo.ts", "src/bar.ts"],
		});
	});

	it("leaves trailing newlines on content-carrying fields intact", () => {
		const tool: Tool = {
			name: "write",
			description: "",
			parameters: z.object({
				path: z.string(),
				content: z.string(),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-write-content-newline",
			name: "write",
			arguments: { path: "docs/foo.md\n", content: "hello\n" },
		});

		expect(result).toEqual({ path: "docs/foo.md", content: "hello\n" });
	});

	it("trims trailing whitespace from title fields while keeping code content", () => {
		const tool: Tool = {
			name: "eval",
			description: "",
			parameters: z.object({
				language: z.enum(["py", "js", "rb", "jl"]),
				code: z.string(),
				title: z.string().optional(),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-eval-title-newline",
			name: "eval",
			arguments: {
				language: "js\n",
				title: "read multi_observation lines 36-100\n",
				code: "console.log('hi')\n",
			},
		});

		expect(result).toEqual({
			language: "js",
			title: "read multi_observation lines 36-100",
			code: "console.log('hi')\n",
		});
	});
});

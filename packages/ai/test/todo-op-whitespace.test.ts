import { describe, expect, it } from "bun:test";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { z } from "zod/v4";

describe("Tool enum argument whitespace", () => {
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
});

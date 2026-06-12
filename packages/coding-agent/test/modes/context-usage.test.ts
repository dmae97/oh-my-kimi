/**
 * Contract: tool schema token estimation reflects the wire JSON Schema.
 *
 * Tools authored with Zod must be counted by the JSON Schema providers
 * actually receive — not by stringifying the Zod instance's enumerable
 * internals (`def` tree), which massively overcounts.
 */
import { describe, expect, it } from "bun:test";
import { zodToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { estimateToolSchemaTokens } from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import { z } from "zod/v4";

describe("estimateToolSchemaTokens", () => {
	it("counts Zod tool schemas by their wire JSON Schema, not Zod internals", () => {
		const parameters = z.object({
			query: z.string().describe("search query"),
			limit: z.number().optional(),
		});
		const zodEstimate = estimateToolSchemaTokens([
			{ name: "web_search", description: "Searches the web.", parameters } as never,
		]);
		const wireEstimate = estimateToolSchemaTokens([
			{ name: "web_search", description: "Searches the web.", parameters: zodToWireSchema(parameters) } as never,
		]);
		expect(zodEstimate).toBe(wireEstimate);
	});
});

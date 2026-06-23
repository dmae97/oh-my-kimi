import { describe, expect, it } from "bun:test";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { DeferredMCPTool, MCPTool, type MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { createMockConnection, createMockTransport } from "./mcp-test-utils";

type CapturedRequest = {
	method: string;
	params: Record<string, unknown> | undefined;
};

const unusedContext = {} as CustomToolContext;

function createSearchToolDefinition(): MCPToolDefinition {
	return {
		name: "search",
		description: "Search symbols or file locations",
		inputSchema: {
			type: "object",
			properties: {
				symbol: { type: "string" },
				language: { type: "string" },
				file: { type: "string" },
				line: { type: "number" },
				column: { type: "number" },
				filters: { type: "object" },
				exact: { type: "boolean" },
			},
			required: ["symbol", "language"],
		},
	};
}

function createCapturedConnection(calls: CapturedRequest[]): MCPServerConnection {
	const transport = createMockTransport(
		new Map([["tools/call", [{ content: [{ type: "text", text: "ok" }] }]]]),
		(method, params) => calls.push({ method, params }),
	);
	return createMockConnection({ tools: {} }, transport);
}

describe("MCP tool arguments", () => {
	it("omits optional empty placeholders before tools/call", async () => {
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), createSearchToolDefinition());

		await tool.execute(
			"call-1",
			{ symbol: "Foo", language: "", file: "", line: 0, filters: {}, exact: false },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: {
					name: "search",
					arguments: { symbol: "Foo", language: "", line: 0, exact: false },
				},
			},
		]);
	});

	it("omits optional empty placeholders for deferred MCP tools", async () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const tool = new DeferredMCPTool("intellij-index", createSearchToolDefinition(), async () => connection);

		await tool.execute(
			"call-1",
			{ symbol: "Foo", language: "TypeScript", file: "", column: "", filters: {} },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: {
					name: "search",
					arguments: { symbol: "Foo", language: "TypeScript" },
				},
			},
		]);
	});
});

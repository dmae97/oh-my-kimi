import { describe, expect, it } from "vitest";
import { mcpAttachDiagnostics } from "../src/cli/mcp-attach.ts";

describe("mcpAttachDiagnostics", () => {
	it("is silent for ready servers and for an empty configuration", () => {
		expect(mcpAttachDiagnostics([])).toEqual([]);
		expect(mcpAttachDiagnostics([{ name: "playwright", state: "ready" }])).toEqual([]);
	});

	it("turns a failed server into a warning that names the server and the reason", () => {
		expect(
			mcpAttachDiagnostics([
				{ name: "playwright", state: "ready" },
				{ name: "serena", state: "failed", error: "spawn uvx ENOENT" },
				{ name: "slow", state: "connecting" },
			]),
		).toEqual([
			{ type: "warning", message: 'MCP server "serena" failed: spawn uvx ENOENT' },
			{ type: "warning", message: 'MCP server "slow" connecting' },
		]);
	});
});

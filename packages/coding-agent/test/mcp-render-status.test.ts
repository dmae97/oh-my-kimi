import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DeferredMCPTool, MCPTool, type MCPToolDetails } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolDefinition, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { theme as activeTheme, getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { formatStatusIcon } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false, undefined, undefined, "dark", "light");
}, 15_000);

async function getRequiredTheme() {
	const uiTheme = await getThemeByName("dark");
	if (!uiTheme) {
		throw new Error("dark theme missing");
	}
	return uiTheme;
}

function makeConnection(): MCPServerConnection {
	const transport: MCPTransport = {
		connected: true,
		request<T = unknown>(): Promise<T> {
			return Promise.reject(new Error("transport is not used by renderer tests"));
		},
		notify(): Promise<void> {
			return Promise.resolve();
		},
		close(): Promise<void> {
			return Promise.resolve();
		},
	};

	return {
		name: "sentry",
		config: { command: "sentry-mcp" },
		transport,
		serverInfo: { name: "sentry", version: "1.0.0" },
		capabilities: { tools: {} },
	};
}

function makeDefinition(): MCPToolDefinition {
	return {
		name: "search_events",
		description: "Search Sentry events",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		},
	};
}

function makeTool(): MCPTool {
	return new MCPTool(makeConnection(), makeDefinition());
}

function makeDeferredTool(): DeferredMCPTool {
	return new DeferredMCPTool("sentry", makeDefinition(), () => Promise.resolve(makeConnection()));
}

type RenderableMCPAgentTool = AgentTool<TSchema, MCPToolDetails> & { mergeCallAndResult: true };

function makeAgentTool(mcpTool: MCPTool): RenderableMCPAgentTool {
	return {
		name: mcpTool.name,
		label: mcpTool.label,
		description: mcpTool.description,
		parameters: mcpTool.parameters,
		mergeCallAndResult: mcpTool.mergeCallAndResult,
		execute(): Promise<never> {
			return Promise.reject(new Error("MCP execution is not used by renderer tests"));
		},
		renderCall(args, options) {
			return mcpTool.renderCall(args, options, activeTheme);
		},
		renderResult(result, options) {
			return mcpTool.renderResult(result, options, activeTheme);
		},
	};
}

async function renderCompletedMCPTool(isError: boolean): Promise<string> {
	const mcpTool = makeTool();
	const tool = makeAgentTool(mcpTool);
	const tui = new TUI(new VirtualTerminal(120, 20));
	const component = new ToolExecutionComponent(tool.name, { query: "level:error" }, {}, tool, tui);

	component.updateResult(
		{
			content: [{ type: "text", text: isError ? "Error: denied" : '{"ok":true}' }],
			details: { serverName: "sentry", mcpToolName: "search_events", isError },
			...(isError ? { isError: true } : {}),
		},
		false,
	);

	return Bun.stripANSI(component.render(160).join("\n"));
}

describe("MCP tool rendering", () => {
	it("replaces the pending call header with a success header after completion", async () => {
		const uiTheme = await getRequiredTheme();
		const pendingIcon = Bun.stripANSI(formatStatusIcon("pending", uiTheme));
		const doneIcon = Bun.stripANSI(uiTheme.styledSymbol("tool.mcp", "accent"));

		const rendered = await renderCompletedMCPTool(false);

		expect(makeTool().mergeCallAndResult).toBe(true);
		expect(makeDeferredTool().mergeCallAndResult).toBe(true);
		expect(rendered).toContain(`${doneIcon} sentry/search_events`);
		expect(rendered).not.toContain(`${pendingIcon} sentry/search_events`);
	}, 15_000);

	it("replaces the pending call header with an error header for MCP errors", async () => {
		const uiTheme = await getRequiredTheme();
		const pendingIcon = Bun.stripANSI(formatStatusIcon("pending", uiTheme));
		const errorIcon = Bun.stripANSI(formatStatusIcon("error", uiTheme));

		const rendered = await renderCompletedMCPTool(true);

		expect(rendered).toContain(`${errorIcon} sentry/search_events`);
		expect(rendered).not.toContain(`${pendingIcon} sentry/search_events`);
	}, 15_000);
});

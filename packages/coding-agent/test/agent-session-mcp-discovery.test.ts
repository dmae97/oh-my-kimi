import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { Type } from "@sinclair/typebox";
import { Settings } from "../src/config/settings";
import type { CustomTool } from "../src/extensibility/custom-tools/types";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createBasicTool(name: string, label: string): AgentTool {
	const schema = Type.Object({ value: Type.String() });
	return {
		name,
		label,
		description: `${label} tool`,
		parameters: schema,
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function createMcpTool(
	name: string,
	serverName: string,
	mcpToolName: string,
	description: string,
	schemaKeys: string[],
): AgentTool {
	const properties = Object.fromEntries(schemaKeys.map(key => [key, Type.String()]));
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description,
		parameters: Type.Object(properties),
		strict: true,
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as AgentTool;
}

function createMcpCustomTool(
	name: string,
	serverName: string,
	mcpToolName: string,
	description: string,
	schemaKeys: string[],
): CustomTool {
	const properties = Object.fromEntries(schemaKeys.map(key => [key, Type.String()]));
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description,
		parameters: Type.Object(properties),
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

describe("AgentSession MCP discovery", () => {
	const sessions: AgentSession[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("caches discoverable MCP search indexes until MCP tools refresh", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: "initial",
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		const firstIndex = session.getDiscoverableMCPSearchIndex();
		const secondIndex = session.getDiscoverableMCPSearchIndex();
		expect(secondIndex).toBe(firstIndex);
		expect(firstIndex.documents.map(document => document.tool.name)).toEqual(["mcp__docs_search"]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__pager_list", "pager", "list", "List pager alerts", ["service"]),
		]);

		const refreshedIndex = session.getDiscoverableMCPSearchIndex();
		expect(refreshedIndex).not.toBe(firstIndex);
		expect(refreshedIndex.documents.map(document => document.tool.name)).toEqual(["mcp__pager_list"]);
	});

	it("reports only currently active MCP tools in non-discovery sessions", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: "initial",
				tools: [readTool, docsSearchTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": false }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: false,
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);

		await session.setActiveToolsByName(["read"]);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toBe("tools:read");
	});

	it("keeps manually deactivated MCP tools off after refresh in non-discovery sessions", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: "initial",
				tools: [readTool, docsSearchTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": false }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: false,
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		await session.setActiveToolsByName(["read"]);
		expect(session.getSelectedMCPToolNames()).toEqual([]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]),
			createMcpCustomTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
				"channel",
				"text",
			]),
		]);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toBe("tools:read");
	});

	it("preserves directly activated MCP tools across refreshes in discovery mode", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: "initial",
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		await session.setActiveToolsByName(["read", "mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]),
			createMcpCustomTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
				"channel",
				"text",
			]),
		]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
	});

	it("keeps MCP tools hidden by default and activates discovered selections additively", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: "initial",
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getDiscoverableMCPTools().map(tool => tool.name)).toEqual([
			"mcp__docs_search",
			"mcp__slack_send_message",
		]);

		await session.activateDiscoveredMCPTools(["mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.systemPrompt).toBe("tools:read,mcp__docs_search");

		await session.activateDiscoveredMCPTools(["mcp__slack_send_message"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.systemPrompt).toBe("tools:read,mcp__docs_search,mcp__slack_send_message");
	});
	it("reapplies default MCP server baselines when refreshed tools reconnect", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: "initial",
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			defaultSelectedMCPServerNames: ["slack"],
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]),
			createMcpCustomTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
				"channel",
				"text",
			]),
		]);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__slack_send_message"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__slack_send_message"]);
		expect(session.systemPrompt).toBe("tools:read,mcp__slack_send_message");
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__slack_send_message"]);
	});

	it("persists cleared MCP selections when refresh removes a selected tool", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: "initial",
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		await session.activateDiscoveredMCPTools(["mcp__docs_search"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__docs_search"]);

		await session.refreshMCPTools([]);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual([]);
	});

	it("restores unavailable MCP selections in memory without rewriting the persisted session selection", async () => {
		const readTool = createBasicTool("read", "Read");
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMCPToolSelection(["mcp__docs_search"]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: "initial",
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry: new Map([[readTool.name, readTool]]),
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__docs_search"]);
	});

	it("restores MCP discovery selections when branching to a context without them", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const sessionManager = SessionManager.inMemory();
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "start",
			timestamp: Date.now(),
		});
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: "initial",
				tools: [readTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		await session.activateDiscoveredMCPTools(["mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);

		const result = await session.branch(userEntryId);

		expect(result.cancelled).toBe(false);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toBe("tools:read");
	});

	it("restores MCP discovery selections when navigating to a branch without them", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const sessionManager = SessionManager.inMemory();
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "start",
			timestamp: Date.now(),
		});
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: "initial",
				tools: [readTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		await session.activateDiscoveredMCPTools(["mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);

		const result = await session.navigateTree(userEntryId, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toBe("tools:read");
	});

	it("preserves explicit MCP baseline when branching into older history without persisted selection", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const sessionManager = SessionManager.inMemory();
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "start",
			timestamp: Date.now(),
		});
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: "initial",
				tools: [readTool, docsSearchTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialSelectedMCPToolNames: ["mcp__docs_search"],
			defaultSelectedMCPToolNames: ["mcp__docs_search"],
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		const result = await session.branch(userEntryId);

		expect(result.cancelled).toBe(false);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.systemPrompt).toBe("tools:read,mcp__docs_search");
	});

	it("preserves explicit MCP baseline when navigating into older history without persisted selection", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const sessionManager = SessionManager.inMemory();
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "start",
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "user",
			content: "follow up",
			timestamp: Date.now(),
		});
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: "initial",
				tools: [readTool, docsSearchTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialSelectedMCPToolNames: ["mcp__docs_search"],
			defaultSelectedMCPToolNames: ["mcp__docs_search"],
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		const result = await session.navigateTree(userEntryId, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.systemPrompt).toBe("tools:read,mcp__docs_search");
	});

	it("restores session defaults in memory across session switches without rewriting sessions missing persisted metadata", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-session-mcp-switch-"));
		tempDirs.push(tempDir);
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);

		const olderSessionManager = SessionManager.create(tempDir, tempDir);
		olderSessionManager.appendMessage({
			role: "user",
			content: "older session",
			timestamp: Date.now(),
		});
		const olderSessionFile = olderSessionManager.getSessionFile();
		expect(olderSessionFile).toBeString();
		await olderSessionManager.rewriteEntries();
		const olderSessionBeforeSwitch = fs.readFileSync(olderSessionFile!, "utf8");
		const olderSessionMtimeBeforeSwitch = fs.statSync(olderSessionFile!).mtimeMs;

		const sessionManager = SessionManager.create(tempDir, tempDir);
		const originalSessionFile = sessionManager.getSessionFile();
		expect(originalSessionFile).toBeString();
		await sessionManager.flush();

		const reasoningModel: Model<"openai-responses"> = {
			...createModel(),
			reasoning: true,
			thinking: { mode: "effort", minLevel: Effort.Medium, maxLevel: Effort.Medium },
		};

		const agent = new Agent({
			initialState: {
				model: reasoningModel,
				systemPrompt: "initial",
				tools: [readTool, docsSearchTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				defaultThinkingLevel: "high",
				serviceTier: "priority",
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialSelectedMCPToolNames: ["mcp__docs_search"],
			defaultSelectedMCPToolNames: ["mcp__docs_search"],
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		sessionManager.appendThinkingLevelChange(ThinkingLevel.High);
		sessionManager.appendServiceTierChange("flex");
		sessionManager.appendMCPToolSelection(["mcp__docs_search"]);
		expect(sessionManager.buildSessionContext().thinkingLevel).toBe(ThinkingLevel.High);
		expect(sessionManager.buildSessionContext().serviceTier).toBe("flex");
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__docs_search"]);
		expect(sessionManager.buildSessionContext().hasPersistedMCPToolSelection).toBe(true);
		await sessionManager.rewriteEntries();
		const originalSessionBeforeSwitch = fs.readFileSync(originalSessionFile!, "utf8");
		const originalSessionMtimeBeforeSwitch = fs.statSync(originalSessionFile!).mtimeMs;
		await Bun.sleep(20);

		await session.switchSession(olderSessionFile!);
		expect(session.sessionFile).toBe(olderSessionFile);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(session.serviceTier).toBe("priority");
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toBe("tools:read");
		expect(fs.readFileSync(olderSessionFile!, "utf8")).toBe(olderSessionBeforeSwitch);
		expect(fs.statSync(olderSessionFile!).mtimeMs).toBe(olderSessionMtimeBeforeSwitch);

		await session.switchSession(originalSessionFile!);
		expect(session.sessionFile).toBe(originalSessionFile);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(session.serviceTier).toBe("flex");
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.systemPrompt).toBe("tools:read,mcp__docs_search");
		expect(fs.readFileSync(originalSessionFile!, "utf8")).toBe(originalSessionBeforeSwitch);
		expect(fs.statSync(originalSessionFile!).mtimeMs).toBe(originalSessionMtimeBeforeSwitch);
	});

	it("restores explicit MCP defaults after startup outage once tools recover in a new session", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: "initial",
				tools: [readTool, docsSearchTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialSelectedMCPToolNames: ["mcp__docs_search", "mcp__slack_send_message"],
			defaultSelectedMCPToolNames: ["mcp__docs_search", "mcp__slack_send_message"],
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]),
			createMcpCustomTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
				"channel",
				"text",
			]),
		]);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);

		await session.newSession();

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.systemPrompt).toBe("tools:read,mcp__docs_search,mcp__slack_send_message");
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual([
			"mcp__docs_search",
			"mcp__slack_send_message",
		]);
	});

	it("clears discovered MCP selections when starting a brand-new session", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: "initial",
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		await session.activateDiscoveredMCPTools(["mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);

		await session.newSession();

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toBe("tools:read");
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";

function createMcpCustomTool(name: string, serverName: string, mcpToolName: string): CustomTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description: `Tool ${mcpToolName} from ${serverName}`,
		mcpServerName: serverName,
		mcpToolName,
		parameters: Type.Object({ query: Type.String() }),
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

function createReasoningModel(): Model<"openai-responses"> {
	return {
		id: "mock-reasoning",
		name: "mock-reasoning",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: true,
		thinking: { mode: "effort", minLevel: Effort.Medium, maxLevel: Effort.High },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

describe("createAgentSession MCP discovery prompt gating", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-discovery-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not advertise MCP discovery when search_tool_bm25 is not active", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
			customTools: [createMcpCustomTool("mcp_github_create_issue", "github", "create_issue")],
		});

		expect(session.systemPrompt).not.toContain("### MCP tool discovery");
		expect(session.systemPrompt).not.toContain("call `search_tool_bm25` before concluding no such tool exists");
	});

	it("preserves explicitly requested MCP tools in discovery mode", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "mcp_github_create_issue", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp_github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp_slack_post_message", "slack", "post_message"),
			],
		});

		expect(session.getActiveToolNames()).toContain("mcp_github_create_issue");
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp_github_create_issue"]);
		expect(session.systemPrompt).toContain("mcp_github_create_issue");

		await session.activateDiscoveredMCPTools(["mcp_slack_post_message"]);

		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["read", "search_tool_bm25", "mcp_github_create_issue", "mcp_slack_post_message"]),
		);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp_github_create_issue", "mcp_slack_post_message"]);
	});

	it("keeps configured discovery default servers visible in discovery mode", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDefaultServers": ["github", "missing"],
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp_github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp_slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(session.getSelectedMCPToolNames()).toEqual(["mcp_github_create_issue"]);
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "search_tool_bm25", "mcp_github_create_issue"]),
			);
			expect(session.getActiveToolNames()).not.toContain("mcp_slack_post_message");
		} finally {
			await session.dispose();
		}
	});

	it("builds search_tool_bm25 descriptions from the loaded MCP catalog", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [createMcpCustomTool("mcp_github_create_issue", "github", "create_issue")],
		});

		const searchTool = session.agent.state.tools.find(tool => tool.name === "search_tool_bm25");
		expect(searchTool?.description).toContain("Total discoverable MCP tools loaded: 1.");
		expect(searchTool?.description).toContain("- `server_name`");
	});
	it("restores explicit MCP, thinking, and service-tier entries when resuming without rewriting the session file", async () => {
		const firstManager = SessionManager.create(tempDir, tempDir);
		const { session: firstSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: firstManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				defaultThinkingLevel: "high",
				serviceTier: "priority",
			}),
			model: createReasoningModel(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp_github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp_slack_post_message", "slack", "post_message"),
			],
		});
		await firstSession.activateDiscoveredMCPTools(["mcp_slack_post_message"]);
		firstSession.sessionManager.appendThinkingLevelChange(ThinkingLevel.Off);
		firstSession.sessionManager.appendServiceTierChange("priority");
		expect(firstSession.sessionManager.buildSessionContext().thinkingLevel).toBe(ThinkingLevel.Off);
		expect(firstSession.getSelectedMCPToolNames()).toEqual(["mcp_slack_post_message"]);
		const sessionFile = firstSession.sessionFile;
		expect(sessionFile).toBeDefined();
		await firstSession.sessionManager.rewriteEntries();
		const persistedBeforeResume = fs.readFileSync(sessionFile!, "utf8");
		const persistedMtimeBeforeResume = fs.statSync(sessionFile!).mtimeMs;
		await Bun.sleep(20);
		await firstSession.dispose();
		const resumedManager = await SessionManager.open(sessionFile!, tempDir);
		const { session: resumedSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: resumedManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				defaultThinkingLevel: "high",
				serviceTier: "none",
			}),
			model: createReasoningModel(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp_github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp_slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(resumedSession.thinkingLevel).toBe(ThinkingLevel.Off);
			expect(resumedSession.serviceTier).toBe("priority");
			expect(resumedSession.getSelectedMCPToolNames()).toEqual(["mcp_slack_post_message"]);
			expect(resumedSession.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "search_tool_bm25", "mcp_slack_post_message"]),
			);
			expect(resumedSession.systemPrompt).toContain("mcp_slack_post_message");
			expect(fs.readFileSync(sessionFile!, "utf8")).toBe(persistedBeforeResume);
			expect(fs.statSync(sessionFile!).mtimeMs).toBe(persistedMtimeBeforeResume);
		} finally {
			await resumedSession.dispose();
		}
	});

	it("restores fallback MCP, thinking, and service-tier state in memory without rewriting the session file", async () => {
		const sessionManager = SessionManager.create(tempDir, tempDir);
		sessionManager.appendMessage({
			role: "user",
			content: "resume me",
			timestamp: Date.now(),
		});
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		await sessionManager.rewriteEntries();
		const persistedBeforeResume = fs.readFileSync(sessionFile!, "utf8");
		const persistedMtimeBeforeResume = fs.statSync(sessionFile!).mtimeMs;
		await Bun.sleep(20);
		const resumedManager = await SessionManager.open(sessionFile!, tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: resumedManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDefaultServers": ["github"],
				defaultThinkingLevel: "high",
				serviceTier: "priority",
			}),
			model: createReasoningModel(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp_github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp_slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(session.thinkingLevel).toBe(ThinkingLevel.High);
			expect(session.serviceTier).toBe("priority");
			expect(session.getSelectedMCPToolNames()).toEqual(["mcp_github_create_issue"]);
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "search_tool_bm25", "mcp_github_create_issue"]),
			);
			expect(session.sessionManager.buildSessionContext().hasPersistedMCPToolSelection).toBe(false);
			expect(fs.readFileSync(sessionFile!, "utf8")).toBe(persistedBeforeResume);
			expect(fs.statSync(sessionFile!).mtimeMs).toBe(persistedMtimeBeforeResume);
		} finally {
			await session.dispose();
		}
	});

	it("keeps a cleared MCP selection empty when resuming with explicitly requested MCP tools", async () => {
		const firstManager = SessionManager.create(tempDir, tempDir);
		const { session: firstSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: firstManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25", "mcp_github_create_issue"],
			customTools: [
				createMcpCustomTool("mcp_github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp_slack_post_message", "slack", "post_message"),
			],
		});
		await firstSession.setActiveToolsByName(["read", "search_tool_bm25"]);
		expect(firstSession.getSelectedMCPToolNames()).toEqual([]);
		const sessionFile = firstSession.sessionFile;
		expect(sessionFile).toBeDefined();
		await firstSession.sessionManager.rewriteEntries();
		await firstSession.dispose();

		const resumedManager = await SessionManager.open(sessionFile!, tempDir);
		const { session: resumedSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: resumedManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25", "mcp_github_create_issue"],
			customTools: [
				createMcpCustomTool("mcp_github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp_slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(resumedSession.getSelectedMCPToolNames()).toEqual([]);
			expect(resumedSession.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "search_tool_bm25"]));
			expect(resumedSession.getActiveToolNames()).not.toContain("mcp_github_create_issue");
		} finally {
			await resumedSession.dispose();
		}
	});
});

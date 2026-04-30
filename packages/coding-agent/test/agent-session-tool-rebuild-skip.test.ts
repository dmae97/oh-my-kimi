import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { Type } from "@sinclair/typebox";
import { Settings } from "../src/config/settings";
import type { CustomTool } from "../src/extensibility/custom-tools/types";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

// Cache-stability invariant: when MCP servers reconnect with byte-identical tool
// definitions, `refreshMCPTools` must not rebuild the system prompt. A rebuild
// invalidates the Anthropic prompt-cache breakpoint placed on the system block
// and forces a full prefix re-encode on the next request.

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

function createBasicTool(name: string, label: string, description = `${label} tool`): AgentTool {
	return {
		name,
		label,
		description,
		parameters: Type.Object({ value: Type.String() }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function createMcpCustomTool(name: string, serverName: string, mcpToolName: string, description: string): CustomTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description,
		parameters: Type.Object({ q: Type.String() }),
		strict: true,
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

describe("AgentSession refreshMCPTools rebuild skipping", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	interface NewSessionOptions {
		mcpDiscoveryEnabled?: boolean;
		getMcpServerInstructions?: () => Map<string, string> | undefined;
	}

	function newSession(
		rebuildSystemPrompt: (toolNames: string[]) => Promise<string>,
		options: NewSessionOptions = {},
	): {
		session: AgentSession;
	} {
		const readTool = createBasicTool("read", "Read");
		const initialMcp = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[initialMcp.name, initialMcp as unknown as AgentTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: "initial",
				tools: [readTool, initialMcp as unknown as AgentTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			toolRegistry,
			rebuildSystemPrompt,
			mcpDiscoveryEnabled: options.mcpDiscoveryEnabled,
			getMcpServerInstructions: options.getMcpServerInstructions,
		});
		sessions.push(session);
		return { session };
	}

	it("skips rebuild when an MCP refresh produces an identical tool set", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});
		// The session constructor does not run rebuildSystemPrompt; baseline=0.
		expect(rebuildCount).toBe(0);

		const initialMcp = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");

		// First refresh: no signature recorded yet, must rebuild.
		await session.refreshMCPTools([initialMcp]);
		expect(rebuildCount).toBe(1);

		// Second refresh with byte-identical metadata: must NOT rebuild.
		await session.refreshMCPTools([initialMcp]);
		expect(rebuildCount).toBe(1);

		// Third refresh, again identical: still no rebuild.
		await session.refreshMCPTools([initialMcp]);
		expect(rebuildCount).toBe(1);
	});

	it("rebuilds when an MCP tool's description changes", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const v1 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search v1");
		await session.refreshMCPTools([v1]);
		expect(rebuildCount).toBe(1);

		const v2 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search v2");
		await session.refreshMCPTools([v2]);
		expect(rebuildCount).toBe(2);
	});

	it("rebuilds when the active tool list changes via setActiveToolsByName", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const a = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		const b = createMcpCustomTool("mcp__nucleus_explain", "nucleus", "explain", "Explain");

		// Bring both into the registry; only `mcp__nucleus_search` becomes active per
		// the agent's initial tool set.
		await session.refreshMCPTools([a, b]);
		const baseline = rebuildCount;
		expect(baseline).toBeGreaterThanOrEqual(1);

		// Activate the previously-inactive tool: the active list grew, signature must
		// change, rebuild must fire.
		await session.setActiveToolsByName(["read", "mcp__nucleus_search", "mcp__nucleus_explain"]);
		expect(rebuildCount).toBe(baseline + 1);

		// Same list again: skip.
		await session.setActiveToolsByName(["read", "mcp__nucleus_search", "mcp__nucleus_explain"]);
		expect(rebuildCount).toBe(baseline + 1);

		// Drop one: rebuild fires again.
		await session.setActiveToolsByName(["read", "mcp__nucleus_search"]);
		expect(rebuildCount).toBe(baseline + 2);
	});

	it("does not skip when refreshBaseSystemPrompt is called explicitly", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Explicit refresh must always rebuild (callers use it to pick up env-side changes
		// such as edit mode toggles, which are invisible to our tool signature).
		await session.refreshBaseSystemPrompt();
		expect(rebuildCount).toBe(2);

		// Subsequent identical MCP refresh should still skip after the explicit refresh
		// freshens the cached signature.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);
	});

	it("ignores incidental insertion order in the refresh argument", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const a = createMcpCustomTool("mcp__nucleus_a", "nucleus", "a", "A");
		const b = createMcpCustomTool("mcp__nucleus_b", "nucleus", "b", "B");

		// `refreshMCPTools` re-derives the active tool set from the registry using the
		// session's existing ordering, so passing the same content in a different order
		// must not mutate the signature.
		await session.refreshMCPTools([a, b]);
		expect(rebuildCount).toBe(1);

		await session.refreshMCPTools([b, a]);
		expect(rebuildCount).toBe(1);
	});

	it("rebuilds when an MCP tool's label changes", async () => {
		// Tool labels are rendered into the prompt body (`{{label}}: \`{{name}}\``),
		// so a label change \u2014 even with name and description constant \u2014 must force
		// a rebuild. Otherwise we'd serve a stale label after an MCP server upgrade.
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const v1 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		// Override the auto-derived label so the test mutates only the label.
		const v1WithLabel = { ...v1, label: "old label" } as typeof v1;
		await session.refreshMCPTools([v1WithLabel]);
		expect(rebuildCount).toBe(1);

		const v2WithLabel = { ...v1, label: "new label" } as typeof v1;
		await session.refreshMCPTools([v2WithLabel]);
		expect(rebuildCount).toBe(2);
	});

	it("rebuilds when MCP server instructions text changes", async () => {
		// `rebuildSystemPrompt` embeds per-server `instructions` text into the appended
		// prompt. The signature must include this so a server upgrade that changes
		// instructions while keeping tools constant still triggers a rebuild.
		let rebuildCount = 0;
		const instructions = new Map<string, string>([["nucleus", "v1 instructions"]]);
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{ getMcpServerInstructions: () => instructions },
		);

		const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Same tools, same instructions: skip.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Mutate the live instructions map (callers return the live reference).
		instructions.set("nucleus", "v2 instructions");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);

		// Adding a new server's instructions also triggers rebuild.
		instructions.set("glean", "glean instructions");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(3);
	});

	it("rebuilds when a discoverable (inactive) registry tool's metadata changes", async () => {
		// With MCP discovery on, the rebuilt prompt summarizes ALL discoverable MCP
		// tools \u2014 including ones not in the active set. The signature must capture the
		// full registry; otherwise a description change to a discoverable-but-inactive
		// tool would silently leave a stale summary in the cached prompt.
		let rebuildCount = 0;
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{ mcpDiscoveryEnabled: true },
		);

		const active = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		const discoverable = createMcpCustomTool("mcp__nucleus_explain", "nucleus", "explain", "Explain v1");

		await session.refreshMCPTools([active, discoverable]);
		const baseline = rebuildCount;
		expect(baseline).toBeGreaterThanOrEqual(1);

		// Same registry: skip.
		await session.refreshMCPTools([active, discoverable]);
		expect(rebuildCount).toBe(baseline);

		// Mutate the discoverable (NOT active) tool's description: signature must
		// differ via the registrySegment branch and force a rebuild.
		const discoverableV2 = createMcpCustomTool("mcp__nucleus_explain", "nucleus", "explain", "Explain v2");
		await session.refreshMCPTools([active, discoverableV2]);
		expect(rebuildCount).toBe(baseline + 1);
	});
});

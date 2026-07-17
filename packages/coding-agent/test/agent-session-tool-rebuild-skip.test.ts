import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { XdevRegistry } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { type } from "arktype";

// Cache-stability invariant: when MCP servers reconnect with byte-identical tool
// definitions, `refreshMCPTools` must not rebuild the system prompt. A rebuild
// invalidates the Anthropic prompt-cache breakpoint placed on the system block
// and forces a full prefix re-encode on the next request.

function createModel(): Model<"openai-responses"> {
	return buildModel({
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
	});
}

function createBasicTool(name: string, label: string, description = `${label} tool`): AgentTool {
	return {
		name,
		label,
		description,
		parameters: type({ value: "string" }),
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
		parameters: type({ q: "string" }),
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
		getMcpServerInstructions?: () => Map<string, string> | undefined;
		getLocalCalendarDate?: () => string;
		xdevRegistry?: XdevRegistry;
		lazyWrite?: boolean;
	}

	function newSession(
		rebuildSystemPrompt: (toolNames: string[]) => Promise<string>,
		options: NewSessionOptions = {},
	): {
		session: AgentSession;
	} {
		const readTool = createBasicTool("read", "Read");
		const initialMcp = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const writeTool = createBasicTool("write", "Write");
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[initialMcp.name, initialMcp as unknown as AgentTool],
		]);
		if (options.xdevRegistry && !options.lazyWrite) toolRegistry.set(writeTool.name, writeTool);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: options.xdevRegistry
					? options.lazyWrite
						? [readTool, initialMcp as unknown as AgentTool]
						: [readTool, writeTool, initialMcp as unknown as AgentTool]
					: [readTool, initialMcp as unknown as AgentTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			toolRegistry,
			builtInToolNames: options.xdevRegistry && !options.lazyWrite ? ["read", "write"] : ["read"],
			ensureWriteRegistered: async () => {
				if (!options.xdevRegistry) return false;
				if (!toolRegistry.has("write")) toolRegistry.set("write", writeTool);
				return true;
			},
			rebuildSystemPrompt: async (toolNames, _tools) => ({
				systemPrompt: [await rebuildSystemPrompt(toolNames)],
			}),
			getMcpServerInstructions: options.getMcpServerInstructions,
			getLocalCalendarDate: options.getLocalCalendarDate,
			xdevRegistry: options.xdevRegistry,
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

		// Connected MCP tools are all enabled after refresh.
		await session.refreshMCPTools([a, b]);
		const baseline = rebuildCount;
		expect(baseline).toBeGreaterThanOrEqual(1);

		// Remove one active tool: the active list shrinks, so rebuild must fire.
		await session.setActiveToolsByName(["read", "mcp__nucleus_search"]);
		expect(rebuildCount).toBe(baseline + 1);

		// Same list again: skip.
		await session.setActiveToolsByName(["read", "mcp__nucleus_search"]);
		expect(rebuildCount).toBe(baseline + 1);

		// Restore it: rebuild fires again.
		await session.setActiveToolsByName(["read", "mcp__nucleus_search", "mcp__nucleus_explain"]);
		expect(rebuildCount).toBe(baseline + 2);
	});

	it("updates live active-tool predicates before rebuilding the prompt", async () => {
		const activeToolNames = new Set(["read", "bash", "grep"]);
		const readTool = createBasicTool("read", "Read");
		const bashTool = createBasicTool("bash", "Bash");
		const grepTool = createBasicTool("grep", "Grep");
		Object.defineProperty(bashTool, "description", {
			get: () => (activeToolNames.has("grep") ? "bash sees grep" : "bash hides grep"),
			enumerable: true,
			configurable: true,
		});
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[bashTool.name, bashTool],
			[grepTool.name, grepTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, bashTool, grepTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			toolRegistry,
			setActiveToolNames: names => {
				activeToolNames.clear();
				for (const name of names) {
					activeToolNames.add(name);
				}
			},
			rebuildSystemPrompt: async (_toolNames, tools) => ({
				systemPrompt: [tools.get("bash")?.description ?? "missing bash"],
			}),
		});
		sessions.push(session);

		await session.setActiveToolsByName(["read", "bash"]);

		expect(agent.state.systemPrompt).toEqual(["bash hides grep"]);
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

	it("rebuilds when the refresh argument tool order changes", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const a = createMcpCustomTool("mcp__nucleus_a", "nucleus", "a", "A");
		const b = createMcpCustomTool("mcp__nucleus_b", "nucleus", "b", "B");

		// All connected MCP tools are active, so their ordering contributes to the
		// rendered prompt and changing it must rebuild.
		await session.refreshMCPTools([a, b]);
		expect(rebuildCount).toBe(1);

		await session.refreshMCPTools([b, a]);
		expect(rebuildCount).toBe(2);
	});

	it("rebuilds when an MCP tool's label changes", async () => {
		// Tool labels are rendered into the prompt body (`{{label}}: \`{{name}}\``),
		// so a label change — even with name and description constant — must force
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

	it("rebuilds when an MCP registry tool's metadata changes", async () => {
		// All connected MCP tools are enabled. The signature must capture the full
		// registry so a description change cannot leave stale prompt metadata cached.
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		}, {});

		const active = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		const secondary = createMcpCustomTool("mcp__nucleus_explain", "nucleus", "explain", "Explain v1");

		await session.refreshMCPTools([active, secondary]);
		const baseline = rebuildCount;
		expect(baseline).toBeGreaterThanOrEqual(1);

		// Same registry: skip.
		await session.refreshMCPTools([active, secondary]);
		expect(rebuildCount).toBe(baseline);

		// Mutate the secondary tool's description: the signature must differ and force
		// a rebuild.
		const secondaryV2 = createMcpCustomTool("mcp__nucleus_explain", "nucleus", "explain", "Explain v2");
		await session.refreshMCPTools([active, secondaryV2]);
		expect(rebuildCount).toBe(baseline + 1);
	});
	it("rebuilds when an MCP tool's customWireName changes", async () => {
		// `customWireName` overrides the model-facing tool name (e.g. `edit` exposes
		// itself as `apply_patch` to GPT-5). The wire name is rendered into the prompt
		// body via `toolPromptNames`, so a wire-name flip with the rest of the metadata
		// constant would otherwise leave a stale system prompt that advertises the wrong
		// callable name to the model. The signature must catch this.
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		// Attach a custom wire name to the MCP tool. `applyToolProxy` forwards arbitrary
		// properties from the underlying CustomTool to the wrapper, so the AgentTool the
		// signature inspects exposes `customWireName` as if it were declared on the type.
		const v1 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		const v1WithWire = { ...v1, customWireName: "wire_v1" } as typeof v1 & { customWireName: string };
		await session.refreshMCPTools([v1WithWire]);
		expect(rebuildCount).toBe(1);

		// Same wire name: skip.
		await session.refreshMCPTools([v1WithWire]);
		expect(rebuildCount).toBe(1);

		// Wire name changes while name/label/description stay constant: must rebuild.
		const v2WithWire = { ...v1, customWireName: "wire_v2" } as typeof v1 & { customWireName: string };
		await session.refreshMCPTools([v2WithWire]);
		expect(rebuildCount).toBe(2);

		// Drop wire name entirely: must rebuild (signature must differ from `wire_v2`).
		await session.refreshMCPTools([v1]);
		expect(rebuildCount).toBe(3);
	});

	it("rebuilds when a tool's getter-based description reflects new settings state", async () => {
		// Built-in tools whose prompt-rendered metadata depends on settings expose
		// `description` via getters that re-evaluate on every access (TaskTool reads
		// task.disabledAgents/maxConcurrency/isolation.mode/simple/async.enabled, and
		// EditTool resolves through the current edit-mode definition). The signature
		// reads `tool.description` live each call, so a settings flip that mutates the
		// rendered string must change the signature on the next
		// `#applyActiveToolsByName`.
		let rebuildCount = 0;
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			// The dynamic tool is active, so the signature reads its description via
			// the active tool metadata segment.
			{},
		);

		// Reuse the initially-active MCP name so the tool stays in the active list
		// across refreshes - we want to defend the path where `tool.description` is read
		// for the active descriptionSegment, not just the registrySegment.
		const settingState = { disabled: "none" };
		const dynamicTool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "placeholder");
		Object.defineProperty(dynamicTool, "description", {
			get: () => `dynamic disabled=${settingState.disabled}`,
			enumerable: true,
			configurable: true,
		});

		await session.refreshMCPTools([dynamicTool]);
		const baseline = rebuildCount;
		expect(baseline).toBeGreaterThanOrEqual(1);

		// Same underlying state, same tool object identity: skip.
		await session.refreshMCPTools([dynamicTool]);
		expect(rebuildCount).toBe(baseline);

		// Mutate the settings-backed state. The tool object identity does not change,
		// but its `description` getter now returns a new string. The signature must
		// pick this up live (no per-tool caching) and force a rebuild.
		settingState.disabled = "plan,scout";
		await session.refreshMCPTools([dynamicTool]);
		expect(rebuildCount).toBe(baseline + 1);

		// Same state again: skip.
		await session.refreshMCPTools([dynamicTool]);
		expect(rebuildCount).toBe(baseline + 1);
	});
	it("rebuilds when the local calendar date rolls over between tool-stable MCP refreshes", async () => {
		// `buildSystemPrompt` injects today's local date into the prompt body. The
		// signature reads the same date provider so a session spanning local midnight
		// must rebuild after an MCP reconnect with an otherwise identical tool set.
		let currentDate = "2026-06-30";
		let rebuildCount = 0;
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{ getLocalCalendarDate: () => currentDate },
		);
		const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");

		// First refresh: no signature yet, must rebuild.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Same tools, same local day: signature matches, skip.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		currentDate = "2026-07-01";

		// Same tools, new local calendar day: date segment changed, must rebuild.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);

		// Same tools, same new local day: skip again.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);
	});
	it("does not rebuild when MCP server instructions change only beyond the 4000-char truncation boundary", async () => {
		// `rebuildSystemPrompt` (sdk.ts) truncates each server instruction to 4000 chars
		// before embedding it. The `getMcpServerInstructions` callback must therefore
		// return pre-truncated strings so the signature hashes exactly what the prompt
		// builder uses. Changes beyond char 4000 cannot affect rendered prompt bytes
		// and must NOT trigger a rebuild.
		const prefix = "A".repeat(4000);
		const instructions = new Map<string, string>([["nucleus", `${prefix}_tail_v1`]]);
		let rebuildCount = 0;
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{
				getMcpServerInstructions: () => {
					// Mirror what sdk.ts does: truncate to 4000 chars before returning.
					const out = new Map<string, string>();
					for (const [name, text] of instructions) {
						out.set(name, text.length > 4000 ? text.slice(0, 4000) : text);
					}
					return out;
				},
			},
		);
		const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");

		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Mutate only the text beyond char 4000: truncated string is identical → skip.
		instructions.set("nucleus", `${prefix}_tail_v2`);
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Mutate within the first 4000 chars: truncated string differs → rebuild.
		instructions.set("nucleus", `${"B".repeat(4000)}_tail_v2`);
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);
	});

	it("announces xd:// mount deltas as steered notices instead of rebuilding the prompt", async () => {
		let rebuildCount = 0;
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{ xdevRegistry: new XdevRegistry([]) },
		);
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const fetch = createMcpCustomTool("mcp__nucleus_fetch", "nucleus", "fetch", "Fetch nucleus");
		const noticeTexts = () =>
			session.agent
				.peekSteeringQueue()
				.flatMap(msg =>
					msg.role === "custom" && msg.customType === "xdev-mount-notice" && typeof msg.content === "string"
						? [msg.content]
						: [],
				);

		// First refresh: initial signature record → one rebuild; the MCP tool is
		// discoverable, so it mounts as a device and is announced.
		await session.refreshMCPTools([search]);
		expect(rebuildCount).toBe(1);
		expect(noticeTexts().at(-1)).toContain("xd://mcp__nucleus_search");

		// Mount-only change: NO rebuild (prompt stays byte-stable), a notice
		// announces the new device.
		await session.refreshMCPTools([search, fetch]);
		expect(rebuildCount).toBe(1);
		const mountNotice = noticeTexts().at(-1) ?? "";
		expect(mountNotice).toContain("became available");
		expect(mountNotice).toContain("xd://mcp__nucleus_fetch");
		expect(mountNotice).not.toContain("No longer mounted");

		// Unmount: still no rebuild, the removal is announced.
		await session.refreshMCPTools([search]);
		expect(rebuildCount).toBe(1);
		const unmountNotice = noticeTexts().at(-1) ?? "";
		expect(unmountNotice).toContain("No longer mounted");
		expect(unmountNotice).toContain("xd://mcp__nucleus_fetch");

		// Identical refresh: no new notice, no rebuild.
		const noticeCount = noticeTexts().length;
		await session.refreshMCPTools([search]);
		expect(rebuildCount).toBe(1);
		expect(noticeTexts().length).toBe(noticeCount);
	});

	it("keeps xd:// mount deltas model-visible without rendering them during quiet startup", async () => {
		const { session } = newSession(async toolNames => `tools:${toolNames.join(",")}`, {
			xdevRegistry: new XdevRegistry([]),
		});
		session.settings.set("startup.quiet", true);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "xdev") notices.push(event.message);
		});

		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		await session.refreshMCPTools([search]);

		expect(notices).toEqual([]);
		expect(
			session.agent
				.peekSteeringQueue()
				.some(message => message.role === "custom" && message.customType === "xdev-mount-notice"),
		).toBe(true);
	});

	it("keeps lazy write registration while rolling back applied state on rebuild failure", async () => {
		let failRebuild = true;
		const xdevRegistry = new XdevRegistry([]);
		const { session } = newSession(
			async toolNames => {
				if (failRebuild) throw new Error("rebuild failed");
				return `tools:${toolNames.join(",")}`;
			},
			{ xdevRegistry, lazyWrite: true },
		);
		const search = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const activeBefore = session.getActiveToolNames();
		const mountedBefore = session.getMountedXdevToolNames();

		await expect(session.refreshMCPTools([search])).rejects.toThrow("rebuild failed");

		expect(session.getActiveToolNames()).toEqual(activeBefore);
		expect(session.getMountedXdevToolNames()).toEqual(mountedBefore);
		expect(session.getToolByName("write")).toBeDefined();
		expect(session.hasBuiltInTool("write")).toBe(true);

		failRebuild = false;
		await session.refreshMCPTools([search]);
		expect(session.getActiveToolNames()).toContain("write");
		expect(session.getMountedXdevToolNames()).toContain(search.name);
	});

	it("rolls back MCP catalog replacement when prompt rebuild fails", async () => {
		let failRebuild = false;
		let date = "2026-07-16";
		const xdevRegistry = new XdevRegistry([]);
		const { session } = newSession(
			async toolNames => {
				if (failRebuild) throw new Error("rebuild failed");
				return `tools:${toolNames.join(",")}`;
			},
			{ xdevRegistry, getLocalCalendarDate: () => date },
		);
		const oldTool = createMcpCustomTool("mcp__nucleus_old", "nucleus", "old", "Old tool");
		const newTool = createMcpCustomTool("mcp__nucleus_new", "nucleus", "new", "New tool");
		await session.refreshMCPTools([oldTool]);
		date = "2026-07-17";
		failRebuild = true;

		await expect(session.refreshMCPTools([newTool])).rejects.toThrow("rebuild failed");
		expect(session.getToolByName(oldTool.name)).toBeDefined();
		expect(session.getToolByName(newTool.name)).toBeUndefined();
		expect(session.getMountedXdevToolNames()).toContain(oldTool.name);

		failRebuild = false;
		await session.refreshMCPTools([newTool]);
		expect(session.getToolByName(oldTool.name)).toBeUndefined();
		expect(session.getToolByName(newTool.name)).toBeDefined();
		expect(session.getMountedXdevToolNames()).toContain(newTool.name);
	});

	it("rolls back RPC catalog replacement when prompt rebuild fails", async () => {
		let failRebuild = false;
		let date = "2026-07-16";
		const xdevRegistry = new XdevRegistry([]);
		const { session } = newSession(
			async toolNames => {
				if (failRebuild) throw new Error("rebuild failed");
				return `tools:${toolNames.join(",")}`;
			},
			{ xdevRegistry, getLocalCalendarDate: () => date },
		);
		const oldTool = { ...createBasicTool("rpc_old", "RPC Old"), loadMode: "discoverable" as const };
		const newTool = { ...createBasicTool("rpc_new", "RPC New"), loadMode: "discoverable" as const };
		await session.refreshRpcHostTools([oldTool]);
		date = "2026-07-17";
		failRebuild = true;

		await expect(session.refreshRpcHostTools([newTool])).rejects.toThrow("rebuild failed");
		expect(session.getToolByName(oldTool.name)).toBeDefined();
		expect(session.getToolByName(newTool.name)).toBeUndefined();
		expect(session.getMountedXdevToolNames()).toContain(oldTool.name);

		failRebuild = false;
		await session.refreshRpcHostTools([newTool]);
		expect(session.getToolByName(oldTool.name)).toBeUndefined();
		expect(session.getToolByName(newTool.name)).toBeDefined();
		expect(session.getMountedXdevToolNames()).toContain(newTool.name);
	});
});

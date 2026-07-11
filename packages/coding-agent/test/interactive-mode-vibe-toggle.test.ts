/**
 * Contracts: /vibe mode toggle on InteractiveMode.
 *
 * 1. Entering vibe mode swaps the active toolset to exactly `read` + the vibe
 *    tools and marks the session's vibe-mode state.
 * 2. Exiting restores the pre-vibe toolset EXACTLY — including the legitimate
 *    empty set (regression: a truthiness/length guard used to skip restoring
 *    `[]`, leaving read/vibe tools active after exit).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

describe("InteractiveMode vibe mode toggle", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-vibe-toggle-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		const registryTools = ["read", ...VIBE_TOOL_NAMES].map(stubTool);

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
			toolRegistry: new Map(registryTools.map(tool => [tool.name, tool])),
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("restores the exact pre-vibe toolset on exit, including an empty one", async () => {
		expect(session.getActiveToolNames()).toEqual([]);

		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(true);
		const inMode = session.getActiveToolNames();
		expect(inMode).toContain("read");
		for (const name of VIBE_TOOL_NAMES) {
			expect(inMode).toContain(name);
		}
		expect(inMode.toSorted()).toEqual(["read", ...VIBE_TOOL_NAMES].toSorted());

		// Toggle off: the empty previous toolset must come back — vibe tools
		// must not leak past the mode.
		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(false);
		expect(session.getActiveToolNames()).toEqual([]);
	});
});

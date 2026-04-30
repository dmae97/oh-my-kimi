import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

describe("issue #816 — plan mode pendingModelSwitch leak", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		_resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-816-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		const defaultModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) throw new Error("Expected claude-sonnet-4-5 in registry");

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: defaultModel,
					systemPrompt: "Test",
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		_resetSettingsForTest();
	});

	it("does not switch to the plan-role model after exit when the entry switch was deferred by streaming", async () => {
		const planModel = modelRegistry.find("anthropic", "claude-haiku-4-5");
		if (!planModel) throw new Error("Expected claude-haiku-4-5 in registry");

		// Stream is active throughout entry: #applyPlanModeModel snapshots the
		// previous (default) model and queues a pending switch to the plan model
		// instead of applying it immediately.
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		vi.spyOn(session, "resolveRoleModelWithThinking").mockReturnValue({
			model: planModel,
			thinkingLevel: undefined,
			explicitThinkingLevel: false,
			warning: undefined,
		});
		// Avoid kicking off real session work during plan mode entry.
		vi.spyOn(session, "sendPlanModeContext").mockResolvedValue(undefined);

		const setModelSpy = vi.spyOn(session, "setModelTemporary").mockResolvedValue(undefined);

		// Enter plan mode → snapshots default, queues pending switch to plan model.
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(true);

		// User confirms exit (e.g., approves plan / pauses plan mode).
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		await mode.handlePlanModeCommand();
		expect(mode.planModeEnabled).toBe(false);

		// Stream ends → event-controller flushes any queued model switch.
		await mode.flushPendingModelSwitch();

		// Contract: the deferred plan-role switch must be discarded on exit.
		// Otherwise the next user turn lands on the plan-role model even though
		// the user is no longer in plan mode.
		expect(setModelSpy).not.toHaveBeenCalled();
	});
});

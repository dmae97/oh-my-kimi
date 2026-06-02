import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

describe("InteractiveMode shutdown", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-shutdown-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("stops from the last committed TUI frame without forcing a teardown repaint", async () => {
		const requestRenderSpy = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const stopSpy = vi.spyOn(mode.ui, "stop").mockImplementation(() => {});
		const drainSpy = vi.spyOn(mode.ui.terminal, "drainInput").mockResolvedValue(undefined);
		const disposeSpy = vi.spyOn(session, "dispose").mockResolvedValue(undefined);
		const quitSpy = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
		vi.spyOn(session.sessionManager, "getSessionId").mockReturnValue("");
		mode.isInitialized = true;

		await mode.shutdown();

		expect(disposeSpy).toHaveBeenCalled();
		expect(requestRenderSpy.mock.calls.some(call => call[0] === true)).toBe(false);
		expect(drainSpy).toHaveBeenCalledWith(1000);
		expect(stopSpy).toHaveBeenCalled();
		expect(quitSpy).toHaveBeenCalledWith(0);
	});
});

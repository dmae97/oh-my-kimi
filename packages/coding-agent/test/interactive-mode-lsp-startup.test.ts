import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "../src/lsp/startup-events";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import type { LspStartupServerInfo } from "../src/tools";
import { EventBus } from "../src/utils/event-bus";

describe("InteractiveMode LSP startup welcome banner", () => {
	let authStorage: AuthStorage;
	let eventBus: EventBus;
	let lspServers: LspStartupServerInfo[];
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		// Prevent ProcessTerminal.start() from sending escape queries to the real
		// terminal (OSC 11, DA1, kitty protocol, cell-size).  The test only reads
		// rendered output via mode.ui.render(), so real terminal I/O is unnecessary.
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		_resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-interactive-mode-lsp-startup-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

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
			settings: Settings.isolated(),
			modelRegistry,
		});
		eventBus = new EventBus();
		lspServers = [
			{
				name: "rust-analyzer",
				status: "connecting",
				fileTypes: [".rs"],
			},
		];
		mode = new InteractiveMode(session, "test", undefined, () => {}, lspServers, undefined, eventBus);
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		_resetSettingsForTest();
	});

	it("updates the welcome banner when startup warmup completes", async () => {
		await mode.init();

		const findServerLine = () =>
			Bun.stripANSI(mode.ui.render(120).join("\n"))
				.split("\n")
				.find(line => line.includes("rust-analyzer")) ?? "";

		expect(findServerLine()).toContain(theme.status.pending);

		const requestRenderSpy = vi.spyOn(mode.ui, "requestRender");
		const showStatusSpy = vi.spyOn(mode, "showStatus");
		requestRenderSpy.mockClear();
		showStatusSpy.mockClear();

		lspServers[0].status = "ready";
		const event: LspStartupEvent = {
			type: "completed",
			servers: [
				{
					name: "rust-analyzer",
					status: "ready",
					fileTypes: [".rs"],
				},
			],
		};

		eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);

		expect(requestRenderSpy).toHaveBeenCalled();
		expect(showStatusSpy).not.toHaveBeenCalled();
		expect(findServerLine()).toContain(theme.status.success);
		expect(findServerLine()).not.toContain(theme.status.pending);
	});
});

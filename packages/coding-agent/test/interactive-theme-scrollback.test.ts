import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { enableAutoTheme, initTheme, previewTheme, setTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const MULTIPLEXER_ENV_KEYS = ["TMUX", "STY", "ZELLIJ", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "TERM"] as const;

let originalMultiplexerEnv: Partial<Record<(typeof MULTIPLEXER_ENV_KEYS)[number], string | undefined>>;
describe("InteractiveMode theme scrollback refresh", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let terminal: VirtualTerminal;

	beforeEach(async () => {
		originalMultiplexerEnv = {};
		for (const key of MULTIPLEXER_ENV_KEYS) {
			originalMultiplexerEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-theme-scrollback-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		await initTheme();
		await setTheme("dark");

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

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
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		terminal = new VirtualTerminal(100, 20);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		mode?.stop();
		await setTheme("dark");
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		for (const key of MULTIPLEXER_ENV_KEYS) {
			const value = originalMultiplexerEnv[key];
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("emits a full scrollback replay when the active theme changes", async () => {
		await terminal.waitForRender();
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});

		await setTheme("light");
		await terminal.waitForRender();

		expect(writes.join("")).toContain("\x1b[3J");
	});

	it("keeps theme previews as non-destructive viewport repaints", async () => {
		await terminal.waitForRender();
		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});

		await previewTheme("light");
		await terminal.waitForRender();

		expect(mode.ui.fullRedraws).toBe(fullRedraws);
		expect(writes.join("")).not.toContain("\x1b[3J");
	});

	it("emits a full scrollback replay when a previewed theme is committed", async () => {
		await terminal.waitForRender();
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});

		await previewTheme("light", { ephemeral: false });
		await terminal.waitForRender();

		expect(writes.join("")).toContain("\x1b[3J");
	});

	it("keeps auto-theme previews as non-destructive viewport repaints", async () => {
		await terminal.waitForRender();
		const originalColorFgBg = Bun.env.COLORFGBG;
		Bun.env.COLORFGBG = "0;15";
		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});

		try {
			enableAutoTheme({ ephemeral: true });
			await terminal.waitForRender();
		} finally {
			if (originalColorFgBg === undefined) {
				delete Bun.env.COLORFGBG;
			} else {
				Bun.env.COLORFGBG = originalColorFgBg;
			}
		}

		expect(mode.ui.fullRedraws).toBe(fullRedraws);
		expect(writes.join("")).not.toContain("\x1b[3J");
	});

	it("keeps theme changes as viewport repaints inside terminal multiplexers", async () => {
		await terminal.waitForRender();
		Bun.env.TMUX = "/tmp/tmux-1000/default,1,0";
		const fullRedraws = mode.ui.fullRedraws;
		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});

		await setTheme("light");
		await terminal.waitForRender();

		expect(mode.ui.fullRedraws).toBe(fullRedraws);
		expect(writes.join("")).not.toContain("\x1b[3J");
	});
});

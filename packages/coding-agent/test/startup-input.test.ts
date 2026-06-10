import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { StartupInput } from "@oh-my-pi/pi-coding-agent/modes/startup-input";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function createStartupInput(): StartupInput {
	return new StartupInput({
		version: "0.0.0-test",
		modelName: "Test Model",
		providerName: "test",
		lspServers: [],
	});
}

beforeAll(() => {
	initTheme();
});

// `start()` is never called: the capture stays detached from stdin/stdout, so
// these tests exercise the pure input → editor → queue contract.
describe("StartupInput pre-TUI capture", () => {
	it("queues Enter submissions in order and clears the editor between them", () => {
		const startup = createStartupInput();

		for (const ch of "hello") startup.feedInput(ch);
		expect(startup.editor.getText()).toBe("hello");

		startup.feedInput("\r");
		expect([...startup.queuedSubmissions]).toEqual(["hello"]);
		expect(startup.editor.getText()).toBe("");

		for (const ch of "world") startup.feedInput(ch);
		startup.feedInput("\r");
		expect([...startup.queuedSubmissions]).toEqual(["hello", "world"]);
	});

	it("ignores Enter on an empty editor", () => {
		const startup = createStartupInput();
		startup.feedInput("\r");
		expect(startup.queuedSubmissions).toHaveLength(0);
	});

	it("queues paste placeholders fully expanded, ready for the real submit pipeline", () => {
		const startup = createStartupInput();
		const pasted = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");

		startup.feedInput(`\x1b[200~${pasted}\x1b[201~`);
		// Large pastes collapse to an atomic placeholder in the editor buffer...
		expect(startup.editor.getText()).toContain("[Paste #1");

		startup.feedInput("\r");
		// ...but the queued submission must be final plain text: the splash
		// editor's paste map is gone by the time the queue is replayed.
		expect(startup.queuedSubmissions[0]).toBe(pasted);
	});

	it("clears typed text on Ctrl+C without queueing it", () => {
		const startup = createStartupInput();
		for (const ch of "draft") startup.feedInput(ch);

		startup.feedInput("\x03");
		expect(startup.editor.getText()).toBe("");
		expect(startup.queuedSubmissions).toHaveLength(0);
	});

	it("releases its editor handlers on detach so the live UI owns submission", () => {
		const startup = createStartupInput();
		expect(startup.editor.onSubmit).toBeDefined();

		startup.detach();
		expect(startup.editor.onSubmit).toBeUndefined();
		expect(startup.editor.onClear).toBeUndefined();
		expect(startup.editor.onExit).toBeUndefined();
	});
});

describe("InteractiveMode startup editor adoption", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-startup-input-");
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
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("adopts the splash editor instance so text typed during startup carries over", () => {
		const startup = createStartupInput();
		for (const ch of "typed while loading") startup.feedInput(ch);
		startup.detach();

		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			startup.editor,
		);

		expect(mode.editor).toBe(startup.editor);
		expect(mode.editor.getText()).toBe("typed while loading");
	});
});

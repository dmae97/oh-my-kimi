import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode } from "../src/modes/interactive-mode";

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: z.object({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

describe("InteractiveMode plan.defaultOnStartup", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		Bun.gc(true);
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-default-plan-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		mode = undefined;
		session = undefined;
		authStorage = undefined as unknown as AuthStorage;
		tempDir = undefined as unknown as TempDir;
		resetSettingsForTest();
		Bun.gc(true);
	});

	function modelOrThrow(registry: ModelRegistry, id: string): Model<Api> {
		const model = registry.find("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	/** Build an InteractiveMode over a brand-new (never-persisted) session. */
	function createHarness(settings: Settings): InteractiveMode {
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${Bun.nanoseconds()}.yml`));
		const initialModel = modelOrThrow(registry, "claude-sonnet-4-5");
		const readTool = makeTool("read");
		const resolveTool = makeTool("resolve");
		// AgentSession requires a Map-typed tool registry; the harness needs both
		// `read` (the initial active tool) and `resolve` (added on plan-mode entry).
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[resolveTool.name, resolveTool],
		]);
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), `active-${Bun.nanoseconds()}`));
		const createdSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model: initialModel,
					systemPrompt: ["Test"],
					tools: [readTool],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			toolRegistry,
		});
		session = createdSession;
		mode = new InteractiveMode(createdSession, "test");
		return mode;
	}

	it("enters plan mode at startup when the setting is enabled", async () => {
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }));

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(true);
		expect(session?.getPlanModeState()).toMatchObject({ enabled: true, planFilePath: "local://PLAN.md" });
		expect(session?.getActiveToolNames()).toContain("resolve");
	});

	it("does not enter plan mode at startup by default", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(false);
		expect(session?.getPlanModeState()).toBeUndefined();
	});

	it("does not enter plan mode when the session has restored history", async () => {
		// A genuinely resumed session has prior entries; gating on getEntries()
		// (not the CLI resume flag) means a `--continue` that created a *fresh*,
		// empty session still gets the startup default (the "enters" case above),
		// while one with restored history is left in its reconciled mode.
		const created = createHarness(Settings.isolated({ "plan.defaultOnStartup": true, "compaction.enabled": false }));
		created.sessionManager.appendMessage({ role: "user", content: "prior turn", timestamp: Date.now() });

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(false);
		expect(session?.getPlanModeState()).toBeUndefined();
	});

	it("does not enter plan mode when plan mode is globally disabled", async () => {
		const created = createHarness(
			Settings.isolated({ "plan.defaultOnStartup": true, "plan.enabled": false, "compaction.enabled": false }),
		);

		await created.init({ suppressWelcomeIntro: true });

		expect(created.planModeEnabled).toBe(false);
		expect(session?.getPlanModeState()).toBeUndefined();
	});
});

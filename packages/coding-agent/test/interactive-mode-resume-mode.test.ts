import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";

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

describe("InteractiveMode resume mode restoration", () => {
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
		tempDir = TempDir.createSync("@pi-resume-mode-");
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

	function modelRegistry(): ModelRegistry {
		return new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${Bun.nanoseconds()}.yml`));
	}

	function modelOrThrow(registry: ModelRegistry, id: string): Model<Api> {
		const model = registry.find("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	function modelValue(model: Model<Api>): string {
		return `${model.provider}/${model.id}`;
	}

	async function writeSessionFile(name: string, entries: Array<Record<string, unknown>>): Promise<string> {
		const sessionFile = path.join(tempDir.path(), `${name}-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			sessionFile,
			`${[{ type: "session", version: 3, id: `${name}-session`, timestamp, cwd: tempDir.path() }, ...entries]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return sessionFile;
	}

	async function writeModelSession(name: string, model: Model<Api>): Promise<string> {
		const timestamp = "2026-06-01T00:00:00.000Z";
		return await writeSessionFile(name, [
			{
				type: "model_change",
				id: `${name}-default-model`,
				parentId: null,
				timestamp,
				model: modelValue(model),
				role: "default",
			},
		]);
	}

	async function writePlanSession(
		name: string,
		defaultModel: Model<Api>,
		options: { temporaryModel?: Model<Api>; planFilePath?: string } = {},
	): Promise<string> {
		const timestamp = "2026-06-01T00:00:00.000Z";
		const defaultEntryId = `${name}-default-model`;
		const temporaryEntryId = `${name}-temporary-model`;
		const parentId = options.temporaryModel ? temporaryEntryId : defaultEntryId;
		return await writeSessionFile(name, [
			{
				type: "model_change",
				id: defaultEntryId,
				parentId: null,
				timestamp,
				model: modelValue(defaultModel),
				role: "default",
			},
			...(options.temporaryModel
				? [
						{
							type: "model_change",
							id: temporaryEntryId,
							parentId: defaultEntryId,
							timestamp,
							model: modelValue(options.temporaryModel),
							role: "temporary",
						},
					]
				: []),
			{
				type: "mode_change",
				id: `${name}-plan-mode`,
				parentId,
				timestamp,
				mode: "plan",
				data: { planFilePath: options.planFilePath ?? "local://PLAN.md" },
			},
		]);
	}

	async function createHarness(
		options: {
			sessionFile?: string;
			initialModel?: Model<Api>;
			activeToolNames?: string[];
			settings?: Settings;
		} = {},
	): Promise<{ mode: InteractiveMode; registry: ModelRegistry; session: AgentSession }> {
		const registry = modelRegistry();
		const initialModel = options.initialModel ?? modelOrThrow(registry, "claude-sonnet-4-5");
		const tools = [makeTool("read"), makeTool("resolve")];
		const toolRegistry = new Map(tools.map(tool => [tool.name, tool]));
		const activeToolNames = options.activeToolNames ?? ["read"];
		const activeTools = activeToolNames.map(name => {
			const tool = toolRegistry.get(name);
			if (!tool) throw new Error(`Unknown active tool ${name}`);
			return tool;
		});
		const manager = options.sessionFile
			? await SessionManager.open(options.sessionFile, path.join(tempDir.path(), "sessions"))
			: SessionManager.create(tempDir.path(), path.join(tempDir.path(), `active-${Bun.nanoseconds()}`));
		const createdSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model: initialModel,
					systemPrompt: ["Test"],
					tools: activeTools,
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: manager,
			settings: options.settings ?? Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: registry,
			toolRegistry,
		});
		const createdMode = new InteractiveMode(createdSession, "test");
		session = createdSession;
		mode = createdMode;
		return { mode: createdMode, registry, session: createdSession };
	}

	it("invokes the registered reconciler after switching sessions", async () => {
		const registry = modelRegistry();
		const defaultModel = modelOrThrow(registry, "claude-sonnet-4-5");
		const targetSessionFile = await writeModelSession("target", defaultModel);
		const created = await createHarness({ initialModel: defaultModel });
		const reconciler = vi.fn(async () => {});
		created.session.setSessionSwitchReconciler(reconciler);

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);

		expect(reconciler).toHaveBeenCalledTimes(1);
	});

	it("restores plan mode from the active session during init", async () => {
		const registry = modelRegistry();
		const defaultModel = modelOrThrow(registry, "claude-sonnet-4-5");
		const planSessionFile = await writePlanSession("plan", defaultModel, {
			planFilePath: "local://RESTORED.md",
		});
		const created = await createHarness({ sessionFile: planSessionFile, initialModel: defaultModel });

		await created.mode.init({ suppressWelcomeIntro: true });

		expect(created.mode.planModeEnabled).toBe(true);
		expect(created.session.getPlanModeState()).toMatchObject({
			enabled: true,
			planFilePath: "local://RESTORED.md",
		});
		expect(created.session.getActiveToolNames()).toContain("resolve");
	});

	it("clears stale plan mode state when switching to a non-plan session", async () => {
		const registry = modelRegistry();
		const defaultModel = modelOrThrow(registry, "claude-sonnet-4-5");
		const planSessionFile = await writePlanSession("plan", defaultModel);
		const targetSessionFile = await writeModelSession("plain", defaultModel);
		const created = await createHarness({ sessionFile: planSessionFile, initialModel: defaultModel });
		await created.mode.init({ suppressWelcomeIntro: true });
		expect(created.mode.planModeEnabled).toBe(true);
		expect(created.session.getActiveToolNames()).toEqual(["read", "resolve"]);
		expect(created.session.peekStandingResolveHandler()).toBeDefined();

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);

		expect(created.mode.planModeEnabled).toBe(false);
		expect(created.mode.planModePaused).toBe(false);
		expect(created.session.getPlanModeState()).toBeUndefined();
		expect(created.session.getActiveToolNames()).toEqual(["read"]);
		expect(created.session.peekStandingResolveHandler()).toBeUndefined();
	});

	it("restores temporary model and plan mode together on session switch", async () => {
		const registry = modelRegistry();
		const defaultModel = modelOrThrow(registry, "claude-sonnet-4-5");
		const temporaryModel = modelOrThrow(registry, "claude-sonnet-4-6");
		const targetSessionFile = await writePlanSession("target-plan", defaultModel, {
			temporaryModel,
			planFilePath: "local://SWITCHED.md",
		});
		const created = await createHarness({ initialModel: defaultModel });
		await created.mode.init({ suppressWelcomeIntro: true });

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);

		expect(created.session.model?.id).toBe(temporaryModel.id);
		expect(created.mode.planModeEnabled).toBe(true);
		expect(created.session.getPlanModeState()).toMatchObject({
			enabled: true,
			planFilePath: "local://SWITCHED.md",
		});
	});
});

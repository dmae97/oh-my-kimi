import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, getBundledModel } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as autoThinkingClassifier from "../src/auto-thinking/classifier";
import { AUTO_THINKING, clampAutoThinkingEffort, resolveProvisionalAutoLevel } from "../src/thinking";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession role model thinking behavior", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionSettings: Settings;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-role-thinking-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		tempDir.removeSync();
	});

	function getAnthropicModelOrThrow(id: string) {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	async function createSession(options: {
		initialModelId: string;
		initialThinkingLevel: Effort;
		modelRoles: Record<string, string>;
	}) {
		const model = getAnthropicModelOrThrow(options.initialModelId);
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: options.initialThinkingLevel,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		sessionSettings = Settings.isolated();
		for (const [role, modelRoleValue] of Object.entries(options.modelRoles)) {
			sessionSettings.setModelRole(role, modelRoleValue);
		}
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});
	}

	it("re-applies explicit role thinking each time that role is selected", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				slow: `${slowModel.provider}/${slowModel.id}:off`,
			},
		});

		const firstSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(firstSwitch?.role).toBe("slow");
		expect(firstSwitch?.model.id).toBe(slowModel.id);
		expect(firstSwitch?.thinkingLevel).toBe("off");
		expect(session.thinkingLevel).toBe("off");

		session.setThinkingLevel(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);

		const secondSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(secondSwitch?.role).toBe("default");
		expect(secondSwitch?.model.id).toBe(defaultModel.id);
		expect(session.thinkingLevel).toBe(Effort.High);

		const thirdSwitch = await session.cycleRoleModels(["default", "slow"]);
		expect(thirdSwitch?.role).toBe("slow");
		expect(thirdSwitch?.model.id).toBe(slowModel.id);
		expect(thirdSwitch?.thinkingLevel).toBe("off");
		expect(session.thinkingLevel).toBe("off");
	});

	it("preserves current thinking when switching into default/no-suffix role", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Low,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				slow: `${slowModel.provider}/${slowModel.id}:high`,
			},
		});

		const toSlow = await session.cycleRoleModels(["default", "slow"]);
		expect(toSlow?.role).toBe("slow");
		expect(toSlow?.thinkingLevel).toBe(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);

		session.setThinkingLevel(Effort.Minimal);
		expect(session.thinkingLevel).toBe(Effort.Minimal);

		const toDefault = await session.cycleRoleModels(["default", "slow"]);
		expect(toDefault?.role).toBe("default");
		expect(toDefault?.model.id).toBe(defaultModel.id);
		expect(toDefault?.thinkingLevel).toBe(Effort.Minimal);
		expect(session.thinkingLevel).toBe(Effort.Minimal);
	});

	it("applies slow role thinking even when plan shares the same model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const slowPlanModel = getAnthropicModelOrThrow("claude-opus-4-5");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Medium,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				smol: `${smolModel.provider}/${smolModel.id}:low`,
				slow: `${slowPlanModel.provider}/${slowPlanModel.id}:high`,
				plan: `${slowPlanModel.provider}/${slowPlanModel.id}:off`,
			},
		});

		const toSmol = await session.cycleRoleModels(["slow", "default", "smol"]);
		expect(toSmol?.role).toBe("smol");
		expect(toSmol?.thinkingLevel).toBe(Effort.Low);
		expect(session.thinkingLevel).toBe(Effort.Low);

		const toSlow = await session.cycleRoleModels(["slow", "default", "smol"]);
		expect(toSlow?.role).toBe("slow");
		expect(toSlow?.model.id).toBe(slowPlanModel.id);
		expect(toSlow?.thinkingLevel).toBe(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("preserves explicit role thinking when updating default model despite unresolved previous model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: "anthropic/nonexistent-model:off",
			},
		});

		await session.setModel(slowModel, "default", { persist: true });

		expect(sessionSettings.getModelRole("default")).toBe(`${slowModel.provider}/${slowModel.id}:off`);
	});

	it("clamps unsupported selections from model metadata", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-non-xhigh.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-non-xhigh.yml"));

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		session.setThinkingLevel(Effort.XHigh);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(session.getAvailableThinkingLevels()).not.toContain("xhigh");
	});

	it("cycles through off and auto before returning to effort levels", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-cycle-thinking.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-cycle-thinking.yml"));

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		expect(session.cycleThinkingLevel()).toBe("off");
		expect(session.thinkingLevel).toBe("off");
		expect(session.cycleThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(resolveProvisionalAutoLevel(model));
		expect(session.cycleThinkingLevel()).toBe(Effort.Minimal);
		expect(session.thinkingLevel).toBe(Effort.Minimal);
	});

	it("keeps auto configured while applying the classifier result as the effective level", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		session.setThinkingLevel(AUTO_THINKING);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();

		await session.prompt("Implement a focused parser fix");

		expect(classifierSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(Effort.Medium);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Medium);
		expect(session.agent.state.thinkingLevel).toBe(Effort.Medium);
	});

	it("restores the last resolved auto effort instead of pending auto on resume", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: resolveProvisionalAutoLevel(model),
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-auto-resume.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-auto-resume.yml"));
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionSettings = Settings.isolated();
		sessionSettings.set("defaultThinkingLevel", AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);

		await session.prompt("Implement a focused parser fix");

		expect(session.isAutoThinking).toBe(true);
		expect(session.sessionManager.buildSessionContext().thinkingLevel).toBe(Effort.Medium);
		session.sessionManager.appendMessage(createAssistantMessage("done"));

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();

		expect(await session.switchSession(sessionFile!)).toBe(true);
		expect(session.isAutoThinking).toBe(false);
		expect(session.configuredThinkingLevel()).toBe(Effort.Medium);
		expect(session.thinkingLevel).toBe(Effort.Medium);
		expect(session.agent.state.thinkingLevel).toBe(Effort.Medium);
	});

	it("falls back to a concrete auto level when classification fails", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockRejectedValue(new Error("classifier down"));

		session.setThinkingLevel(AUTO_THINKING);
		const fallback = resolveProvisionalAutoLevel(model);
		await session.prompt("Investigate a regression");

		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(fallback);
		expect(session.autoResolvedThinkingLevel()).toBe(fallback);
		expect(session.agent.state.thinkingLevel).toBe(fallback);
	});

	it("skips classification for synthetic turns", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.XHigh);

		session.setThinkingLevel(AUTO_THINKING);
		const provisional = resolveProvisionalAutoLevel(model);
		await session.prompt("Synthetic maintenance turn", { synthetic: true });

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(session.thinkingLevel).toBe(provisional);
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});

	it("maps ultrathink prompts directly to the highest auto-supported level", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-5");
		await createSession({
			initialModelId: model.id,
			initialThinkingLevel: Effort.High,
			modelRoles: { default: `${model.provider}/${model.id}` },
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);

		session.setThinkingLevel(AUTO_THINKING);
		const expected = clampAutoThinkingEffort(model, Effort.XHigh);
		await session.prompt("ultrathink through the unsafe refactor");

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.thinkingLevel).toBe(expected);
		expect(session.autoResolvedThinkingLevel()).toBe(expected);
	});

	it("keeps auto effectively off for non-reasoning models", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled gpt-4o-mini model");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-non-reasoning-auto.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-non-reasoning-auto.yml"));
		sessionSettings = Settings.isolated();
		sessionSettings.set("defaultThinkingLevel", AUTO_THINKING);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
			thinkingLevel: AUTO_THINKING,
		});
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.XHigh);

		expect(session.isAutoThinking).toBe(true);
		expect(session.thinkingLevel).toBeUndefined();
		expect(session.agent.state.thinkingLevel).toBeUndefined();

		await session.prompt("Implement a tiny change");

		expect(classifierSpy).not.toHaveBeenCalled();
		expect(session.thinkingLevel).toBeUndefined();
		expect(session.agent.state.thinkingLevel).toBeUndefined();
		expect(session.autoResolvedThinkingLevel()).toBeUndefined();
	});
});

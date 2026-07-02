import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession advisor toggle", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let replacementModel: Model;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-advisor-toggle-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		const replacement = getBundledModel("openai", "gpt-4o-mini");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		if (!replacement) throw new Error("Expected built-in OpenAI model to exist");
		model = bundled;
		replacementModel = replacement;
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-advisor-toggle-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
		});
	});

	afterEach(async () => {
		await session.dispose();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("starts with advisor disabled", () => {
		expect(session.isAdvisorActive()).toBe(false);
		expect(session.isAdvisorEnabled()).toBe(false);
		expect(session.formatAdvisorStatus()).toBe("Advisor is disabled.");
	});

	it("toggle enables the advisor and runtime", () => {
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const active = session.toggleAdvisorEnabled();
		expect(active).toBe(true);
		expect(session.isAdvisorActive()).toBe(true);
		expect(session.isAdvisorEnabled()).toBe(true);
		expect(session.formatAdvisorStatus()).toContain("Advisor is enabled (anthropic/claude-sonnet-4-5)");
	});

	it("explicit enable rebuilds the runtime when the advisor role changes", () => {
		session.settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);
		expect(session.getAdvisorAgent()?.state.model.provider).toBe(model.provider);
		expect(session.getAdvisorAgent()?.state.model.id).toBe(model.id);

		session.settings.setModelRole("advisor", `${replacementModel.provider}/${replacementModel.id}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);

		expect(session.getAdvisorAgent()?.state.model.provider).toBe(replacementModel.provider);
		expect(session.getAdvisorAgent()?.state.model.id).toBe(replacementModel.id);
	});

	it("explicit enable overrides default-off setting for the session only", () => {
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		session.settings.override("advisor.enabled", false);
		const customSession = new AgentSession({
			agent: session.agent,
			sessionManager,
			settings: session.settings,
			modelRegistry,
			advisorTools: [],
		});
		expect(customSession.isAdvisorEnabled()).toBe(false);

		const active = customSession.setAdvisorEnabled(true);

		expect(active).toBe(true);
		expect(customSession.isAdvisorActive()).toBe(true);
		expect(customSession.isAdvisorEnabled()).toBe(true);
		expect(customSession.settings.get("advisor.enabled")).toBe(false);
	});

	it("toggle disables the advisor and runtime", () => {
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		session.toggleAdvisorEnabled();
		const active = session.toggleAdvisorEnabled();
		expect(active).toBe(false);
		expect(session.isAdvisorActive()).toBe(false);
		expect(session.isAdvisorEnabled()).toBe(false);
	});

	it("setAdvisorEnabled reports inactive when the advisor role resolves to no model", () => {
		// The advisor role falls back to the `slow` priority chain when unset, so an
		// unset role still resolves a model. The inactive-but-enabled path is only
		// reached when the configured advisor model cannot be resolved at all.
		session.settings.setModelRole("advisor", "nonexistent/advisor-model");
		const active = session.setAdvisorEnabled(true);
		expect(active).toBe(false);
		expect(session.isAdvisorActive()).toBe(false);
		expect(session.isAdvisorEnabled()).toBe(true);
		expect(session.formatAdvisorStatus()).toBe(
			"Advisor setting is enabled, but no model is assigned to the 'advisor' role.",
		);
	});

	it("keeps sessions isolated when sharing a Settings instance", async () => {
		const sharedSettings = Settings.isolated({ "compaction.enabled": false });
		sharedSettings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(sharedSettings.get("advisor.enabled")).toBe(false);

		const sessionA = new AgentSession({
			agent: session.agent,
			sessionManager,
			settings: sharedSettings,
			modelRegistry,
			advisorTools: [],
		});
		const sessionB = new AgentSession({
			agent: session.agent,
			sessionManager,
			settings: sharedSettings,
			modelRegistry,
			advisorTools: [],
		});

		expect(sessionA.isAdvisorEnabled()).toBe(false);
		expect(sessionB.isAdvisorEnabled()).toBe(false);

		const activeA = sessionA.setAdvisorEnabled(true);
		expect(activeA).toBe(true);
		expect(sessionA.isAdvisorEnabled()).toBe(true);
		expect(sessionA.isAdvisorActive()).toBe(true);

		expect(sessionB.isAdvisorEnabled()).toBe(false);
		expect(sessionB.isAdvisorActive()).toBe(false);
		expect(sessionB.formatAdvisorStatus()).toBe("Advisor is disabled.");

		const activeB = sessionB.toggleAdvisorEnabled();
		expect(activeB).toBe(true);
		expect(sessionB.isAdvisorEnabled()).toBe(true);

		sessionA.setAdvisorEnabled(false);
		expect(sessionA.isAdvisorEnabled()).toBe(false);
		expect(sessionA.isAdvisorActive()).toBe(false);

		expect(sessionB.isAdvisorEnabled()).toBe(true);
		expect(sessionB.isAdvisorActive()).toBe(true);
	});
});

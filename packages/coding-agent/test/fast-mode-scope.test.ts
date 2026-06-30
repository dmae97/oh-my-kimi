import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("/fast targets the current model's service-tier family", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-fast-mode-scope-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	async function createSession(provider: "anthropic" | "openai", modelId: string): Promise<AgentSession> {
		const model = getBundledModel(provider, modelId);
		if (!model) {
			throw new Error(`Expected bundled test model ${provider}/${modelId} to exist`);
		}
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(model.provider, "token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
		session.subscribe(() => {});
		return session;
	}

	it("enables priority on the Anthropic family for a Claude model", async () => {
		const session = await createSession("anthropic", "claude-sonnet-4-5");
		session.setFastMode(true);
		expect(session.serviceTierByFamily).toEqual({ anthropic: "priority" });
		expect(session.isFastModeEnabled()).toBe(true);
	});

	it("enables priority on the OpenAI family for an OpenAI model", async () => {
		const session = await createSession("openai", "gpt-5.2");
		session.setFastMode(true);
		expect(session.serviceTierByFamily).toEqual({ openai: "priority" });
		expect(session.isFastModeEnabled()).toBe(true);
	});

	it("clears only the current model's family when disabled", async () => {
		const session = await createSession("anthropic", "claude-sonnet-4-5");
		session.setFastMode(true);
		session.setFastMode(false);
		expect(session.serviceTierByFamily).toEqual({});
		expect(session.isFastModeEnabled()).toBe(false);
	});

	it("toggle reports the resulting state", async () => {
		const session = await createSession("anthropic", "claude-sonnet-4-5");
		expect(session.toggleFastMode()).toBe(true);
		expect(session.serviceTierByFamily.anthropic).toBe("priority");
		expect(session.toggleFastMode()).toBe(false);
		expect(session.serviceTierByFamily.anthropic).toBeUndefined();
	});
});

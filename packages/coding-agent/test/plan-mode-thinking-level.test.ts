/**
 * Tests for plan mode thinking level propagation.
 *
 * Bug: When entering plan mode, the thinking level configured on the plan role
 * (e.g., "anthropic/claude-sonnet-4-5:xhigh") is discarded. resolveRoleModel()
 * calls resolveModelRoleValue() but only returns .model, dropping the thinking level.
 * #applyPlanModeModel() therefore has no thinking level to apply.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("plan mode thinking level", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-plan-thinking-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage.close();
		tempDir.removeSync();
	});

	function createSessionWithRoles(modelRoles: Record<string, string>): AgentSession {
		const sonnet = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!sonnet) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		session = new AgentSession({
			agent: new Agent({
				initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ modelRoles }),
			modelRegistry,
		});
		return session;
	}

	describe("resolveRoleModelWithThinking", () => {
		it("returns thinking level when plan role includes a thinking suffix", () => {
			createSessionWithRoles({ plan: "anthropic/claude-sonnet-4-5:xhigh" });

			const result = session.resolveRoleModelWithThinking("plan");

			expect(result.model).toBeDefined();
			expect(result.model!.provider).toBe("anthropic");
			expect(result.model!.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBe(ThinkingLevel.XHigh);
			expect(result.explicitThinkingLevel).toBe(true);
		});

		it("returns no explicit thinking level when plan role has no thinking suffix", () => {
			createSessionWithRoles({ plan: "anthropic/claude-sonnet-4-5" });

			const result = session.resolveRoleModelWithThinking("plan");

			expect(result.model).toBeDefined();
			expect(result.model!.id).toBe("claude-sonnet-4-5");
			expect(result.explicitThinkingLevel).toBe(false);
		});

		it("returns no model when no plan role is configured", () => {
			createSessionWithRoles({});

			const result = session.resolveRoleModelWithThinking("plan");

			expect(result.model).toBeUndefined();
		});

		it("returns thinking level for different levels", () => {
			createSessionWithRoles({ plan: "anthropic/claude-sonnet-4-5:high" });

			const result = session.resolveRoleModelWithThinking("plan");
			expect(result.thinkingLevel).toBe(ThinkingLevel.High);
			expect(result.explicitThinkingLevel).toBe(true);
		});

		it("works with the default role", () => {
			createSessionWithRoles({ default: "anthropic/claude-sonnet-4-5:medium" });

			const result = session.resolveRoleModelWithThinking("default");
			expect(result.model!.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBe(ThinkingLevel.Medium);
			expect(result.explicitThinkingLevel).toBe(true);
		});

		it("resolveRoleModel still returns just the model (backward compat)", () => {
			createSessionWithRoles({ plan: "anthropic/claude-sonnet-4-5:xhigh" });

			const model = session.resolveRoleModel("plan");
			expect(model).toBeDefined();
			expect(model!.provider).toBe("anthropic");
			expect(model!.id).toBe("claude-sonnet-4-5");
		});
	});
});

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "omk-agent-core";
import { getModel } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

/**
 * `agent_end` fires once per agent-loop attempt, so an extension cannot tell a
 * retry boundary from the end of the work. `agent_settled` fires once, only
 * when no retry follows, which is what activity/queue lifecycles need to
 * release state exactly once.
 */

describe("agent_settled extension event", () => {
	let session: AgentSession;
	let tempDir: string;
	let emitted: string[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `omk-agent-settled-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		const model = getModel("anthropic", "claude-sonnet-4-5");
		const agent = new Agent({ initialState: { model: model!, systemPrompt: "Test", tools: [] } });
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, tempDir),
			resourceLoader: createTestResourceLoader(),
			sessionManager: SessionManager.inMemory(),
			settingsManager,
		});

		emitted = [];
		// Spy the real runner's emit so dispose() keeps its other methods.
		const runner = (session as unknown as { _extensionRunner: { emit: (event: { type: string }) => Promise<void> } })
			._extensionRunner;
		vi.spyOn(runner, "emit").mockImplementation(async (event: { type: string }) => {
			emitted.push(event.type);
		});
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function setWillRetry(willRetry: boolean): void {
		vi.spyOn(
			session as unknown as { _willRetryAfterAgentEnd: () => boolean },
			"_willRetryAfterAgentEnd",
		).mockReturnValue(willRetry);
	}

	async function fireAgentEnd(): Promise<void> {
		await (session as unknown as { _emitExtensionEvent: (event: unknown) => Promise<void> })._emitExtensionEvent({
			messages: [],
			type: "agent_end",
		});
	}

	it("emits agent_settled after agent_end when no retry follows", async () => {
		setWillRetry(false);
		await fireAgentEnd();
		expect(emitted).toEqual(["agent_end", "agent_settled"]);
	});

	it("does not emit agent_settled while a retry is still pending", async () => {
		setWillRetry(true);
		await fireAgentEnd();
		expect(emitted).toEqual(["agent_end"]);
	});

	it("emits agent_settled exactly once across a retry sequence", async () => {
		setWillRetry(true);
		await fireAgentEnd();
		await fireAgentEnd();
		setWillRetry(false);
		await fireAgentEnd();

		expect(emitted).toEqual(["agent_end", "agent_end", "agent_end", "agent_settled"]);
		expect(emitted.filter((type) => type === "agent_settled")).toHaveLength(1);
	});

	it("orders agent_settled strictly after its agent_end", async () => {
		setWillRetry(false);
		await fireAgentEnd();
		expect(emitted.indexOf("agent_settled")).toBeGreaterThan(emitted.indexOf("agent_end"));
	});

	it("does not emit agent_settled for unrelated events", async () => {
		setWillRetry(false);
		await (session as unknown as { _emitExtensionEvent: (event: unknown) => Promise<void> })._emitExtensionEvent({
			type: "agent_start",
		});
		expect(emitted).toEqual(["agent_start"]);
	});
});

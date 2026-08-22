/**
 * Bash boundary resource gate integration (roadmap §25.4 M3): heavy commands
 * acquire shared permits in adaptive mode, critical pressure defers heavy
 * work with a §11.3 structured result while light commands stay allowed,
 * and observe mode leaves bash behavior untouched.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "omk-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import type { ResourceGovernorSettings } from "../src/core/resource-governor-settings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentSession bash resource permits", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `omk-resource-permit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createSession(resourceGovernor: ResourceGovernorSettings): AgentSession {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("mock model unavailable");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});
		agent.maxToolConcurrency = 4;
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory({ resourceGovernor }),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, tempDir),
			resourceLoader: createTestResourceLoader(),
		});
		return session;
	}

	function fakeOperations(onExec?: () => void): BashOperations {
		return {
			exec: async (_command, _cwd, options) => {
				onExec?.();
				options.onData(Buffer.from("fake-exec\n"));
				return { exitCode: 0 };
			},
		};
	}

	it("acquires and releases a shared permit for heavy bash in adaptive mode", async () => {
		const s = createSession({ mode: "adaptive", cpuSampleMs: 150 });
		await s.prompt("hello"); // governed preflight records the admission decision

		let activeWeightDuringExec = -1;
		const result = await s.executeBash("vitest", undefined, {
			operations: fakeOperations(() => {
				activeWeightDuringExec = s.getWorkloadPermitSnapshot()?.activeWeight ?? -1;
			}),
		});
		expect(result.exitCode).toBe(0);
		expect(activeWeightDuringExec).toBe(1);
		expect(s.getWorkloadPermitSnapshot()).toMatchObject({ activeWeight: 0, queuedCount: 0 });
	});

	it("leaves light commands ungated (no pool is even created)", async () => {
		const s = createSession({ mode: "adaptive", cpuSampleMs: 150 });
		await s.prompt("hello");
		const result = await s.executeBash("ls -la", undefined, { operations: fakeOperations() });
		expect(result.exitCode).toBe(0);
		expect(s.getWorkloadPermitSnapshot()).toBeNull();
	});

	it("defers heavy bash with a §11.3 structured result at critical pressure while light stays allowed", async () => {
		// Absurd-but-valid thresholds force critical on any real host (§18.1
		// keeps critical <= constrained): effective memory < 1 TiB.
		const s = createSession({
			mode: "adaptive",
			cpuSampleMs: 150,
			constrainedAvailableMemoryMiB: 1_048_576,
			criticalAvailableMemoryMiB: 1_048_576,
		});
		await s.prompt("hello");
		expect(s.getCurrentResourceAdmission()?.pressure).toBe("critical");

		let spawned = false;
		const blocked = await s.executeBash("npm test", undefined, {
			operations: fakeOperations(() => {
				spawned = true;
			}),
		});
		expect(spawned).toBe(false);
		expect(blocked.exitCode).not.toBe(0);
		expect(blocked.output).toContain("resource_pressure");
		expect(blocked.output).toContain("defer-heavy");
		expect(blocked.output).toContain("resource.memory.critical");

		const light = await s.executeBash("ls -la", undefined, { operations: fakeOperations() });
		expect(light.exitCode).toBe(0);
	});

	it("keeps observe mode bash behavior untouched (feature-off parity at the boundary)", async () => {
		const s = createSession({ mode: "observe" });
		await s.prompt("hello");
		const result = await s.executeBash("vitest", undefined, { operations: fakeOperations() });
		expect(result.exitCode).toBe(0);
		expect(s.getWorkloadPermitSnapshot()).toBeNull();
	});

	it("exposes one shared pool instance for future child wiring (§14.1)", async () => {
		const s = createSession({ mode: "adaptive" });
		const pool = s.workloadPermitPool;
		expect(s.workloadPermitPool).toBe(pool);
		expect(pool.snapshot().activeWeight).toBe(0);
	});
});

/**
 * AgentSession resource governor integration (roadmap §25.3 M2 exit criteria):
 * adaptive mode applies the admission tool cap for the run and restores it,
 * never raises a configured cap, keeps `off` identical to baseline, records
 * observe-mode decisions without cap changes, and restores the cap on abort.
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
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
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

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("waitFor timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("AgentSession resource governor lease", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `omk-resource-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		session?.dispose();
		session = undefined;
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createSession(input: {
		readonly resourceGovernor?: ResourceGovernorSettings;
		readonly baselineCap?: number;
		readonly abortable?: boolean;
	}): { session: AgentSession; agent: Agent; capsDuringRun: (number | undefined)[] } {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("mock model unavailable");
		const capsDuringRun: (number | undefined)[] = [];
		let agentRef: Agent | undefined;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (_model, _context, options) => {
				capsDuringRun.push(agentRef?.maxToolConcurrency);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (input.abortable) {
						const checkAbort = () => {
							if (options?.signal?.aborted) {
								stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
							} else {
								setTimeout(checkAbort, 5);
							}
						};
						checkAbort();
					} else {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
					}
				});
				return stream;
			},
		});
		agentRef = agent;
		agent.maxToolConcurrency = input.baselineCap ?? 4;

		const settings: Partial<Settings> = input.resourceGovernor ? { resourceGovernor: input.resourceGovernor } : {};
		const settingsManager = SettingsManager.inMemory(settings);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		return { session, agent, capsDuringRun };
	}

	it("adaptive mode applies the admission cap during the run and restores the baseline after (M2)", async () => {
		const {
			session: s,
			agent,
			capsDuringRun,
		} = createSession({
			resourceGovernor: { mode: "adaptive", cpuSampleMs: 150 },
			baselineCap: 4,
		});
		const settledEvents: Array<{ promptRunId: string; outcome: string }> = [];
		s.subscribe((event) => {
			if (event.type === "prompt_settled") {
				settledEvents.push({ promptRunId: event.promptRunId, outcome: event.outcome });
			}
		});
		await s.prompt("hello");

		// §16.4 (M4): the run settles exactly once with a completed outcome.
		expect(settledEvents).toHaveLength(1);
		expect(settledEvents[0]?.outcome).toBe("completed");
		expect(settledEvents[0]?.promptRunId).toMatch(/^prompt-run-/);

		expect(capsDuringRun.length).toBeGreaterThan(0);
		const capDuringRun = capsDuringRun[0];
		expect(capDuringRun).toBeGreaterThanOrEqual(1);
		expect(capDuringRun).toBeLessThanOrEqual(4);

		const decision = s.getCurrentResourceAdmission();
		expect(decision).not.toBeNull();
		expect(capDuringRun).toBe(decision?.maxToolConcurrency);

		// After the run the configured baseline is restored exactly.
		expect(agent.maxToolConcurrency).toBe(4);
	});

	it("adaptive mode never raises a configured cap of 1 (M2 exit criterion)", async () => {
		const {
			session: s,
			agent,
			capsDuringRun,
		} = createSession({
			resourceGovernor: { mode: "adaptive", cpuSampleMs: 150 },
			baselineCap: 1,
		});
		await s.prompt("hello");
		expect(capsDuringRun[0]).toBe(1);
		expect(agent.maxToolConcurrency).toBe(1);
	});

	it("off mode leaves the cap untouched and records nothing (feature-off baseline)", async () => {
		const {
			session: s,
			agent,
			capsDuringRun,
		} = createSession({
			resourceGovernor: { mode: "off" },
			baselineCap: 4,
		});
		await s.prompt("hello");
		expect(capsDuringRun[0]).toBe(4);
		expect(agent.maxToolConcurrency).toBe(4);
		expect(s.getCurrentResourceAdmission()).toBeNull();
	});

	it("OMK_RESOURCE_GOVERNOR=off overrides adaptive settings (§18.2 kill switch)", async () => {
		process.env.OMK_RESOURCE_GOVERNOR = "off";
		try {
			const {
				session: s,
				agent,
				capsDuringRun,
			} = createSession({
				resourceGovernor: { mode: "adaptive" },
				baselineCap: 4,
			});
			await s.prompt("hello");
			expect(capsDuringRun[0]).toBe(4);
			expect(agent.maxToolConcurrency).toBe(4);
			expect(s.getCurrentResourceAdmission()).toBeNull();
		} finally {
			delete process.env.OMK_RESOURCE_GOVERNOR;
		}
	});

	it("observe mode (default settings) records a decision without changing the cap (§7.4)", async () => {
		const { session: s, agent, capsDuringRun } = createSession({ baselineCap: 4 });
		await s.prompt("hello");
		// Cap is untouched during and after the run.
		expect(capsDuringRun[0]).toBe(4);
		expect(agent.maxToolConcurrency).toBe(4);
		// The fire-and-forget probe records a decision shortly after.
		await waitFor(() => s.getCurrentResourceAdmission() !== null);
		const decision = s.getCurrentResourceAdmission();
		expect(decision?.schemaVersion).toBe(1);
		expect(["normal", "constrained", "critical"]).toContain(decision?.pressure ?? "");
	});

	it("restores the baseline cap when the run is aborted (M2 abort criterion)", async () => {
		const { session: s, agent } = createSession({
			resourceGovernor: { mode: "adaptive", cpuSampleMs: 150 },
			baselineCap: 4,
			abortable: true,
		});
		const promptPromise = s.prompt("hello");
		await waitFor(() => s.isStreaming);
		await s.abort();
		await promptPromise.catch(() => {});
		expect(agent.maxToolConcurrency).toBe(4);
	});

	it("exposes the §19.4 read-only snapshot API", async () => {
		const { session: s } = createSession({ resourceGovernor: { mode: "observe" } });
		const snapshot = await s.getHostResourceSnapshot();
		expect(snapshot.schemaVersion).toBe(1);
		expect(snapshot.logicalCpuCount).toBeGreaterThanOrEqual(1);
	});
});

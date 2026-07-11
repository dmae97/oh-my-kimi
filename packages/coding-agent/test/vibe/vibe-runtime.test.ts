/**
 * Contracts: vibe worker-session registry lifecycle.
 *
 * 1. `spawn` returns immediately (session id + turn job id) while the turn
 *    runs in the background; the settled turn self-delivers a result carrying
 *    the activity trace AND the worker's response, and the session stays
 *    addressable (idle) afterwards.
 * 2. `send` routes by state: steering into a streaming mid-turn worker,
 *    queueing when the worker is mid-turn but not steerable (drained into the
 *    next turn automatically), and starting a follow-up turn on the SAME
 *    worker id when idle.
 * 3. `runSubagentFollowUpTurn` continues a live session in place: consecutive
 *    turns hit the same AgentSession instance (context retained) and the
 *    finalized result carries the yield payload + tool trace.
 * 4. `wait` wakes on the FIRST settling turn among concurrent sessions and
 *    acknowledges its delivery so the result is not delivered twice.
 * 5. `kill` cancels the in-flight turn job and releases the worker session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentProgress, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

function createSession(options: { manager?: AsyncJobManager } = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "prompt",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

async function pollUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
		await Bun.sleep(5);
	}
}

/**
 * Minimal stand-in for a worker AgentSession: records prompts/steers, replays
 * a scripted event stream through subscribed listeners on each prompt, and
 * reports a final assistant message — enough surface for the executor's run
 * monitor + driveSessionToYield.
 */
function createFakeWorkerSession(options: { streaming?: boolean } = {}) {
	const listeners = new Set<(event: unknown) => void>();
	const prompts: string[] = [];
	const steers: string[] = [];
	let disposed = false;
	let lastAssistant: { stopReason: string; content: Array<{ type: string; text: string }> } | undefined;
	let script: { events: unknown[]; responseText: string } | undefined;
	const fake = {
		isStreaming: options.streaming ?? false,
		model: undefined,
		subscribe(listener: (event: unknown) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt(text: string): Promise<boolean> {
			prompts.push(text);
			const active = script;
			script = undefined;
			if (active) {
				for (const event of active.events) {
					for (const listener of [...listeners]) listener(event);
				}
				lastAssistant = { stopReason: "stop", content: [{ type: "text", text: active.responseText }] };
				const end = { type: "message_end", message: { role: "assistant", content: lastAssistant.content } };
				for (const listener of [...listeners]) listener(end);
			}
			return true;
		},
		async steer(text: string): Promise<void> {
			steers.push(text);
		},
		async waitForIdle(): Promise<void> {},
		getLastAssistantMessage() {
			return lastAssistant;
		},
		async abort(): Promise<void> {},
		async dispose(): Promise<void> {
			disposed = true;
		},
	};
	return {
		session: fake as unknown as AgentSession,
		prompts,
		steers,
		isDisposed: () => disposed,
		setStreaming(value: boolean) {
			fake.isStreaming = value;
		},
		setScript(next: { events: unknown[]; responseText: string }) {
			script = next;
		},
	};
}

/** Scripted turn: one `read` tool call, then a successful `yield` carrying `data`. */
function yieldTurnEvents(data: unknown): unknown[] {
	return [
		{ type: "tool_execution_start", toolName: "read", args: { path: "src/foo.ts" }, intent: "Reading foo" },
		{ type: "tool_execution_end", toolName: "read", result: {}, isError: false },
		{ type: "tool_execution_start", toolName: "yield", args: {} },
		{
			type: "tool_execution_end",
			toolName: "yield",
			result: { details: { status: "success", data } },
			isError: false,
		},
	];
}

/** Progress snapshot in the shape the executor's run monitor emits. */
function progressSnapshot(id: string, overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "prompt",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

describe("vibe session registry", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		VibeSessionRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("spawn returns immediately and self-delivers a turn result with activity trace + response", async () => {
		const gate = deferred();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: createFakeWorkerSession().session,
				status: "running",
			});
			options.onProgress?.(
				progressSnapshot(options.id, {
					toolCount: 2,
					recentTools: [
						{ tool: "bash", args: "bun test", endMs: 2 },
						{ tool: "read", args: "src/foo.ts", endMs: 1 },
					],
					lastIntent: "Running tests",
					resolvedModel: "prov/fast-model",
				}),
			);
			await gate.promise;
			AgentRegistry.global().setStatus(options.id, "idle");
			return makeResult(options.id, { output: "Implemented the widget.", requests: 3 });
		});

		const manager = createManager();
		const session = createSession({ manager });
		const registry = VibeSessionRegistry.global();

		const { id, jobId } = await registry.spawn(session, { cli: "fast", name: "Fast", prompt: "Build the widget." });
		expect(id).toBe("Fast");

		// Ack is immediate: the job is still running behind the gate.
		const job = manager.getJob(jobId)!;
		expect(job.status).toBe("running");
		expect(registry.screens("Main")[0]?.cli).toBe("fast");

		gate.resolve();
		await job.promise;

		expect(job.status).toBe("completed");
		const text = job.resultText ?? "";
		// Envelope + summarized activity (compressed tool trace, oldest first) + response.
		expect(text).toContain('<vibe-turn session="Fast" cli="fast" turn="1" status="completed"');
		expect(text).toContain('model="prov/fast-model"');
		expect(text.indexOf("read(src/foo.ts)")).toBeGreaterThan(-1);
		expect(text.indexOf("read(src/foo.ts)")).toBeLessThan(text.indexOf("bash(bun test)"));
		expect(text).toContain("Implemented the widget.");
		// Session survives the turn, addressable for follow-ups.
		const entry = registry.screens("Main")[0]!;
		expect(entry.state).toBe("idle");
		expect(entry.turns).toBe(1);
	});

	it("send steers a streaming mid-turn worker and queues for a non-steerable one", async () => {
		const gate = deferred();
		const fake = createFakeWorkerSession({ streaming: true });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: fake.session,
				status: "running",
			});
			await gate.promise;
			AgentRegistry.global().setStatus(options.id, "idle");
			return makeResult(options.id);
		});
		const followUps: Array<{ id: string; message: string }> = [];
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => {
			followUps.push({ id: options.id, message: options.message });
			return makeResult(options.id, { output: "queued work done" });
		});

		const manager = createManager();
		const session = createSession({ manager });
		const registry = VibeSessionRegistry.global();
		const { jobId } = await registry.spawn(session, { cli: "good", name: "Good", prompt: "Design it." });
		await pollUntil(() => AgentRegistry.global().get("Good") !== undefined);

		// Streaming worker → steering.
		const steered = await registry.send(session, { session: "Good", message: "Focus on the API first." });
		expect(steered.mode).toBe("steered");
		expect(fake.steers).toEqual(["Focus on the API first."]);

		// Not streaming → queued for the next turn.
		fake.setStreaming(false);
		const queued = await registry.send(session, { session: "Good", message: "Then write tests." });
		expect(queued.mode).toBe("queued");
		expect(registry.screens("Main")[0]?.queued).toBe(1);

		// Settling the turn drains the queue into an automatic follow-up turn.
		gate.resolve();
		await manager.getJob(jobId)!.promise;
		await pollUntil(() => followUps.length === 1);
		expect(followUps[0]).toEqual({ id: "Good", message: "Then write tests." });
	});

	it("send to an idle session starts a follow-up turn on the same worker", async () => {
		const gate = deferred();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: createFakeWorkerSession().session,
				status: "running",
			});
			await gate.promise;
			AgentRegistry.global().setStatus(options.id, "idle");
			return makeResult(options.id);
		});
		const followUps: Array<{ id: string; message: string }> = [];
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => {
			followUps.push({ id: options.id, message: options.message });
			options.onProgress?.(
				progressSnapshot(options.id, {
					toolCount: 1,
					recentTools: [{ tool: "edit", args: "src/foo.ts", endMs: 1 }],
				}),
			);
			return makeResult(options.id, { output: "Renamed everything." });
		});

		const manager = createManager();
		const session = createSession({ manager });
		const registry = VibeSessionRegistry.global();
		const spawn = await registry.spawn(session, { cli: "fast", name: "Fast", prompt: "First task." });
		gate.resolve();
		await manager.getJob(spawn.jobId)!.promise;

		const outcome = await registry.send(session, { session: "Fast", message: "Now rename the helpers." });
		expect(outcome.mode).toBe("turn");
		const turnJob = manager.getJob(outcome.jobId!)!;
		await turnJob.promise;

		expect(followUps).toEqual([{ id: "Fast", message: "Now rename the helpers." }]);
		const text = turnJob.resultText ?? "";
		expect(text).toContain('turn="2"');
		expect(text).toContain("edit(src/foo.ts)");
		expect(text).toContain("Renamed everything.");
		expect(registry.screens("Main")[0]?.turns).toBe(2);
	});

	it("runSubagentFollowUpTurn continues the same live session and finalizes trace + yield response", async () => {
		const fake = createFakeWorkerSession();
		AgentRegistry.global().register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			session: fake.session,
			status: "idle",
		});
		const agent = { name: "task", description: "worker", systemPrompt: "sp", source: "bundled" as const };

		fake.setScript({ events: yieldTurnEvents({ report: "did the first thing" }), responseText: "first summary" });
		const progressSnapshots: AgentProgress[] = [];
		const first = await executorModule.runSubagentFollowUpTurn({
			id: "Worker",
			agent,
			message: "do the first thing",
			onProgress: progress => progressSnapshots.push({ ...progress, recentTools: progress.recentTools.slice() }),
		});
		expect(first.exitCode).toBe(0);
		expect(first.output).toContain("did the first thing");
		expect(progressSnapshots.some(progress => progress.recentTools.some(entry => entry.tool === "read"))).toBe(true);

		// Second turn lands on the SAME session instance — prior context retained.
		fake.setScript({ events: yieldTurnEvents({ report: "built on prior work" }), responseText: "second summary" });
		const second = await executorModule.runSubagentFollowUpTurn({ id: "Worker", agent, message: "now extend it" });
		expect(second.exitCode).toBe(0);
		expect(second.output).toContain("built on prior work");
		expect(fake.prompts).toEqual(["do the first thing", "now extend it"]);
		expect(fake.isDisposed()).toBe(false);
	});

	it("wait wakes on the first settling turn among concurrent sessions and suppresses its re-delivery", async () => {
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: createFakeWorkerSession().session,
				status: "running",
			});
			const gate = deferred();
			gates.set(options.id, gate);
			await gate.promise;
			AgentRegistry.global().setStatus(options.id, "idle");
			return makeResult(options.id, { output: `${options.id} finished.` });
		});

		const manager = createManager();
		const session = createSession({ manager });
		const registry = VibeSessionRegistry.global();
		const fast = await registry.spawn(session, { cli: "fast", name: "Fast", prompt: "Task A." });
		const good = await registry.spawn(session, { cli: "good", name: "Good", prompt: "Task B." });
		await pollUntil(() => gates.size === 2);

		const waitPromise = registry.wait(session, { sessions: ["Fast", "Good"], timeoutMs: 5000 });
		gates.get("Fast")!.resolve();
		const outcome = await waitPromise;

		expect(outcome.timedOut).toBe(false);
		expect(outcome.settled.map(entry => entry.id)).toEqual(["Fast"]);
		expect(outcome.settled[0]!.resultText).toContain("Fast finished.");
		expect(outcome.stillRunning).toEqual(["Good"]);
		// The reported result must not be delivered a second time as a follow-up.
		expect(manager.isDeliverySuppressed(fast.jobId)).toBe(true);
		expect(manager.isDeliverySuppressed(good.jobId)).toBe(false);

		gates.get("Good")!.resolve();
		await manager.getJob(good.jobId)!.promise;
	});

	it("wait reports the settled turn even when a queued follow-up starts immediately", async () => {
		const firstGate = deferred();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: createFakeWorkerSession().session,
				status: "running",
			});
			await firstGate.promise;
			AgentRegistry.global().setStatus(options.id, "idle");
			return makeResult(options.id, { output: "First turn done." });
		});
		const followUpGate = deferred();
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => {
			await followUpGate.promise;
			return makeResult(options.id, { output: "Follow-up done." });
		});

		const manager = createManager();
		const session = createSession({ manager });
		const registry = VibeSessionRegistry.global();
		const { jobId } = await registry.spawn(session, { cli: "fast", name: "Fast", prompt: "Task A." });
		await pollUntil(() => AgentRegistry.global().get("Fast") !== undefined);

		// Queued while mid-turn: #finishTurn starts this follow-up turn inside
		// the settling job's callback, BEFORE the watched job's promise resolves.
		const queued = await registry.send(session, { session: "Fast", message: "Task B." });
		expect(queued.mode).toBe("queued");

		const waitPromise = registry.wait(session, { sessions: ["Fast"], timeoutMs: 5000 });
		firstGate.resolve();
		const outcome = await waitPromise;

		// The settled first turn is reported (not shadowed by the new in-flight
		// turn) and acknowledged so it is not re-delivered …
		expect(outcome.settled.map(entry => entry.jobId)).toEqual([jobId]);
		expect(outcome.settled[0]!.resultText).toContain("First turn done.");
		expect(manager.isDeliverySuppressed(jobId)).toBe(true);
		// … while the drained-queue follow-up shows as still running.
		expect(outcome.stillRunning).toEqual(["Fast"]);

		followUpGate.resolve();
		await manager.getJob("Fast-t2")!.promise;
	});

	it("kill cancels the in-flight turn and releases the worker session", async () => {
		const gate = deferred();
		const fake = createFakeWorkerSession();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: fake.session,
				status: "running",
			});
			await gate.promise;
			return makeResult(options.id);
		});

		const manager = createManager();
		const session = createSession({ manager });
		const registry = VibeSessionRegistry.global();
		const { jobId } = await registry.spawn(session, { cli: "fast", name: "Doomed", prompt: "Never mind." });
		await pollUntil(() => AgentRegistry.global().get("Doomed") !== undefined);

		const outcome = await registry.kill(session, "Doomed");
		expect(outcome.cancelledTurn).toBe(true);
		expect(manager.getJob(jobId)!.status).toBe("cancelled");
		expect(fake.isDisposed()).toBe(true);
		expect(AgentRegistry.global().get("Doomed")).toBeUndefined();
		expect(registry.screens("Main")[0]?.state).toBe("dead");
		await expect(registry.send(session, { session: "Doomed", message: "hello?" })).rejects.toThrow("dead");

		gate.resolve();
	});

	it("killAll terminates every session for the owner (mode-exit path)", async () => {
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: createFakeWorkerSession().session,
				status: "running",
			});
			const gate = deferred();
			gates.set(options.id, gate);
			await gate.promise;
			return makeResult(options.id);
		});

		const manager = createManager();
		const session = createSession({ manager });
		const registry = VibeSessionRegistry.global();
		await registry.spawn(session, { cli: "fast", name: "One", prompt: "A." });
		await registry.spawn(session, { cli: "good", name: "Two", prompt: "B." });
		await pollUntil(() => gates.size === 2);

		const killed = await registry.killAll("Main", manager);
		expect(killed).toBe(2);
		expect(registry.listIds("Main")).toEqual([]);
		expect(AgentRegistry.global().get("One")).toBeUndefined();
		expect(AgentRegistry.global().get("Two")).toBeUndefined();

		for (const gate of gates.values()) gate.resolve();
	});
});

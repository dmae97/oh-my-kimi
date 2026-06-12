import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { PlanModeState } from "../../plan-mode/state";
import * as taskDiscovery from "../../task/discovery";
import type { ExecutorOptions } from "../../task/executor";
import * as taskExecutor from "../../task/executor";
import { AgentOutputManager } from "../../task/output-manager";
import type { AgentDefinition, AgentProgress, SingleResult } from "../../task/types";
import type { ToolSession } from "../../tools";
import { EVAL_AGENT_MAX_DEPTH, runEvalAgent } from "../agent-bridge";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../bridge-timeout";
import { IdleTimeout } from "../idle-timeout";
import { disposeAllVmContexts } from "../js/context-manager";
import { executeJs } from "../js/executor";
import { disposeAllKernelSessions, executePython } from "../py/executor";

const taskAgent = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Run the task.",
	source: "bundled",
	spawns: "*",
	model: ["pi/task"],
} satisfies AgentDefinition;

const reviewerAgent = {
	name: "reviewer",
	description: "Reviewer agent",
	systemPrompt: "Review the task.",
	source: "bundled",
	model: ["pi/smol"],
} satisfies AgentDefinition;

interface SessionOptions {
	cwd?: string;
	sessionFile?: string | null;
	artifactsDir?: string | null;
	spawns?: string | null;
	depth?: number;
	activeModel?: string;
	modelString?: string;
	enableLsp?: boolean;
	settings?: Settings;
	outputManager?: AgentOutputManager;
	planMode?: boolean;
}

function makeSession(options: SessionOptions = {}): ToolSession {
	const settings =
		options.settings ??
		Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
		});
	const artifactsDir = options.artifactsDir ?? null;
	return {
		cwd: options.cwd ?? process.cwd(),
		hasUI: false,
		settings,
		taskDepth: options.depth ?? 0,
		enableLsp: options.enableLsp ?? true,
		agentOutputManager: options.outputManager,
		getSessionFile: () => options.sessionFile ?? null,
		getSessionSpawns: () => options.spawns ?? "*",
		getActiveModelString: () => options.activeModel ?? "p/active",
		getModelString: () => options.modelString ?? "p/fallback",
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => "test-session",
		getEvalSessionId: () => "test-eval-session",
		getPlanModeState: options.planMode
			? () =>
					({
						enabled: true,
						planFilePath: path.join(options.cwd ?? process.cwd(), "plan.md"),
					}) satisfies PlanModeState
			: undefined,
	};
}

function mockAgents(agents: AgentDefinition[] = [taskAgent, reviewerAgent]): void {
	vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

function singleResult(options: ExecutorOptions, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

function makeEvalSession(
	tempDir: TempDir,
	prefix: string,
	settings?: Settings,
): { session: ToolSession; sessionFile: string; sessionId: string } {
	const sessionFile = path.join(tempDir.path(), "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	const session = makeSession({
		cwd: tempDir.path(),
		sessionFile,
		artifactsDir,
		settings,
		outputManager: new AgentOutputManager(() => artifactsDir),
	});
	return { session, sessionFile, sessionId: `${prefix}:${crypto.randomUUID()}` };
}

describe("runEvalAgent", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves the default task agent and agentType overrides", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options =>
			singleResult(options, {
				output: options.agent.name,
			}),
		);
		const session = makeSession();

		const defaultResult = await runEvalAgent({ prompt: "hello" }, { session });
		const overrideResult = await runEvalAgent({ prompt: "hello", agentType: "reviewer" }, { session });

		expect(defaultResult.text).toBe("task");
		expect(overrideResult.text).toBe("reviewer");
		expect(runSpy.mock.calls[0]?.[0].agent.name).toBe("task");
		expect(runSpy.mock.calls[1]?.[0].agent.name).toBe("reviewer");
	});

	it("throws for an unknown agent", async () => {
		mockAgents([taskAgent]);
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		await expect(runEvalAgent({ prompt: "hello", agentType: "missing" }, { session: makeSession() })).rejects.toThrow(
			'Unknown agent "missing"',
		);
	});

	it("enforces spawn restrictions and the eval recursion cap", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		await expect(runEvalAgent({ prompt: "hello" }, { session: makeSession({ spawns: "" }) })).rejects.toThrow(
			"spawns disabled",
		);
		await expect(runEvalAgent({ prompt: "hello" }, { session: makeSession({ spawns: "reviewer" }) })).rejects.toThrow(
			"Allowed: reviewer",
		);
		await expect(
			runEvalAgent({ prompt: "hello" }, { session: makeSession({ depth: EVAL_AGENT_MAX_DEPTH }) }),
		).rejects.toThrow("maximum depth");
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("throws instead of spawning from plan mode", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));

		await expect(runEvalAgent({ prompt: "hello" }, { session: makeSession({ planMode: true }) })).rejects.toThrow(
			"unavailable in plan mode",
		);
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("passes parent execution options and only sets outputSchema when schema is supplied", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));
		const abortController = new AbortController();
		const schema = { type: "object", properties: { ok: { type: "boolean" } } };
		const session = makeSession({ depth: 2, activeModel: "p/current", modelString: "p/fallback" });

		await runEvalAgent(
			{ prompt: " hello ", label: "My Agent", model: "p/override", schema },
			{ session, signal: abortController.signal },
		);
		await runEvalAgent({ prompt: "plain" }, { session });

		const firstOptions = runSpy.mock.calls[0]?.[0];
		const secondOptions = runSpy.mock.calls[1]?.[0];
		if (!firstOptions || !secondOptions) throw new Error("runSubprocess was not called");
		expect(firstOptions.taskDepth).toBe(2);
		expect(firstOptions.signal).toBe(abortController.signal);
		expect(firstOptions.parentActiveModelPattern).toBe("p/current");
		expect(firstOptions.outputSchema).toBe(schema);
		expect(firstOptions.assignment).toBe("hello");
		expect(firstOptions.description).toBe("My Agent");
		expect(firstOptions.modelOverride).toEqual(["p/override"]);
		expect(secondOptions.outputSchema).toBeUndefined();
	});

	it("forces LSP off for bridge subagents even when task.enableLsp is on", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => singleResult(options));
		// makeSession() defaults to enableLsp: true and task.enableLsp: true.
		const session = makeSession();

		await runEvalAgent({ prompt: "hello" }, { session });

		const options = runSpy.mock.calls[0]?.[0];
		if (!options) throw new Error("runSubprocess was not called");
		expect(options.enableLsp).toBe(false);
	});

	it("maps successful and failed subagent results", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess");
		runSpy.mockImplementationOnce(async options =>
			singleResult(options, {
				id: "0-EvalAgent",
				output: "done",
				resolvedModel: "p/model",
			}),
		);
		runSpy.mockImplementationOnce(async options =>
			singleResult(options, {
				exitCode: 1,
				output: "",
				stderr: "stderr",
				error: "boom",
			}),
		);

		const result = await runEvalAgent({ prompt: "hello" }, { session: makeSession() });
		expect(result).toEqual({
			text: "done",
			details: { agent: "task", id: "0-EvalAgent", model: "p/model", structured: false },
		});
		await expect(runEvalAgent({ prompt: "fail" }, { session: makeSession() })).rejects.toThrow("boom");
	});

	// Regression: a runtime-limit abort returns exitCode=1, stderr="", error=undefined,
	// aborted=true, abortReason="Subagent runtime limit exceeded (...)". The previous
	// failure-message coalesce stopped at the empty `stderr` (since `??` only skips
	// nullish values) and shipped an empty error through the bridge — Python then
	// surfaced the generic `bridge call '__agent__' failed`. See #2006.
	it("surfaces abortReason for aborts that leave stderr empty", async () => {
		mockAgents();
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess");
		runSpy.mockImplementationOnce(async options =>
			singleResult(options, {
				exitCode: 1,
				output: "",
				stderr: "",
				error: undefined,
				aborted: true,
				abortReason: "Subagent runtime limit exceeded (task.maxRuntimeMs=900000)",
			}),
		);
		runSpy.mockImplementationOnce(async options =>
			singleResult(options, {
				exitCode: 1,
				output: "",
				stderr: "   ",
				error: "   ",
				aborted: true,
				abortReason: "Cancelled by caller",
			}),
		);
		runSpy.mockImplementationOnce(async options =>
			singleResult(options, {
				exitCode: 1,
				output: "",
				stderr: "",
				error: undefined,
			}),
		);

		await expect(runEvalAgent({ prompt: "slow" }, { session: makeSession() })).rejects.toThrow(
			"Subagent runtime limit exceeded (task.maxRuntimeMs=900000)",
		);
		// Whitespace-only stderr/error must not mask abortReason either.
		await expect(runEvalAgent({ prompt: "cancelled" }, { session: makeSession() })).rejects.toThrow(
			"Cancelled by caller",
		);
		// Last resort: still produce a non-empty message even when nothing useful is set,
		// so Python never falls back to `bridge call '__agent__' failed`.
		await expect(runEvalAgent({ prompt: "blank" }, { session: makeSession() })).rejects.toThrow(
			"agent() subagent 'task' failed.",
		);
	});
});

describe("agent() through eval runtimes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await disposeAllVmContexts();
		await disposeAllKernelSessions();
	});

	it("exposes agent() in JavaScript and parses structured output", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-js-");
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "js-agent");
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options =>
			singleResult(options, {
				output: options.outputSchema ? '{"ok":true,"n":3}' : "hello from agent",
			}),
		);

		const result = await executeJs(
			'const text = await agent("hi"); const data = await agent("json", { schema: { type: "object" } }); return JSON.stringify([text, data]);',
			{ cwd: tempDir.path(), sessionId, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual(["hello from agent", { ok: true, n: 3 }]);
	});

	it("bounds JavaScript parallel() by the task.maxConcurrency setting while preserving order", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-js-parallel-");
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
			"task.maxConcurrency": 2,
		});
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "js-agent-parallel", settings);
		mockAgents();
		let inFlight = 0;
		let maxInFlight = 0;
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				await Bun.sleep(options.assignment === "a" ? 30 : 10);
				return singleResult(options, { output: options.assignment ?? "" });
			} finally {
				inFlight--;
			}
		});

		const result = await executeJs(
			'const values = await parallel(["a", "b", "c", "d"].map(name => () => agent(name))); return JSON.stringify(values);',
			{ cwd: tempDir.path(), sessionId, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual(["a", "b", "c", "d"]);
		expect(maxInFlight).toBeGreaterThan(1);
		expect(maxInFlight).toBeLessThanOrEqual(2);
	});

	it("propagates JavaScript parallel() rejections", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-js-reject-");
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "js-agent-reject");
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			if (options.assignment === "bad") {
				return singleResult(options, { exitCode: 1, output: "", stderr: "boom", error: "boom" });
			}
			return singleResult(options, { output: options.assignment ?? "" });
		});

		const result = await executeJs('await parallel([() => agent("ok"), () => agent("bad")]);', {
			cwd: tempDir.path(),
			sessionId,
			session,
			sessionFile,
		});

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("boom");
	});

	it("exposes agent() in the Python runtime", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-py-");
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "py-agent");
		mockAgents();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options =>
			singleResult(options, { output: "hello from python" }),
		);

		const result = await executePython('print(agent("hi"))', {
			cwd: tempDir.path(),
			sessionId,
			sessionFile,
			kernelMode: "per-call",
			toolSession: session,
		});
		if (result.exitCode === undefined && result.cancelled) {
			expect(result.output).toBe("");
			return; // kernel unavailable in this environment
		}

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("hello from python");
	});

	it("bounds Python parallel() by the task.maxConcurrency setting while preserving order", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-py-parallel-");
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
			"task.maxConcurrency": 2,
		});
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "py-agent-parallel", settings);
		mockAgents();
		let inFlight = 0;
		let maxInFlight = 0;
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				await Bun.sleep(options.assignment === "a" ? 30 : 10);
				return singleResult(options, { output: options.assignment ?? "" });
			} finally {
				inFlight--;
			}
		});

		const result = await executePython(
			'import json\nprint(json.dumps(parallel([lambda n=n: agent(n) for n in ["a", "b", "c", "d"]])))',
			{ cwd: tempDir.path(), sessionId, sessionFile, kernelMode: "per-call", toolSession: session },
		);
		if (result.exitCode === undefined && result.cancelled) {
			expect(result.output).toBe("");
			return; // kernel unavailable in this environment
		}

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual(["a", "b", "c", "d"]);
		expect(maxInFlight).toBeGreaterThan(1);
		expect(maxInFlight).toBeLessThanOrEqual(2);
	});

	it("interrupting a Python parallel() fan-out settles the kernel cleanly and preserves session state", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-py-interrupt-");
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
			"task.maxConcurrency": 6,
		});
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "py-agent-interrupt", settings);
		mockAgents();
		// Subagents that ignore the abort for far longer than the kernel's SIGINT
		// escalation window. Each kernel worker thread blocks in a synchronous
		// `urllib` bridge call, joined by `parallel()`'s ThreadPoolExecutor exit.
		// The host must respond the instant the cell aborts so the kernel can
		// unwind via KeyboardInterrupt instead of being hard-killed (which used to
		// surface "[kernel] Python kernel shutdown" and lose all session state).
		let inFlight = 0;
		let markSaturated: (() => void) | undefined;
		const saturated = new Promise<void>(resolve => {
			markSaturated = resolve;
		});
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			// task.maxConcurrency=6 → six bridge calls block at once; signal then.
			if (++inFlight >= 6) markSaturated?.();
			await Bun.sleep(9000); // deliberately ignores options.signal
			return singleResult(options, { output: options.assignment ?? "" });
		});

		// Seed persistent session state and confirm the kernel is reusable.
		const seed = await executePython("PREP_MARKER = 4242", {
			cwd: tempDir.path(),
			sessionId,
			sessionFile,
			kernelMode: "session",
			toolSession: session,
		});
		if (seed.exitCode === undefined && seed.cancelled) {
			expect(seed.output).toBe("");
			return; // kernel unavailable in this environment
		}
		expect(seed.exitCode).toBe(0);

		const ac = new AbortController();
		// Abort the instant all six worker threads are confirmed blocked in their
		// bridge calls (condition-driven) instead of waiting a fixed wall second.
		void saturated.then(() => ac.abort(new Error("external interrupt")));

		const start = Date.now();
		const result = await executePython(
			"import json\nprint(json.dumps(parallel([lambda n=n: agent(str(n)) for n in range(12)])))",
			{
				cwd: tempDir.path(),
				sessionId,
				sessionFile,
				kernelMode: "session",
				toolSession: session,
				idleTimeoutMs: 60_000,
				signal: ac.signal,
			},
		);
		const elapsed = Date.now() - start;

		// Cancelled, but cleanly: no hard-kill, settled well within the kernel's 5s
		// SIGINT escalation window rather than ~6s after it.
		expect(result.cancelled).toBe(true);
		expect(result.output).not.toContain("Python kernel shutdown");
		expect(elapsed).toBeLessThan(4000);

		// The persistent kernel survived the interrupt: prior state is intact.
		const after = await executePython("print(PREP_MARKER)", {
			cwd: tempDir.path(),
			sessionId,
			sessionFile,
			kernelMode: "session",
			toolSession: session,
		});
		expect(after.exitCode).toBe(0);
		expect(after.output.trim()).toBe("4242");
	}, 30_000);

	it("streams enriched agent progress through onStatus before the cell finishes", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-progress-");
		const { session, sessionFile, sessionId } = makeEvalSession(tempDir, "js-agent-progress");
		mockAgents();

		const makeProgress = (options: ExecutorOptions, overrides: Partial<AgentProgress>): AgentProgress => ({
			index: options.index,
			id: options.id,
			agent: options.agent.name,
			agentSource: options.agent.source,
			status: "running",
			task: options.task,
			assignment: options.assignment,
			description: options.description,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			tokens: 0,
			requests: 0,
			cost: 0,
			durationMs: 0,
			...overrides,
		});

		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			options.onProgress?.(
				makeProgress(options, {
					status: "running",
					currentTool: "read",
					currentToolArgs: "config.ts",
					lastIntent: "Reading config",
					toolCount: 4,
					contextTokens: 5000,
					contextWindow: 200000,
					cost: 0.03,
					durationMs: 800,
					resolvedModel: "p/model",
				}),
			);
			options.onProgress?.(
				makeProgress(options, {
					status: "completed",
					toolCount: 7,
					contextTokens: 8000,
					contextWindow: 200000,
					cost: 0.06,
					durationMs: 1500,
					resolvedModel: "p/model",
				}),
			);
			return singleResult(options, { output: "done" });
		});

		const events: Array<{ op: string; [key: string]: unknown }> = [];
		const result = await executeJs('await agent("investigate", { label: "Scout" });', {
			cwd: tempDir.path(),
			sessionId,
			session,
			sessionFile,
			onStatus: event => events.push(event),
		});

		expect(result.exitCode).toBe(0);

		const agentEvents = events.filter(event => event.op === "agent");
		// Both throttled ticks were delivered live (the cell awaited agent() and
		// the executor collected them as displayOutputs too).
		expect(agentEvents.length).toBe(2);

		const running = agentEvents[0];
		expect(running.status).toBe("running");
		expect(running.currentTool).toBe("read");
		expect(running.lastIntent).toBe("Reading config");
		expect(running.contextTokens).toBe(5000);
		expect(running.taskPreview).toBe("investigate");
		expect(typeof running.id).toBe("string");

		// The final completion event keeps the rich stats — no sparse event
		// coalesces over it and drops toolCount/cost.
		const completed = agentEvents[1];
		expect(completed.status).toBe("completed");
		expect(completed.toolCount).toBe(7);
		expect(completed.cost).toBeCloseTo(0.06);
		expect(completed.id).toBe(running.id);

		// Same events are still present in the executor's returned displayOutputs.
		const displayAgentEvents = result.displayOutputs.filter(
			(output): output is Extract<typeof output, { type: "status" }> => output.type === "status",
		);
		expect(displayAgentEvents.length).toBe(2);
	});

	it("pauses the idle watchdog while a quiet agent() runs past the budget", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-timeout-pause-");
		const { session } = makeEvalSession(tempDir, "js-agent-timeout-pause");
		mockAgents();

		// runSubprocess runs far past the eval timeout budget and emits NO progress
		// of its own. The bridge pause must make that delegated time invisible to
		// the watchdog.
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			await Bun.sleep(40);
			return singleResult(options, { output: "done" });
		});

		const ops: string[] = [];
		using idle = new IdleTimeout(20);
		const result = await runEvalAgent(
			{ prompt: "investigate" },
			{
				session,
				signal: idle.signal,
				emitStatus: event => {
					ops.push(event.op);
					if (event.op === EVAL_TIMEOUT_PAUSE_OP) idle.pause();
					if (event.op === EVAL_TIMEOUT_RESUME_OP) idle.resume();
				},
			},
		);

		expect(result.text).toBe("done");
		expect(ops).toEqual([EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP]);
		expect(idle.signal.aborted).toBe(false);

		await Bun.sleep(60);
		expect(idle.signal.aborted).toBe(true);
	});

	it("keeps timeout paused despite agent() progress snapshots", async () => {
		using tempDir = TempDir.createSync("@omp-eval-agent-progress-timeout-pause-");
		const { session } = makeEvalSession(tempDir, "js-agent-progress-timeout-pause");
		mockAgents();

		// Stream frequent progress snapshots (op:"agent") for well past the budget.
		// They render as status, but timeout accounting is controlled only by the
		// bridge pause/resume events.
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			for (let i = 0; i < 20; i++) {
				options.onProgress?.({
					index: options.index,
					id: options.id,
					agent: options.agent.name,
					agentSource: options.agent.source,
					status: "running",
					task: options.task,
					assignment: options.assignment,
					description: options.description,
					recentTools: [],
					recentOutput: [],
					toolCount: i,
					tokens: 0,
					requests: 0,
					cost: 0,
					durationMs: i * 10,
				});
				await Bun.sleep(5);
			}
			return singleResult(options, { output: "done" });
		});

		const ops: string[] = [];
		using idle = new IdleTimeout(40);
		const result = await runEvalAgent(
			{ prompt: "investigate" },
			{
				session,
				signal: idle.signal,
				emitStatus: event => {
					ops.push(event.op);
					if (event.op === EVAL_TIMEOUT_PAUSE_OP) idle.pause();
					if (event.op === EVAL_TIMEOUT_RESUME_OP) idle.resume();
				},
			},
		);

		expect(result.text).toBe("done");
		expect(ops[0]).toBe(EVAL_TIMEOUT_PAUSE_OP);
		expect(ops).toContain("agent");
		expect(ops.at(-1)).toBe(EVAL_TIMEOUT_RESUME_OP);
		expect(idle.signal.aborted).toBe(false);
	});
});

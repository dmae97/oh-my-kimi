/**
 * Contracts: task tool spawn/resume routing (rework-contracts.md §3).
 *
 * 1. With an AsyncJobManager wired, `execute` returns immediately (agent id +
 *    job id) while the job body is still gated; job completion delivers a
 *    result carrying the `task(resume:"<id>")` / `history://<id>` hint.
 * 2. Resume routes through `AgentLifecycleManager.ensureLive` and hands the
 *    live session to `resumeSubprocess`; an ensureLive rejection surfaces as a
 *    ToolError naming `history://<id>`.
 * 3. The session-scoped spawn semaphore (task.maxConcurrency) serializes job
 *    bodies: with concurrency 1 the second body does not start until the
 *    first releases.
 *
 * Param validation (agent XOR resume, resume+isolated, missing assignment) is
 * covered by test/task/task-schema.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createSession(options: { manager?: AsyncJobManager; settings?: Record<string, unknown> }): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
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
	let resolve!: () => void;
	const promise = new Promise<void>(res => {
		resolve = res;
	});
	return { promise, resolve };
}

async function pollUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
		await Bun.sleep(5);
	}
}

describe("task spawn/resume routing", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("returns immediately on spawn and delivers the resume hint when the job completes", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const gate = deferred();
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await gate.promise;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));

		const result = await tool.execute("tc-spawn", {
			agent: "task",
			id: "Spawnling",
			description: "background work",
			assignment: "Do the thing.",
		} as TaskParams);

		// Tool returned while the job body is still gated on the deferred.
		const text = getFirstText(result);
		expect(text).toContain("Spawned agent `Spawnling`");
		const jobId = result.details?.async?.jobId;
		expect(jobId).toBeTruthy();
		expect(text).toContain(`job \`${jobId}\``);
		const job = manager.getJob(jobId!);
		expect(job?.status).toBe("running");
		expect(job?.resultText).toBeUndefined();

		gate.resolve();
		await job!.promise;

		expect(job!.status).toBe("completed");
		expect(job!.resultText).toContain('task(resume:"Spawnling")');
		expect(job!.resultText).toContain("history://Spawnling");
		expect(runSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects an async resume of an unregistered agent without registering a job", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager }));

		const error = await tool
			.execute("tc-resume-unknown", { resume: "Nobody", assignment: "Follow up." } as TaskParams)
			.then(
				() => null,
				err => err as Error,
			);

		expect(error).toBeInstanceOf(ToolError);
		expect(error?.message).toContain('Unknown agent "Nobody"');
		expect(error?.message).toContain("history://Nobody");
		expect(manager.getAllJobs()).toHaveLength(0);
	});

	it("resume routes through AgentLifecycleManager.ensureLive and hands the live session to resumeSubprocess", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const fakeSession = { messages: [] } as unknown as AgentSession;
		AgentRegistry.global().register({
			id: "Reso",
			displayName: "task",
			kind: "sub",
			session: fakeSession,
			status: "idle",
		});
		const ensureLiveSpy = vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockResolvedValue(fakeSession);
		const resumeSpy = vi
			.spyOn(executorModule, "resumeSubprocess")
			.mockResolvedValue(makeResult("Reso", { output: "Follow-up done." }));

		// No job manager => sync fallback, so the resume pipeline runs inline.
		const tool = await TaskTool.create(createSession({}));
		const result = await tool.execute("tc-resume", {
			resume: "Reso",
			assignment: "Also check refresh tokens.",
		} as TaskParams);

		expect(ensureLiveSpy).toHaveBeenCalledTimes(1);
		expect(ensureLiveSpy).toHaveBeenCalledWith("Reso");
		expect(resumeSpy).toHaveBeenCalledTimes(1);
		const resumeOptions = resumeSpy.mock.calls[0]![0];
		expect(resumeOptions.session).toBe(fakeSession);
		expect(resumeOptions.id).toBe("Reso");
		expect(resumeOptions.assignment).toBe("Also check refresh tokens.");

		const text = getFirstText(result);
		expect(text).toContain("Reso");
		expect(text).toContain("completed");
		expect(result.details?.results).toHaveLength(1);
		expect(result.details?.results[0]?.exitCode).toBe(0);
	});

	it("surfaces an ensureLive rejection as a ToolError naming history://", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockRejectedValue(new Error("session file corrupt"));

		const tool = await TaskTool.create(createSession({}));
		const error = await tool
			.execute("tc-resume-dead", { resume: "Ghost", assignment: "Wake up." } as TaskParams)
			.then(
				() => null,
				err => err as Error,
			);

		expect(error).toBeInstanceOf(ToolError);
		expect(error?.message).toContain('Cannot resume "Ghost"');
		expect(error?.message).toContain("session file corrupt");
		expect(error?.message).toContain("history://Ghost");
	});

	it("bounds concurrent job bodies with the session spawn semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const started: string[] = [];
		const gates = new Map<string, Deferred>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const gate = deferred();
			gates.set(id, gate);
			await gate.promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(createSession({ manager, settings: { "task.maxConcurrency": 1 } }));

		const first = await tool.execute("tc-1", { agent: "task", id: "First", assignment: "Work A." } as TaskParams);
		const second = await tool.execute("tc-2", { agent: "task", id: "Second", assignment: "Work B." } as TaskParams);
		const firstJob = manager.getJob(first.details!.async!.jobId)!;
		const secondJob = manager.getJob(second.details!.async!.jobId)!;

		// First job body reaches the executor; second stays parked at the semaphore.
		await pollUntil(() => started.length >= 1);
		await Bun.sleep(25);
		expect(started).toHaveLength(1);

		// Releasing the first body lets the second one start.
		gates.get(started[0]!)!.resolve();
		await firstJob.promise;
		await pollUntil(() => started.length === 2);
		expect(started).toEqual(["First", "Second"]);

		gates.get("Second")!.resolve();
		await secondJob.promise;
		expect(firstJob.status).toBe("completed");
		expect(secondJob.status).toBe("completed");
	});
});

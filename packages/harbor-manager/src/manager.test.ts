import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { experimentDetail } from "./experiments";
import { ManagerServer } from "./server";
import { RunStore } from "./store";

/**
 * Contracts under test:
 *  - discover() backfills historical job dirs into run rows.
 *  - syncRun() mirrors trial outcomes (pass / error / running) and rollups.
 *  - REST API surfaces runs, trials, compact transcripts, and rejects bad launches.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function makeJobsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-manager-test-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function writeFixtureJob(jobsDir: string, jobName: string): void {
	const jobDir = path.join(jobsDir, jobName);
	fs.mkdirSync(jobDir, { recursive: true });
	fs.writeFileSync(
		path.join(jobDir, "result.json"),
		JSON.stringify({
			n_total_trials: 3,
			stats: { n_running_trials: 1, n_pending_trials: 0 },
		}),
	);
	fs.writeFileSync(
		path.join(jobDir, "config.json"),
		JSON.stringify({
			dataset: "test-dataset@1.0",
			agents: [{ name: "omp", model_name: "anthropic/claude-opus-4-8" }],
		}),
	);
	const mkTrial = (name: string, body: Record<string, unknown> | null) => {
		const dir = path.join(jobDir, name, "agent");
		fs.mkdirSync(dir, { recursive: true });
		if (body) fs.writeFileSync(path.join(jobDir, name, "result.json"), JSON.stringify(body));
	};
	mkTrial("alpha__abc", {
		started_at: "2026-07-12T10:00:00",
		finished_at: "2026-07-12T10:05:00",
		verifier_result: { rewards: { reward: 1 } },
		agent_result: { cost_usd: 0.5, n_input_tokens: 100, n_output_tokens: 10, n_cache_tokens: 80 },
	});
	mkTrial("beta__def", {
		started_at: "2026-07-12T10:00:00",
		finished_at: "2026-07-12T10:02:00",
		exception_info: { exception_type: "AgentTimeoutError" },
		agent_result: { cost_usd: 0.2 },
	});
	mkTrial("gamma__ghi", null); // running: no result.json yet
	// transcript for alpha
	const transcript = [
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				model: "claude-opus-4-8",
				content: [
					{ type: "text", text: "Reading the file first." },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } },
				],
			},
		}),
		JSON.stringify({
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "file contents" }],
			},
		}),
	].join("\n");
	fs.writeFileSync(path.join(jobDir, "alpha__abc", "agent", "omp.txt"), transcript);
}

describe("RunStore", () => {
	it("discovers historical job dirs and mirrors trial state", () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "job-a");
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		expect(store.discover()).toBe(1);
		const run = store.getRun("job-a");
		// No job-level finished_at + fresh dir + a running trial → still running.
		expect(run?.status).toBe("running");
		expect(run?.dataset).toBe("test-dataset@1.0");
		expect(run?.models).toBe("anthropic/claude-opus-4-8");
		expect(run?.nTotal).toBe(3);
		expect(run?.pass).toBe(1);
		expect(run?.error).toBe(1);
		expect(run?.running).toBe(1);
		expect(run?.costUsd).toBeCloseTo(0.7, 5);

		const trials = store.listTrials("job-a");
		expect(trials.map(t => [t.task, t.status])).toEqual([
			["alpha", "pass"],
			["beta", "error"],
			["gamma", "running"],
		]);
		expect(trials[1].detail).toBe("AgentTimeoutError");

		// re-discover is idempotent
		expect(store.discover()).toBe(0);
	});

	it("marks discovered runs complete when harbor recorded a terminal state", () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "job-done");
		const jobDir = path.join(jobsDir, "job-done");
		fs.writeFileSync(
			path.join(jobDir, "result.json"),
			JSON.stringify({
				n_total_trials: 2,
				finished_at: "2026-07-12T11:00:00",
				stats: { n_running_trials: 0, n_pending_trials: 0 },
			}),
		);
		fs.rmSync(path.join(jobDir, "gamma__ghi"), { recursive: true, force: true });
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		store.discover();
		expect(store.getRun("job-done")?.status).toBe("complete");
		expect(store.getRun("job-done")?.finishedAt).not.toBeNull();
	});

	it("stores experiment goals and run roles, and orders baselines first", () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "exp-treat");
		writeFixtureJob(jobsDir, "exp-base");
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		store.discover();
		store.setExperimentGoal("exp", "does the treatment beat the baseline?");
		expect(store.setRunMeta("exp-base", { role: "baseline", note: "plain model" })).toBe(true);
		expect(store.setRunMeta("exp-treat", { role: "variant", note: "slide N=8" })).toBe(true);
		expect(store.setRunMeta("exp-missing", { role: "variant" })).toBe(false);

		const detail = experimentDetail(store, "exp");
		expect(detail?.goal).toBe("does the treatment beat the baseline?");
		expect(detail?.arms.map(a => [a.arm, a.run.role, a.run.note])).toEqual([
			["base", "baseline", "plain model"],
			["treat", "variant", "slide N=8"],
		]);
	});

	it("finalizes running rows whose owning process died", () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "job-b");
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		store.registerLaunch({
			jobName: "job-b",
			dataset: "test-dataset@1.0",
			agent: "omp",
			models: ["m"],
			pid: 999999999, // certainly dead
		});
		const rows = store.syncActive();
		expect(rows).toHaveLength(1);
		expect(store.getRun("job-b")?.status).toBe("failed");
	});
});

describe("ManagerServer API", () => {
	it("serves runs, trials, transcripts, and validates launches", async () => {
		const jobsDir = makeJobsDir();
		writeFixtureJob(jobsDir, "job-api");
		const manager = new ManagerServer(jobsDir);
		const server = manager.start(0);
		cleanups.push(() => {
			void manager.stop();
		});
		const base = `http://localhost:${server.port}`;

		const runs = (await (await fetch(`${base}/api/runs`)).json()) as Array<{ jobName: string; pass: number }>;
		expect(runs.map(r => r.jobName)).toContain("job-api");

		const detailRes = await fetch(`${base}/api/runs/job-api`);
		expect(detailRes.status).toBe(200);
		const detail = (await detailRes.json()) as { run: { pass: number }; trials: Array<{ status: string }> };
		expect(detail.run.pass).toBe(1);
		expect(detail.trials).toHaveLength(3);

		const tr = await fetch(`${base}/api/runs/job-api/trials/alpha__abc/transcript?tail=10`);
		expect(tr.status).toBe(200);
		const transcript = (await tr.json()) as { entries: Array<{ kind: string; tools?: string[] }> };
		expect(transcript.entries.map(e => e.kind)).toEqual(["assistant", "toolResult"]);
		expect(transcript.entries[0].tools).toEqual(["read"]);

		const missing = await fetch(`${base}/api/runs/nope`);
		expect(missing.status).toBe(404);

		const badLaunch = await fetch(`${base}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(badLaunch.status).toBe(400);

		const cancelUnknown = (await (await fetch(`${base}/api/runs/nope`, { method: "DELETE" })).json()) as {
			cancelled: boolean;
		};
		expect(cancelUnknown.cancelled).toBe(false);
	});
});

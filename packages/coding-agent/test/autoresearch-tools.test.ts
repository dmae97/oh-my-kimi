import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { createSessionRuntime } from "../src/autoresearch/state";
import { openAutoresearchStorage } from "../src/autoresearch/storage";
import { createInitExperimentTool } from "../src/autoresearch/tools/init-experiment";
import { createLogExperimentTool } from "../src/autoresearch/tools/log-experiment";
import { createRunExperimentTool } from "../src/autoresearch/tools/run-experiment";
import { createUpdateNotesTool } from "../src/autoresearch/tools/update-notes";
import type { LogDetails, RunDetails } from "../src/autoresearch/types";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";

afterEach(() => {
	vi.restoreAllMocks();
});

function firstTextBlockText(content: Array<TextContent | ImageContent>): string {
	const block = content.find((c): c is TextContent => c.type === "text");
	if (!block) throw new Error("expected a text tool content block");
	return block.text;
}

function makeTempDir(prefix = "pi-autoresearch-tools"): string {
	const dir = path.join(os.tmpdir(), `${prefix}-${Snowflake.next()}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function dashboardStub() {
	return {
		clear(): void {},
		requestRender(): void {},
		showOverlay: async (): Promise<void> => {},
		updateWidget(): void {},
	};
}

function createCtx(cwd: string): ExtensionContext {
	return { cwd, hasUI: false } as ExtensionContext;
}

interface PiHarness {
	api: ExtensionAPI;
	activeTools: string[];
	appendEntries: Array<{ customType: string; data: unknown }>;
	setActiveToolsCalls: string[][];
}

function createPiHarness(initialTools: string[] = []): PiHarness {
	const activeTools = [...initialTools];
	const appendEntries: Array<{ customType: string; data: unknown }> = [];
	const setActiveToolsCalls: string[][] = [];
	const api = {
		appendEntry: (customType: string, data?: unknown) => {
			appendEntries.push({ customType, data });
		},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		getActiveTools: () => [...activeTools],
		setActiveTools: async (toolNames: string[]) => {
			setActiveToolsCalls.push([...toolNames]);
			activeTools.splice(0, activeTools.length, ...toolNames);
		},
	} as unknown as ExtensionAPI;
	return { api, activeTools, appendEntries, setActiveToolsCalls };
}

async function initGitRepo(dir: string): Promise<{ baselineCommit: string; mainBranch: string }> {
	await $`git init --initial-branch=main`.cwd(dir).quiet();
	await $`git config user.email tester@example.com`.cwd(dir).quiet();
	await $`git config user.name Tester`.cwd(dir).quiet();
	await Bun.write(path.join(dir, "README.md"), "# baseline\n");
	await $`git add -A`.cwd(dir).quiet();
	await $`git commit -m baseline`.cwd(dir).quiet();
	const sha = (await $`git rev-parse HEAD`.cwd(dir).text()).trim();
	const branch = (await $`git rev-parse --abbrev-ref HEAD`.cwd(dir).text()).trim();
	return { baselineCommit: sha, mainBranch: branch };
}

async function checkoutBranch(dir: string, name: string): Promise<void> {
	await $`git checkout -b ${name}`.cwd(dir).quiet();
}

async function writeHarnessStub(dir: string, body = "echo METRIC m=1"): Promise<void> {
	await Bun.write(path.join(dir, "autoresearch.sh"), `#!/usr/bin/env bash\n${body}\n`);
}

describe("init_experiment", () => {
	let dbOverride: string;

	beforeEach(() => {
		dbOverride = makeTempDir("pi-autoresearch-init-db");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbOverride;
	});

	afterEach(() => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		fs.rmSync(dbOverride, { recursive: true, force: true });
	});

	it("opens a new session and persists scope and metric metadata", async () => {
		const dir = makeTempDir();
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const tool = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		});

		const result = await tool.execute(
			"call-1",
			{
				name: "speed",
				goal: "make x fast",
				primary_metric: "runtime_ms",
				metric_unit: "ms",
				direction: "lower",
				scope_paths: ["src", "src/foo"],
				off_limits: ["test"],
				secondary_metrics: ["memory_mb"],
				constraints: ["no api break"],
				max_iterations: 50,
			},
			undefined,
			undefined,
			createCtx(dir),
		);
		expect(firstTextBlockText(result.content)).toContain("Started session");
		expect(result.details?.createdSession).toBe(true);
		expect(result.details?.bumpedSegment).toBe(false);

		const storage = await openAutoresearchStorage(dir);
		const session = storage.getActiveSession();
		expect(session).not.toBeNull();
		expect(session?.primaryMetric).toBe("runtime_ms");
		expect(session?.scopePaths).toEqual(["src", "src/foo"]);
		expect(session?.offLimits).toEqual(["test"]);
		expect(session?.secondaryMetrics).toEqual(["memory_mb"]);
		expect(session?.maxIterations).toBe(50);
	});

	it("updates fields without bumping segment when no new_segment flag is passed", async () => {
		const dir = makeTempDir();
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const tool = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		});

		await tool.execute(
			"call-a",
			{ name: "a", primary_metric: "ms", scope_paths: ["src"] },
			undefined,
			undefined,
			createCtx(dir),
		);
		const second = await tool.execute(
			"call-b",
			{ name: "a", primary_metric: "ms", scope_paths: ["src", "lib"], goal: "v2" },
			undefined,
			undefined,
			createCtx(dir),
		);
		expect(second.details?.createdSession).toBe(false);
		expect(second.details?.bumpedSegment).toBe(false);
		expect(second.details?.state.scopePaths).toEqual(["src", "lib"]);
		expect(second.details?.state.goal).toBe("v2");
		expect(second.details?.state.currentSegment).toBe(0);
	});

	it("bumps segment when new_segment is true on a re-init", async () => {
		const dir = makeTempDir();
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const tool = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		});
		await tool.execute("a", { name: "x", primary_metric: "ms" }, undefined, undefined, createCtx(dir));
		const result = await tool.execute(
			"b",
			{ name: "x", primary_metric: "ms", new_segment: true },
			undefined,
			undefined,
			createCtx(dir),
		);
		expect(result.details?.bumpedSegment).toBe(true);
		expect(result.details?.state.currentSegment).toBe(1);
	});

	it("rejects when autoresearch.sh is missing on first init", async () => {
		const dir = makeTempDir();
		const runtime = createSessionRuntime();
		const tool = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		});
		const result = await tool.execute(
			"call-1",
			{ name: "x", primary_metric: "m" },
			undefined,
			undefined,
			createCtx(dir),
		);
		expect(firstTextBlockText(result.content)).toContain("autoresearch.sh");
		const storage = await openAutoresearchStorage(dir);
		expect(storage.getActiveSession()).toBeNull();
	});

	it("auto-commits pending harness changes on an autoresearch branch", async () => {
		const dir = makeTempDir();
		const { baselineCommit: initialBaseline } = await initGitRepo(dir);
		await checkoutBranch(dir, "autoresearch/setup-test");
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const tool = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		});
		const result = await tool.execute(
			"call-1",
			{ name: "x", primary_metric: "m", goal: "speed" },
			undefined,
			undefined,
			createCtx(dir),
		);
		expect(result.details?.harnessCommitted).toBe(true);
		const newHead = (await $`git rev-parse HEAD`.cwd(dir).text()).trim();
		expect(newHead).not.toBe(initialBaseline);
		expect(result.details?.baselineCommit).toBe(newHead);
		const status = (await $`git status --porcelain`.cwd(dir).text()).trim();
		expect(status).toBe("");
		const message = (await $`git log -1 --pretty=%B`.cwd(dir).text()).trim();
		expect(message).toContain("autoresearch: harness setup");
	});

	it("does not auto-commit when not on an autoresearch branch", async () => {
		const dir = makeTempDir();
		const { baselineCommit: initialBaseline } = await initGitRepo(dir);
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const tool = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		});
		const result = await tool.execute(
			"call-1",
			{ name: "x", primary_metric: "m" },
			undefined,
			undefined,
			createCtx(dir),
		);
		expect(result.details?.harnessCommitted).toBe(false);
		const newHead = (await $`git rev-parse HEAD`.cwd(dir).text()).trim();
		expect(newHead).toBe(initialBaseline);
		// Harness file is still in the worktree, untracked.
		expect(fs.existsSync(path.join(dir, "autoresearch.sh"))).toBe(true);
	});
});

describe("run_experiment", () => {
	let dbOverride: string;

	beforeEach(() => {
		dbOverride = makeTempDir("pi-autoresearch-run-db");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbOverride;
	});

	afterEach(() => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		fs.rmSync(dbOverride, { recursive: true, force: true });
	});

	it("rejects when no session is active", async () => {
		const dir = makeTempDir();
		const runtime = createSessionRuntime();
		const run = createRunExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		});
		const result = await run.execute("call-1", {}, undefined, undefined, createCtx(dir));
		expect(firstTextBlockText(result.content)).toContain("no active autoresearch session");
	});

	it("accepts arbitrary commands, parses METRIC/ASI, and stores a run", async () => {
		const dir = makeTempDir();
		await writeHarnessStub(dir, "echo METRIC runtime_ms=42; echo METRIC memory_mb=12; echo ASI hypothesis=baseline");
		const runtime = createSessionRuntime();
		const init = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		});
		await init.execute(
			"i",
			{ name: "speed", primary_metric: "runtime_ms", metric_unit: "ms" },
			undefined,
			undefined,
			createCtx(dir),
		);
		const run = createRunExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		});
		const result = await run.execute("r", { timeout_seconds: 5 }, undefined, undefined, createCtx(dir));
		const details = result.details as RunDetails;
		expect(details.parsedPrimary).toBe(42);
		expect(details.parsedMetrics).toMatchObject({ runtime_ms: 42, memory_mb: 12 });
		expect(details.parsedAsi).toMatchObject({ hypothesis: "baseline" });
		expect(details.passed).toBe(true);
		expect(fs.existsSync(details.benchmarkLogPath)).toBe(true);

		const storage = await openAutoresearchStorage(dir);
		const session = storage.getActiveSession();
		const runs = storage.listRuns(session!.id);
		expect(runs).toHaveLength(1);
		expect(runs[0].parsedPrimary).toBe(42);
		expect(runs[0].status).toBeNull();
	});

	it("abandons a prior pending run instead of blocking", async () => {
		const dir = makeTempDir();
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const initTool = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		});
		await initTool.execute("i", { name: "x", primary_metric: "m" }, undefined, undefined, createCtx(dir));
		const run = createRunExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		});
		await run.execute("r1", {}, undefined, undefined, createCtx(dir));
		const result = await run.execute("r2", {}, undefined, undefined, createCtx(dir));
		const details = result.details as RunDetails;
		expect(details.abandonedPriorRun).not.toBeNull();
		expect(details.runNumber).not.toBe(details.abandonedPriorRun);
	});

	it("runs ./autoresearch.sh and parses METRIC/ASI from its output", async () => {
		const dir = makeTempDir();
		await writeHarnessStub(dir, "echo METRIC m=99");
		const runtime = createSessionRuntime();
		const init = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		});
		await init.execute("i", { name: "x", primary_metric: "m" }, undefined, undefined, createCtx(dir));
		const run = createRunExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		});
		const result = await run.execute("r", {}, undefined, undefined, createCtx(dir));
		const details = result.details as RunDetails;
		expect(details.command).toBe("bash autoresearch.sh");
		expect(details.parsedPrimary).toBe(99);
	});
});

describe("log_experiment", () => {
	let dbOverride: string;

	beforeEach(() => {
		dbOverride = makeTempDir("pi-autoresearch-log-db");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbOverride;
	});

	afterEach(() => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		fs.rmSync(dbOverride, { recursive: true, force: true });
	});

	async function setupRun(dir: string, runtime = createSessionRuntime()) {
		await writeHarnessStub(dir, "echo METRIC runtime_ms=10");
		const harness = createPiHarness();
		const init = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		await init.execute(
			"i",
			{
				name: "speed",
				primary_metric: "runtime_ms",
				metric_unit: "ms",
				scope_paths: ["src"],
				off_limits: ["forbidden"],
			},
			undefined,
			undefined,
			createCtx(dir),
		);
		const run = createRunExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		await run.execute("r", {}, undefined, undefined, createCtx(dir));
		const log = createLogExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		return { runtime, log, harness };
	}

	it("rejects when no pending run exists", async () => {
		const dir = makeTempDir();
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const harness = createPiHarness();
		const init = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		await init.execute("i", { name: "x", primary_metric: "m" }, undefined, undefined, createCtx(dir));
		const log = createLogExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		const result = await log.execute(
			"l",
			{ metric: 1, status: "keep", description: "x" },
			undefined,
			undefined,
			createCtx(dir),
		);
		expect(firstTextBlockText(result.content)).toContain("no pending run");
	});

	it("stores keep with metric and updates baseline", async () => {
		const dir = makeTempDir();
		const { log, runtime } = await setupRun(dir);
		const result = await log.execute(
			"l",
			{ metric: 10, status: "keep", description: "baseline" },
			undefined,
			undefined,
			createCtx(dir),
		);
		const details = result.details as LogDetails;
		expect(details.experiment.status).toBe("keep");
		expect(details.experiment.metric).toBe(10);
		expect(details.state.bestMetric).toBe(10);
		expect(details.state.results).toHaveLength(1);
		expect(runtime.state.bestMetric).toBe(10);
	});

	it("flags scope deviations and warns when justification is missing", async () => {
		const dir = makeTempDir();
		await initGitRepo(dir);
		const { log } = await setupRun(dir);
		fs.mkdirSync(path.join(dir, "forbidden"), { recursive: true });
		await Bun.write(path.join(dir, "forbidden", "x.ts"), "export const v = 1;\n");
		const result = await log.execute(
			"l",
			{ metric: 10, status: "keep", description: "wrote forbidden" },
			undefined,
			undefined,
			createCtx(dir),
		);
		const details = result.details as LogDetails;
		expect(details.scopeDeviations.length).toBeGreaterThan(0);
		expect(details.justification).toBeNull();
		expect(firstTextBlockText(result.content)).toContain("unjustified");
	});

	it("records the justification when provided", async () => {
		const dir = makeTempDir();
		await initGitRepo(dir);
		const { log } = await setupRun(dir);
		fs.mkdirSync(path.join(dir, "forbidden"), { recursive: true });
		await Bun.write(path.join(dir, "forbidden", "x.ts"), "export const v = 1;\n");
		const result = await log.execute(
			"l",
			{
				metric: 10,
				status: "keep",
				description: "wrote forbidden",
				justification: "this file moved into scope",
			},
			undefined,
			undefined,
			createCtx(dir),
		);
		const details = result.details as LogDetails;
		expect(details.scopeDeviations.length).toBeGreaterThan(0);
		expect(details.justification).toBe("this file moved into scope");
	});

	it("flags previously logged runs via flag_runs", async () => {
		const dir = makeTempDir();
		const { log } = await setupRun(dir);
		const first = await log.execute(
			"l1",
			{ metric: 10, status: "keep", description: "baseline" },
			undefined,
			undefined,
			createCtx(dir),
		);
		const firstId = (first.details as LogDetails).experiment.runNumber;
		expect(firstId).not.toBeNull();

		// New run + log that flags the previous run.
		const harness = createPiHarness();
		const runtime = createSessionRuntime();
		// Re-hydrate runtime by re-running the tools chain.
		const init = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		await init.execute(
			"i",
			{
				name: "speed",
				primary_metric: "runtime_ms",
				metric_unit: "ms",
				scope_paths: ["src"],
				off_limits: ["forbidden"],
			},
			undefined,
			undefined,
			createCtx(dir),
		);
		const run = createRunExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		await run.execute("r2", {}, undefined, undefined, createCtx(dir));
		const log2 = createLogExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		const second = await log2.execute(
			"l2",
			{
				metric: 8,
				status: "keep",
				description: "improved",
				flag_runs: [{ run_id: firstId as number, reason: "reward-hacked" }],
			},
			undefined,
			undefined,
			createCtx(dir),
		);
		const details = second.details as LogDetails;
		expect(details.flaggedRuns).toEqual([{ runId: firstId as number, reason: "reward-hacked" }]);

		// Refresh storage to confirm DB row updated
		const storage = await openAutoresearchStorage(dir);
		const session = storage.getActiveSession();
		const runs = storage.listLoggedRuns(session!.id);
		const flagged = runs.find(r => r.id === firstId);
		expect(flagged?.flagged).toBe(true);
		expect(flagged?.flaggedReason).toBe("reward-hacked");
	});

	it("on a non-autoresearch branch, discard reverts only run-modified files", async () => {
		const dir = makeTempDir();
		await writeHarnessStub(dir);
		await initGitRepo(dir);
		// Commit `src/edit-me.ts` to baseline so it is tracked, not in pre-run dirty paths.
		fs.mkdirSync(path.join(dir, "src"), { recursive: true });
		await Bun.write(path.join(dir, "src", "edit-me.ts"), "export const v = 1;\n");
		await $`git add -A`.cwd(dir).quiet();
		await $`git commit -m seed`.cwd(dir).quiet();
		const runtime = createSessionRuntime();
		const harness = createPiHarness();
		const init = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		await init.execute(
			"i",
			{ name: "x", primary_metric: "m", scope_paths: ["src"] },
			undefined,
			undefined,
			createCtx(dir),
		);
		const run = createRunExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		// Pre-existing untracked file (will not be touched by revert because it was dirty before run)
		await Bun.write(path.join(dir, "preexisting.txt"), "leave me\n");
		await run.execute("r", {}, undefined, undefined, createCtx(dir));
		// Simulate a run-introduced change
		await Bun.write(path.join(dir, "src", "edit-me.ts"), "export const v = 2;\n");
		await Bun.write(path.join(dir, "src", "new.ts"), "export const NEW = true;\n");

		const log = createLogExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		await log.execute(
			"l",
			{ metric: 12, status: "discard", description: "regress" },
			undefined,
			undefined,
			createCtx(dir),
		);
		// Pre-existing file untouched
		expect(fs.readFileSync(path.join(dir, "preexisting.txt"), "utf8")).toBe("leave me\n");
		// New untracked file removed
		expect(fs.existsSync(path.join(dir, "src", "new.ts"))).toBe(false);
		// Tracked edit reverted to baseline content
		expect(fs.readFileSync(path.join(dir, "src", "edit-me.ts"), "utf8")).toBe("export const v = 1;\n");
	});

	it("on an autoresearch branch, discard reverts uncommitted changes but preserves prior commits", async () => {
		const dir = makeTempDir();
		await initGitRepo(dir);
		// Commit the harness on main so it is part of the autoresearch branch's baseline.
		await writeHarnessStub(dir);
		await $`git add -A`.cwd(dir).quiet();
		await $`git commit -m harness`.cwd(dir).quiet();
		await checkoutBranch(dir, "autoresearch/test-20260501");
		const runtime = createSessionRuntime();
		const harness = createPiHarness();
		const init = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		await init.execute("i", { name: "x", primary_metric: "m" }, undefined, undefined, createCtx(dir));
		// Simulate a previously kept iteration by committing it directly on the branch.
		await Bun.write(path.join(dir, "src", "kept.ts"), "export const v = 1;\n");
		await $`git add -A`.cwd(dir).quiet();
		await $`git commit -m "kept iteration"`.cwd(dir).quiet();
		const headBeforeDiscard = (await $`git rev-parse HEAD`.cwd(dir).text()).trim();

		const run = createRunExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		await run.execute("r", {}, undefined, undefined, createCtx(dir));
		// Current iteration's uncommitted edits.
		await Bun.write(path.join(dir, "src", "kept.ts"), "export const v = 999;\n");
		await Bun.write(path.join(dir, "scratch.ts"), "// junk\n");

		const log = createLogExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		await log.execute(
			"l",
			{ metric: 12, status: "discard", description: "regress" },
			undefined,
			undefined,
			createCtx(dir),
		);
		const headAfter = (await $`git rev-parse HEAD`.cwd(dir).text()).trim();
		// Prior commits survive — discard does not rewind history.
		expect(headAfter).toBe(headBeforeDiscard);
		// Uncommitted iteration changes are gone.
		expect(fs.readFileSync(path.join(dir, "src", "kept.ts"), "utf8")).toBe("export const v = 1;\n");
		expect(fs.existsSync(path.join(dir, "scratch.ts"))).toBe(false);
		const status = (await $`git status --porcelain`.cwd(dir).text()).trim();
		expect(status).toBe("");
	});

	it("on an autoresearch branch, keep commits files that were dirty before run_experiment", async () => {
		const dir = makeTempDir();
		await initGitRepo(dir);
		await writeHarnessStub(dir);
		await $`git add -A`.cwd(dir).quiet();
		await $`git commit -m harness`.cwd(dir).quiet();
		// Seed a tracked file that the agent will edit during the iteration.
		fs.mkdirSync(path.join(dir, "src"), { recursive: true });
		await Bun.write(path.join(dir, "src", "store.ts"), "export const v = 1;\n");
		await $`git add -A`.cwd(dir).quiet();
		await $`git commit -m seed`.cwd(dir).quiet();
		await checkoutBranch(dir, "autoresearch/keep-test");
		const runtime = createSessionRuntime();
		const harness = createPiHarness();
		const init = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		await init.execute(
			"i",
			{ name: "x", primary_metric: "m", scope_paths: ["src"] },
			undefined,
			undefined,
			createCtx(dir),
		);
		// Agent edits BEFORE running the benchmark — the iteration's diff is dirty
		// at run_experiment time.
		await Bun.write(path.join(dir, "src", "store.ts"), "export const v = 2;\n");
		const run = createRunExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		await run.execute("r", {}, undefined, undefined, createCtx(dir));

		const log = createLogExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		const result = await log.execute(
			"l",
			{ metric: 42, status: "keep", description: "improvement" },
			undefined,
			undefined,
			createCtx(dir),
		);
		const details = result.details as LogDetails;
		expect(details.experiment.modifiedPaths).toContain("src/store.ts");
		const status = (await $`git status --porcelain`.cwd(dir).text()).trim();
		expect(status).toBe("");
		const lastMsg = (await $`git log -1 --pretty=%B`.cwd(dir).text()).trim();
		expect(lastMsg).toContain("improvement");
	});

	it("flags off-scope dirty files even when they were dirty before run_experiment", async () => {
		const dir = makeTempDir();
		await initGitRepo(dir);
		await writeHarnessStub(dir);
		await $`git add -A`.cwd(dir).quiet();
		await $`git commit -m harness`.cwd(dir).quiet();
		await checkoutBranch(dir, "autoresearch/scope-test");
		const runtime = createSessionRuntime();
		const harness = createPiHarness();
		const init = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		await init.execute(
			"i",
			{ name: "x", primary_metric: "m", scope_paths: ["src"], off_limits: ["forbidden"] },
			undefined,
			undefined,
			createCtx(dir),
		);
		// Off-scope edit BEFORE run_experiment.
		fs.mkdirSync(path.join(dir, "forbidden"), { recursive: true });
		await Bun.write(path.join(dir, "forbidden", "x.ts"), "export const v = 1;\n");
		const run = createRunExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		await run.execute("r", {}, undefined, undefined, createCtx(dir));

		const log = createLogExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		const result = await log.execute(
			"l",
			{ metric: 42, status: "keep", description: "off-scope" },
			undefined,
			undefined,
			createCtx(dir),
		);
		const details = result.details as LogDetails;
		expect(details.scopeDeviations).toContain("forbidden/x.ts");
	});
});

describe("update_notes", () => {
	let dbOverride: string;

	beforeEach(() => {
		dbOverride = makeTempDir("pi-autoresearch-notes-db");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbOverride;
	});

	afterEach(() => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		fs.rmSync(dbOverride, { recursive: true, force: true });
	});

	it("replaces session notes and refreshes runtime state", async () => {
		const dir = makeTempDir();
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const harness = createPiHarness();
		const init = createInitExperimentTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		await init.execute("i", { name: "x", primary_metric: "m" }, undefined, undefined, createCtx(dir));
		const notes = createUpdateNotesTool({
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		});
		const result = await notes.execute("n", { body: "## Plan\n- step one\n" }, undefined, undefined, createCtx(dir));
		expect(result.details?.notes).toContain("step one");
		expect(runtime.state.notes).toContain("step one");

		const append = await notes.execute(
			"n2",
			{ body: "", append_idea: "try caching" },
			undefined,
			undefined,
			createCtx(dir),
		);
		expect(append.details?.notes).toContain("- try caching");
		expect(runtime.state.notes).toContain("- try caching");
	});
});

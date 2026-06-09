import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { formatSessionDumpText, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { TempDir } from "@oh-my-pi/pi-utils";
import { generateReport } from "@oh-my-pi/typescript-edit-benchmark/report";
import {
	buildBenchmarkResult,
	type TaskRunResult,
	writeConversationDump,
} from "@oh-my-pi/typescript-edit-benchmark/runner";
import type { EditTask } from "@oh-my-pi/typescript-edit-benchmark/tasks";

const tempDirs: TempDir[] = [];

async function createTempDir(prefix: string): Promise<TempDir> {
	const dir = await TempDir.create(prefix);
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map(async dir => {
			await dir.remove();
		}),
	);
});

function createTask(id: string): EditTask {
	return {
		id,
		name: id,
		prompt: `Fix ${id}`,
		files: [`${id}.ts`],
		inputDir: "/tmp/input",
		expectedDir: "/tmp/expected",
	};
}

function createRun(runIndex: number, success: boolean, overrides: Partial<TaskRunResult> = {}): TaskRunResult {
	return {
		runIndex,
		success,
		patchApplied: success,
		verificationPassed: success,
		tokens: { input: 12, output: 8, total: 20 },
		duration: 100,
		toolCalls: {
			read: 1,
			edit: 1,
			write: 0,
			editSuccesses: success ? 1 : 0,
			editFailures: success ? 0 : 1,
			editWarnings: 0,
			editAutocorrects: 0,
			totalInputChars: 50,
		},
		editFailures: [],
		editWarnings: [],
		editAutocorrectCount: 0,
		...overrides,
	};
}

describe("buildBenchmarkResult", () => {
	it("summarizes completed runs without requiring every scheduled run to finish", () => {
		const completedTask = createTask("completed");
		const pendingTask = createTask("pending");
		const resultsByTask = new Map([[completedTask.id, [createRun(0, true)]]]);

		const result = buildBenchmarkResult({
			tasks: [completedTask, pendingTask],
			config: {
				provider: "anthropic",
				model: "claude",
				runsPerTask: 2,
				timeout: 1000,
				taskConcurrency: 1,
			},
			resultsByTask,
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		expect(result.summary.totalTasks).toBe(2);
		expect(result.summary.totalRuns).toBe(1);
		expect(result.summary.successfulRuns).toBe(1);
		expect(result.tasks.find(task => task.id === "pending")?.runs).toEqual([]);
		expect(result.startTime).toBe("2026-04-28T00:00:00.000Z");
		expect(result.endTime).toBe("2026-04-28T00:00:01.000Z");
	});

	it("can generate a report before any run completes", () => {
		const result = buildBenchmarkResult({
			tasks: [createTask("pending")],
			config: {
				provider: "anthropic",
				model: "claude",
				runsPerTask: 2,
				timeout: 1000,
				taskConcurrency: 1,
			},
			resultsByTask: new Map(),
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		expect(result.summary.totalRuns).toBe(0);
		expect(generateReport(result)).toContain("| Total Runs | 0 |");
	});

	it("renders atom input args directly in edit error patch blocks", () => {
		const task = createTask("atom");
		const titleExpression = "$" + "{title}";
		const input = [
			"---orcid.ts",
			"276ka=    if (works.length > 0) {",
			"277fo=      for (const title of works) {",
			`278hu=        md += \`- ${titleExpression}\\n\`;`,
			"279he=      }",
			"280nd=    } else {",
			"281he=      md += 'No works available.\\n';",
			"282rd=    }",
		].join("\n");
		const failedRun: TaskRunResult = {
			...createRun(0, false),
			editFailures: [{ toolCallId: "edit-1", args: { input }, error: "No changes made" }],
		};
		const result = buildBenchmarkResult({
			tasks: [task],
			config: {
				provider: "anthropic",
				model: "claude",
				runsPerTask: 1,
				timeout: 1000,
				taskConcurrency: 1,
				editVariant: "atom",
			},
			resultsByTask: new Map([[task.id, [failedRun]]]),
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		const report = generateReport(result);
		expect(report).toContain(`\`\`\`diff\n${input}\n\`\`\``);
		expect(report).not.toContain('"input":');
	});

	it("summarizes edit failure categories including range-continuation", () => {
		const task = createTask("range");
		const input = "1aa..3cc=first\nsecond";
		const failedRun: TaskRunResult = {
			...createRun(0, false),
			editFailures: [
				{
					toolCallId: "edit-1",
					args: { input },
					error: "Diff line 2: unrecognized op.",
					category: "range-continuation",
				},
			],
		};
		const result = buildBenchmarkResult({
			tasks: [task],
			config: {
				provider: "anthropic",
				model: "claude",
				runsPerTask: 1,
				timeout: 1000,
				taskConcurrency: 1,
				editVariant: "atom",
			},
			resultsByTask: new Map([[task.id, [failedRun]]]),
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		expect(result.summary.editFailureCategories["range-continuation"]).toBe(1);
		const report = generateReport(result);
		expect(report).toContain("| range-continuation | 1 | 100.0% |");
		expect(report).toContain("- Category: range-continuation");
	});

	it("picks the successful run with the lowest tokens as the task best", () => {
		const task = createTask("best");
		const losing = createRun(0, false, { tokens: { input: 5, output: 5, total: 10 } });
		const winning = createRun(1, true, { tokens: { input: 100, output: 50, total: 150 } });
		const expensive = createRun(2, true, { tokens: { input: 500, output: 250, total: 750 } });
		const result = buildBenchmarkResult({
			tasks: [task],
			config: {
				provider: "anthropic",
				model: "claude",
				runsPerTask: 3,
				timeout: 1000,
				taskConcurrency: 1,
			},
			resultsByTask: new Map([[task.id, [losing, winning, expensive]]]),
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		const taskResult = result.tasks[0]!;
		expect(taskResult.success).toBe(true);
		expect(taskResult.bestRunIndex).toBe(1);
		expect(taskResult.tokens.total).toBe(150);
		expect(result.summary.successfulTasks).toBe(1);
		expect(result.summary.successfulRuns).toBe(2);
		expect(result.summary.totalTokens.total).toBe(150);
		expect(result.summary.taskSuccessRate).toBe(1);
		expect(result.summary.flakyTasks).toBe(1);
		expect(result.summary.consistentlyPassingTasks).toBe(0);
	});

	it("falls back to the cheapest failure when no run succeeded", () => {
		const task = createTask("none");
		const expensiveFail = createRun(0, false, { tokens: { input: 200, output: 100, total: 300 } });
		const cheapFail = createRun(1, false, { tokens: { input: 20, output: 10, total: 30 } });
		const result = buildBenchmarkResult({
			tasks: [task],
			config: {
				provider: "anthropic",
				model: "claude",
				runsPerTask: 2,
				timeout: 1000,
				taskConcurrency: 1,
			},
			resultsByTask: new Map([[task.id, [expensiveFail, cheapFail]]]),
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		const taskResult = result.tasks[0]!;
		expect(taskResult.success).toBe(false);
		expect(taskResult.bestRunIndex).toBe(1);
		expect(taskResult.tokens.total).toBe(30);
		expect(result.summary.successfulTasks).toBe(0);
		expect(result.summary.taskSuccessRate).toBe(0);
	});

	it("ignores ghost runs when picking the best non-successful run", () => {
		const task = createTask("ghost");
		const ghostRun = createRun(0, false, {
			tokens: { input: 0, output: 0, total: 0 },
			toolCalls: {
				read: 0,
				edit: 0,
				write: 0,
				editSuccesses: 0,
				editFailures: 0,
				editWarnings: 0,
				editAutocorrects: 0,
				totalInputChars: 0,
			},
		});
		const realFailure = createRun(1, false, { tokens: { input: 40, output: 20, total: 60 } });
		const result = buildBenchmarkResult({
			tasks: [task],
			config: {
				provider: "anthropic",
				model: "claude",
				runsPerTask: 2,
				timeout: 1000,
				taskConcurrency: 1,
			},
			resultsByTask: new Map([[task.id, [ghostRun, realFailure]]]),
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		const taskResult = result.tasks[0]!;
		expect(taskResult.bestRunIndex).toBe(1);
		expect(taskResult.tokens.total).toBe(60);
		expect(result.summary.ghostRuns).toBe(1);
	});

	it("reports median, p1, and p99 token stats across best runs", () => {
		// Five tasks, each a single successful best run with a distinct token cost.
		const totals = [110, 220, 330, 440, 550];
		const tasks = totals.map((_, i) => createTask(`t${i}`));
		const resultsByTask = new Map(
			totals.map((total, i) => [
				tasks[i]!.id,
				[createRun(0, true, { tokens: { input: (i + 1) * 100, output: (i + 1) * 10, total } })],
			]),
		);

		const result = buildBenchmarkResult({
			tasks,
			config: {
				provider: "anthropic",
				model: "claude",
				runsPerTask: 1,
				timeout: 1000,
				taskConcurrency: 1,
			},
			resultsByTask,
			startTime: "2026-04-28T00:00:00.000Z",
			endTime: "2026-04-28T00:00:01.000Z",
		});

		const { summary } = result;
		// Mean is unchanged by the new fields: total sum 1650 / 5 tasks = 330.
		expect(summary.avgTokensPerTask.total).toBe(330);
		// Median = the middle sample (linear interpolation at rank 2 of [110..550]).
		expect(summary.medianTokensPerTask).toEqual({ input: 300, output: 30, total: 330 });
		// p1/p99 interpolate near the extremes (ranks 0.04 and 3.96 over 5 samples).
		expect(summary.p1TokensPerTask).toEqual({ input: 104, output: 10, total: 114 });
		expect(summary.p99TokensPerTask).toEqual({ input: 496, output: 50, total: 546 });
	});
});

describe("writeConversationDump", () => {
	it("writes benchmark conversations as session dumps and copies artifacts", async () => {
		const sourceRoot = await createTempDir("@typescript-edit-benchmark-source-");
		const dumpRoot = await createTempDir("@typescript-edit-benchmark-dump-");
		const sourceWorkDir = sourceRoot.join("worktree");
		const sourceSessionDir = sourceRoot.join("sessions");
		await fs.mkdir(sourceWorkDir, { recursive: true });
		await fs.mkdir(sourceSessionDir, { recursive: true });

		const sourceSession = SessionManager.create(sourceWorkDir, sourceSessionDir);
		const userMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "Fix the failing benchmark." }],
			attribution: "user",
			timestamp: Date.now(),
		};
		sourceSession.appendMessage(userMessage);
		await sourceSession.ensureOnDisk();
		const artifactId = await sourceSession.saveArtifact("artifact contents", "read");
		await sourceSession.flush();
		await sourceSession.close();

		const sourceSessionFile = sourceSession.getSessionFile();
		if (!sourceSessionFile || !artifactId) {
			throw new Error("Test fixture failed to create source session dump");
		}
		const sourceArtifactPath = await sourceSession.getArtifactPath(artifactId);
		if (!sourceArtifactPath) {
			throw new Error("Test fixture failed to resolve source artifact path");
		}

		const dumpPath = await writeConversationDump({
			dumpDir: dumpRoot.absolute(),
			taskId: "task/weird",
			runIndex: 0,
			snapshot: {
				messages: [userMessage],
				sourceSessionFile,
			},
		});

		expect(dumpPath).toBe(path.join(dumpRoot.absolute(), "task_weird", "run-1.md"));

		const dumpText = await Bun.file(dumpPath).text();
		const expectedBody = formatSessionDumpText({ messages: [userMessage] });
		expect(dumpText.trim()).toBe(expectedBody.trim());

		const copiedArtifactPath = path.join(dumpPath.slice(0, -3), path.basename(sourceArtifactPath));
		expect(await Bun.file(copiedArtifactPath).text()).toBe("artifact contents");
	});
});

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Text } from "@oh-my-pi/pi-tui";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../../extensibility/extensions";
import type { Theme } from "../../modes/theme/theme";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "../../session/streaming-output";
import { replaceTabs, shortenPath } from "../../tools/render-utils";
import * as git from "../../utils/git";
import { parseWorkDirDirtyPaths } from "../git";
import {
	EXPERIMENT_MAX_BYTES,
	EXPERIMENT_MAX_LINES,
	formatElapsed,
	formatNum,
	killTree,
	parseAsiLines,
	parseMetricLines,
	tryGitPrefix,
	tryGitStatus,
} from "../helpers";
import { buildExperimentState } from "../state";
import { openAutoresearchStorageIfExists } from "../storage";
import type { AutoresearchToolFactoryOptions, RunDetails, RunExperimentProgressDetails } from "../types";
import { DEFAULT_HARNESS_COMMAND } from "./init-experiment";

const runExperimentSchema = Type.Object({
	timeout_seconds: Type.Optional(Type.Number({ description: "Timeout in seconds. Defaults to 600." })),
});

interface ProcessExecutionResult {
	exitCode: number | null;
	killed: boolean;
	logPath: string;
	output: string;
}

interface ProgressSnapshot {
	elapsed: string;
	runDirectory: string;
	fullOutputPath: string;
	tailOutput: string;
	truncation?: RunExperimentProgressDetails["truncation"];
}

export function createRunExperimentTool(
	options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof runExperimentSchema, RunDetails | RunExperimentProgressDetails> {
	return {
		name: "run_experiment",
		label: "Run Experiment",
		description:
			"Run any benchmark command. Output is captured automatically; `METRIC name=value` and `ASI key=value` lines printed by the command are parsed.",
		parameters: runExperimentSchema,
		defaultInactive: true,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const storage = await openAutoresearchStorageIfExists(ctx.cwd);
			const currentBranch = (await git.branch.current(ctx.cwd)) ?? null;
			const session = storage?.getActiveSessionForBranch(currentBranch) ?? null;
			if (!storage || !session) {
				return {
					content: [
						{
							type: "text",
							text: "Error: no active autoresearch session for the current branch. Call init_experiment first.",
						},
					],
				};
			}

			const runtime = options.getRuntime(ctx);

			const abandonedPriorRun = (() => {
				const pending = storage.getPendingRun(session.id);
				if (!pending) return null;
				storage.abandonPendingRuns(session.id);
				return pending.id;
			})();

			const resolvedCommand = DEFAULT_HARNESS_COMMAND;
			const preRunStatus = await tryGitStatus(ctx.cwd);
			const workDirPrefix = await tryGitPrefix(ctx.cwd);
			const preRunDirtyPaths = parseWorkDirDirtyPaths(preRunStatus, workDirPrefix);

			const startedAt = Date.now();
			const insertedRun = storage.insertRun({
				sessionId: session.id,
				segment: session.currentSegment,
				command: resolvedCommand,
				logPath: "", // patched after we know the run id
				preRunDirtyPaths,
				startedAt,
			});

			const runDirectory = path.join(storage.projectDir, "runs", String(insertedRun.id).padStart(4, "0"));
			const benchmarkLogPath = path.join(runDirectory, "benchmark.log");
			fs.mkdirSync(runDirectory, { recursive: true });
			storage.updateRunLogPath(insertedRun.id, benchmarkLogPath);

			runtime.lastRunDuration = null;
			runtime.lastRunAsi = null;
			runtime.lastRunArtifactDir = runDirectory;
			runtime.lastRunNumber = insertedRun.id;
			runtime.lastRunSummary = null;
			runtime.runningExperiment = {
				startedAt,
				command: resolvedCommand,
				runDirectory,
				runNumber: insertedRun.id,
			};
			options.dashboard.updateWidget(ctx, runtime);
			options.dashboard.requestRender();

			const timeoutMs = Math.max(0, Math.floor((params.timeout_seconds ?? 600) * 1000));
			let execution: ProcessExecutionResult;
			try {
				execution = await executeProcess({
					command: ["bash", "-lc", resolvedCommand],
					cwd: ctx.cwd,
					logPath: benchmarkLogPath,
					timeoutMs,
					signal,
					onProgress: details => {
						onUpdate?.({
							content: [{ type: "text", text: details.tailOutput }],
							details: {
								phase: "running",
								elapsed: details.elapsed,
								truncation: details.truncation,
								fullOutputPath: details.fullOutputPath,
								runDirectory: details.runDirectory,
							},
						});
					},
				});
			} finally {
				runtime.runningExperiment = null;
				options.dashboard.updateWidget(ctx, runtime);
				options.dashboard.requestRender();
			}

			const completedAt = Date.now();
			const durationMs = completedAt - startedAt;
			const durationSeconds = durationMs / 1000;
			runtime.lastRunDuration = durationSeconds;

			const llmTruncation = truncateTail(execution.output, {
				maxBytes: EXPERIMENT_MAX_BYTES,
				maxLines: EXPERIMENT_MAX_LINES,
			});
			const displayTruncation = truncateTail(execution.output, {
				maxBytes: DEFAULT_MAX_BYTES,
				maxLines: DEFAULT_MAX_LINES,
			});

			const parsedMetricsMap = parseMetricLines(execution.output);
			const parsedMetrics = parsedMetricsMap.size > 0 ? Object.fromEntries(parsedMetricsMap.entries()) : null;
			const parsedPrimary = parsedMetricsMap.get(session.primaryMetric) ?? null;
			const parsedAsi = parseAsiLines(execution.output);
			runtime.lastRunAsi = parsedAsi;

			storage.markRunCompleted({
				runId: insertedRun.id,
				completedAt,
				durationMs,
				exitCode: execution.exitCode,
				timedOut: execution.killed,
				parsedPrimary,
				parsedMetrics,
				parsedAsi,
			});

			const passed = execution.exitCode === 0 && !execution.killed;
			const resultDetails: RunDetails = {
				runNumber: insertedRun.id,
				runDirectory,
				benchmarkLogPath,
				command: resolvedCommand,
				exitCode: execution.exitCode,
				durationSeconds,
				passed,
				crashed: execution.exitCode !== 0 || execution.killed,
				timedOut: execution.killed,
				tailOutput: displayTruncation.content,
				parsedMetrics,
				parsedPrimary,
				parsedAsi,
				metricName: session.primaryMetric,
				metricUnit: session.metricUnit,
				preRunDirtyPaths,
				abandonedPriorRun,
				truncation: llmTruncation.truncated ? llmTruncation : undefined,
				fullOutputPath: execution.logPath,
			};

			runtime.lastRunSummary = {
				command: resolvedCommand,
				durationSeconds,
				parsedAsi,
				parsedMetrics,
				parsedPrimary,
				passed,
				preRunDirtyPaths,
				runDirectory,
				runNumber: insertedRun.id,
				exitCode: execution.exitCode,
				timedOut: execution.killed,
			};
			runtime.autoResumeArmed = true;
			runtime.lastAutoResumePendingRunNumber = null;

			// Refresh state to reflect any prior abandonment changes (logged set unchanged).
			const refreshedSession = storage.getSessionById(session.id);
			if (refreshedSession) {
				runtime.state = buildExperimentState(refreshedSession, storage.listLoggedRuns(session.id));
			}
			options.dashboard.updateWidget(ctx, runtime);
			options.dashboard.requestRender();

			const headerLines: string[] = [];
			if (abandonedPriorRun !== null) {
				headerLines.push(`Note: abandoned prior pending run #${abandonedPriorRun} before starting this run.`);
			}
			const warningPrefix = headerLines.length > 0 ? `${headerLines.join("\n")}\n\n` : "";

			return {
				content: [
					{
						type: "text",
						text: warningPrefix + buildRunText(resultDetails, llmTruncation.content, runtime.state.bestMetric),
					},
				],
				details: resultDetails,
			};
		},
		renderCall(_args, _options, theme): Text {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("run_experiment"))} ${theme.fg("muted", DEFAULT_HARNESS_COMMAND)}`,
				0,
				0,
			);
		},
		renderResult(result, options, theme): Text {
			if (isProgressDetails(result.details)) {
				const header = theme.fg("warning", `Running ${result.details.elapsed}...`);
				const preview = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
				return new Text(preview ? `${header}\n${theme.fg("dim", preview)}` : header, 0, 0);
			}
			const details = result.details;
			if (!details || !isRunDetails(details)) {
				return new Text(replaceTabs(result.content.find(part => part.type === "text")?.text ?? ""), 0, 0);
			}
			const statusText = renderStatus(details, theme);
			if (!options.expanded && details.tailOutput.trim().length === 0) {
				return new Text(statusText, 0, 0);
			}
			const preview = replaceTabs(
				options.expanded ? details.tailOutput : details.tailOutput.split("\n").slice(-5).join("\n"),
			);
			const suffix =
				options.expanded && details.truncation && details.fullOutputPath
					? `\n${theme.fg("warning", `Full output: ${shortenPath(details.fullOutputPath)}`)}`
					: "";
			return new Text(preview ? `${statusText}\n${theme.fg("dim", preview)}${suffix}` : statusText, 0, 0);
		},
	};
}
async function executeProcess(opts: {
	command: string[];
	cwd: string;
	logPath: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onProgress?(details: ProgressSnapshot): void;
}): Promise<ProcessExecutionResult> {
	const { promise, resolve, reject } = Promise.withResolvers<ProcessExecutionResult>();
	const child = childProcess.spawn(opts.command[0] ?? "bash", opts.command.slice(1), {
		cwd: opts.cwd,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});

	const tailChunks: Buffer[] = [];
	let chunksBytes = 0;
	let killedByTimeout = false;
	let resolved = false;
	let writeStream: fs.WriteStream | undefined = fs.createWriteStream(opts.logPath);
	let forceKillTimeout: NodeJS.Timeout | undefined;

	const closeWriteStream = (): Promise<void> => {
		if (!writeStream) return Promise.resolve();
		const stream = writeStream;
		writeStream = undefined;
		return new Promise<void>((resolveClose, rejectClose) => {
			stream.end((error?: Error | null) => {
				if (error) {
					rejectClose(error);
					return;
				}
				resolveClose();
			});
		});
	};

	const cleanup = (): void => {
		if (progressTimer) clearInterval(progressTimer);
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (forceKillTimeout) clearTimeout(forceKillTimeout);
		opts.signal?.removeEventListener("abort", abortHandler);
	};

	const finish = (callback: () => void): void => {
		if (resolved) return;
		resolved = true;
		cleanup();
		callback();
	};

	const appendChunk = (data: Buffer): void => {
		writeStream?.write(data);
		tailChunks.push(data);
		chunksBytes += data.length;
		while (chunksBytes > DEFAULT_MAX_BYTES * 2 && tailChunks.length > 1) {
			const removed = tailChunks.shift();
			if (removed) chunksBytes -= removed.length;
		}
	};

	const snapshot = (): ProgressSnapshot => {
		const tail = truncateTail(Buffer.concat(tailChunks).toString("utf8"), {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
		});
		return {
			elapsed: formatElapsed(Date.now() - startedAt),
			runDirectory: path.dirname(opts.logPath),
			fullOutputPath: opts.logPath,
			tailOutput: tail.content,
			truncation: tail.truncated ? tail : undefined,
		};
	};

	const killTreeWithEscalation = (): void => {
		if (!child.pid) return;
		killTree(child.pid);
		forceKillTimeout = setTimeout(() => {
			if (child.pid) killTree(child.pid, "SIGKILL");
		}, 1_000);
		forceKillTimeout.unref?.();
	};

	const startedAt = Date.now();
	const progressTimer = opts.onProgress
		? setInterval(() => {
				opts.onProgress?.(snapshot());
			}, 1000)
		: undefined;
	const timeoutHandle =
		opts.timeoutMs > 0
			? setTimeout(() => {
					killedByTimeout = true;
					killTreeWithEscalation();
				}, opts.timeoutMs)
			: undefined;

	const abortHandler = (): void => {
		killTreeWithEscalation();
	};
	if (opts.signal?.aborted) {
		abortHandler();
	} else {
		opts.signal?.addEventListener("abort", abortHandler, { once: true });
	}

	child.stdout?.on("data", data => {
		appendChunk(data);
	});
	child.stderr?.on("data", data => {
		appendChunk(data);
	});
	child.on("error", error => {
		void closeWriteStream().finally(() => {
			finish(() => reject(error));
		});
	});
	child.on("close", async code => {
		try {
			await closeWriteStream();
			if (opts.signal?.aborted) {
				finish(() => reject(new Error("aborted")));
				return;
			}
			const output = await fs.promises.readFile(opts.logPath, "utf8");
			finish(() =>
				resolve({
					exitCode: code,
					killed: killedByTimeout,
					logPath: opts.logPath,
					output,
				}),
			);
		} catch (error) {
			finish(() => reject(error));
		}
	});

	return promise;
}

function buildRunText(details: RunDetails, outputPreview: string, bestMetric: number | null): string {
	const lines: string[] = [];
	lines.push(`Run #${details.runNumber} directory: ${details.runDirectory}`);
	if (details.timedOut) {
		lines.push(`TIMEOUT after ${details.durationSeconds.toFixed(1)}s`);
	} else if (details.exitCode !== 0) {
		lines.push(`FAILED with exit code ${details.exitCode} in ${details.durationSeconds.toFixed(1)}s`);
	} else {
		lines.push(`PASSED in ${details.durationSeconds.toFixed(1)}s`);
	}
	if (bestMetric !== null) {
		lines.push(`Current baseline ${details.metricName}: ${formatNum(bestMetric, details.metricUnit)}`);
	}
	if (details.parsedPrimary !== null) {
		lines.push(`Parsed ${details.metricName}: ${details.parsedPrimary}`);
		lines.push(`Next log_experiment metric: ${details.parsedPrimary}`);
	}
	if (details.parsedMetrics) {
		const secondaryEntries = Object.entries(details.parsedMetrics)
			.filter(([name]) => name !== details.metricName)
			.map(([name, value]) => [name, value] as const);
		const secondary = secondaryEntries.map(([name, value]) => `${name}=${value}`);
		if (secondary.length > 0) {
			lines.push(`Parsed metrics: ${secondary.join(", ")}`);
			lines.push(`Next log_experiment metrics: ${JSON.stringify(Object.fromEntries(secondaryEntries))}`);
		}
	}
	if (details.parsedAsi) {
		lines.push(`Parsed ASI keys: ${Object.keys(details.parsedAsi).join(", ")}`);
	}
	lines.push("");
	lines.push(outputPreview);
	if (details.truncation && details.fullOutputPath) {
		lines.push("");
		lines.push(
			`Output truncated (${formatBytes(EXPERIMENT_MAX_BYTES)} limit). Full output: ${details.fullOutputPath}`,
		);
	}
	return lines.join("\n").trimEnd();
}

function renderStatus(details: RunDetails, theme: Theme): string {
	if (details.timedOut) {
		return theme.fg("error", `TIMEOUT ${details.durationSeconds.toFixed(1)}s`);
	}
	if (details.exitCode !== 0) {
		return theme.fg("error", `FAIL exit=${details.exitCode} ${details.durationSeconds.toFixed(1)}s`);
	}
	const metric =
		details.parsedPrimary !== null
			? ` ${details.metricName}=${formatNum(details.parsedPrimary, details.metricUnit)}`
			: "";
	return theme.fg("success", `PASS ${details.durationSeconds.toFixed(1)}s${metric}`);
}

function isRunDetails(value: unknown): value is RunDetails {
	if (typeof value !== "object" || value === null) return false;
	return "command" in value && "durationSeconds" in value;
}

function isProgressDetails(value: unknown): value is RunExperimentProgressDetails {
	if (typeof value !== "object" || value === null) return false;
	return "phase" in value && (value as { phase: unknown }).phase === "running";
}

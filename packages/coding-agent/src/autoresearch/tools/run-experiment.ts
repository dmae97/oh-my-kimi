import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Text } from "@oh-my-pi/pi-tui";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../../extensibility/extensions";
import type { Theme } from "../../modes/theme/theme";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "../../session/streaming-output";
import { replaceTabs, shortenPath, truncateToWidth } from "../../tools/render-utils";
import * as git from "../../utils/git";
import { parseWorkDirDirtyPaths } from "../git";
import {
	collectLoggedRunNumbers,
	EXPERIMENT_MAX_BYTES,
	EXPERIMENT_MAX_LINES,
	formatElapsed,
	formatNum,
	getAutoresearchRunDirectory,
	getNextAutoresearchRunNumber,
	isAutoresearchLocalStatePath,
	isAutoresearchShCommand,
	killTree,
	parseAsiLines,
	parseMetricLines,
	readPendingRunSummary,
	resolveWorkDir,
	validateWorkDir,
} from "../helpers";
import type { AutoresearchToolFactoryOptions, RunDetails, RunExperimentProgressDetails } from "../types";

const runExperimentSchema = Type.Object({
	command: Type.String({
		description: "Shell command to run for this experiment.",
	}),
	timeout_seconds: Type.Optional(
		Type.Number({
			description: "Timeout in seconds. Defaults to 600.",
		}),
	),
	checks_timeout_seconds: Type.Optional(
		Type.Number({
			description: "Timeout in seconds for autoresearch.checks.sh. Defaults to 300.",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description:
				"When true, allow a command that differs from the segment benchmark command and skip the rule that autoresearch.sh must be invoked directly when that script exists.",
		}),
	),
});

interface ProcessExecutionResult {
	exitCode: number | null;
	killed: boolean;
	logPath: string;
	output: string;
}

interface ChecksExecutionResult {
	code: number | null;
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
			"Run an experiment command with timing, output capture, structured metric parsing, durable run artifacts, and optional autoresearch.checks.sh validation.",
		parameters: runExperimentSchema,
		defaultInactive: true,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const workDirError = validateWorkDir(ctx.cwd);
			if (workDirError) {
				return {
					content: [{ type: "text", text: `Error: ${workDirError}` }],
				};
			}

			const runtime = options.getRuntime(ctx);
			const state = runtime.state;
			const workDir = resolveWorkDir(ctx.cwd);
			const checksPath = path.join(workDir, "autoresearch.checks.sh");
			const autoresearchScriptPath = path.join(workDir, "autoresearch.sh");

			const forceCommand = params.force === true;
			if (!forceCommand && state.benchmarkCommand && params.command.trim() !== state.benchmarkCommand) {
				return {
					content: [
						{
							type: "text",
							text:
								"Error: command does not match the benchmark command recorded for this segment.\n" +
								`Expected: ${state.benchmarkCommand}\nReceived: ${params.command}`,
						},
					],
				};
			}

			if (!forceCommand && fs.existsSync(autoresearchScriptPath) && !isAutoresearchShCommand(params.command)) {
				return {
					content: [
						{
							type: "text",
							text:
								`Error: autoresearch.sh exists. Run it directly instead of using a different command.\n` +
								`Expected something like: bash autoresearch.sh\n` +
								`Received: ${params.command}`,
						},
					],
				};
			}

			if (state.maxExperiments !== null) {
				const segmentRuns = state.results.filter(result => result.segment === state.currentSegment).length;
				if (segmentRuns >= state.maxExperiments) {
					return {
						content: [
							{
								type: "text",
								text: `Maximum experiments reached (${state.maxExperiments}). Re-initialize to start a new segment.`,
							},
						],
					};
				}
			}

			const pendingRun =
				runtime.lastRunSummary ?? (await readPendingRunSummary(workDir, collectLoggedRunNumbers(state.results)));
			if (pendingRun) {
				return {
					content: [
						{
							type: "text",
							text:
								`Error: run #${pendingRun.runNumber} has not been logged yet. ` +
								"Call log_experiment before starting another benchmark run.",
						},
					],
				};
			}

			const runNumber = getNextAutoresearchRunNumber(workDir, runtime.lastRunNumber);
			const runDirectory = getAutoresearchRunDirectory(workDir, runNumber);
			const benchmarkLogPath = path.join(runDirectory, "benchmark.log");
			const checksLogPath = path.join(runDirectory, "checks.log");
			const runJsonPath = path.join(runDirectory, "run.json");
			await fs.promises.mkdir(runDirectory, { recursive: true });

			const preRunStatus = await git.status(workDir, {
				porcelainV1: true,
				untrackedFiles: "all",
				z: true,
			});
			const workDirPrefix = await git.show.prefix(workDir);
			const preRunDirtyPaths = parseWorkDirDirtyPaths(preRunStatus, workDirPrefix).filter(
				p => !isAutoresearchLocalStatePath(p),
			);

			runtime.lastRunChecks = null;
			runtime.lastRunDuration = null;
			runtime.lastRunAsi = null;
			runtime.lastRunArtifactDir = runDirectory;
			runtime.lastRunNumber = runNumber;
			runtime.lastRunSummary = null;
			await Bun.write(
				runJsonPath,
				JSON.stringify(
					{
						runNumber,
						runDirectory,
						benchmarkLogPath,
						checksLogPath,
						command: params.command,
						preRunDirtyPaths,
						startedAt: new Date().toISOString(),
					},
					null,
					2,
				),
			);

			runtime.runningExperiment = {
				startedAt: Date.now(),
				command: params.command,
				runDirectory,
				runNumber,
			};
			options.dashboard.updateWidget(ctx, runtime);
			options.dashboard.requestRender();

			const timeoutMs = Math.max(0, Math.floor((params.timeout_seconds ?? 600) * 1000));
			const startedAt = Date.now();
			let execution: ProcessExecutionResult;
			try {
				execution = await executeProcess({
					command: ["bash", "-lc", params.command],
					cwd: workDir,
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

			const durationSeconds = (Date.now() - startedAt) / 1000;
			runtime.lastRunDuration = durationSeconds;

			const benchmarkPassed = execution.exitCode === 0 && !execution.killed;
			let checksPass: boolean | null = null;
			let checksTimedOut = false;
			let checksOutput = "";
			let checksDuration = 0;
			let checksLogPathValue: string | undefined;

			if (benchmarkPassed && fs.existsSync(checksPath)) {
				const checksStartedAt = Date.now();
				const checksResult = await runChecks({
					cwd: workDir,
					pathToChecks: checksPath,
					logPath: checksLogPath,
					timeoutMs: Math.max(0, Math.floor((params.checks_timeout_seconds ?? 300) * 1000)),
					signal,
				});
				checksDuration = (Date.now() - checksStartedAt) / 1000;
				checksTimedOut = checksResult.killed;
				checksPass = checksResult.code === 0 && !checksResult.killed;
				checksOutput = checksResult.output;
				checksLogPathValue = checksResult.logPath;
			}

			runtime.lastRunChecks =
				checksPass === null
					? null
					: {
							pass: checksPass,
							output: checksOutput,
							duration: checksDuration,
						};

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
			const parsedPrimary = parsedMetricsMap.get(state.metricName) ?? null;
			const parsedAsi = parseAsiLines(execution.output);
			runtime.lastRunAsi = parsedAsi;

			const resultDetails: RunDetails = {
				runNumber,
				runDirectory,
				benchmarkLogPath,
				checksLogPath: checksLogPathValue,
				command: params.command,
				exitCode: execution.exitCode,
				durationSeconds,
				passed: benchmarkPassed && (checksPass === null || checksPass),
				crashed: execution.exitCode !== 0 || execution.killed || checksPass === false,
				timedOut: execution.killed,
				tailOutput: displayTruncation.content,
				checksPass,
				checksTimedOut,
				checksOutput: checksOutput.split("\n").slice(-80).join("\n"),
				checksDuration,
				parsedMetrics,
				parsedPrimary,
				parsedAsi,
				metricName: state.metricName,
				metricUnit: state.metricUnit,
				preRunDirtyPaths,
				truncation: llmTruncation.truncated ? llmTruncation : undefined,
				fullOutputPath: execution.logPath,
			};
			runtime.lastRunSummary = {
				checksDurationSeconds: checksDuration,
				checksPass,
				checksTimedOut,
				command: params.command,
				durationSeconds,
				parsedAsi,
				parsedMetrics,
				parsedPrimary,
				passed: resultDetails.passed,
				preRunDirtyPaths,
				runDirectory,
				runNumber,
			};
			runtime.autoResumeArmed = true;
			runtime.lastAutoResumePendingRunNumber = null;
			options.dashboard.updateWidget(ctx, runtime);
			options.dashboard.requestRender();

			await Bun.write(
				runJsonPath,
				JSON.stringify(
					{
						runNumber,
						runDirectory,
						benchmarkLogPath,
						checksLogPath: checksLogPathValue,
						command: params.command,
						completedAt: new Date().toISOString(),
						durationSeconds,
						exitCode: execution.exitCode,
						timedOut: execution.killed,
						checks: {
							durationSeconds: checksDuration,
							passed: checksPass,
							timedOut: checksTimedOut,
						},
						parsedMetrics,
						parsedPrimary,
						parsedAsi,
						preRunDirtyPaths,
						truncation: resultDetails.truncation,
						fullOutputPath: resultDetails.fullOutputPath,
					},
					null,
					2,
				),
			);

			const commandWarnings: string[] = [];
			if (forceCommand) {
				if (state.benchmarkCommand && params.command.trim() !== state.benchmarkCommand) {
					commandWarnings.push(
						`Warning: command override (force=true). Segment benchmark is ${state.benchmarkCommand}; ran ${params.command}.`,
					);
				}
				if (fs.existsSync(autoresearchScriptPath) && !isAutoresearchShCommand(params.command)) {
					commandWarnings.push(
						"Warning: autoresearch.sh exists but the command was not a direct autoresearch.sh invocation (force=true).",
					);
				}
			}
			const warningPrefix = commandWarnings.length > 0 ? `${commandWarnings.join("\n")}\n\n` : "";

			return {
				content: [
					{
						type: "text",
						text: warningPrefix + buildRunText(resultDetails, llmTruncation.content, state.bestMetric),
					},
				],
				details: resultDetails,
			};
		},
		renderCall(args, _options, theme): Text {
			const commandPreview = truncateToWidth(replaceTabs(args.command), 100);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("run_experiment"))} ${theme.fg("muted", commandPreview)}`,
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

async function executeProcess(options: {
	command: string[];
	cwd: string;
	logPath: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onProgress?(details: ProgressSnapshot): void;
}): Promise<ProcessExecutionResult> {
	const { promise, resolve, reject } = Promise.withResolvers<ProcessExecutionResult>();
	const child = childProcess.spawn(options.command[0] ?? "bash", options.command.slice(1), {
		cwd: options.cwd,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});

	const tailChunks: Buffer[] = [];
	let chunksBytes = 0;
	let killedByTimeout = false;
	let resolved = false;
	let writeStream: fs.WriteStream | undefined = fs.createWriteStream(options.logPath);
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
		options.signal?.removeEventListener("abort", abortHandler);
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
			runDirectory: path.dirname(options.logPath),
			fullOutputPath: options.logPath,
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
	const progressTimer = options.onProgress
		? setInterval(() => {
				options.onProgress?.(snapshot());
			}, 1000)
		: undefined;
	const timeoutHandle =
		options.timeoutMs > 0
			? setTimeout(() => {
					killedByTimeout = true;
					killTreeWithEscalation();
				}, options.timeoutMs)
			: undefined;

	const abortHandler = (): void => {
		killTreeWithEscalation();
	};
	if (options.signal?.aborted) {
		abortHandler();
	} else {
		options.signal?.addEventListener("abort", abortHandler, { once: true });
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
			if (options.signal?.aborted) {
				finish(() => reject(new Error("aborted")));
				return;
			}
			const output = await fs.promises.readFile(options.logPath, "utf8");
			finish(() =>
				resolve({
					exitCode: code,
					killed: killedByTimeout,
					logPath: options.logPath,
					output,
				}),
			);
		} catch (error) {
			finish(() => reject(error));
		}
	});

	return promise;
}

async function runChecks(options: {
	cwd: string;
	pathToChecks: string;
	logPath: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<ChecksExecutionResult> {
	const result = await executeProcess({
		command: ["bash", options.pathToChecks],
		cwd: options.cwd,
		logPath: options.logPath,
		timeoutMs: options.timeoutMs,
		signal: options.signal,
	});
	return {
		code: result.exitCode,
		killed: result.killed,
		logPath: result.logPath,
		output: result.output.trim(),
	};
}

function buildRunText(details: RunDetails, outputPreview: string, bestMetric: number | null): string {
	const lines: string[] = [];
	lines.push(`Run directory: ${details.runDirectory}`);
	if (details.timedOut) {
		lines.push(`TIMEOUT after ${details.durationSeconds.toFixed(1)}s`);
	} else if (details.exitCode !== 0) {
		lines.push(`FAILED with exit code ${details.exitCode} in ${details.durationSeconds.toFixed(1)}s`);
	} else {
		lines.push(`PASSED in ${details.durationSeconds.toFixed(1)}s`);
	}
	if (details.checksTimedOut) {
		lines.push(`Checks timed out after ${details.checksDuration.toFixed(1)}s`);
	} else if (details.checksPass === false) {
		lines.push(`Checks failed in ${details.checksDuration.toFixed(1)}s`);
	} else if (details.checksPass === true) {
		lines.push(`Checks passed in ${details.checksDuration.toFixed(1)}s`);
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
	if (details.checksLogPath) {
		lines.push(`Checks log: ${details.checksLogPath}`);
	}
	if (details.checksPass === false && details.checksOutput.length > 0) {
		lines.push("");
		lines.push("Checks output:");
		lines.push(details.checksOutput);
	}
	return lines.join("\n").trimEnd();
}

function renderStatus(details: RunDetails, theme: Theme): string {
	if (details.timedOut) {
		return theme.fg("error", `TIMEOUT ${details.durationSeconds.toFixed(1)}s`);
	}
	if (details.checksTimedOut) {
		return theme.fg("warning", `Checks timeout ${details.checksDuration.toFixed(1)}s`);
	}
	if (details.checksPass === false) {
		return theme.fg("error", `Checks failed ${details.checksDuration.toFixed(1)}s`);
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
	return "phase" in value && value.phase === "running";
}

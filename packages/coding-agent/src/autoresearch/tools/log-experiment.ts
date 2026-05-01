import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@oh-my-pi/pi-ai";
import { Text } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../../extensibility/extensions";
import type { Theme } from "../../modes/theme/theme";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import * as git from "../../utils/git";
import { applyAutoresearchContractToExperimentState } from "../apply-contract-to-state";
import { loadAutoresearchScriptSnapshot, pathMatchesContractPath, readAutoresearchContract } from "../contract";
import { computeRunModifiedPaths, getCurrentAutoresearchBranch, parseWorkDirDirtyPathsWithStatus } from "../git";
import {
	collectLoggedRunNumbers,
	formatNum,
	inferMetricUnitFromName,
	isAutoresearchCommittableFile,
	isAutoresearchLocalStatePath,
	isAutoresearchShCommand,
	isBetter,
	mergeAsi,
	readPendingRunSummary,
	resolveWorkDir,
	validateWorkDir,
} from "../helpers";
import {
	cloneExperimentState,
	computeConfidence,
	currentResults,
	findBaselineMetric,
	findBaselineSecondary,
	findBestKeptMetric,
} from "../state";
import type {
	ASIData,
	AutoresearchToolFactoryOptions,
	ExperimentResult,
	ExperimentState,
	LogDetails,
	NumericMetricMap,
} from "../types";

const EXPERIMENT_TOOL_NAMES = ["init_experiment", "run_experiment", "log_experiment"];

const logExperimentSchema = Type.Object({
	commit: Type.String({
		description: "Current git commit hash or placeholder.",
	}),
	metric: Type.Number({
		description: "Primary metric value for this run.",
	}),
	status: StringEnum(["keep", "discard", "crash", "checks_failed"], {
		description: "Outcome for this run.",
	}),
	description: Type.String({
		description: "Short description of the experiment.",
	}),
	metrics: Type.Optional(
		Type.Record(Type.String(), Type.Number(), {
			description: "Secondary metrics for this run.",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description:
				"When true: skip ASI field requirements and allow keeping a run whose primary metric regressed versus the best kept run.",
		}),
	),
	skip_restore: Type.Optional(
		Type.Boolean({
			description:
				"When true and status is discard/crash/checks_failed: skip reverting the working tree to HEAD. Useful when the experiment did not modify tracked files or you want to preserve the current state.",
		}),
	),
	asi: Type.Optional(
		Type.Object(
			{
				hypothesis: Type.Optional(
					Type.String({
						description:
							"REQUIRED on every log_experiment call (any status). One-sentence prediction this run was meant to test.",
					}),
				),
				rollback_reason: Type.Optional(
					Type.String({
						description:
							"REQUIRED when status is discard, crash, or checks_failed. Why this approach is being rolled back.",
					}),
				),
				next_action_hint: Type.Optional(
					Type.String({
						description:
							"REQUIRED when status is discard, crash, or checks_failed. Concrete next experiment direction.",
					}),
				),
			},
			{
				additionalProperties: Type.Unknown(),
				description:
					"Actionable side information captured for this run. Always include `hypothesis`. On discard/crash/checks_failed also include `rollback_reason` and `next_action_hint`. Extra free-form keys are accepted.",
			},
		),
	),
});

interface KeepCommitResult {
	error?: string;
	note?: string;
}

export function createLogExperimentTool(
	options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof logExperimentSchema, LogDetails> {
	return {
		name: "log_experiment",
		label: "Log Experiment",
		description:
			"Log the experiment result, update dashboard state, persist JSONL history, and apply git keep or revert behavior.",
		parameters: logExperimentSchema,
		defaultInactive: true,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const workDirError = validateWorkDir(ctx.cwd);
			if (workDirError) {
				return {
					content: [{ type: "text", text: `Error: ${workDirError}` }],
				};
			}

			const runtime = options.getRuntime(ctx);
			const state = runtime.state;
			const workDir = resolveWorkDir(ctx.cwd);

			const contractResult = readAutoresearchContract(workDir);
			const scriptSnapshot = loadAutoresearchScriptSnapshot(workDir);
			const contractErrors = [...contractResult.errors, ...scriptSnapshot.errors];
			if (contractErrors.length > 0) {
				return {
					content: [{ type: "text", text: `Error: ${contractErrors.join(" ")}` }],
				};
			}
			const benchmarkForSync = contractResult.contract.benchmark;
			if (benchmarkForSync.command && !isAutoresearchShCommand(benchmarkForSync.command)) {
				return {
					content: [
						{
							type: "text",
							text:
								"Error: Benchmark.command in autoresearch.md must invoke `autoresearch.sh` directly before logging. " +
								"Fix autoresearch.md or move the workload into autoresearch.sh.",
						},
					],
				};
			}

			const pendingRun =
				runtime.lastRunSummary ?? (await readPendingRunSummary(workDir, collectLoggedRunNumbers(state.results)));
			if (!pendingRun) {
				return {
					content: [{ type: "text", text: "Error: no unlogged run is available. Run run_experiment first." }],
				};
			}

			applyAutoresearchContractToExperimentState(contractResult.contract, state);
			const logPreamble =
				"Refreshed session fields from autoresearch.md before logging (benchmark, scope, constraints).\n\n";
			runtime.lastRunSummary = pendingRun;
			runtime.lastRunAsi = pendingRun.parsedAsi;
			runtime.lastRunChecks =
				pendingRun.checksPass === null
					? null
					: {
							pass: pendingRun.checksPass,
							output: "",
							duration: pendingRun.checksDurationSeconds ?? 0,
						};
			runtime.lastRunDuration = pendingRun.durationSeconds;

			if (pendingRun.parsedPrimary !== null && params.metric !== pendingRun.parsedPrimary) {
				return {
					content: [
						{
							type: "text",
							text:
								"Error: metric does not match the parsed primary metric from the pending run.\n" +
								`Expected: ${pendingRun.parsedPrimary}\nReceived: ${params.metric}`,
						},
					],
				};
			}

			if (params.status === "keep" && !pendingRun.passed) {
				return {
					content: [
						{
							type: "text",
							text: "Error: cannot keep this run because the pending benchmark did not pass. Log it as crash or checks_failed instead.",
						},
					],
				};
			}

			if (params.status === "keep" && runtime.lastRunChecks && !runtime.lastRunChecks.pass) {
				return {
					content: [
						{
							type: "text",
							text: "Error: cannot keep this run because autoresearch.checks.sh failed. Log it as checks_failed instead.",
						},
					],
				};
			}

			const observedStatusError = validateObservedStatus(params.status, pendingRun);
			if (observedStatusError) {
				return {
					content: [{ type: "text", text: `Error: ${observedStatusError}` }],
				};
			}

			const forceLoose = params.force === true;
			const secondaryMetrics = buildSecondaryMetrics(params.metrics, pendingRun.parsedMetrics, state.metricName);

			const mergedAsi = mergeAsi(runtime.lastRunAsi, sanitizeAsi(params.asi));
			if (!forceLoose) {
				const asiValidationError = validateAsiRequirements(mergedAsi, params.status);
				if (asiValidationError) {
					return {
						content: [{ type: "text", text: `Error: ${asiValidationError}` }],
					};
				}
			}

			const preRunDirtyPaths = pendingRun.preRunDirtyPaths;
			let keepScopeValidation: { committablePaths: string[] } | undefined;
			if (params.status === "keep") {
				const scopeValidation = await validateKeepPaths(options, workDir, state);
				if (typeof scopeValidation === "string") {
					return {
						content: [{ type: "text", text: `Error: ${scopeValidation}` }],
					};
				}
				const currentBestMetric = findBestKeptMetric(state.results, state.currentSegment, state.bestDirection);
				if (
					!forceLoose &&
					currentBestMetric !== null &&
					params.metric !== currentBestMetric &&
					!isBetter(params.metric, currentBestMetric, state.bestDirection)
				) {
					return {
						content: [
							{
								type: "text",
								text:
									"Error: cannot keep this run because the primary metric regressed.\n" +
									`Current best: ${currentBestMetric}\nReceived: ${params.metric}`,
							},
						],
					};
				}
				keepScopeValidation = scopeValidation;
			}

			const experiment: ExperimentResult = {
				runNumber: runtime.lastRunNumber ?? pendingRun.runNumber,
				commit: params.commit.slice(0, 7),
				metric: params.metric,
				metrics: secondaryMetrics,
				status: params.status,
				description: params.description,
				timestamp: Date.now(),
				segment: state.currentSegment,
				confidence: null,
				asi: mergedAsi,
			};

			const activeBranch = await getCurrentAutoresearchBranch(options.pi, workDir);
			if (!activeBranch) {
				return {
					content: [
						{
							type: "text",
							text:
								"Error: autoresearch keep/discard actions require an active `autoresearch/...` branch. " +
								"Run `/autoresearch` again to restore the protected branch before logging this run.",
						},
					],
				};
			}

			let gitNote: string | null = null;
			if (params.status === "keep") {
				const commitResult = await commitKeptExperiment(options, workDir, state, experiment, keepScopeValidation);
				if (commitResult.error) {
					return {
						content: [{ type: "text", text: `Error: ${commitResult.error}` }],
					};
				}
				gitNote = commitResult.note ?? null;
			} else if (!params.skip_restore) {
				const revertResult = await revertFailedExperiment(options, workDir, preRunDirtyPaths);
				if (revertResult.error) {
					return {
						content: [{ type: "text", text: `Error: ${revertResult.error}` }],
					};
				}
				gitNote = revertResult.note ?? null;
			}

			const previousState = cloneExperimentState(state);
			state.results.push(experiment);
			registerSecondaryMetrics(state, secondaryMetrics);
			state.bestMetric = findBaselineMetric(state.results, state.currentSegment);
			state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
			experiment.confidence = state.confidence;

			const wallClockSeconds = runtime.lastRunDuration;
			try {
				persistRun(workDir, experiment);
			} catch (error) {
				runtime.state = previousState;
				options.dashboard.updateWidget(ctx, runtime);
				options.dashboard.requestRender();
				throw error;
			}
			try {
				await updateRunMetadata(runtime.lastRunArtifactDir ?? pendingRun.runDirectory, {
					commit: experiment.commit,
					confidence: experiment.confidence,
					description: experiment.description,
					gitNote,
					loggedAt: new Date(experiment.timestamp).toISOString(),
					loggedAsi: experiment.asi,
					loggedMetric: experiment.metric,
					loggedMetrics: experiment.metrics,
					runNumber: runtime.lastRunNumber ?? pendingRun.runNumber,
					status: experiment.status,
					wallClockSeconds,
				});
			} catch (error) {
				logger.warn("Failed to update autoresearch run metadata after persisting JSONL history", {
					error: error instanceof Error ? error.message : String(error),
					runDirectory: runtime.lastRunArtifactDir ?? pendingRun.runDirectory,
					runNumber: runtime.lastRunNumber ?? pendingRun.runNumber,
				});
			}

			runtime.runningExperiment = null;
			runtime.lastRunChecks = null;
			runtime.lastRunDuration = null;
			runtime.lastRunAsi = null;
			runtime.lastRunArtifactDir = null;
			runtime.lastRunNumber = null;
			runtime.lastRunSummary = null;
			runtime.autoResumeArmed = true;
			runtime.lastAutoResumePendingRunNumber = null;

			const currentSegmentRuns = currentResults(state.results, state.currentSegment).length;
			const text = logPreamble + buildLogText(state, experiment, currentSegmentRuns, wallClockSeconds, gitNote);
			if (state.maxExperiments !== null && currentSegmentRuns >= state.maxExperiments) {
				runtime.autoresearchMode = false;
				options.pi.appendEntry(
					"autoresearch-control",
					runtime.goal ? { mode: "off", goal: runtime.goal } : { mode: "off" },
				);
				await options.pi.setActiveTools(
					options.pi.getActiveTools().filter(name => !EXPERIMENT_TOOL_NAMES.includes(name)),
				);
			}
			options.dashboard.updateWidget(ctx, runtime);
			options.dashboard.requestRender();

			return {
				content: [{ type: "text", text }],
				details: {
					experiment: {
						...experiment,
						metrics: { ...experiment.metrics },
						asi: experiment.asi ? structuredClone(experiment.asi) : undefined,
					},
					state: cloneExperimentState(state),
					wallClockSeconds,
				},
			};
		},
		renderCall(args, _options, theme): Text {
			const color = args.status === "keep" ? "success" : args.status === "discard" ? "warning" : "error";
			const description = truncateToWidth(replaceTabs(args.description), 100);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("log_experiment"))} ${theme.fg(color, args.status)} ${theme.fg("muted", description)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme): Text {
			const details = result.details;
			if (!details) {
				return new Text(replaceTabs(result.content.find(part => part.type === "text")?.text ?? ""), 0, 0);
			}
			const summary = renderSummary(details, theme);
			return new Text(summary, 0, 0);
		},
	};
}

function cloneMetrics(value: NumericMetricMap | undefined): NumericMetricMap {
	return value ? { ...value } : {};
}

function buildSecondaryMetrics(
	overrides: NumericMetricMap | undefined,
	parsedMetrics: NumericMetricMap | null,
	primaryMetricName: string,
): NumericMetricMap {
	const merged: NumericMetricMap = {};
	for (const [name, value] of Object.entries(parsedMetrics ?? {})) {
		if (name === "__proto__" || name === "constructor" || name === "prototype") continue;
		if (name === primaryMetricName) continue;
		merged[name] = value;
	}
	for (const [name, value] of Object.entries(cloneMetrics(overrides))) {
		if (name === "__proto__" || name === "constructor" || name === "prototype") continue;
		merged[name] = value;
	}
	return merged;
}

function sanitizeAsi(value: { [key: string]: unknown } | undefined): ASIData | undefined {
	if (!value) return undefined;
	const result: ASIData = {};
	for (const [key, entryValue] of Object.entries(value)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		const sanitized = sanitizeAsiValue(entryValue);
		if (sanitized !== undefined) {
			result[key] = sanitized;
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeAsiValue(value: unknown): ASIData[string] | undefined {
	if (value === null) return null;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) {
		const items = value
			.map(item => sanitizeAsiValue(item))
			.filter((item): item is NonNullable<typeof item> => item !== undefined);
		return items;
	}
	if (typeof value === "object") {
		const objectValue = value as { [key: string]: unknown };
		const result: ASIData = {};
		for (const [key, entryValue] of Object.entries(objectValue)) {
			if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
			const sanitized = sanitizeAsiValue(entryValue);
			if (sanitized !== undefined) {
				result[key] = sanitized;
			}
		}
		return result;
	}
	return undefined;
}

export function validateAsiRequirements(asi: ASIData | undefined, status: ExperimentResult["status"]): string | null {
	if (!asi) {
		return 'asi is required. Pass `asi: { hypothesis: "..." }` describing what this run was meant to verify.';
	}
	if (typeof asi.hypothesis !== "string" || asi.hypothesis.trim().length === 0) {
		return 'asi.hypothesis is required and must be a non-empty string. Pass `asi: { hypothesis: "..." }`.';
	}
	if (status === "keep") return null;
	if (typeof asi.rollback_reason !== "string" || asi.rollback_reason.trim().length === 0) {
		return "asi.rollback_reason is required for discard, crash, and checks_failed results.";
	}
	if (typeof asi.next_action_hint !== "string" || asi.next_action_hint.trim().length === 0) {
		return "asi.next_action_hint is required for discard, crash, and checks_failed results.";
	}
	return null;
}

function registerSecondaryMetrics(state: ExperimentState, metrics: NumericMetricMap): void {
	for (const name of Object.keys(metrics)) {
		if (state.secondaryMetrics.some(metric => metric.name === name)) continue;
		state.secondaryMetrics.push({
			name,
			unit: inferMetricUnitFromName(name),
		});
	}
}

function persistRun(workDir: string, experiment: ExperimentResult): void {
	const entry = {
		run: experiment.runNumber,
		...experiment,
	};
	const jsonlPath = path.join(workDir, "autoresearch.jsonl");
	fs.appendFileSync(jsonlPath, `${JSON.stringify(entry)}\n`);
}
function validateObservedStatus(
	status: ExperimentResult["status"],
	pendingRun: { checksPass: boolean | null; passed: boolean },
): string | null {
	if (pendingRun.checksPass === false) {
		return status === "checks_failed"
			? null
			: "benchmark checks failed for the pending run. Log it as checks_failed.";
	}
	if (!pendingRun.passed) {
		return status === "crash" ? null : "the pending benchmark failed. Log it as crash.";
	}
	return status === "keep" || status === "discard" ? null : "the pending benchmark passed. Log it as keep or discard.";
}

async function commitKeptExperiment(
	_options: AutoresearchToolFactoryOptions,
	workDir: string,
	state: ExperimentState,
	experiment: ExperimentResult,
	scopeValidation: { committablePaths: string[] } | undefined,
): Promise<KeepCommitResult> {
	if (!scopeValidation || scopeValidation.committablePaths.length === 0) {
		return { note: "nothing to commit" };
	}

	try {
		await git.stage.files(workDir, scopeValidation.committablePaths);
	} catch (err) {
		return {
			error: `git add failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (!(await git.diff.has(workDir, { cached: true, files: scopeValidation.committablePaths }))) {
		return { note: "nothing to commit" };
	}

	const payload: { [key: string]: string | number } = {
		status: experiment.status,
		[state.metricName]: experiment.metric,
	};
	for (const [name, value] of Object.entries(experiment.metrics)) {
		payload[name] = value;
	}
	const commitMessage = `${experiment.description}\n\nResult: ${JSON.stringify(payload)}`;
	let commitResultText = "";
	try {
		const commitResult = await git.commit(workDir, commitMessage, {
			files: scopeValidation.committablePaths,
		});
		commitResultText = mergeStdoutStderr(commitResult);
	} catch (err) {
		return {
			error: `git commit failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const newCommit = (await git.head.short(workDir, 7)) ?? "";
	if (newCommit.length >= 7) {
		experiment.commit = newCommit;
	}
	const summaryLine = commitResultText.split("\n").find(line => line.trim().length > 0) ?? "committed";
	return { note: summaryLine.trim() };
}

async function revertFailedExperiment(
	options: AutoresearchToolFactoryOptions,
	workDir: string,
	preRunDirtyPaths: string[],
): Promise<KeepCommitResult> {
	let statusText: string;
	try {
		statusText = await git.status(workDir, {
			pathspecs: ["."],
			porcelainV1: true,
			untrackedFiles: "all",
			z: true,
		});
	} catch (err) {
		return {
			error: `git status failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const workDirPrefix = await readGitWorkDirPrefix(options, workDir);
	const { tracked, untracked } = computeRunModifiedPaths(preRunDirtyPaths, statusText, workDirPrefix);
	const totalReverted = tracked.length + untracked.length;
	if (totalReverted === 0) {
		return { note: "nothing to revert" };
	}

	if (tracked.length > 0) {
		try {
			await git.restore(workDir, { files: tracked, source: "HEAD", staged: true, worktree: true });
		} catch (err) {
			return {
				error: `git restore failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	for (const filePath of untracked) {
		const absolutePath = path.join(workDir, filePath);
		try {
			fs.rmSync(absolutePath, { force: true, recursive: true });
		} catch {
			// Best-effort removal of untracked files
		}
	}

	return { note: `reverted ${totalReverted} file${totalReverted === 1 ? "" : "s"}` };
}

function mergeStdoutStderr(result: { stderr: string; stdout: string }): string {
	return `${result.stdout}${result.stderr}`;
}

async function validateKeepPaths(
	options: AutoresearchToolFactoryOptions,
	workDir: string,
	state: ExperimentState,
): Promise<{ committablePaths: string[] } | string> {
	if (state.scopePaths.length === 0) {
		return "Files in Scope is empty for the current segment. Re-run init_experiment after fixing autoresearch.md.";
	}

	let statusText: string;
	try {
		statusText = await git.status(workDir, {
			pathspecs: ["."],
			porcelainV1: true,
			untrackedFiles: "all",
			z: true,
		});
	} catch (err) {
		return `git status failed: ${err instanceof Error ? err.message : String(err)}`;
	}

	const workDirPrefix = await readGitWorkDirPrefix(options, workDir);
	const committablePaths: string[] = [];
	for (const entry of parseWorkDirDirtyPathsWithStatus(statusText, workDirPrefix)) {
		if (isAutoresearchLocalStatePath(entry.path)) {
			continue;
		}
		if (isAutoresearchCommittableFile(entry.path)) {
			committablePaths.push(entry.path);
			continue;
		}
		if (state.offLimits.some(spec => pathMatchesContractPath(entry.path, spec))) {
			return `cannot keep this run because ${entry.path} is listed under Off Limits in autoresearch.md`;
		}
		if (!state.scopePaths.some(spec => pathMatchesContractPath(entry.path, spec))) {
			return `cannot keep this run because ${entry.path} is outside Files in Scope`;
		}
		committablePaths.push(entry.path);
	}

	return { committablePaths };
}

async function updateRunMetadata(
	runDirectory: string | null,
	metadata: {
		commit: string;
		confidence: number | null;
		description: string;
		gitNote: string | null;
		loggedAt: string;
		loggedAsi: ASIData | undefined;
		loggedMetric: number;
		loggedMetrics: NumericMetricMap;
		runNumber: number | null;
		status: ExperimentResult["status"];
		wallClockSeconds: number | null;
	},
): Promise<void> {
	if (!runDirectory) return;
	const runJsonPath = path.join(runDirectory, "run.json");
	let existing: Record<string, unknown> = {};
	try {
		existing = (await Bun.file(runJsonPath).json()) as Record<string, unknown>;
	} catch {
		existing = {};
	}
	await Bun.write(
		runJsonPath,
		JSON.stringify(
			{
				...existing,
				loggedRunNumber: metadata.runNumber,
				loggedAt: metadata.loggedAt,
				loggedAsi: metadata.loggedAsi,
				loggedMetric: metadata.loggedMetric,
				loggedMetrics: metadata.loggedMetrics,
				status: metadata.status,
				description: metadata.description,
				commit: metadata.commit,
				gitNote: metadata.gitNote,
				confidence: metadata.confidence,
				wallClockSeconds: metadata.wallClockSeconds,
			},
			null,
			2,
		),
	);
}

function buildLogText(
	state: ExperimentState,
	experiment: ExperimentResult,
	currentSegmentRuns: number,
	wallClockSeconds: number | null,
	gitNote: string | null,
): string {
	const displayRunNumber = experiment.runNumber ?? state.results.length;
	const lines = [`Logged run #${displayRunNumber}: ${experiment.status} - ${experiment.description}`];
	if (wallClockSeconds !== null) {
		lines.push(`Wall clock: ${wallClockSeconds.toFixed(1)}s`);
	}
	if (state.bestMetric !== null) {
		lines.push(`Baseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`);
	}
	if (currentSegmentRuns > 1 && state.bestMetric !== null && experiment.metric !== state.bestMetric) {
		const delta = ((experiment.metric - state.bestMetric) / state.bestMetric) * 100;
		const sign = delta > 0 ? "+" : "";
		lines.push(`This run: ${formatNum(experiment.metric, state.metricUnit)} (${sign}${delta.toFixed(1)}%)`);
	} else {
		lines.push(`This run: ${formatNum(experiment.metric, state.metricUnit)}`);
	}
	if (Object.keys(experiment.metrics).length > 0) {
		const baselineSecondary = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
		const parts = Object.entries(experiment.metrics).map(([name, value]) => {
			const unit = state.secondaryMetrics.find(metric => metric.name === name)?.unit ?? "";
			const baseline = baselineSecondary[name];
			if (baseline === undefined || baseline === 0 || currentSegmentRuns === 1) {
				return `${name}: ${formatNum(value, unit)}`;
			}
			const delta = ((value - baseline) / baseline) * 100;
			const sign = delta > 0 ? "+" : "";
			return `${name}: ${formatNum(value, unit)} (${sign}${delta.toFixed(1)}%)`;
		});
		lines.push(`Secondary metrics: ${parts.join("  ")}`);
	}
	if (experiment.asi) {
		const asiSummary = Object.entries(experiment.asi)
			.map(([key, value]) => `${key}: ${truncateAsiValue(value)}`)
			.join(" | ");
		lines.push(`ASI: ${asiSummary}`);
	}
	if (state.confidence !== null) {
		const status = state.confidence >= 2 ? "likely real" : state.confidence >= 1 ? "marginal" : "within noise";
		lines.push(`Confidence: ${state.confidence.toFixed(1)}x noise floor (${status})`);
	}
	if (gitNote) {
		lines.push(`Git: ${gitNote}`);
	}
	if (state.maxExperiments !== null) {
		lines.push(`Progress: ${currentSegmentRuns}/${state.maxExperiments} runs in current segment`);
		if (currentSegmentRuns >= state.maxExperiments) {
			lines.push(`Maximum experiments reached (${state.maxExperiments}). Autoresearch mode is now off.`);
		}
	}
	return lines.join("\n");
}

async function readGitWorkDirPrefix(options: AutoresearchToolFactoryOptions, workDir: string): Promise<string> {
	void options;
	try {
		return await git.show.prefix(workDir);
	} catch {
		return "";
	}
}

function truncateAsiValue(value: ASIData[string]): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function renderSummary(details: LogDetails, theme: Theme): string {
	const { experiment, state } = details;
	const color = experiment.status === "keep" ? "success" : experiment.status === "discard" ? "warning" : "error";
	let summary = `${theme.fg(color, experiment.status.toUpperCase())} ${theme.fg("muted", truncateToWidth(replaceTabs(experiment.description), 100))}`;
	summary += ` ${theme.fg("accent", `${state.metricName}=${formatNum(experiment.metric, state.metricUnit)}`)}`;
	if (state.bestMetric !== null) {
		summary += ` ${theme.fg("dim", `baseline ${formatNum(state.bestMetric, state.metricUnit)}`)}`;
	}
	if (state.confidence !== null) {
		summary += ` ${theme.fg("dim", `conf ${state.confidence.toFixed(1)}x`)}`;
	}
	return summary;
}

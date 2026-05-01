import * as fs from "node:fs";
import * as path from "node:path";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import * as git from "../utils/git";
import commandResumeTemplate from "./command-resume.md" with { type: "text" };
import { createDashboardController } from "./dashboard";
import { ensureAutoresearchBranch } from "./git";
import { formatNum } from "./helpers";
import promptTemplate from "./prompt.md" with { type: "text" };
import resumeMessageTemplate from "./resume-message.md" with { type: "text" };
import {
	buildExperimentState,
	createExperimentState,
	createRuntimeStore,
	currentResults,
	findBaselineMetric,
	findBaselineRunNumber,
	findBestKeptMetric,
	reconstructControlState,
} from "./state";
import { openAutoresearchStorage, type RunRow } from "./storage";
import { createInitExperimentTool } from "./tools/init-experiment";
import { createLogExperimentTool } from "./tools/log-experiment";
import { createRunExperimentTool } from "./tools/run-experiment";
import { createUpdateNotesTool } from "./tools/update-notes";
import type { AutoresearchRuntime, ExperimentResult, PendingRunSummary } from "./types";

const EXPERIMENT_TOOL_NAMES = ["init_experiment", "run_experiment", "log_experiment", "update_notes"];

export const createAutoresearchExtension: ExtensionFactory = api => {
	const runtimeStore = createRuntimeStore();
	const dashboard = createDashboardController();

	const getSessionKey = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const getRuntime = (ctx: ExtensionContext): AutoresearchRuntime => runtimeStore.ensure(getSessionKey(ctx));

	const rehydrate = async (ctx: ExtensionContext): Promise<void> => {
		const runtime = getRuntime(ctx);
		const control = reconstructControlState(ctx.sessionManager.getBranch());
		runtime.goal = control.goal;
		runtime.autoresearchMode = control.autoresearchMode;
		runtime.autoResumeArmed = false;
		runtime.lastAutoResumePendingRunNumber = null;

		const storage = await openAutoresearchStorage(ctx.cwd);
		const session = storage.getActiveSession();
		if (session) {
			const loggedRuns = storage.listLoggedRuns(session.id);
			runtime.state = buildExperimentState(session, loggedRuns);
			runtime.goal = runtime.goal ?? session.goal;
			runtime.lastRunSummary = pendingRunSummaryFromRow(storage.getPendingRun(session.id));
		} else {
			runtime.state = createExperimentState();
			runtime.lastRunSummary = null;
		}
		runtime.lastRunDuration = runtime.lastRunSummary?.durationSeconds ?? null;
		runtime.lastRunAsi = runtime.lastRunSummary?.parsedAsi ?? null;
		runtime.lastRunArtifactDir = runtime.lastRunSummary?.runDirectory ?? null;
		runtime.lastRunNumber = runtime.lastRunSummary?.runNumber ?? null;
		runtime.runningExperiment = null;
		dashboard.updateWidget(ctx, runtime);

		const activeTools = api.getActiveTools();
		const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
		const nextActiveTools = runtime.autoresearchMode
			? [...new Set([...activeTools, ...EXPERIMENT_TOOL_NAMES])]
			: activeTools.filter(name => !experimentTools.has(name));
		const toolsChanged =
			nextActiveTools.length !== activeTools.length ||
			nextActiveTools.some((name, index) => name !== activeTools[index]);
		if (toolsChanged) {
			await api.setActiveTools(nextActiveTools);
		}
	};

	const setMode = (
		ctx: ExtensionContext,
		enabled: boolean,
		goal: string | null,
		mode: "on" | "off" | "clear",
	): void => {
		const runtime = getRuntime(ctx);
		runtime.autoresearchMode = enabled;
		runtime.autoResumeArmed = false;
		runtime.goal = goal;
		runtime.lastAutoResumePendingRunNumber = null;
		api.appendEntry("autoresearch-control", goal ? { mode, goal } : { mode });
	};

	api.registerTool(createInitExperimentTool({ dashboard, getRuntime, pi: api }));
	api.registerTool(createRunExperimentTool({ dashboard, getRuntime, pi: api }));
	api.registerTool(createLogExperimentTool({ dashboard, getRuntime, pi: api }));
	api.registerTool(createUpdateNotesTool({ dashboard, getRuntime, pi: api }));

	api.registerCommand("autoresearch", {
		description: "Toggle builtin autoresearch mode, or pass off / clear, or a goal message.",
		getArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
			if (argumentPrefix.includes(" ")) return null;
			const normalized = argumentPrefix.trim().toLowerCase();
			if (normalized.length === 0) return null;
			const completions: AutocompleteItem[] = [
				{ label: "off", value: "off", description: "Leave autoresearch mode" },
				{
					label: "clear",
					value: "clear",
					description: "Reset worktree to baseline and close the active session",
				},
			];
			const filtered = completions.filter(item => item.label.startsWith(normalized));
			return filtered.length > 0 ? filtered : null;
		},
		async handler(args, ctx): Promise<void> {
			const trimmed = args.trim();
			const runtime = getRuntime(ctx);

			if (trimmed === "" && runtime.autoresearchMode) {
				setMode(ctx, false, runtime.goal, "off");
				dashboard.updateWidget(ctx, runtime);
				const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
				await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
				ctx.ui.notify("Autoresearch mode disabled", "info");
				return;
			}

			if (trimmed === "off") {
				setMode(ctx, false, runtime.goal, "off");
				dashboard.updateWidget(ctx, runtime);
				const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
				await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
				ctx.ui.notify("Autoresearch mode disabled", "info");
				return;
			}

			if (trimmed === "clear" || trimmed.startsWith("clear ")) {
				const flagPart = trimmed === "clear" ? "" : trimmed.slice("clear ".length).trim();
				const keepTree = flagPart.includes("--keep-tree");
				const resetTreeForce = flagPart.includes("--reset-tree");
				await handleClear(ctx, runtime, { keepTree, resetTreeForce });
				return;
			}

			const goalArg = trimmed.length > 0 ? trimmed : null;
			const branchResult = await ensureAutoresearchBranch(api, ctx.cwd, goalArg ?? runtime.goal);
			if (!branchResult.ok) {
				ctx.ui.notify(branchResult.error, "error");
				return;
			}
			if (branchResult.warning) {
				ctx.ui.notify(branchResult.warning, "warning");
			}

			const storage = await openAutoresearchStorage(ctx.cwd);
			const existingSession = storage.getActiveSession();
			const resumeContext = trimmed;
			const branchStatusLine = branchResult.branchName
				? branchResult.created
					? `Created and checked out dedicated git branch \`${branchResult.branchName}\` before resuming.`
					: `Using dedicated git branch \`${branchResult.branchName}\`.`
				: "Continuing on the current branch — no autoresearch branch was created.";

			if (existingSession) {
				if (goalArg) storage.updateSession(existingSession.id, { goal: goalArg });
				if (branchResult.branchName) {
					storage.updateSession(existingSession.id, { branch: branchResult.branchName });
				}
				const refreshed = storage.getSessionById(existingSession.id) ?? existingSession;
				runtime.state = buildExperimentState(refreshed, storage.listLoggedRuns(refreshed.id));
				runtime.goal = refreshed.goal ?? goalArg;
				setMode(ctx, true, runtime.goal, "on");
				dashboard.updateWidget(ctx, runtime);
				await api.setActiveTools([...new Set([...api.getActiveTools(), ...EXPERIMENT_TOOL_NAMES])]);
				api.sendUserMessage(
					prompt.render(commandResumeTemplate, {
						branch_status_line: branchStatusLine,
						has_resume_context: resumeContext.length > 0,
						resume_context: resumeContext,
					}),
				);
				return;
			}

			setMode(ctx, true, goalArg, "on");
			dashboard.updateWidget(ctx, runtime);
			await api.setActiveTools([...new Set([...api.getActiveTools(), ...EXPERIMENT_TOOL_NAMES])]);
			if (goalArg !== null) {
				api.sendUserMessage(goalArg);
			} else {
				ctx.ui.notify("Autoresearch enabled—describe what to optimize in your next message.", "info");
			}
		},
	});

	api.registerShortcut("ctrl+x", {
		description: "Toggle autoresearch dashboard",
		handler(ctx): void {
			const runtime = getRuntime(ctx);
			if (runtime.state.results.length === 0 && !runtime.runningExperiment) {
				ctx.ui.notify("No autoresearch results yet", "info");
				return;
			}
			runtime.dashboardExpanded = !runtime.dashboardExpanded;
			dashboard.updateWidget(ctx, runtime);
		},
	});

	api.registerShortcut("ctrl+shift+x", {
		description: "Show autoresearch dashboard overlay",
		handler(ctx): Promise<void> {
			return dashboard.showOverlay(ctx, getRuntime(ctx));
		},
	});

	api.on("session_start", (_event, ctx) => rehydrate(ctx));
	api.on("session_switch", (_event, ctx) => rehydrate(ctx));
	api.on("session_branch", (_event, ctx) => rehydrate(ctx));
	api.on("session_tree", (_event, ctx) => rehydrate(ctx));
	api.on("session_shutdown", (_event, ctx) => {
		dashboard.clear(ctx);
		runtimeStore.clear(getSessionKey(ctx));
	});

	api.on("agent_end", async (_event, ctx) => {
		const runtime = getRuntime(ctx);
		runtime.runningExperiment = null;
		dashboard.updateWidget(ctx, runtime);
		dashboard.requestRender();
		if (!runtime.autoresearchMode) return;
		if (ctx.hasPendingMessages()) {
			runtime.autoResumeArmed = false;
			return;
		}
		const storage = await openAutoresearchStorage(ctx.cwd);
		const session = storage.getActiveSession();
		const pendingRow = session ? storage.getPendingRun(session.id) : null;
		const pendingRun = pendingRunSummaryFromRow(pendingRow);
		runtime.lastRunSummary = pendingRun;
		runtime.lastRunDuration = pendingRun?.durationSeconds ?? runtime.lastRunDuration;
		runtime.lastRunAsi = pendingRun?.parsedAsi ?? runtime.lastRunAsi;
		const shouldResumePendingRun =
			pendingRun !== null && runtime.lastAutoResumePendingRunNumber !== pendingRun.runNumber;
		if (!shouldResumePendingRun && !runtime.autoResumeArmed) {
			return;
		}
		runtime.autoResumeArmed = false;
		runtime.lastAutoResumePendingRunNumber = pendingRun?.runNumber ?? null;
		api.sendMessage(
			{
				customType: "autoresearch-resume",
				content: prompt.render(resumeMessageTemplate, {
					has_pending_run: Boolean(pendingRun),
				}),
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
	});

	api.on("before_agent_start", async (event, ctx) => {
		const runtime = getRuntime(ctx);
		if (!runtime.autoresearchMode) return;
		const storage = await openAutoresearchStorage(ctx.cwd);
		const session = storage.getActiveSession();
		if (session) {
			runtime.state = buildExperimentState(session, storage.listLoggedRuns(session.id));
		}
		const pendingRow = session ? storage.getPendingRun(session.id) : null;
		const pendingRun = pendingRunSummaryFromRow(pendingRow);
		runtime.lastRunSummary = pendingRun;
		runtime.lastRunDuration = pendingRun?.durationSeconds ?? runtime.lastRunDuration;
		runtime.lastRunAsi = pendingRun?.parsedAsi ?? runtime.lastRunAsi;
		const state = runtime.state;
		const currentSegmentResults = currentResults(state.results, state.currentSegment);
		const baselineMetric = findBaselineMetric(state.results, state.currentSegment);
		const baselineRunNumber = findBaselineRunNumber(state.results, state.currentSegment);
		const bestMetric = findBestKeptMetric(state.results, state.currentSegment, state.bestDirection);
		const bestResult = bestKeptResult(state.results, state.currentSegment, state.bestDirection);
		const goal = runtime.goal ?? state.goal ?? state.name ?? "";
		const recentResults = currentSegmentResults.slice(-3).map(result => {
			const asiSummary = summarizeExperimentAsi(result);
			return {
				asi_summary: asiSummary,
				description: result.description,
				has_asi_summary: Boolean(asiSummary),
				metric_display: formatNum(result.metric, state.metricUnit),
				run_number: result.runNumber ?? state.results.indexOf(result) + 1,
				status: result.status,
				has_deviations: result.scopeDeviations.length > 0,
				deviations: result.scopeDeviations.join(", "),
				justified: Boolean(result.justification),
				flagged: result.flagged,
				flagged_reason: result.flaggedReason ?? "",
			};
		});
		const unjustifiedRuns = currentSegmentResults
			.filter(r => r.status === "keep" && !r.flagged && r.scopeDeviations.length > 0 && !r.justification)
			.slice(-3)
			.map(r => ({
				run_number: r.runNumber,
				paths: r.scopeDeviations.join(", "),
			}));
		const lastCommand = pendingRun?.command ?? null;
		const showCommandWarning =
			Boolean(state.benchmarkCommand) && lastCommand !== null && lastCommand !== state.benchmarkCommand;
		return {
			systemPrompt: prompt.render(promptTemplate, {
				base_system_prompt: event.systemPrompt,
				has_goal: goal.trim().length > 0,
				goal,
				working_dir: ctx.cwd,
				default_metric_name: state.metricName,
				metric_name: state.metricName,
				has_branch: Boolean(state.branch),
				branch: state.branch,
				has_baseline_commit: Boolean(state.baselineCommit),
				baseline_commit: state.baselineCommit ? state.baselineCommit.slice(0, 12) : "",
				has_notes: state.notes.trim().length > 0,
				notes: state.notes,
				current_segment: state.currentSegment + 1,
				current_segment_run_count: currentSegmentResults.length,
				has_baseline_metric: baselineMetric !== null,
				baseline_metric_display: formatNum(baselineMetric, state.metricUnit),
				baseline_run_number: baselineRunNumber,
				has_best_result: bestResult !== null && bestMetric !== null,
				best_metric_display: bestMetric !== null ? formatNum(bestMetric, state.metricUnit) : "-",
				best_run_number: bestResult ? (bestResult.runNumber ?? state.results.indexOf(bestResult) + 1) : null,
				has_recent_results: recentResults.length > 0,
				recent_results: recentResults,
				has_unjustified_runs: unjustifiedRuns.length > 0,
				unjustified_runs: unjustifiedRuns,
				has_pending_run: Boolean(pendingRun),
				pending_run_number: pendingRun?.runNumber,
				pending_run_command: pendingRun?.command,
				pending_run_passed: pendingRun?.passed ?? false,
				has_pending_run_metric: pendingRun?.parsedPrimary !== null && pendingRun?.parsedPrimary !== undefined,
				pending_run_metric_display:
					pendingRun?.parsedPrimary !== null && pendingRun?.parsedPrimary !== undefined
						? formatNum(pendingRun.parsedPrimary, state.metricUnit)
						: null,
				has_preferred_command_warning: showCommandWarning,
				preferred_command: state.benchmarkCommand ?? "",
				last_command: lastCommand ?? "",
			}),
		};
	});

	async function handleClear(
		ctx: ExtensionContext,
		runtime: AutoresearchRuntime,
		opts: { keepTree: boolean; resetTreeForce: boolean },
	): Promise<void> {
		const storage = await openAutoresearchStorage(ctx.cwd);
		const session = storage.getActiveSession();
		const branchName = await tryReadBranch(ctx.cwd);
		const onAutoresearchBranch = branchName?.startsWith("autoresearch/") ?? false;
		const shouldResetTree = !opts.keepTree && (onAutoresearchBranch || opts.resetTreeForce);
		if (shouldResetTree && session?.baselineCommit) {
			try {
				await git.reset(ctx.cwd, { hard: true, target: session.baselineCommit });
				await git.clean(ctx.cwd);
				ctx.ui.notify(`Reset worktree to baseline ${session.baselineCommit.slice(0, 12)}.`, "info");
			} catch (err) {
				ctx.ui.notify(
					`Failed to reset worktree to baseline: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		} else if (shouldResetTree) {
			ctx.ui.notify("No baseline commit recorded — skipped worktree reset.", "warning");
		}

		removeLegacyArtifacts(ctx.cwd);

		if (session) {
			storage.closeSession(session.id);
		}
		runtime.state = createExperimentState();
		runtime.goal = null;
		runtime.lastRunDuration = null;
		runtime.lastRunAsi = null;
		runtime.lastRunArtifactDir = null;
		runtime.lastRunNumber = null;
		runtime.lastRunSummary = null;
		setMode(ctx, false, null, "clear");
		dashboard.updateWidget(ctx, runtime);
		const experimentTools = new Set(EXPERIMENT_TOOL_NAMES);
		await api.setActiveTools(api.getActiveTools().filter(name => !experimentTools.has(name)));
		ctx.ui.notify("Autoresearch session cleared.", "info");
	}
};

const LEGACY_ARTIFACTS = [
	"autoresearch.md",
	"autoresearch.sh",
	"autoresearch.checks.sh",
	"autoresearch.program.md",
	"autoresearch.ideas.md",
	"autoresearch.jsonl",
	"autoresearch.config.json",
	".autoresearch",
];

function removeLegacyArtifacts(workDir: string): void {
	for (const name of LEGACY_ARTIFACTS) {
		const target = path.join(workDir, name);
		try {
			fs.rmSync(target, { recursive: true, force: true });
		} catch (err) {
			logger.warn("Failed to remove legacy autoresearch artifact", {
				path: target,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

function pendingRunSummaryFromRow(row: RunRow | null): PendingRunSummary | null {
	if (!row) return null;
	if (row.status !== null) return null;
	if (row.completedAt === null) return null;
	const passed = row.exitCode === 0 && !row.timedOut;
	return {
		command: row.command,
		durationSeconds: row.durationMs !== null ? row.durationMs / 1000 : null,
		parsedAsi: row.parsedAsi,
		parsedMetrics: row.parsedMetrics,
		parsedPrimary: row.parsedPrimary,
		passed,
		preRunDirtyPaths: row.preRunDirtyPaths,
		runDirectory: path.dirname(row.logPath),
		runNumber: row.id,
		exitCode: row.exitCode,
		timedOut: row.timedOut,
	};
}

function summarizeExperimentAsi(result: ExperimentResult): string | null {
	const hypothesis = typeof result.asi?.hypothesis === "string" ? result.asi.hypothesis.trim() : "";
	const rollback = typeof result.asi?.rollback_reason === "string" ? result.asi.rollback_reason.trim() : "";
	const next = typeof result.asi?.next_action_hint === "string" ? result.asi.next_action_hint.trim() : "";
	const summary = [hypothesis, rollback, next].filter(part => part.length > 0).join(" | ");
	return summary.length > 0 ? summary.slice(0, 220) : null;
}

function bestKeptResult(
	results: ExperimentResult[],
	segment: number,
	direction: "lower" | "higher",
): ExperimentResult | null {
	let best: ExperimentResult | null = null;
	for (const result of results) {
		if (result.segment !== segment || result.status !== "keep" || result.flagged) continue;
		if (!best) {
			best = result;
			continue;
		}
		const better = direction === "lower" ? result.metric < best.metric : result.metric > best.metric;
		if (better) best = result;
	}
	return best;
}

async function tryReadBranch(cwd: string): Promise<string | null> {
	try {
		return (await git.branch.current(cwd)) ?? null;
	} catch {
		return null;
	}
}

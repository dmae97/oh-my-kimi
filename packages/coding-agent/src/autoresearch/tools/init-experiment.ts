import * as path from "node:path";
import { StringEnum } from "@oh-my-pi/pi-ai";
import { Text } from "@oh-my-pi/pi-tui";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../../extensibility/extensions";
import type { Theme } from "../../modes/theme/theme";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import * as git from "../../utils/git";
import { parseWorkDirDirtyPaths } from "../git";
import { dedupeStrings, normalizePathSpec } from "../helpers";
import { buildExperimentState } from "../state";
import { openAutoresearchStorage, type SessionRow } from "../storage";
import type { AutoresearchToolFactoryOptions, ExperimentState } from "../types";

export const HARNESS_FILENAME = "autoresearch.sh";
export const DEFAULT_HARNESS_COMMAND = `bash ${HARNESS_FILENAME}`;
const HARNESS_COMMIT_TITLE = "autoresearch: harness setup";

const initExperimentSchema = Type.Object({
	name: Type.String({ description: "Human-readable experiment name." }),
	goal: Type.Optional(Type.String({ description: "Free-form description of what this session optimizes." })),
	primary_metric: Type.String({
		description:
			"Primary metric name shown in the dashboard. Match the `METRIC <name>=<value>` lines printed by the benchmark.",
	}),
	metric_unit: Type.Optional(
		Type.String({ description: "Unit for the primary metric (e.g. ms, µs, mb). Empty when unitless." }),
	),
	direction: Type.Optional(
		StringEnum(["lower", "higher"], { description: "Whether lower or higher values are better. Defaults to lower." }),
	),
	secondary_metrics: Type.Optional(
		Type.Array(Type.String(), {
			description: "Names of secondary metrics tracked alongside the primary metric.",
		}),
	),
	scope_paths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Files or directories the agent expects to modify. Used post-hoc to flag scope deviations on log_experiment; never used to block edits.",
		}),
	),
	off_limits: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Paths the agent SHOULD NOT modify. Used post-hoc to flag scope deviations on log_experiment; never used to block edits.",
		}),
	),
	constraints: Type.Optional(
		Type.Array(Type.String(), { description: "Free-form constraints (e.g. 'no api break')." }),
	),
	max_iterations: Type.Optional(Type.Number({ description: "Soft cap on iterations per segment. Optional." })),
	new_segment: Type.Optional(
		Type.Boolean({
			description:
				"When true, bump to a new segment even when an active session exists. New baselines and best-metric reset.",
		}),
	),
});

interface InitExperimentDetails {
	state: ExperimentState;
	createdSession: boolean;
	bumpedSegment: boolean;
	abandonedRuns: number;
	harnessCommitted: boolean;
	baselineCommit: string | null;
}

export function createInitExperimentTool(
	options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof initExperimentSchema, InitExperimentDetails> {
	return {
		name: "init_experiment",
		label: "Init Experiment",
		description:
			"Initialize or reconfigure the autoresearch session. On first call (Phase 1 → Phase 2 transition), requires `./autoresearch.sh` to exist and pending harness changes are auto-committed on an autoresearch branch. Pass `new_segment: true` to start a fresh baseline within an existing session.",
		parameters: initExperimentSchema,
		defaultInactive: true,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const storage = await openAutoresearchStorage(ctx.cwd);
			const runtime = options.getRuntime(ctx);

			const direction = params.direction ?? "lower";
			const metricUnit = params.metric_unit ?? "";
			const scopePaths = dedupeStrings((params.scope_paths ?? []).map(normalizePathSpec));
			const offLimits = dedupeStrings((params.off_limits ?? []).map(normalizePathSpec));
			const constraints = dedupeStrings(params.constraints ?? []);
			const secondaryMetrics = dedupeStrings(params.secondary_metrics ?? []);
			const goal = params.goal?.trim() || null;
			const maxIterations =
				params.max_iterations !== undefined && Number.isFinite(params.max_iterations) && params.max_iterations > 0
					? Math.floor(params.max_iterations)
					: null;
			const branch = (await git.branch.current(ctx.cwd)) ?? null;
			const onAutoresearchBranch = branch?.startsWith("autoresearch/") ?? false;

			const existing = storage.getActiveSessionForBranch(branch);
			const isNewSegmentInit = existing !== null && params.new_segment === true;
			const requiresHarness = !existing || isNewSegmentInit;

			if (requiresHarness) {
				const harnessExists = await Bun.file(path.join(ctx.cwd, HARNESS_FILENAME)).exists();
				if (!harnessExists) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ./${HARNESS_FILENAME} does not exist. Phase 1 of autoresearch is harness setup — write \`./${HARNESS_FILENAME}\` so it exits 0 and prints \`METRIC <name>=<value>\`, validate it via \`bash ${HARNESS_FILENAME}\`, then call init_experiment again.`,
							},
						],
					};
				}
			}

			let harnessCommitted = false;
			let commitWarning: string | null = null;
			if (requiresHarness && onAutoresearchBranch) {
				const dirty = await detectPendingChanges(ctx.cwd);
				if (dirty) {
					try {
						await git.stage.files(ctx.cwd, []);
						const message = buildHarnessCommitMessage(goal, params.name);
						await git.commit(ctx.cwd, message);
						harnessCommitted = true;
					} catch (err) {
						commitWarning = `Failed to auto-commit harness changes: ${err instanceof Error ? err.message : String(err)}. Recording baseline at current HEAD; discard may not preserve uncommitted harness files.`;
					}
				}
			}

			const baselineCommit = await tryReadHeadSha(ctx.cwd);

			let session: SessionRow;
			let createdSession = false;
			let bumpedSegment = false;
			let abandonedRuns = 0;

			if (!existing) {
				session = storage.openSession({
					name: params.name,
					goal,
					primaryMetric: params.primary_metric,
					metricUnit,
					direction,
					preferredCommand: DEFAULT_HARNESS_COMMAND,
					branch,
					baselineCommit,
					maxIterations,
					scopePaths,
					offLimits,
					constraints,
					secondaryMetrics,
				});
				createdSession = true;
			} else {
				abandonedRuns = storage.abandonPendingRuns(existing.id);
				const updates: Parameters<typeof storage.updateSession>[1] = {
					goal,
					maxIterations,
					scopePaths,
					offLimits,
					constraints,
					secondaryMetrics,
					primaryMetric: params.primary_metric,
					metricUnit,
					direction,
					branch,
				};
				if (isNewSegmentInit) {
					updates.baselineCommit = baselineCommit;
				}
				let updated = storage.updateSession(existing.id, updates);
				if (isNewSegmentInit) {
					updated = storage.bumpSegment(existing.id);
					bumpedSegment = true;
				}
				session = updated;
			}

			const loggedRuns = storage.listLoggedRuns(session.id);
			const state = buildExperimentState(session, loggedRuns);
			runtime.state = state;
			runtime.goal = session.goal;
			runtime.autoresearchMode = true;
			runtime.autoResumeArmed = true;
			runtime.lastAutoResumePendingRunNumber = null;
			runtime.lastRunDuration = null;
			runtime.lastRunAsi = null;
			runtime.lastRunArtifactDir = null;
			runtime.lastRunNumber = null;
			runtime.lastRunSummary = null;
			options.dashboard.updateWidget(ctx, runtime);
			options.dashboard.requestRender();

			const lines: string[] = [];
			if (abandonedRuns > 0) {
				lines.push(`Abandoned ${abandonedRuns} pending run${abandonedRuns === 1 ? "" : "s"} before reconfiguring.`);
			}
			if (harnessCommitted && session.baselineCommit) {
				lines.push(`Committed harness setup at ${session.baselineCommit.slice(0, 12)}.`);
			}
			if (commitWarning) {
				lines.push(commitWarning);
			}
			if (createdSession) {
				lines.push(`Started session #${session.id}: ${session.name}`);
			} else if (bumpedSegment) {
				lines.push(`Bumped segment to ${session.currentSegment} for session #${session.id}: ${session.name}`);
			} else {
				lines.push(`Updated session #${session.id} (segment ${session.currentSegment}): ${session.name}`);
			}
			lines.push(
				`Metric: ${session.primaryMetric} (${session.metricUnit || "unitless"}, ${session.direction} is better)`,
			);
			lines.push(`Benchmark entrypoint: ${DEFAULT_HARNESS_COMMAND}`);
			if (session.scopePaths.length > 0) {
				lines.push(`Files in scope: ${session.scopePaths.join(", ")}`);
			}
			if (session.offLimits.length > 0) {
				lines.push(`Off limits: ${session.offLimits.join(", ")}`);
			}
			if (session.maxIterations !== null) {
				lines.push(`Max iterations per segment: ${session.maxIterations}`);
			}
			if (session.branch) {
				lines.push(`Active branch: ${session.branch}`);
			}
			if (session.baselineCommit) {
				lines.push(`Baseline commit: ${session.baselineCommit.slice(0, 12)}`);
			}
			if (createdSession) {
				lines.push(
					"Phase 2: iteration loop is active. Run the baseline experiment with `run_experiment` and log it.",
				);
			} else if (bumpedSegment) {
				lines.push("Run a fresh baseline for the new segment.");
			}
			if (requiresHarness && !onAutoresearchBranch) {
				lines.push(
					"Note: not on a dedicated `autoresearch/*` branch — `log_experiment discard` will only revert run-modified files, not reset to baseline.",
				);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					state,
					createdSession,
					bumpedSegment,
					abandonedRuns,
					harnessCommitted,
					baselineCommit: session.baselineCommit,
				},
			};
		},
		renderCall(args, _options, theme): Text {
			return new Text(renderInitCall(args.name, theme), 0, 0);
		},
		renderResult(result): Text {
			const text = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
			return new Text(text, 0, 0);
		},
	};
}

function renderInitCall(name: string, theme: Theme): string {
	return `${theme.fg("toolTitle", theme.bold("init_experiment"))} ${theme.fg("accent", truncateToWidth(replaceTabs(name), 100))}`;
}

async function tryReadHeadSha(cwd: string): Promise<string | null> {
	try {
		return (await git.head.sha(cwd)) ?? null;
	} catch {
		return null;
	}
}

async function detectPendingChanges(cwd: string): Promise<boolean> {
	try {
		const statusText = await git.status(cwd, { porcelainV1: true, untrackedFiles: "all", z: true });
		const workDirPrefix = await git.show.prefix(cwd).catch(() => "");
		return parseWorkDirDirtyPaths(statusText, workDirPrefix).length > 0;
	} catch {
		return false;
	}
}

function buildHarnessCommitMessage(goal: string | null, name: string): string {
	const lines = [HARNESS_COMMIT_TITLE, "", `Benchmark entrypoint: ${DEFAULT_HARNESS_COMMAND}`];
	if (goal) {
		lines.push(`Goal: ${goal}`);
	} else {
		lines.push(`Session: ${name}`);
	}
	return lines.join("\n");
}

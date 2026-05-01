import { StringEnum } from "@oh-my-pi/pi-ai";
import { Text } from "@oh-my-pi/pi-tui";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../../extensibility/extensions";
import type { Theme } from "../../modes/theme/theme";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import * as git from "../../utils/git";
import { dedupeStrings, normalizePathSpec } from "../helpers";
import { buildExperimentState } from "../state";
import { openAutoresearchStorage, type SessionRow } from "../storage";
import type { AutoresearchToolFactoryOptions, ExperimentState } from "../types";

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
	preferred_command: Type.Optional(
		Type.String({
			description:
				"Preferred benchmark command for this segment. Advisory; run_experiment accepts any command but warns when the command differs.",
		}),
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
}

export function createInitExperimentTool(
	options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof initExperimentSchema, InitExperimentDetails> {
	return {
		name: "init_experiment",
		label: "Init Experiment",
		description:
			"Initialize or reconfigure the autoresearch session. Pass `new_segment: true` to start a fresh baseline within an existing session.",
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
			const preferredCommand = params.preferred_command?.trim() || null;
			const goal = params.goal?.trim() || null;
			const maxIterations =
				params.max_iterations !== undefined && Number.isFinite(params.max_iterations) && params.max_iterations > 0
					? Math.floor(params.max_iterations)
					: null;
			const branch = (await git.branch.current(ctx.cwd)) ?? null;

			const existing = storage.getActiveSession();
			let session: SessionRow;
			let createdSession = false;
			let bumpedSegment = false;
			let abandonedRuns = 0;

			if (!existing) {
				const baselineCommit = await tryReadHeadSha(ctx.cwd);
				session = storage.openSession({
					name: params.name,
					goal,
					primaryMetric: params.primary_metric,
					metricUnit,
					direction,
					preferredCommand,
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
				const updates = {
					goal,
					preferredCommand,
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
				let updated = storage.updateSession(existing.id, updates);
				if (params.new_segment === true) {
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
			if (session.preferredCommand) {
				lines.push(`Preferred command: ${session.preferredCommand}`);
			}
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
				lines.push("Run the baseline experiment now and log it.");
			} else if (bumpedSegment) {
				lines.push("Run a fresh baseline for the new segment.");
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					state,
					createdSession,
					bumpedSegment,
					abandonedRuns,
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

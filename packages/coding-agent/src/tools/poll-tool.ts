import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { isBackgroundJobSupportEnabled } from "../async";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import pollDescription from "../prompts/tools/poll.md" with { type: "text" };
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from "./index";
import {
	formatBadge,
	formatDuration,
	formatEmptyMessage,
	formatStatusIcon,
	getPreviewLines,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
} from "./render-utils";

const pollSchema = Type.Object({
	jobs: Type.Optional(
		Type.Array(Type.String(), {
			description: "job ids to wait for",
			examples: [["job-1234"]],
		}),
	),
});

type PollParams = Static<typeof pollSchema>;

const WAIT_DURATION_MS: Record<string, number> = {
	"5s": 5_000,
	"10s": 10_000,
	"30s": 30_000,
	"1m": 60_000,
	"5m": 5 * 60_000,
};

function parseWaitDurationMs(value: string | undefined): number {
	return (value ? WAIT_DURATION_MS[value] : undefined) ?? WAIT_DURATION_MS["30s"];
}

interface PollResult {
	id: string;
	type: "bash" | "task";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	resultText?: string;
	errorText?: string;
}

export interface PollToolDetails {
	jobs: PollResult[];
}

export class PollTool implements AgentTool<typeof pollSchema, PollToolDetails> {
	readonly name = "poll";
	readonly label = "Poll";
	readonly description: string;
	readonly parameters = pollSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(pollDescription);
	}

	static createIf(session: ToolSession): PollTool | null {
		if (!isBackgroundJobSupportEnabled(session.settings)) return null;
		return new PollTool(session);
	}

	async execute(
		_toolCallId: string,
		params: PollParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<PollToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<PollToolDetails>> {
		const manager = this.session.asyncJobManager;
		if (!manager) {
			return {
				content: [{ type: "text", text: "Async execution is disabled; no background jobs to poll." }],
				details: { jobs: [] },
			};
		}

		const requestedIds = params.jobs;

		// Resolve which jobs to watch
		const jobsToWatch = requestedIds?.length
			? requestedIds.map(id => manager.getJob(id)).filter(j => j != null)
			: manager.getRunningJobs();

		if (jobsToWatch.length === 0) {
			const message = requestedIds?.length
				? `No matching jobs found for IDs: ${requestedIds.join(", ")}`
				: "No running background jobs to wait for.";
			return {
				content: [{ type: "text", text: message }],
				details: { jobs: [] },
			};
		}

		// If all watched jobs are already done, return immediately
		const runningJobs = jobsToWatch.filter(j => j.status === "running");
		if (runningJobs.length === 0) {
			return this.#buildResult(manager, jobsToWatch);
		}

		// Wait until at least one running job finishes, the wait duration elapses, or the call is aborted.
		const racePromises: Promise<unknown>[] = runningJobs.map(j => j.promise);
		const waitMs = parseWaitDurationMs(this.session.settings.get("async.pollWaitDuration"));
		const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
		const timeoutHandle = setTimeout(() => timeoutResolve(), waitMs);
		racePromises.push(timeoutPromise);

		const watchedJobIds = runningJobs.map(job => job.id);
		manager.watchJobs(watchedJobIds);

		const PROGRESS_INTERVAL_MS = 500;
		const emitProgress = () => {
			if (!onUpdate) return;
			const snapshot = this.#snapshotJobs(jobsToWatch);
			onUpdate({
				content: [{ type: "text", text: "" }],
				details: { jobs: snapshot },
			});
		};
		const progressTimer = onUpdate ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		emitProgress();

		try {
			if (signal) {
				const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
				const onAbort = () => abortResolve();
				signal.addEventListener("abort", onAbort, { once: true });
				racePromises.push(abortPromise);
				try {
					await Promise.race(racePromises);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			} else {
				await Promise.race(racePromises);
			}
		} finally {
			manager.unwatchJobs(watchedJobIds);
			clearTimeout(timeoutHandle);
			if (progressTimer) clearInterval(progressTimer);
		}

		if (signal?.aborted) {
			return this.#buildResult(manager, jobsToWatch);
		}

		return this.#buildResult(manager, jobsToWatch);
	}

	#snapshotJobs(
		jobs: {
			id: string;
			type: "bash" | "task";
			status: string;
			label: string;
			startTime: number;
			resultText?: string;
			errorText?: string;
		}[],
	): PollResult[] {
		const now = Date.now();
		return jobs.map(j => {
			const current = this.session.asyncJobManager?.getJob(j.id);
			const latest = current ?? j;
			return {
				id: latest.id,
				type: latest.type,
				status: latest.status as PollResult["status"],
				label: latest.label,
				durationMs: Math.max(0, now - latest.startTime),
				...(latest.resultText ? { resultText: latest.resultText } : {}),
				...(latest.errorText ? { errorText: latest.errorText } : {}),
			};
		});
	}

	#buildResult(
		manager: NonNullable<ToolSession["asyncJobManager"]>,
		jobs: {
			id: string;
			type: "bash" | "task";
			status: string;
			label: string;
			startTime: number;
			resultText?: string;
			errorText?: string;
		}[],
	): AgentToolResult<PollToolDetails> {
		const jobResults = this.#snapshotJobs(jobs);

		manager.acknowledgeDeliveries(jobResults.filter(j => j.status !== "running").map(j => j.id));

		const completed = jobResults.filter(j => j.status !== "running");
		const running = jobResults.filter(j => j.status === "running");

		const lines: string[] = [];
		if (completed.length > 0) {
			lines.push(`## Completed (${completed.length})\n`);
			for (const j of completed) {
				lines.push(`### ${j.id} [${j.type}] — ${j.status}`);
				lines.push(`Label: ${j.label}`);
				if (j.resultText) {
					lines.push("```", j.resultText, "```");
				}
				if (j.errorText) {
					lines.push(`Error: ${j.errorText}`);
				}
				lines.push("");
			}
		}

		if (running.length > 0) {
			lines.push(`## Still Running (${running.length})\n`);
			for (const j of running) {
				lines.push(`- \`${j.id}\` [${j.type}] — ${j.label}`);
			}
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { jobs: jobResults },
		};
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface PollRenderArgs {
	jobs?: string[];
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;
const LABEL_MAX_WIDTH = 60;
const PREVIEW_LINES_COLLAPSED = 1;
const PREVIEW_LINES_EXPANDED = 4;
const PREVIEW_LINE_WIDTH = 80;

function statusToIcon(status: PollResult["status"]): ToolUIStatus {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
			return "aborted";
		case "running":
			return "running";
	}
}

function statusToColor(status: PollResult["status"]): ToolUIColor {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
			return "warning";
		case "running":
			return "accent";
	}
}

function describeTarget(args: PollRenderArgs | undefined): string {
	const ids = args?.jobs ?? [];
	if (ids.length === 0) return "all running jobs";
	if (ids.length === 1) return ids[0]!;
	return `${ids.length} jobs`;
}

export const pollToolRenderer = {
	inline: true,

	renderCall(args: PollRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: "Poll", description: describeTarget(args) }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: PollToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: PollRenderArgs,
	): Component {
		const jobs = result.details?.jobs ?? [];

		if (jobs.length === 0) {
			const fallback = result.content?.find(c => c.type === "text")?.text || "No jobs to poll";
			const header = renderStatusLine(
				{ icon: "warning", title: "Poll", description: describeTarget(args) },
				uiTheme,
			);
			return new Text([header, formatEmptyMessage(fallback, uiTheme)].join("\n"), 0, 0);
		}

		const counts = { completed: 0, failed: 0, cancelled: 0, running: 0 };
		for (const job of jobs) counts[job.status]++;

		const meta: string[] = [];
		if (counts.completed > 0) meta.push(uiTheme.fg("success", `${counts.completed} done`));
		if (counts.failed > 0) meta.push(uiTheme.fg("error", `${counts.failed} failed`));
		if (counts.cancelled > 0) meta.push(uiTheme.fg("warning", `${counts.cancelled} cancelled`));
		if (counts.running > 0) meta.push(uiTheme.fg("accent", `${counts.running} running`));

		const headerIcon: ToolUIStatus = counts.failed > 0 ? "warning" : counts.running > 0 ? "info" : "success";
		const description =
			counts.running > 0
				? `waiting on ${counts.running} of ${jobs.length}`
				: `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"} settled`;

		const header = renderStatusLine(
			{
				icon: headerIcon,
				spinnerFrame: counts.running > 0 ? options.spinnerFrame : undefined,
				title: "Poll",
				description,
				meta,
			},
			uiTheme,
		);

		// Sort: running first (so user sees what's still pending), then failed, then completed/cancelled.
		const statusOrder: Record<PollResult["status"], number> = {
			running: 0,
			failed: 1,
			cancelled: 2,
			completed: 3,
		};
		const sortedJobs = [...jobs].sort((a, b) => {
			const diff = statusOrder[a.status] - statusOrder[b.status];
			if (diff !== 0) return diff;
			return b.durationMs - a.durationMs;
		});

		let cached: RenderCache | undefined;
		return {
			render(width: number): string[] {
				const expanded = options.expanded;
				const spinnerFrame = options.spinnerFrame ?? 0;
				const key = new Hasher().bool(expanded).u32(width).u32(spinnerFrame).digest();
				if (cached?.key === key) return cached.lines;

				const itemLines = renderTreeList<PollResult>(
					{
						items: sortedJobs,
						expanded,
						maxCollapsed: COLLAPSED_LIST_LIMIT,
						itemType: "job",
						renderItem: job => {
							const lines: string[] = [];
							const icon = formatStatusIcon(
								statusToIcon(job.status),
								uiTheme,
								job.status === "running" ? options.spinnerFrame : undefined,
							);
							const typeBadge = formatBadge(job.type, statusToColor(job.status), uiTheme);
							const idText = uiTheme.fg("muted", job.id);
							const label = truncateToWidth(
								replaceTabs(job.label || "(no label)"),
								LABEL_MAX_WIDTH,
								Ellipsis.Unicode,
							);
							const labelText = uiTheme.fg("toolOutput", label);
							const durationText = uiTheme.fg("dim", formatDuration(job.durationMs));
							lines.push(`${icon} ${idText} ${typeBadge} ${labelText} ${durationText}`);

							const preview = job.errorText?.trim() || job.resultText?.trim();
							if (preview) {
								const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
								const previewLines = getPreviewLines(preview, maxLines, PREVIEW_LINE_WIDTH, Ellipsis.Unicode);
								const tone = job.errorText ? "error" : "dim";
								for (const pl of previewLines) {
									lines.push(`  ${uiTheme.fg(tone, pl)}`);
								}
							}
							return lines;
						},
					},
					uiTheme,
				);

				const all = [header, ...itemLines].map(l => truncateToWidth(l, width, Ellipsis.Unicode));
				cached = { key, lines: all };
				return all;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},

	mergeCallAndResult: true,
};

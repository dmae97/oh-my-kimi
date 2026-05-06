import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { isBackgroundJobSupportEnabled } from "../async";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import jobDescription from "../prompts/tools/job.md" with { type: "text" };
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

const jobSchema = Type.Object({
	poll: Type.Optional(
		Type.Array(Type.String(), {
			description: "background job ids to wait for; omit (with no `cancel`) to wait on all running jobs",
			examples: [["job-1234"]],
		}),
	),
	cancel: Type.Optional(
		Type.Array(Type.String(), {
			description: "background job ids to cancel",
			examples: [["job-1234"]],
		}),
	),
});

type JobParams = Static<typeof jobSchema>;

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

interface JobSnapshot {
	id: string;
	type: "bash" | "task";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	resultText?: string;
	errorText?: string;
}

type CancelStatus = "cancelled" | "not_found" | "already_completed";

interface CancelOutcome {
	id: string;
	status: CancelStatus;
	message: string;
}

export interface JobToolDetails {
	jobs: JobSnapshot[];
	cancelled?: { id: string; status: CancelStatus }[];
}

export class JobTool implements AgentTool<typeof jobSchema, JobToolDetails> {
	readonly name = "job";
	readonly label = "Job";
	readonly summary = "Manage long-running background jobs (async bash/python)";
	readonly description: string;
	readonly parameters = jobSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(jobDescription);
	}

	static createIf(session: ToolSession): JobTool | null {
		if (!isBackgroundJobSupportEnabled(session.settings)) return null;
		return new JobTool(session);
	}

	async execute(
		_toolCallId: string,
		params: JobParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<JobToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<JobToolDetails>> {
		const manager = this.session.asyncJobManager;
		if (!manager) {
			return {
				content: [{ type: "text", text: "Async execution is disabled; no background jobs are available." }],
				details: { jobs: [] },
			};
		}

		const cancelIds = params.cancel ?? [];
		const cancelOutcomes: CancelOutcome[] = [];
		for (const id of cancelIds) {
			const existing = manager.getJob(id);
			if (!existing) {
				cancelOutcomes.push({ id, status: "not_found", message: `Background job not found: ${id}` });
				continue;
			}
			if (existing.status !== "running") {
				cancelOutcomes.push({
					id,
					status: "already_completed",
					message: `Background job ${id} is already ${existing.status}.`,
				});
				continue;
			}
			const cancelled = manager.cancel(id);
			cancelOutcomes.push(
				cancelled
					? { id, status: "cancelled", message: `Cancelled background job ${id}.` }
					: { id, status: "already_completed", message: `Background job ${id} is already completed.` },
			);
		}

		const requestedPollIds = params.poll;
		// If only `cancel` was provided (no `poll`), don't wait — return immediately.
		const shouldPoll = requestedPollIds !== undefined || cancelIds.length === 0;

		if (!shouldPoll) {
			const cancelledJobs = cancelIds.map(id => manager.getJob(id)).filter(j => j != null);
			return this.#buildResult(manager, cancelledJobs, cancelOutcomes);
		}

		// Resolve which jobs to watch.
		// - If `poll` was passed explicitly, watch exactly those (filtered to existing).
		// - If `poll` was omitted (and so was `cancel`), default to all running jobs.
		const jobsToWatch = requestedPollIds
			? requestedPollIds.map(id => manager.getJob(id)).filter(j => j != null)
			: manager.getRunningJobs();

		if (jobsToWatch.length === 0) {
			if (cancelOutcomes.length > 0) {
				const cancelledJobs = cancelIds.map(id => manager.getJob(id)).filter(j => j != null);
				return this.#buildResult(manager, cancelledJobs, cancelOutcomes);
			}
			const message = requestedPollIds?.length
				? `No matching jobs found for IDs: ${requestedPollIds.join(", ")}`
				: "No running background jobs to wait for.";
			return {
				content: [{ type: "text", text: message }],
				details: { jobs: [] },
			};
		}

		// If all watched jobs are already done, build immediate result.
		const runningJobs = jobsToWatch.filter(j => j.status === "running");
		if (runningJobs.length === 0) {
			const cancelledJobs = cancelIds.map(id => manager.getJob(id)).filter(j => j != null);
			return this.#buildResult(manager, [...cancelledJobs, ...jobsToWatch], cancelOutcomes);
		}

		// Wait until at least one running job finishes, the wait duration elapses, or the call is aborted.
		const racePromises: Promise<unknown>[] = runningJobs.map(j => j.promise);
		const waitMs = parseWaitDurationMs(this.session.settings.get("async.pollWaitDuration"));
		const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
		const timeoutHandle = setTimeout(() => timeoutResolve(), waitMs);
		racePromises.push(timeoutPromise);

		const watchedJobIds = runningJobs.map(job => job.id);
		manager.watchJobs(watchedJobIds);

		const cancelledJobs = cancelIds.map(id => manager.getJob(id)).filter(j => j != null);
		const allTrackedJobs = [...cancelledJobs, ...jobsToWatch];

		const PROGRESS_INTERVAL_MS = 500;
		const emitProgress = () => {
			if (!onUpdate) return;
			const snapshot = this.#snapshotJobs(allTrackedJobs);
			onUpdate({
				content: [{ type: "text", text: "" }],
				details: {
					jobs: snapshot,
					...(cancelOutcomes.length
						? { cancelled: cancelOutcomes.map(({ id, status }) => ({ id, status })) }
						: {}),
				},
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

		return this.#buildResult(manager, allTrackedJobs, cancelOutcomes);
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
	): JobSnapshot[] {
		const now = Date.now();
		return jobs.map(j => {
			const current = this.session.asyncJobManager?.getJob(j.id);
			const latest = current ?? j;
			return {
				id: latest.id,
				type: latest.type,
				status: latest.status as JobSnapshot["status"],
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
		cancelOutcomes: CancelOutcome[],
	): AgentToolResult<JobToolDetails> {
		// Deduplicate by id (cancelled jobs may also appear in the watched set).
		const seen = new Set<string>();
		const uniqueJobs = jobs.filter(j => {
			if (seen.has(j.id)) return false;
			seen.add(j.id);
			return true;
		});
		const jobResults = this.#snapshotJobs(uniqueJobs);

		manager.acknowledgeDeliveries(jobResults.filter(j => j.status !== "running").map(j => j.id));

		const completed = jobResults.filter(j => j.status !== "running");
		const running = jobResults.filter(j => j.status === "running");

		const lines: string[] = [];

		if (cancelOutcomes.length > 0) {
			lines.push(`## Cancelled (${cancelOutcomes.length})\n`);
			for (const o of cancelOutcomes) lines.push(`- ${o.message}`);
			lines.push("");
		}

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
			content: [{ type: "text", text: lines.join("\n").trimEnd() }],
			details: {
				jobs: jobResults,
				...(cancelOutcomes.length ? { cancelled: cancelOutcomes.map(({ id, status }) => ({ id, status })) } : {}),
			},
		};
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface JobRenderArgs {
	poll?: string[];
	cancel?: string[];
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;
const LABEL_MAX_WIDTH = 60;
const PREVIEW_LINES_COLLAPSED = 1;
const PREVIEW_LINES_EXPANDED = 4;
const PREVIEW_LINE_WIDTH = 80;

function statusToIcon(status: JobSnapshot["status"]): ToolUIStatus {
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

function statusToColor(status: JobSnapshot["status"]): ToolUIColor {
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

function describeTarget(args: JobRenderArgs | undefined): string {
	const poll = args?.poll ?? [];
	const cancel = args?.cancel ?? [];
	const parts: string[] = [];
	if (cancel.length > 0) {
		parts.push(cancel.length === 1 ? `cancel ${cancel[0]}` : `cancel ${cancel.length} jobs`);
	}
	if (poll.length > 0) {
		parts.push(poll.length === 1 ? `poll ${poll[0]}` : `poll ${poll.length} jobs`);
	}
	if (parts.length === 0) return "all running jobs";
	return parts.join(", ");
}

export const jobToolRenderer = {
	inline: true,

	renderCall(args: JobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: "Job", description: describeTarget(args) }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: JobToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: JobRenderArgs,
	): Component {
		const jobs = result.details?.jobs ?? [];

		if (jobs.length === 0) {
			const fallback = result.content?.find(c => c.type === "text")?.text || "No jobs to process";
			const header = renderStatusLine({ icon: "warning", title: "Job", description: describeTarget(args) }, uiTheme);
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
				title: "Job",
				description,
				meta,
			},
			uiTheme,
		);

		// Sort: running first (so user sees what's still pending), then failed, then completed/cancelled.
		const statusOrder: Record<JobSnapshot["status"], number> = {
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

				const itemLines = renderTreeList<JobSnapshot>(
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

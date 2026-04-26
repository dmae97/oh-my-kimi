import { type Component, padding, Text, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme, ThemeColor } from "../modes/theme/theme";
import { renderStatusLine } from "../tui";
import type {
	GhRunWatchFailedLogDetails,
	GhRunWatchJobDetails,
	GhRunWatchRunDetails,
	GhRunWatchViewDetails,
	GhToolDetails,
} from "./gh";
import { formatShortSha } from "./gh-format";
import {
	formatExpandHint,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
	truncateToWidth as truncateVisualWidth,
} from "./render-utils";

type GithubToolRenderArgs = {
	op?: string;
	run?: string;
	branch?: string;
};

const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const RUNNING_STATUSES = new Set(["in_progress"]);
const PENDING_STATUSES = new Set(["queued", "requested", "waiting", "pending"]);
const FALLBACK_WIDTH = 80;

function getWatchHeader(watch: GhRunWatchViewDetails): string {
	if (watch.mode === "run" && watch.run) {
		if (watch.state === "watching") {
			return `watching run #${watch.run.id} on ${watch.repo}`;
		}

		return `run #${watch.run.id} on ${watch.repo}`;
	}

	const shortSha = formatShortSha(watch.headSha) ?? "this commit";
	if (watch.state === "watching") {
		return `watching ${shortSha} on ${watch.repo}`;
	}

	return `workflow runs for ${shortSha} on ${watch.repo}`;
}

function getRunLabel(run: GhRunWatchRunDetails): string {
	return replaceTabs(run.workflowName ?? run.displayTitle ?? "GitHub Actions");
}

function getRunMeta(run: GhRunWatchRunDetails): string[] {
	const parts: string[] = [];
	if (run.branch) {
		parts.push(replaceTabs(run.branch));
	} else if (run.headSha) {
		parts.push(formatShortSha(run.headSha) ?? run.headSha);
	}
	parts.push(`#${run.id}`);
	return parts;
}

function formatRunLine(run: GhRunWatchRunDetails, theme: Theme): string {
	const title = theme.fg("accent", getRunLabel(run));
	const metaParts = getRunMeta(run);
	const meta = metaParts.map((part, index) =>
		index === metaParts.length - 1 ? theme.fg("muted", part) : theme.fg("text", part),
	);
	return [title, ...meta].join("  ");
}

function getJobStateVisual(
	job: GhRunWatchJobDetails,
	theme: Theme,
): { iconRaw: string; iconColor: ToolUIColor; textColor: ThemeColor } {
	if (job.conclusion && SUCCESS_CONCLUSIONS.has(job.conclusion)) {
		return {
			iconRaw: theme.status.success,
			iconColor: "success",
			textColor: "success",
		};
	}

	if (job.conclusion && FAILURE_CONCLUSIONS.has(job.conclusion)) {
		return {
			iconRaw: theme.status.error,
			iconColor: "error",
			textColor: "error",
		};
	}

	if (job.status && RUNNING_STATUSES.has(job.status)) {
		return {
			iconRaw: theme.status.enabled,
			iconColor: "warning",
			textColor: "warning",
		};
	}

	if (job.status && PENDING_STATUSES.has(job.status)) {
		return {
			iconRaw: theme.status.shadowed,
			iconColor: "muted",
			textColor: "muted",
		};
	}

	return {
		iconRaw: theme.status.shadowed,
		iconColor: "muted",
		textColor: "muted",
	};
}

function renderJobLine(job: GhRunWatchJobDetails, width: number, theme: Theme): string {
	const visual = getJobStateVisual(job, theme);
	const prefix = theme.fg(visual.iconColor, `${visual.iconRaw} `);
	const durationLabel = job.durationSeconds !== undefined ? `${job.durationSeconds}s` : undefined;
	const styledDuration = durationLabel ? theme.fg(visual.textColor, durationLabel) : undefined;
	const reservedWidth = visibleWidth(prefix) + (styledDuration ? 1 + visibleWidth(styledDuration) : 0);
	const nameWidth = Math.max(8, width - reservedWidth);
	const jobName = theme.fg(visual.textColor, truncateVisualWidth(replaceTabs(job.name), nameWidth));
	let line = `${prefix}${jobName}`;
	if (styledDuration) {
		line += padding(Math.max(1, width - visibleWidth(line) - visibleWidth(styledDuration)));
		line += styledDuration;
	}
	return line;
}

function renderRunBlock(run: GhRunWatchRunDetails, width: number, theme: Theme): string[] {
	const lines = [formatRunLine(run, theme)];
	if (run.jobs.length === 0) {
		lines.push(theme.fg("dim", "waiting for workflow jobs..."));
		return lines;
	}

	for (const job of run.jobs) {
		lines.push(renderJobLine(job, width, theme));
	}
	return lines;
}

function renderFailedLogs(
	failedLogs: GhRunWatchFailedLogDetails[],
	width: number,
	theme: Theme,
	expanded: boolean,
): string[] {
	if (failedLogs.length === 0) {
		return [];
	}

	const lines = ["", theme.fg("error", "failed logs")];
	for (const entry of failedLogs) {
		const context = entry.workflowName ? `${entry.workflowName}  #${entry.runId}` : `run #${entry.runId}`;
		lines.push(
			theme.fg("error", `${theme.status.error} ${replaceTabs(entry.jobName)}  ${theme.fg("muted", context)}`),
		);

		if (!entry.available || !entry.tail) {
			lines.push(theme.fg("dim", "  log tail unavailable"));
			continue;
		}

		const tailLines = replaceTabs(entry.tail)
			.split("\n")
			.filter(line => line.length > 0);
		const previewLimit = expanded ? tailLines.length : Math.min(PREVIEW_LIMITS.OUTPUT_COLLAPSED, tailLines.length);
		for (const line of tailLines.slice(-previewLimit)) {
			lines.push(theme.fg("dim", `  ${truncateVisualWidth(line, Math.max(8, width - 2))}`));
		}

		if (!expanded && tailLines.length > previewLimit) {
			const remaining = tailLines.length - previewLimit;
			lines.push(theme.fg("dim", `  … ${remaining} more log lines ${formatExpandHint(theme, false, true)}`));
		}
	}

	return lines;
}

function buildRenderedLines(
	watch: GhRunWatchViewDetails,
	theme: Theme,
	options: RenderResultOptions,
	width: number,
): string[] {
	const lines = [theme.fg("muted", getWatchHeader(watch))];

	if (watch.note) {
		lines.push(theme.fg("dim", replaceTabs(watch.note)));
	}

	if (watch.mode === "run" && watch.run) {
		lines.push(...renderRunBlock(watch.run, width, theme));
	} else if (watch.mode === "commit") {
		const runs = watch.runs ?? [];
		if (runs.length === 0) {
			lines.push(theme.fg("dim", "waiting for workflow runs..."));
		} else {
			runs.forEach((run, index) => {
				if (index > 0) {
					lines.push("");
				}
				lines.push(...renderRunBlock(run, width, theme));
			});
		}
	}

	lines.push(...renderFailedLogs(watch.failedLogs ?? [], width, theme, options.expanded));
	return lines;
}

function renderFallbackText(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	theme: Theme,
): Component {
	const text = result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.join("\n");
	if (text) {
		return new Text(replaceTabs(text), 0, 0);
	}

	const header = renderStatusLine(
		{
			icon: result.isError ? "error" : "warning",
			title: "GitHub Run Watch",
			description: result.isError ? "failed" : "no output",
		},
		theme,
	);
	return new Text(header, 0, 0);
}

export const githubToolRenderer = {
	renderCall(args: GithubToolRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const lines: string[] = [];

		// Header with spinner reflecting the dispatched op
		const icon =
			options.spinnerFrame !== undefined
				? formatStatusIcon("running", uiTheme, options.spinnerFrame)
				: formatStatusIcon("pending", uiTheme);

		// Build a target description that mirrors the result view style
		const runId = typeof args.run === "string" && args.run.trim().length > 0 ? args.run.trim() : undefined;
		const branch = typeof args.branch === "string" && args.branch.trim().length > 0 ? args.branch.trim() : undefined;

		const op = typeof args.op === "string" && args.op.trim().length > 0 ? args.op.trim() : undefined;
		if (op && op !== "run_watch") {
			const title = uiTheme.fg("accent", `GitHub ${op}`);
			lines.push(`${icon} ${title}`);
			return new Text(lines.join("\n"), 0, 0);
		}

		if (runId) {
			// "⠋ GitHub Run Watch  run #12345"
			const title = uiTheme.fg("accent", "GitHub Run Watch");
			const meta = uiTheme.fg("muted", `#${runId}`);
			lines.push(`${icon} ${title}  ${meta}`);
		} else if (branch) {
			// "⠋ GitHub Run Watch  feature-branch"
			const title = uiTheme.fg("accent", "GitHub Run Watch");
			const meta = uiTheme.fg("text", branch);
			lines.push(`${icon} ${title}  ${meta}`);
		} else {
			// "⠋ GitHub Run Watch  current HEAD"
			const title = uiTheme.fg("accent", "GitHub Run Watch");
			const meta = uiTheme.fg("muted", "current HEAD");
			lines.push(`${icon} ${title}  ${meta}`);
		}

		lines.push(uiTheme.fg("dim", "  waiting for workflow data..."));

		return new Text(lines.join("\n"), 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GhToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const watch = result.details?.watch;
		if (!watch) {
			return renderFallbackText(result, uiTheme);
		}

		return {
			render(width: number): string[] {
				const lineWidth = Math.max(24, width || FALLBACK_WIDTH);
				return buildRenderedLines(watch, uiTheme, options, lineWidth).map(line => truncateToWidth(line, lineWidth));
			},
			invalidate() {},
		};
	},

	mergeCallAndResult: true,
	inline: true,
};

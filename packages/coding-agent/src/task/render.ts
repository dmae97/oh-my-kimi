/**
 * TUI rendering for task tool.
 *
 * Provides renderCall and renderResult functions for displaying
 * task execution in the terminal UI.
 */
import path from "node:path";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Markdown, Text } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { formatContextUsage } from "../modes/components/status-line/context-thresholds";
import { shimmerEnabled, shimmerText } from "../modes/theme/shimmer";
import { getMarkdownTheme, type Theme } from "../modes/theme/theme";
import {
	formatBadge,
	formatDuration,
	formatMoreItems,
	formatStatusIcon,
	replaceTabs,
	type ToolUIStatus,
	truncateToWidth,
} from "../tools/render-utils";
import {
	type FindingPriority,
	getPriorityInfo,
	PRIORITY_LABELS,
	parseReportFindingDetails,
	type ReportFindingDetails,
	type SubmitReviewDetails,
} from "../tools/review";
import { framedBlock, renderStatusLine } from "../tui";
import { repairDoubleEncodedJsonString } from "./repair-args";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import type { AgentProgress, SingleResult, TaskItem, TaskParams, TaskToolDetails } from "./types";

/**
 * Get status icon for agent state.
 * For running status, uses animated spinner if spinnerFrame is provided.
 * Maps AgentProgress status to styled icon format.
 */
function getStatusIcon(status: AgentProgress["status"], theme: Theme, spinnerFrame?: number): string {
	switch (status) {
		case "pending":
			return formatStatusIcon("pending", theme);
		case "running":
			return formatStatusIcon("running", theme, spinnerFrame);
		case "completed":
			return formatStatusIcon("success", theme);
		case "failed":
			return formatStatusIcon("error", theme);
		case "aborted":
			return formatStatusIcon("aborted", theme);
	}
}

/**
 * Append tool-count, context, and cost stats to a status line string.
 */
function appendAgentStats(
	line: string,
	opts: {
		toolCount?: number;
		tokens: number;
		contextTokens?: number;
		contextWindow?: number;
		cost: number;
		resolvedModel?: string;
		showResolvedModelBadge?: boolean;
	},
	theme: Theme,
): string {
	if (opts.toolCount) {
		line += `${theme.sep.dot}${theme.fg("dim", `${formatNumber(opts.toolCount)} ${theme.icon.extensionTool}`)}`;
	}
	// Current per-turn context — match the status line's `<pct>%/<window>` gauge (e.g. `5.1%/1M`).
	if (opts.contextTokens && opts.contextTokens > 0) {
		const ctx =
			opts.contextWindow && opts.contextWindow > 0
				? formatContextUsage((opts.contextTokens / opts.contextWindow) * 100, opts.contextWindow)
				: `${formatNumber(opts.contextTokens)}`;
		line += `${theme.sep.dot}${theme.fg("dim", ctx)}`;
	}
	if (opts.cost > 0) {
		line += `${theme.sep.dot}${theme.fg("statusLineCost", `$${opts.cost.toFixed(2)}`)}`;
	}
	if (opts.resolvedModel && opts.showResolvedModelBadge) {
		line += `${theme.sep.dot}${theme.fg("dim", truncateToWidth(replaceTabs(opts.resolvedModel), 30))}`;
	}
	return line;
}

function formatFindingSummary(findings: ReportFindingDetails[], theme: Theme): string {
	if (findings.length === 0) return theme.fg("dim", "Findings: none");

	const counts: { [P in FindingPriority]?: number } = {};
	for (const finding of findings) {
		counts[finding.priority] = (counts[finding.priority] ?? 0) + 1;
	}

	const parts: string[] = [];
	for (const label of PRIORITY_LABELS) {
		const { symbol, color } = getPriorityInfo(label);
		const count = counts[label] ?? 0;
		const text = theme.fg(color, `${label}:${count}`);
		parts.push(theme.styledSymbol(symbol, color) ? `${theme.styledSymbol(symbol, color)} ${text}` : text);
	}

	return `${theme.fg("dim", "Findings:")} ${parts.join(theme.sep.dot)}`;
}

function normalizeReportFindings(value: unknown): ReportFindingDetails[] {
	if (!Array.isArray(value)) return [];
	const findings: ReportFindingDetails[] = [];
	for (const item of value) {
		const finding = parseReportFindingDetails(item);
		if (finding) findings.push(finding);
	}
	return findings;
}

/**
 * Normalize the `yield` slot of `extractedToolData` into an array of
 * yield-detail records. The subprocess executor always populates this slot as
 * `unknown[]` (see `executor.ts` `extractData` handler), but the renderer
 * MUST also tolerate a stray single object — optional chaining short-circuits
 * on `null`/`undefined` only, so calling `.map` on a plain object would throw
 * `TypeError: completeData?.map is not a function` and crash the TUI.
 * A single object is wrapped as a 1-element array so the review verdict still
 * renders; non-object primitives drop out.
 */
function normalizeYieldData(value: unknown): Array<{ data: unknown }> {
	if (Array.isArray(value)) {
		return value.filter((item): item is { data: unknown } => item !== null && typeof item === "object");
	}
	if (value !== null && typeof value === "object") {
		return [value as { data: unknown }];
	}
	return [];
}

function formatJsonScalar(value: unknown, _theme: Theme): string {
	if (value === null) return "null";
	if (typeof value === "string") {
		const trimmed = truncateToWidth(value, 70);
		return `"${trimmed}"`;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

function formatTaskId(id: string): string {
	// Ids are name-based (e.g. "Anna", "Anna-2"); a "." separates nesting levels
	// (e.g. "Anna.Bob"). Render the hierarchy with a ">" breadcrumb.
	const segments = id.split(".");
	return segments.length < 2 ? id : segments.join(">");
}

const MISSING_YIELD_WARNING_PREFIX = "SYSTEM WARNING: Subagent exited without calling yield tool";

function extractMissingYieldWarning(output: string): { warning?: string; rest: string } {
	const lines = output.split("\n");
	const firstLine = lines[0]?.trim() ?? "";
	if (!firstLine.startsWith(MISSING_YIELD_WARNING_PREFIX)) {
		return { rest: output };
	}
	const rest = lines
		.slice(1)
		.join("\n")
		.replace(/^\s*\n+/, "");
	return { warning: firstLine, rest };
}

function buildTreePrefix(ancestors: boolean[], theme: Theme): string {
	return ancestors.map(hasNext => (hasNext ? `${theme.tree.vertical}  ` : "   ")).join("");
}

function renderJsonTreeLines(
	value: unknown,
	theme: Theme,
	maxDepth: number,
	maxLines: number,
): { lines: string[]; truncated: boolean } {
	const lines: string[] = [];
	let truncated = false;

	const iconObject = theme.styledSymbol("icon.folder", "muted");
	const iconArray = theme.styledSymbol("icon.package", "muted");
	const iconScalar = theme.styledSymbol("icon.file", "muted");

	const pushLine = (line: string) => {
		if (lines.length >= maxLines) {
			truncated = true;
			return false;
		}
		lines.push(line);
		return true;
	};

	const renderNode = (val: unknown, key: string | undefined, ancestors: boolean[], isLast: boolean, depth: number) => {
		if (lines.length >= maxLines) {
			truncated = true;
			return;
		}

		const connector = isLast ? theme.tree.last : theme.tree.branch;
		const prefix = `${buildTreePrefix(ancestors, theme)}${theme.fg("dim", connector)} `;
		const scalar = formatJsonScalar(val, theme);

		if (scalar) {
			const label = key ? theme.fg("muted", key) : theme.fg("muted", "value");
			pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", scalar)}`);
			return;
		}

		if (Array.isArray(val)) {
			const header = key ? theme.fg("muted", key) : theme.fg("muted", "array");
			pushLine(`${prefix}${iconArray} ${header}`);
			if (val.length === 0) {
				pushLine(
					`${buildTreePrefix([...ancestors, !isLast], theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"[]",
					)}`,
				);
				return;
			}
			if (depth >= maxDepth) {
				pushLine(
					`${buildTreePrefix([...ancestors, !isLast], theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"…",
					)}`,
				);
				return;
			}
			const nextAncestors = [...ancestors, !isLast];
			for (let i = 0; i < val.length; i++) {
				renderNode(val[i], `[${i}]`, nextAncestors, i === val.length - 1, depth + 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}

		if (val && typeof val === "object") {
			const header = key ? theme.fg("muted", key) : theme.fg("muted", "object");
			pushLine(`${prefix}${iconObject} ${header}`);
			const entries = Object.entries(val as Record<string, unknown>);
			if (entries.length === 0) {
				pushLine(
					`${buildTreePrefix([...ancestors, !isLast], theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"{}",
					)}`,
				);
				return;
			}
			if (depth >= maxDepth) {
				pushLine(
					`${buildTreePrefix([...ancestors, !isLast], theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"…",
					)}`,
				);
				return;
			}
			const nextAncestors = [...ancestors, !isLast];
			for (let i = 0; i < entries.length; i++) {
				const [childKey, child] = entries[i];
				renderNode(child, childKey, nextAncestors, i === entries.length - 1, depth + 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}

		const label = key ? theme.fg("muted", key) : theme.fg("muted", "value");
		pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", String(val))}`);
	};

	const renderRoot = (val: unknown) => {
		if (Array.isArray(val)) {
			for (let i = 0; i < val.length; i++) {
				renderNode(val[i], `[${i}]`, [], i === val.length - 1, 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}
		if (val && typeof val === "object") {
			const entries = Object.entries(val as Record<string, unknown>);
			for (let i = 0; i < entries.length; i++) {
				const [childKey, child] = entries[i];
				renderNode(child, childKey, [], i === entries.length - 1, 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}
		renderNode(val, undefined, [], true, 0);
	};

	renderRoot(value);

	return { lines, truncated };
}

function renderOutputSection(
	output: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	maxCollapsed = 3,
	maxExpanded = 10,
	warning?: string,
): string[] {
	const lines: string[] = [];
	const trimmedOutput = output.trimEnd();
	if (!trimmedOutput && !warning) return lines;

	if (warning) {
		lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);
		lines.push(
			`${continuePrefix}  ${theme.fg("warning", theme.status.warning)} ${theme.fg(
				"dim",
				truncateToWidth(warning, 80),
			)}`,
		);

		if (!trimmedOutput) {
			return lines;
		}

		if (trimmedOutput.startsWith("{") || trimmedOutput.startsWith("[")) {
			try {
				const parsed = JSON.parse(trimmedOutput);

				if (!expanded) {
					lines.push(`${continuePrefix}  ${theme.fg("dim", formatOutputInline(parsed, theme))}`);
					return lines;
				}

				const tree = renderJsonTreeLines(parsed, theme, expanded ? 6 : 2, expanded ? 24 : 6);
				if (tree.lines.length > 0) {
					for (const line of tree.lines) {
						lines.push(`${continuePrefix}  ${line}`);
					}
					if (tree.truncated) {
						lines.push(`${continuePrefix}  ${theme.fg("dim", "…")}`);
					}
					return lines;
				}
			} catch {
				// Fall back to raw output
			}
		}

		const outputLines = output.trimEnd().split("\n");
		const previewCount = expanded ? maxExpanded : maxCollapsed;
		for (const line of outputLines.slice(0, previewCount)) {
			lines.push(`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(line), 70))}`);
		}

		if (outputLines.length > previewCount) {
			lines.push(
				`${continuePrefix}  ${theme.fg("dim", formatMoreItems(outputLines.length - previewCount, "line"))}`,
			);
		}

		return lines;
	}

	if (trimmedOutput.startsWith("{") || trimmedOutput.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmedOutput);

			// Collapsed: inline format like Args
			if (!expanded) {
				lines.push(`${continuePrefix}${theme.fg("dim", formatOutputInline(parsed, theme))}`);
				return lines;
			}

			// Expanded: tree format
			lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);
			const tree = renderJsonTreeLines(parsed, theme, expanded ? 6 : 2, expanded ? 24 : 6);
			if (tree.lines.length > 0) {
				for (const line of tree.lines) {
					lines.push(`${continuePrefix}  ${line}`);
				}
				if (tree.truncated) {
					lines.push(`${continuePrefix}  ${theme.fg("dim", "…")}`);
				}
				return lines;
			}
		} catch {
			// Fall back to raw output
		}
	}

	lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);

	const outputLines = output.trimEnd().split("\n");
	const previewCount = expanded ? maxExpanded : maxCollapsed;
	for (const line of outputLines.slice(0, previewCount)) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(line), 70))}`);
	}

	if (outputLines.length > previewCount) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", formatMoreItems(outputLines.length - previewCount, "line"))}`);
	}

	return lines;
}

function renderTaskSection(
	task: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	maxExpanded = 20,
): string[] {
	const lines: string[] = [];
	const trimmed = task.trim();
	if (!expanded || !trimmed) return lines;

	lines.push(`${continuePrefix}${theme.fg("dim", "Task")}`);
	const taskLines = trimmed.split("\n");
	for (const line of taskLines.slice(0, maxExpanded)) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(line), 70))}`);
	}
	if (taskLines.length > maxExpanded) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", formatMoreItems(taskLines.length - maxExpanded, "line"))}`);
	}

	return lines;
}

function formatScalarInline(value: unknown, maxLen: number, _theme: Theme): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") {
		const firstLine = value.split("\n")[0].trim();
		if (firstLine.length === 0) return `"" (${value.split("\n").length} lines)`;
		const preview = truncateToWidth(firstLine, maxLen);
		if (value.includes("\n")) return `"${preview}…" (${value.split("\n").length} lines)`;
		return `"${preview}"`;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") {
		const keys = Object.keys(value);
		return `{${keys.length} keys}`;
	}
	return String(value);
}

function formatOutputInline(data: unknown, theme: Theme, maxWidth = 80): string {
	if (data === null || data === undefined) return "Output: none";

	// For scalars, show directly
	if (typeof data !== "object") {
		return `Output: ${formatScalarInline(data, 60, theme)}`;
	}

	// For arrays, show count and first element preview
	if (Array.isArray(data)) {
		if (data.length === 0) return "Output: []";
		const preview = formatScalarInline(data[0], 40, theme);
		return `Output: [${data.length} items] ${preview}${data.length > 1 ? "…" : ""}`;
	}

	// For objects, show key=value pairs inline
	const entries = Object.entries(data as Record<string, unknown>);
	if (entries.length === 0) return "Output: {}";

	const pairs: string[] = [];
	let totalLen = "Output: ".length;

	for (const [key, value] of entries) {
		const valueStr = formatScalarInline(value, 24, theme);
		const pairStr = `${key}=${valueStr}`;
		const addLen = pairs.length > 0 ? pairStr.length + 2 : pairStr.length; // +2 for ", "

		if (totalLen + addLen > maxWidth && pairs.length > 0) {
			pairs.push("…");
			break;
		}

		pairs.push(pairStr);
		totalLen += addLen;
	}

	return `Output: ${pairs.join(", ")}`;
}

/**
 * Render the per-task list (`id` + ui `description`) for the streaming call
 * preview. The args stream in token by token, so the array grows over time and
 * trailing entries may be partially parsed — every field access is defensive.
 */
function renderTaskItemLines(tasks: TaskItem[] | undefined, expanded: boolean, theme: Theme): string[] {
	const items = tasks ?? [];
	if (items.length === 0) return [];

	const bullet = theme.fg("dim", "•");
	const cap = expanded ? items.length : Math.min(items.length, 12);
	const truncated = cap < items.length;

	const lines: string[] = [];
	for (let i = 0; i < cap; i++) {
		const task = items[i] as Partial<TaskItem> | undefined;
		const rawId = task?.id?.trim();
		const idLabel = rawId ? formatTaskId(rawId) : `#${i + 1}`;
		let line = `${bullet} ${theme.fg("accent", theme.bold(idLabel))}`;
		const desc = task?.description?.trim();
		if (desc) {
			line += `: ${theme.fg("muted", truncateToWidth(replaceTabs(desc), 64))}`;
		}
		lines.push(line);
	}
	if (truncated) {
		lines.push(`${bullet} ${theme.fg("dim", formatMoreItems(items.length - cap, "agent"))}`);
	}
	return lines;
}

/**
 * Build the shared-context section (the `# Goal / # Constraints` background
 * passed to every subagent). Rendered in both the streaming call preview and
 * the merged result frame so the brief stays visible for the whole task
 * lifecycle — not just until the first progress snapshot replaces the call view.
 */
type TaskRenderSection = { lines: string[] };
type ContextSectionRenderer = (width: number) => TaskRenderSection;

// Default output-block layout is: left border + one-cell content inset + right
// border. Render markdown at that inner width so the output block does not need
// to rewrap already-rendered context lines.
const CONTEXT_FRAME_INSET = 3;

function contextMarkdownWidth(frameWidth: number): number {
	return Math.max(1, frameWidth - CONTEXT_FRAME_INSET);
}

function createContextSectionRenderer(args: TaskParams | undefined, theme: Theme): ContextSectionRenderer | undefined {
	// `renderResult` receives the raw tool args (unlike `renderCall`, which is
	// fed through `repairTaskParams`), so undo any per-field double-encoding here
	// too. The repair is idempotent on already-clean text.
	const context = repairDoubleEncodedJsonString(args?.context ?? "").trim();
	if (!context) return undefined;

	const markdown = new Markdown(context, 0, 0, getMarkdownTheme(), {
		color: text => theme.fg("muted", text),
	});
	return width => ({ lines: markdown.render(contextMarkdownWidth(width)) });
}

/**
 * Render the tool call arguments.
 */
export function renderCall(
	args: TaskParams,
	options: RenderResultOptions & { renderContext?: { hasResult?: boolean } },
	theme: Theme,
): Component {
	const showIsolated = "isolated" in args && args.isolated === true;
	const header = renderStatusLine({ icon: "pending", title: "Task", description: args.agent }, theme);
	const contextSectionRenderer = createContextSectionRenderer(args, theme);
	return framedBlock(theme, width => {
		const sections: Array<{ label?: string; lines: string[]; separator?: boolean }> = [];

		if (contextSectionRenderer) sections.push(contextSectionRenderer(width));

		// The per-task preview list only exists to surface dispatched agents while
		// the call args stream in. Once a result snapshot exists, `renderResult`
		// draws the same agents as progress/result lines, so showing the Tasks
		// section here would just repeat the count the result frame already shows.
		if (!options.renderContext?.hasResult) {
			sections.push({
				separator: true,
				lines: renderTaskItemLines(args.tasks, options.expanded, theme),
			});
		}

		return {
			header,
			headerMeta: showIsolated ? "isolated" : undefined,
			sections,
			state: "pending",
			borderColor: "borderMuted",
			width,
		};
	});
}

/**
 * Render streaming progress for a single agent.
 */
function renderAgentProgress(
	progress: AgentProgress,
	prefix: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	spinnerFrame?: number,
): string[] {
	const lines: string[] = [];

	const icon = getStatusIcon(progress.status, theme, spinnerFrame);
	const iconColor =
		progress.status === "completed"
			? "success"
			: progress.status === "failed" || progress.status === "aborted"
				? "error"
				: "accent";

	// Main status line: id: description [status] · stats · ⟨agent⟩
	const description = progress.description?.trim();
	const displayId = formatTaskId(progress.id);
	const titlePart = description ? `${theme.bold(displayId)}: ${description}` : displayId;
	const indent = prefix ? `${prefix} ` : "";
	let statusLine: string;
	if (progress.status === "running") {
		const bullet = theme.fg("accent", "•");
		const name = theme.fg("accent", description ? theme.bold(displayId) : displayId);
		statusLine = `${indent}${bullet} ${name}`;
		if (description) {
			const desc = shimmerEnabled() ? shimmerText(description, theme) : theme.fg("accent", description);
			statusLine += `${theme.fg("accent", ":")} ${desc}`;
		}
	} else {
		statusLine = `${indent}${theme.fg(iconColor, icon)} ${theme.fg("accent", titlePart)}`;
	}

	// Show retry-blocked badge so the parent immediately sees that a child
	// is sleeping on a provider 429, not silently progressing. Wins over the
	// generic running marker because "we're waiting on a quota window" is
	// the operationally meaningful state.
	if (progress.retryState && progress.status === "running") {
		statusLine += ` ${formatBadge("retrying", "warning", theme)}`;
	} else if (progress.retryFailure && (progress.status === "failed" || progress.status === "aborted")) {
		statusLine += ` ${formatBadge("rate-limited", "error", theme)}`;
	} else if (progress.status === "failed" || progress.status === "aborted") {
		const statusLabel = progress.status === "failed" ? "failed" : "aborted";
		statusLine += ` ${formatBadge(statusLabel, iconColor, theme)}`;
	}

	const showBadge = settings.get("task.showResolvedModelBadge");
	if (progress.status === "running") {
		if (!description) {
			const taskPreview = truncateToWidth(progress.assignment ?? progress.task, 40);
			statusLine += ` ${theme.fg("muted", taskPreview)}`;
		}
		statusLine = appendAgentStats(statusLine, { ...progress, showResolvedModelBadge: showBadge }, theme);
	} else if (progress.status === "completed") {
		statusLine = appendAgentStats(statusLine, { ...progress, showResolvedModelBadge: showBadge }, theme);
	}

	lines.push(statusLine);

	lines.push(...renderTaskSection(progress.assignment ?? progress.task, continuePrefix, expanded, theme));

	// Current tool (if running) or most recent completed tool
	if (progress.status === "running") {
		if (progress.currentTool) {
			let toolLine = `${continuePrefix}${theme.tree.hook} ${theme.fg("muted", progress.currentTool)}`;
			const toolDetail = progress.lastIntent ?? progress.currentToolArgs;
			if (toolDetail) {
				toolLine += `: ${theme.fg("dim", truncateToWidth(replaceTabs(toolDetail), 40))}`;
			}
			if (progress.currentToolStartMs) {
				const elapsed = Date.now() - progress.currentToolStartMs;
				if (elapsed > 5000) {
					toolLine += `${theme.sep.dot}${theme.fg("warning", formatDuration(elapsed))}`;
				}
			}
			lines.push(toolLine);
		} else if (progress.recentTools.length > 0) {
			// Show most recent completed tool when idle between tools
			const recent = progress.recentTools[0];
			let toolLine = `${continuePrefix}${theme.tree.hook} ${theme.fg("dim", recent.tool)}`;
			const toolDetail = progress.lastIntent ?? recent.args;
			if (toolDetail) {
				toolLine += `: ${theme.fg("dim", truncateToWidth(replaceTabs(toolDetail), 40))}`;
			}
			lines.push(toolLine);
		}
	}

	// Retry detail line: surface why the subagent is paused and roughly how
	// long until the next attempt. Without this, the parent UI would just
	// keep spinning while a child sleeps on a 3-hour provider rate-limit.
	if (progress.retryState && progress.status === "running") {
		const remainingMs = Math.max(0, progress.retryState.startedAtMs + progress.retryState.delayMs - Date.now());
		const waitLabel = remainingMs > 0 ? `in ${formatDuration(remainingMs)}` : "now";
		const summary =
			`retrying ${progress.retryState.attempt}/${progress.retryState.maxAttempts} ${waitLabel}: ` +
			truncateToWidth(replaceTabs(progress.retryState.errorMessage), 60);
		lines.push(`${continuePrefix}${theme.tree.hook} ${theme.fg("warning", summary)}`);
	} else if (progress.retryFailure && progress.status !== "running") {
		const summary = `auto-retry gave up after ${progress.retryFailure.attempt} attempt${
			progress.retryFailure.attempt === 1 ? "" : "s"
		}: ${truncateToWidth(replaceTabs(progress.retryFailure.errorMessage), 80)}`;
		lines.push(`${continuePrefix}${theme.tree.hook} ${theme.fg("error", summary)}`);
	}

	// Render extracted tool data inline (e.g., review findings)
	if (progress.extractedToolData) {
		// For completed tasks, check for review verdict from yield tool
		if (progress.status === "completed") {
			const completeData = normalizeYieldData(progress.extractedToolData.yield);
			const reportFindingData = normalizeReportFindings(progress.extractedToolData.report_finding);
			const reviewData = completeData
				.map(c => c.data as SubmitReviewDetails)
				.filter(d => d && typeof d === "object" && "overall_correctness" in d);
			if (reviewData.length > 0) {
				const summary = reviewData[reviewData.length - 1];
				const findings = reportFindingData;
				lines.push(...renderReviewResult(summary, findings, continuePrefix, expanded, theme));
				return lines; // Review result handles its own rendering
			}
		}

		for (const toolName in progress.extractedToolData) {
			const dataArray = progress.extractedToolData[toolName];
			// Handle report_finding with tree formatting
			if (toolName === "report_finding") {
				const findings = normalizeReportFindings(dataArray);
				if (findings.length === 0) continue;
				lines.push(`${continuePrefix}${formatFindingSummary(findings, theme)}`);
				lines.push(...renderFindings(findings, continuePrefix, expanded, theme));
				continue;
			}

			// Nested `task` data has its own dedicated tree renderer below that
			// also merges in the in-flight snapshot — skip the generic inline
			// path so we don't render twice.
			if (toolName === "task") continue;

			const handler = subprocessToolRegistry.getHandler(toolName);
			if (handler?.renderInline) {
				const displayCount = expanded ? (dataArray as unknown[]).length : 3;
				const recentData = (dataArray as unknown[]).slice(-displayCount);
				for (const data of recentData) {
					const component = handler.renderInline(data, theme);
					if (component instanceof Text) {
						lines.push(`${continuePrefix}${component.getText()}`);
					}
				}
				if ((dataArray as unknown[]).length > displayCount) {
					lines.push(
						`${continuePrefix}${theme.fg(
							"dim",
							formatMoreItems((dataArray as unknown[]).length - displayCount, "item"),
						)}`,
					);
				}
			}
		}
	}

	// Nested `task` tree: completed sub-calls from `extractedToolData.task` plus
	// the in-flight snapshot (if any). Surfacing this in the live view means
	// the user sees deep-tree progress without waiting for this agent to finish
	// its own turn.
	const completedTaskCalls = (progress.extractedToolData?.task as TaskToolDetails[] | undefined) ?? [];
	const inflight = progress.inflightTaskDetails;
	if (completedTaskCalls.length > 0 || inflight) {
		const snapshots = inflight ? [...completedTaskCalls, inflight] : completedTaskCalls;
		const nestedLines = renderNestedTaskTree(snapshots, expanded, theme, spinnerFrame);
		for (const line of nestedLines) {
			lines.push(`${continuePrefix}${line}`);
		}
	}

	// Expanded view: recent output and tools
	if (expanded && progress.status === "running") {
		const output = progress.recentOutput.join("\n");
		lines.push(...renderOutputSection(output, continuePrefix, true, theme, 2, 6));
	}

	return lines;
}

/**
 * Render review result with combined verdict + findings in tree structure.
 */
function renderReviewResult(
	summary: SubmitReviewDetails,
	findings: ReportFindingDetails[],
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
): string[] {
	const lines: string[] = [];

	// Verdict line
	const verdictColor = summary.overall_correctness === "correct" ? "success" : "error";
	const verdictIcon = summary.overall_correctness === "correct" ? theme.status.success : theme.status.error;
	lines.push(
		`${continuePrefix} Patch is ${theme.fg(verdictColor, summary.overall_correctness)} ${theme.fg(
			verdictColor,
			verdictIcon,
		)} ${theme.fg("dim", `(${(summary.confidence * 100).toFixed(0)}% confidence)`)}`,
	);

	// Explanation preview (first ~80 chars when collapsed, full when expanded)
	if (summary.explanation) {
		if (expanded) {
			lines.push(`${continuePrefix}${theme.fg("dim", "Summary")}`);
			const explanationLines = summary.explanation.split("\n");
			for (const line of explanationLines) {
				lines.push(`${continuePrefix}  ${theme.fg("dim", replaceTabs(line))}`);
			}
		} else {
			// Preview: first sentence or ~100 chars (flatten tabs/newlines first)
			const flat = replaceTabs(summary.explanation).replace(/[\r\n]+/g, " ");
			const firstSentence = flat.split(/[.!?]/)[0].trim();
			const preview = truncateToWidth(`${firstSentence}.`, 100);
			lines.push(`${continuePrefix}${theme.fg("dim", preview)}`);
		}
	}

	// Findings summary + list
	lines.push(`${continuePrefix}${formatFindingSummary(findings, theme)}`);

	if (findings.length > 0) {
		lines.push(...renderFindings(findings, continuePrefix, expanded, theme));
	}

	return lines;
}

/**
 * Render review findings list.
 */
function renderFindings(
	findings: ReportFindingDetails[],
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
): string[] {
	const lines: string[] = [];

	// Sort by priority (lower = more severe) when collapsed to show most important first
	const sortedFindings = expanded
		? findings
		: [...findings].sort((a, b) => getPriorityInfo(a.priority).ord - getPriorityInfo(b.priority).ord);
	const displayCount = expanded ? sortedFindings.length : Math.min(3, sortedFindings.length);

	for (let i = 0; i < displayCount; i++) {
		const finding = sortedFindings[i];
		const isLastFinding = i === displayCount - 1 && (expanded || sortedFindings.length <= 3);
		const findingPrefix = isLastFinding ? theme.tree.last : theme.tree.branch;
		const findingContinue = isLastFinding ? "   " : `${theme.tree.vertical}  `;

		const { color } = getPriorityInfo(finding.priority);
		const rawTitle = finding.title?.replace(/^\[P\d\]\s*/, "") ?? "Untitled";
		const titleText = replaceTabs(rawTitle).replace(/[\r\n]+/g, " ");
		const loc = `${path.basename(finding.file_path || "<unknown>")}:${finding.line_start}`;

		lines.push(
			`${continuePrefix}${findingPrefix} ${theme.fg(color, `[${finding.priority}]`)} ${titleText} ${theme.fg("dim", loc)}`,
		);

		// Show body when expanded
		if (expanded && finding.body) {
			// Wrap body text
			const bodyLines = finding.body.split("\n");
			for (const bodyLine of bodyLines) {
				lines.push(`${continuePrefix}${findingContinue}${theme.fg("dim", replaceTabs(bodyLine))}`);
			}
		}
	}

	if (!expanded && findings.length > 3) {
		lines.push(`${continuePrefix}${theme.fg("dim", formatMoreItems(findings.length - 3, "finding"))}`);
	}

	return lines;
}

/**
 * Render final result for a single agent.
 */
function renderAgentResult(
	result: SingleResult,
	prefix: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
): string[] {
	const lines: string[] = [];

	const { warning: missingCompleteWarning, rest: outputWithoutWarning } = extractMissingYieldWarning(result.output);
	const aborted = result.aborted ?? false;
	const mergeFailed = !aborted && result.exitCode === 0 && !!result.error;
	const success = !aborted && result.exitCode === 0 && !result.error;
	const needsWarning = Boolean(missingCompleteWarning) && success;
	const icon = aborted
		? theme.status.aborted
		: needsWarning
			? theme.status.warning
			: success
				? theme.status.success
				: theme.status.error;
	const iconColor = needsWarning ? "warning" : success ? "success" : mergeFailed ? "warning" : "error";
	const statusText = aborted
		? "aborted"
		: needsWarning
			? "warning"
			: success
				? "done"
				: mergeFailed
					? "merge failed"
					: "failed";

	// Main status line: id: description [status] · stats · ⟨agent⟩
	const description = result.description?.trim();
	const displayId = formatTaskId(result.id);
	const titlePart = description ? `${theme.bold(displayId)}: ${description}` : displayId;
	let statusLine = `${prefix ? `${prefix} ` : ""}${theme.fg(iconColor, icon)} ${theme.fg("accent", titlePart)} ${formatBadge(
		statusText,
		iconColor,
		theme,
	)}`;
	const showBadge = settings.get("task.showResolvedModelBadge");
	statusLine = appendAgentStats(
		statusLine,
		{
			tokens: result.tokens,
			contextTokens: result.contextTokens,
			contextWindow: result.contextWindow,
			cost: result.usage?.cost.total ?? 0,
			resolvedModel: result.resolvedModel,
			showResolvedModelBadge: showBadge,
		},
		theme,
	);
	statusLine += `${theme.sep.dot}${theme.fg("dim", formatDuration(result.durationMs))}`;

	if (result.truncated) {
		statusLine += ` ${theme.fg("warning", "[truncated]")}`;
	}

	lines.push(statusLine);

	lines.push(...renderTaskSection(result.assignment ?? result.task, continuePrefix, expanded, theme));

	if (aborted && result.abortReason) {
		lines.push(
			`${continuePrefix}${theme.fg("error", theme.status.aborted)} ${theme.fg("dim", truncateToWidth(replaceTabs(result.abortReason), 80))}`,
		);
	}
	// Check for review result (yield with review schema + report_finding)
	// Check for review result (yield with review schema + report_finding).
	// `normalizeYieldData` guards against a stray non-array `yield` slot —
	// optional chaining on `.map` only short-circuits on null/undefined and
	// would otherwise crash the renderer with `TypeError: completeData?.map
	// is not a function` when the slot is a plain object (see issue #1987).
	const completeData = normalizeYieldData(result.extractedToolData?.yield);
	const reportFindingData = normalizeReportFindings(result.extractedToolData?.report_finding);

	// Extract review verdict from yield tool's data field if it matches SubmitReviewDetails
	const reviewData = completeData
		.map(c => c.data as SubmitReviewDetails)
		.filter(d => d && typeof d === "object" && "overall_correctness" in d);
	const submitReviewData = reviewData.length > 0 ? reviewData : undefined;

	if (submitReviewData) {
		// Use combined review renderer
		const summary = submitReviewData[submitReviewData.length - 1];
		const findings = reportFindingData;
		lines.push(...renderReviewResult(summary, findings, continuePrefix, expanded, theme));
		return lines;
	}
	if (reportFindingData.length > 0) {
		const hasCompleteData = completeData.length > 0;
		const message = hasCompleteData
			? "Review verdict missing expected fields"
			: "Review incomplete (yield not called)";
		lines.push(`${continuePrefix}${theme.fg("warning", theme.status.warning)} ${theme.fg("dim", message)}`);
		lines.push(`${continuePrefix}${formatFindingSummary(reportFindingData, theme)}`);
		lines.push(...renderFindings(reportFindingData, continuePrefix, expanded, theme));
		return lines;
	}

	// Check for extracted tool data with custom renderers (skip review tools)
	let hasCustomRendering = false;
	const deferredToolLines: string[] = [];
	if (result.extractedToolData) {
		for (const [toolName, dataArray] of Object.entries(result.extractedToolData)) {
			// Skip review tools - handled above
			if (toolName === "yield" || toolName === "report_finding") continue;

			const handler = subprocessToolRegistry.getHandler(toolName);
			if (handler?.renderFinal && (dataArray as unknown[]).length > 0) {
				const isTaskTool = toolName === "task";
				const component = handler.renderFinal(dataArray as unknown[], theme, expanded);
				const target = isTaskTool ? deferredToolLines : lines;
				if (!isTaskTool) {
					hasCustomRendering = true;
					target.push(`${continuePrefix}${theme.fg("dim", `Tool: ${toolName}`)}`);
				}
				if (component instanceof Text) {
					// Prefix each line with continuePrefix
					const text = component.getText();
					for (const line of text.split("\n")) {
						target.push(`${continuePrefix}${line}`);
					}
				} else if (component instanceof Container) {
					// For containers, render each child
					for (const child of (component as Container).children) {
						if (child instanceof Text) {
							target.push(`${continuePrefix}${child.getText()}`);
						}
					}
				}
			}
		}
	}

	if (hasCustomRendering && missingCompleteWarning) {
		lines.push(
			`${continuePrefix}${theme.fg("warning", theme.status.warning)} ${theme.fg(
				"dim",
				truncateToWidth(missingCompleteWarning, 80),
			)}`,
		);
	}

	// Fallback to output preview if no custom rendering
	if (!hasCustomRendering) {
		lines.push(
			...renderOutputSection(outputWithoutWarning, continuePrefix, expanded, theme, 3, 12, missingCompleteWarning),
		);
	}

	if (deferredToolLines.length > 0) {
		lines.push(...deferredToolLines);
	}

	if (result.patchPath && !aborted && result.exitCode === 0) {
		lines.push(`${continuePrefix}${theme.fg("dim", `Patch: ${result.patchPath}`)}`);
	} else if (result.branchName && !aborted && result.exitCode === 0) {
		lines.push(`${continuePrefix}${theme.fg("dim", `Branch: ${result.branchName}`)}`);
	}

	// Error message
	if (result.error && (!success || mergeFailed) && (!aborted || result.error !== result.abortReason)) {
		lines.push(
			`${continuePrefix}${theme.fg(mergeFailed ? "warning" : "error", truncateToWidth(replaceTabs(result.error), 70))}`,
		);
	}

	return lines;
}

/**
 * Render the tool result.
 */
export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: TaskToolDetails },
	options: RenderResultOptions,
	theme: Theme,
	args?: TaskParams,
): Component {
	const fallbackText = result.content.find(c => c.type === "text")?.text ?? "";
	const details = result.details;
	const contextSectionRenderer = createContextSectionRenderer(args, theme);

	if (!details) {
		const text = result.content.find(c => c.type === "text")?.text || "";
		const header = renderStatusLine({ icon: "success", title: "Task" }, theme);
		return framedBlock(theme, width => ({
			header,
			sections: [
				...(contextSectionRenderer ? [contextSectionRenderer(width)] : []),
				...(text ? [{ separator: true, lines: [theme.fg("dim", truncateToWidth(text, width))] }] : []),
			],
			state: "success",
			borderColor: "borderMuted",
			width,
		}));
	}

	const hasResults = Boolean(details.results && details.results.length > 0);
	const aborted = hasResults && details.results.some(r => r.aborted);
	const failed = hasResults && details.results.some(r => !r.aborted && r.exitCode !== 0);
	const mergeFailed = hasResults && details.results.some(r => !r.aborted && r.exitCode === 0 && Boolean(r.error));
	const isError = aborted || failed;
	const agentCount = hasResults ? details.results.length : (details.progress?.length ?? 0);
	const icon: ToolUIStatus = options.isPartial ? "running" : isError ? "error" : mergeFailed ? "warning" : "success";
	// Surface the dispatched agent type (e.g. `Reviewer`) alongside the count so
	// the header reads `Task 16 agents: Reviewer`. All tasks in one call share a
	// single `agent` type (top-level param), so one label covers the whole batch.
	const agentName = args?.agent?.trim();
	const countLabel = agentCount > 0 ? `${agentCount} ${agentCount === 1 ? "agent" : "agents"}` : undefined;
	const metaLabel = countLabel ? (agentName ? `${countLabel}: ${agentName}` : countLabel) : agentName;
	const header = renderStatusLine(
		{
			icon,
			title: "Task",
			meta: metaLabel ? [metaLabel] : undefined,
		},
		theme,
	);

	return framedBlock(theme, width => {
		const { expanded, isPartial, spinnerFrame } = options;
		const lines: string[] = [];

		const shouldRenderProgress =
			Boolean(details.progress && details.progress.length > 0) && (isPartial || details.results.length === 0);
		if (shouldRenderProgress && details.progress) {
			details.progress.forEach(progress => {
				lines.push(...renderAgentProgress(progress, "", "  ", expanded, theme, spinnerFrame));
			});
		} else if (details.results && details.results.length > 0) {
			details.results.forEach(res => {
				lines.push(...renderAgentResult(res, "", "  ", expanded, theme));
			});

			const abortedCount = details.results.filter(r => r.aborted).length;
			const mergeFailedCount = details.results.filter(r => !r.aborted && r.exitCode === 0 && r.error).length;
			const successCount = details.results.filter(r => !r.aborted && r.exitCode === 0 && !r.error).length;
			const failCount = details.results.length - successCount - mergeFailedCount - abortedCount;
			const summaryParts: string[] = [];
			if (abortedCount > 0) summaryParts.push(theme.fg("error", `${abortedCount} aborted`));
			if (successCount > 0) summaryParts.push(theme.fg("success", `${successCount} succeeded`));
			if (mergeFailedCount > 0) summaryParts.push(theme.fg("warning", `${mergeFailedCount} merge failed`));
			if (failCount > 0) summaryParts.push(theme.fg("error", `${failCount} failed`));
			summaryParts.push(theme.fg("dim", formatDuration(details.totalDurationMs)));
			// Wrap the run summary in the theme's bracket glyphs (dim chrome, colored
			// counts) to match the bash tool's `[Wall: … | Exit: …]` footer.
			lines.push(
				theme.fg("dim", theme.format.bracketLeft) +
					summaryParts.join(theme.fg("dim", theme.sep.dot)) +
					theme.fg("dim", theme.format.bracketRight),
			);
		}

		const state = isPartial ? "running" : isError ? "error" : mergeFailed ? "warning" : "success";
		const borderColor = isError ? "error" : "borderMuted";

		if (lines.length === 0) {
			const text = fallbackText.trim() ? fallbackText : "No results";
			return {
				header,
				sections: [
					...(contextSectionRenderer ? [contextSectionRenderer(width)] : []),
					{ separator: true, lines: [theme.fg("dim", truncateToWidth(text, width))] },
				],
				state,
				borderColor,
				width,
			};
		}

		if (fallbackText.trim()) {
			const summaryLines = fallbackText.split("\n");
			const markerIndex = summaryLines.findIndex(
				line =>
					line.includes("<system-notification>") ||
					line.startsWith("Applied patches:") ||
					line.startsWith("No changes to apply."),
			);
			if (markerIndex >= 0) {
				const extra = summaryLines.slice(markerIndex);
				for (const line of extra) {
					if (!line.trim()) continue;
					lines.push(theme.fg("dim", line));
				}
			}
		}

		while (lines.length > 0 && lines[0].trim() === "") lines.shift();
		return {
			header,
			sections: [
				...(contextSectionRenderer ? [contextSectionRenderer(width)] : []),
				...(lines.length > 0 ? [{ separator: true, lines }] : []),
			],
			state,
			borderColor,
			width,
		};
	});
}

function isTaskToolDetails(value: unknown): value is TaskToolDetails {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		"results" in (value as TaskToolDetails) &&
		Array.isArray((value as TaskToolDetails).results)
	);
}

// Nested subagent snapshots sit one or more levels below the frame border, so
// they keep tree guides to convey depth (the parent prepends its own continue
// prefix). Only the top-level agent list drops guides (the frame is its box).
function nestedMarkers(isLast: boolean, theme: Theme): { prefix: string; continuePrefix: string } {
	return {
		prefix: isLast ? theme.fg("dim", theme.tree.last) : theme.fg("dim", theme.tree.branch),
		continuePrefix: isLast ? "   " : `${theme.fg("dim", theme.tree.vertical)}  `,
	};
}

function renderNestedTaskResults(detailsList: TaskToolDetails[], expanded: boolean, theme: Theme): string[] {
	const lines: string[] = [];
	for (const details of detailsList) {
		if (!details.results || details.results.length === 0) continue;
		details.results.forEach((result, index) => {
			const { prefix, continuePrefix } = nestedMarkers(index === details.results.length - 1, theme);
			lines.push(...renderAgentResult(result, prefix, continuePrefix, expanded, theme));
		});
	}
	return lines;
}

/**
 * Render a list of `TaskToolDetails` snapshots — completed (`results[]`) or
 * in-flight (`progress[]`) — as an interleaved tree. Used by the live progress
 * view to surface nested subagent activity while this agent is still running.
 */
function renderNestedTaskTree(
	detailsList: TaskToolDetails[],
	expanded: boolean,
	theme: Theme,
	spinnerFrame?: number,
): string[] {
	const lines: string[] = [];
	for (const details of detailsList) {
		const hasResults = Boolean(details.results && details.results.length > 0);
		if (hasResults) {
			details.results.forEach((result, index) => {
				const { prefix, continuePrefix } = nestedMarkers(index === details.results.length - 1, theme);
				lines.push(...renderAgentResult(result, prefix, continuePrefix, expanded, theme));
			});
			continue;
		}
		const inflight = details.progress;
		if (inflight && inflight.length > 0) {
			inflight.forEach((prog, index) => {
				const { prefix, continuePrefix } = nestedMarkers(index === inflight.length - 1, theme);
				lines.push(...renderAgentProgress(prog, prefix, continuePrefix, expanded, theme, spinnerFrame));
			});
		}
	}
	return lines;
}

subprocessToolRegistry.register<TaskToolDetails>("task", {
	extractData: event => {
		const details = event.result?.details;
		return isTaskToolDetails(details) ? details : undefined;
	},
	renderFinal: (allData, theme, expanded) => {
		const lines = renderNestedTaskResults(allData, expanded, theme);
		return new Text(lines.join("\n"), 0, 0);
	},
});

export const taskToolRenderer = {
	renderCall,
	renderResult,
	mergeCallAndResult: true,
};

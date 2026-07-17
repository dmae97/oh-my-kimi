/**
 * Hierarchical tree list rendering helper.
 */

import { replaceTabs } from "@oh-my-pi/pi-tui";
import type { Theme } from "../modes/theme/theme";
import { formatMoreItems } from "../tools/render-utils";
import type { TreeContext } from "./types";
import { getTreeBranch, getTreeContinuePrefix } from "./utils";

export interface TreeListOptions<T> {
	items: T[];
	expanded?: boolean;
	maxCollapsed?: number;
	/** Strict total-line budget for collapsed mode. When set (and not expanded),
	 *  rendered item lines plus the trailing summary line must fit within this budget.
	 */
	maxCollapsedLines?: number;
	itemType?: string;
	truncateFrom?: "start" | "end";
	/** Index (into `items`) of the task that MUST stay visible when collapsed —
	 *  the in-progress task or a subagent-matched pending task. When set, the
	 *  collapsed window slides to include it, emitting leading/trailing
	 *  `… N more` summaries on whichever side is truncated. Bounds the preview by
	 *  `maxCollapsed` items; ignores `maxCollapsedLines`. Ignored when expanded or
	 *  when everything already fits. */
	anchorIndex?: number;
	/** Called once per item with `isLast: false` during budget calculation;
	 *  line count MUST NOT vary based on `isLast`. */
	renderItem: (item: T, context: TreeContext) => string | string[];
}

export function renderTreeList<T>(options: TreeListOptions<T>, theme: Theme): string[] {
	const {
		items,
		expanded = false,
		maxCollapsed = 8,
		maxCollapsedLines,
		itemType = "item",
		truncateFrom = "end",
		renderItem,
	} = options;
	const maxItems = expanded ? items.length : Math.min(items.length, maxCollapsed);
	const linesBudget = !expanded && maxCollapsedLines !== undefined ? maxCollapsedLines : Infinity;

	// Anchored collapse: keep a specific item (in-progress / subagent-matched
	// task) visible by sliding a `maxItems`-wide window over it, with two-sided
	// `… N more` summaries. Edge truncation can only keep a head or tail slice,
	// so an active item in the middle would otherwise vanish.
	if (
		!expanded &&
		options.anchorIndex !== undefined &&
		options.anchorIndex >= 0 &&
		options.anchorIndex < items.length &&
		items.length > maxItems
	) {
		const half = Math.floor((maxItems - 1) / 2);
		const winStart = Math.min(Math.max(options.anchorIndex - half, 0), items.length - maxItems);
		const winEnd = winStart + maxItems;
		const before = winStart;
		const after = items.length - winEnd;
		const lines: string[] = [];
		if (before > 0) {
			lines.push(`${theme.fg("dim", theme.tree.branch)} ${theme.fg("muted", formatMoreItems(before, itemType))}`);
		}
		for (let i = winStart; i < winEnd; i++) {
			const rendered = renderItem(items[i], {
				index: i,
				isLast: false,
				depth: 0,
				theme,
				prefix: "",
				continuePrefix: "",
			});
			const itemLines = Array.isArray(rendered) ? rendered : rendered ? [rendered] : [];
			if (itemLines.length === 0) continue;
			const isLast = after === 0 && i === winEnd - 1;
			const prefix = `${theme.fg("dim", getTreeBranch(isLast, theme))} `;
			const continuePrefix = `${theme.fg("dim", getTreeContinuePrefix(isLast, theme))}`;
			lines.push(`${prefix}${replaceTabs(itemLines[0]!)}`);
			for (let j = 1; j < itemLines.length; j++) {
				lines.push(`${continuePrefix}${replaceTabs(itemLines[j]!)}`);
			}
		}
		if (after > 0) {
			lines.push(`${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", formatMoreItems(after, itemType))}`);
		}
		return lines;
	}

	const candidateIndices: number[] = [];
	if (truncateFrom === "start") {
		const startCandidateIdx = Math.max(0, items.length - maxItems);
		for (let i = startCandidateIdx; i < items.length; i++) {
			candidateIndices.push(i);
		}
	} else {
		for (let i = 0; i < maxItems; i++) {
			candidateIndices.push(i);
		}
	}

	// Pre-render each candidate item once.
	// isLast cannot be known at this point (fittingCount is not yet determined);
	// renderItem implementations MUST NOT vary line count based on isLast.
	const preRendered: string[][] = [];
	for (let i = 0; i < candidateIndices.length; i++) {
		const itemIdx = candidateIndices[i];
		const rendered = renderItem(items[itemIdx], {
			index: itemIdx,
			isLast: false,
			depth: 0,
			theme,
			prefix: "",
			continuePrefix: "",
		});
		preRendered.push(Array.isArray(rendered) ? rendered : rendered ? [rendered] : []);
	}

	let displayedSlice: { start: number; end: number };
	let remaining: number;
	let fittedLineCount = 0;

	if (truncateFrom === "start") {
		let fittingCount = candidateIndices.length;
		if (linesBudget !== Infinity) {
			fittingCount = 0;
			for (let i = candidateIndices.length - 1; i >= 0; i--) {
				const count = preRendered[i].length;
				const remainingBefore = candidateIndices[i];
				const reservedSummaryLines = remainingBefore > 0 ? 1 : 0;
				if (fittedLineCount + count + reservedSummaryLines > linesBudget) break;
				fittedLineCount += count;
				fittingCount++;
			}
		}
		const start = candidateIndices.length - fittingCount;
		displayedSlice = { start, end: candidateIndices.length };
		remaining = candidateIndices.length > 0 ? candidateIndices[start] : 0;
	} else {
		let fittingCount = candidateIndices.length;
		if (linesBudget !== Infinity) {
			fittingCount = 0;
			for (let i = 0; i < candidateIndices.length; i++) {
				const count = preRendered[i].length;
				const remainingAfter = items.length - (i + 1);
				const reservedSummaryLines = remainingAfter > 0 ? 1 : 0;
				if (fittedLineCount + count + reservedSummaryLines > linesBudget) break;
				fittedLineCount += count;
				fittingCount = i + 1;
			}
		}
		displayedSlice = { start: 0, end: fittingCount };
		remaining = items.length - fittingCount;
	}

	const hasSummary = !expanded && remaining > 0 && (linesBudget === Infinity || fittedLineCount < linesBudget);

	// Emit pre-rendered content with correct isLast-based branch prefixes.
	const lines: string[] = [];

	if (truncateFrom === "start" && hasSummary) {
		lines.push(`${theme.fg("dim", theme.tree.branch)} ${theme.fg("muted", formatMoreItems(remaining, itemType))}`);
	}

	for (let i = displayedSlice.start; i < displayedSlice.end; i++) {
		const isLast =
			truncateFrom === "start" ? i === displayedSlice.end - 1 : !hasSummary && i === displayedSlice.end - 1;
		const branch = getTreeBranch(isLast, theme);
		const prefix = `${theme.fg("dim", branch)} `;
		const continuePrefix = `${theme.fg("dim", getTreeContinuePrefix(isLast, theme))}`;
		const itemLines = preRendered[i]!;
		if (itemLines.length === 0) continue;
		lines.push(`${prefix}${replaceTabs(itemLines[0]!)}`);
		for (let j = 1; j < itemLines.length; j++) {
			lines.push(`${continuePrefix}${replaceTabs(itemLines[j]!)}`);
		}
	}

	if (truncateFrom === "end" && hasSummary) {
		lines.push(`${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", formatMoreItems(remaining, itemType))}`);
	}

	return lines;
}

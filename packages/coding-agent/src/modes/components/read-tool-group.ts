import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { InternalUrlRouter } from "../../internal-urls";
import { getLanguageFromPath, theme } from "../../modes/theme/theme";
import { parseLineRanges, splitPathAndSel } from "../../tools/path-utils";
import { PREVIEW_LIMITS, shortenPath } from "../../tools/render-utils";
import { renderCodeCell } from "../../tui";
import type { ToolExecutionHandle } from "./tool-execution";

/**
 * Read calls whose target is resolved through {@link InternalUrlRouter} are
 * rendered as full tool executions (not collapsed into the read group) so the
 * resolved content is visible. `path` is the canonical arg; `file_path` is the
 * legacy alias still tolerated by the read tool schema.
 */
function readArgsTarget(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const record = args as Record<string, unknown>;
	return typeof record.path === "string"
		? record.path
		: typeof record.file_path === "string"
			? record.file_path
			: undefined;
}

export function readArgsHaveTarget(args: unknown): boolean {
	return readArgsTarget(args) !== undefined;
}

export function readArgsTargetInternalUrl(args: unknown): boolean {
	const target = readArgsTarget(args);
	if (!target) return false;
	return InternalUrlRouter.instance().canHandle(target);
}

type ReadRenderArgs = {
	path?: string;
	file_path?: string;
	// Legacy field from the old schema; tolerated for rebuilt transcripts.
	sel?: string;
};

type ReadToolSuffixResolution = {
	from: string;
	to: string;
};

type ReadToolResultDetails = {
	suffixResolution?: {
		from?: string;
		to?: string;
	};
	conflictCount?: number;
	displayReadTargets?: unknown;
};

type ReadToolGroupOptions = {
	showContentPreview?: boolean;
};

function getSuffixResolution(details: ReadToolResultDetails | undefined): ReadToolSuffixResolution | undefined {
	if (typeof details?.suffixResolution?.from !== "string" || typeof details.suffixResolution.to !== "string") {
		return undefined;
	}
	return { from: details.suffixResolution.from, to: details.suffixResolution.to };
}

type ReadEntry = {
	toolCallId: string;
	path: string;
	displayPaths?: string[];
	status: "pending" | "success" | "warning" | "error";
	correctedFrom?: string;
	contentText?: string;
	conflictCount?: number;
};

/** Number of code lines to show in collapsed preview mode */
const COLLAPSED_PREVIEW_LINES = PREVIEW_LIMITS.OUTPUT_COLLAPSED;

type ReadDisplayTarget = {
	entry: ReadEntry;
	targetPath: string;
	basePath: string;
	selector?: string;
};

type ReadSummaryRow = {
	targetPath: string;
	basePath: string;
	targets: ReadDisplayTarget[];
};

const READ_STATUS_RANK: Record<ReadEntry["status"], number> = {
	success: 0,
	pending: 1,
	warning: 2,
	error: 3,
};

const URL_LIKE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function getDisplayReadTargets(details: ReadToolResultDetails | undefined): string[] | undefined {
	if (!Array.isArray(details?.displayReadTargets)) return undefined;
	const targets = details.displayReadTargets
		.filter((target): target is string => typeof target === "string")
		.map(target => target.trim())
		.filter(target => target.length > 0);
	return targets.length > 0 ? targets : undefined;
}

function selectorChunkIsLineRangeList(chunk: string): boolean {
	const trimmed = chunk.trim();
	if (!trimmed) return false;
	try {
		return parseLineRanges(trimmed) !== null;
	} catch {
		return false;
	}
}

function nextTopLevelToken(input: string, start: number): string {
	let braceDepth = 0;
	for (let i = start; i < input.length; i++) {
		const ch = input[i];
		if (ch === "\\" && i + 1 < input.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth === 0 && (ch === "," || ch === ";")) {
			return input.slice(start, i);
		}
	}
	return input.slice(start);
}

function commaContinuesLineRangeSelector(input: string, partStart: number, commaIndex: number): boolean {
	const currentPart = input.slice(partStart, commaIndex).trim();
	if (!splitPathAndSel(currentPart).sel) return false;
	return selectorChunkIsLineRangeList(nextTopLevelToken(input, commaIndex + 1));
}

function splitReadDisplayPathSpecs(rawPath: string): string[] {
	const normalized = rawPath.trim();
	if (!normalized || URL_LIKE_RE.test(normalized)) return [rawPath];

	const parts: string[] = [];
	let braceDepth = 0;
	let partStart = 0;
	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized[i];
		if (ch === "\\" && i + 1 < normalized.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth !== 0 || (ch !== "," && ch !== ";")) continue;
		if (ch === "," && commaContinuesLineRangeSelector(normalized, partStart, i)) continue;
		parts.push(normalized.slice(partStart, i).trim());
		partStart = i + 1;
	}
	parts.push(normalized.slice(partStart).trim());

	const cleanParts = parts.filter(part => part.length > 0);
	if (cleanParts.length <= 1) return [rawPath];
	return cleanParts.every(part => splitPathAndSel(part).sel !== undefined) ? cleanParts : [rawPath];
}

function splitSelectorDisplayParts(sel: string | undefined): Array<string | undefined> {
	if (!sel) return [undefined];
	const chunks = sel.split(":");
	if (chunks.length === 1) {
		if (!selectorChunkIsLineRangeList(sel) || !sel.includes(",")) return [sel];
		return sel
			.split(",")
			.map(chunk => chunk.trim())
			.filter(chunk => chunk.length > 0);
	}
	if (chunks.length === 2) {
		const [left, right] = chunks as [string, string];
		const leftIsRange = selectorChunkIsLineRangeList(left);
		const rightIsRange = selectorChunkIsLineRangeList(right);
		if (leftIsRange && left.includes(",")) {
			return left
				.split(",")
				.map(chunk => chunk.trim())
				.filter(chunk => chunk.length > 0)
				.map(chunk => `${chunk}:${right}`);
		}
		if (rightIsRange && right.includes(",")) {
			return right
				.split(",")
				.map(chunk => chunk.trim())
				.filter(chunk => chunk.length > 0)
				.map(chunk => `${left}:${chunk}`);
		}
	}
	return [sel];
}

function formatMergedSelectorParts(selectors: string[]): string {
	if (selectors.length <= 3) return selectors.join(",");
	const first = selectors[0]!;
	const second = selectors[1]!;
	const last = selectors[selectors.length - 1]!;
	return `${first},${second},…,${last}`;
}

export class ReadToolGroupComponent extends Container implements ToolExecutionHandle {
	#entries = new Map<string, ReadEntry>();
	#text: Text;
	#expanded = false;
	#showContentPreview: boolean;
	// A read group accretes entries across multiple assistant completions for as
	// long as the run of reads is uninterrupted. While it is the active group it
	// must stay in the transcript's repaintable live region — its header line
	// re-layouts from `Read <path>` to `Read (N)` + tree as entries arrive, so a
	// frozen snapshot taken on a risk terminal would strand the single-entry form
	// (see TranscriptContainer / NativeScrollbackLiveRegion). The controller calls
	// `finalize()` once the run breaks so the block can commit to native scrollback.
	#finalized = false;

	constructor(options: ReadToolGroupOptions = {}) {
		super();
		this.#showContentPreview = options.showContentPreview ?? false;
		this.#text = new Text("", 0, 0);
		this.addChild(this.#text);
		this.#updateDisplay();
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	finalize(): void {
		this.#finalized = true;
	}

	updateArgs(args: ReadRenderArgs, toolCallId?: string): void {
		if (!toolCallId) return;
		const basePath = args.file_path || args.path || "";
		const rawPath = args.sel ? `${basePath}:${args.sel}` : basePath;
		const entry: ReadEntry = this.#entries.get(toolCallId) ?? {
			toolCallId,
			path: rawPath,
			status: "pending",
		};
		entry.path = rawPath;
		this.#entries.set(toolCallId, entry);
		this.#updateDisplay();
	}

	updateResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		isPartial = false,
		toolCallId?: string,
	): void {
		if (!toolCallId) return;
		const entry = this.#entries.get(toolCallId);
		if (!entry) return;
		if (isPartial) return;
		const details = result.details as ReadToolResultDetails | undefined;
		const suffixResolution = getSuffixResolution(details);
		const displayPaths = getDisplayReadTargets(details);
		if (suffixResolution) {
			entry.path = suffixResolution.to;
			entry.correctedFrom = suffixResolution.from;
			entry.displayPaths = undefined;
		} else {
			entry.correctedFrom = undefined;
			entry.displayPaths = displayPaths;
		}
		const conflictCount =
			typeof details?.conflictCount === "number" && details.conflictCount > 0 ? details.conflictCount : undefined;
		entry.conflictCount = conflictCount;
		entry.status = result.isError ? "error" : suffixResolution ? "warning" : "success";
		// Store the text content for preview/expanded display
		const textContent = result.content?.find(c => c.type === "text")?.text;
		if (textContent !== undefined) {
			entry.contentText = textContent;
		}
		this.#updateDisplay();
	}

	setArgsComplete(_toolCallId?: string): void {
		this.#updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	getComponent(): Component {
		return this;
	}

	#updateDisplay(): void {
		const entries = [...this.#entries.values()];
		const displayTargets = this.#displayTargetsForEntries(entries);
		const displayRows = this.#buildSummaryRows(displayTargets);

		// Clear previous children and rebuild the summary and preview blocks.
		this.clear();
		this.#text = new Text("", 0, 0);

		if (displayRows.length === 0) {
			this.#text.setText(` ${theme.format.bullet} ${theme.fg("toolTitle", theme.bold("Read"))}`);
			this.addChild(this.#text);
			return;
		}

		if (displayRows.length === 1) {
			const row = displayRows[0]!;
			if (!this.#shouldRenderPreviewRow(row)) {
				const statusSymbol = this.#formatStatus(this.#statusForTargets(row.targets));
				const pathDisplay = this.#formatRowPath(row);
				this.#text.setText(
					` ${statusSymbol} ${theme.fg("toolTitle", theme.bold("Read"))} ${pathDisplay}`.trimEnd(),
				);
				this.addChild(this.#text);
			}
			for (const entry of this.#previewEntriesForRow(row)) {
				this.#addContentPreview(entry);
			}
			return;
		}

		const header = `${theme.fg("toolTitle", theme.bold("Read"))}${theme.fg("dim", ` (${displayRows.length})`)}`;
		const lines = [` ${theme.format.bullet} ${header}`];
		const entriesWithoutPreview = entries.filter(entry => !this.#shouldRenderPreview(entry));
		const summaryTargets = this.#displayTargetsForEntries(entriesWithoutPreview);
		const rows = this.#buildSummaryRows(summaryTargets);
		for (const [index, row] of rows.entries()) {
			this.#appendSummaryRow(lines, row, index, rows.length);
		}

		this.#text.setText(lines.join("\n"));
		this.addChild(this.#text);

		for (const entry of entries) {
			if (this.#shouldRenderPreview(entry)) {
				this.#addContentPreview(entry);
			}
		}
	}

	#displayTargetsForEntries(entries: ReadEntry[]): ReadDisplayTarget[] {
		const targets: ReadDisplayTarget[] = [];
		for (const entry of entries) {
			const pathSpecs = entry.displayPaths ?? splitReadDisplayPathSpecs(entry.path);
			for (const pathSpec of pathSpecs) {
				const split = splitPathAndSel(pathSpec);
				for (const selector of splitSelectorDisplayParts(split.sel)) {
					targets.push({
						entry,
						targetPath: selector ? `${split.path}:${selector}` : pathSpec,
						basePath: split.path,
						selector,
					});
				}
			}
		}
		return targets;
	}

	#buildSummaryRows(targets: ReadDisplayTarget[]): ReadSummaryRow[] {
		const selectorTargetsByBasePath = new Map<string, ReadDisplayTarget[]>();
		for (const target of targets) {
			if (!target.selector) continue;
			const existing = selectorTargetsByBasePath.get(target.basePath);
			if (existing) existing.push(target);
			else selectorTargetsByBasePath.set(target.basePath, [target]);
		}

		const mergeableBasePaths = new Set<string>();
		for (const [basePath, baseTargets] of selectorTargetsByBasePath) {
			if (basePath && baseTargets.length > 1) {
				mergeableBasePaths.add(basePath);
			}
		}

		const emittedMergedRows = new Set<string>();
		const rows: ReadSummaryRow[] = [];
		for (const target of targets) {
			if (target.selector && mergeableBasePaths.has(target.basePath)) {
				if (!emittedMergedRows.has(target.basePath)) {
					const mergedTargets = selectorTargetsByBasePath.get(target.basePath) ?? [target];
					rows.push({
						targetPath: `${target.basePath}:${formatMergedSelectorParts(
							mergedTargets
								.map(mergedTarget => mergedTarget.selector)
								.filter(selector => selector !== undefined),
						)}`,
						basePath: target.basePath,
						targets: mergedTargets,
					});
					emittedMergedRows.add(target.basePath);
				}
				continue;
			}
			rows.push({ targetPath: target.targetPath, basePath: target.basePath, targets: [target] });
		}
		return rows;
	}

	#appendSummaryRow(lines: string[], row: ReadSummaryRow, index: number, total: number): void {
		const connector = index === total - 1 ? theme.tree.last : theme.tree.branch;
		lines.push(`   ${theme.fg("dim", connector)} ${this.#formatRow(row)}`.trimEnd());
	}

	#formatRow(row: ReadSummaryRow): string {
		const status = this.#statusForTargets(row.targets);
		const statusPrefix = status === "success" ? "" : `${this.#formatStatus(status)} `;
		return `${statusPrefix}${this.#formatRowPath(row)}`;
	}

	#formatRowPath(row: ReadSummaryRow): string {
		return this.#formatPathValue(row.targetPath, {
			correctedFrom: this.#correctedFromForTargets(row.targets),
			conflictCount: this.#conflictCountForTargets(row.targets),
		});
	}

	#statusForTargets(targets: ReadDisplayTarget[]): ReadEntry["status"] {
		let status: ReadEntry["status"] = "success";
		for (const target of targets) {
			if (READ_STATUS_RANK[target.entry.status] > READ_STATUS_RANK[status]) {
				status = target.entry.status;
			}
		}
		return status;
	}

	#correctedFromForTargets(targets: ReadDisplayTarget[]): string | undefined {
		for (const target of targets) {
			if (target.entry.correctedFrom) return target.entry.correctedFrom;
		}
		return undefined;
	}

	#conflictCountForTargets(targets: ReadDisplayTarget[]): number | undefined {
		let conflictCount = 0;
		for (const target of targets) {
			if (target.entry.conflictCount && target.entry.conflictCount > conflictCount) {
				conflictCount = target.entry.conflictCount;
			}
		}
		return conflictCount > 0 ? conflictCount : undefined;
	}

	#previewEntriesForRow(row: ReadSummaryRow): ReadEntry[] {
		const entries: ReadEntry[] = [];
		const seen = new Set<string>();
		for (const target of row.targets) {
			if (seen.has(target.entry.toolCallId) || !this.#shouldRenderPreview(target.entry)) continue;
			entries.push(target.entry);
			seen.add(target.entry.toolCallId);
		}
		return entries;
	}

	#shouldRenderPreviewRow(row: ReadSummaryRow): boolean {
		return this.#previewEntriesForRow(row).length > 0;
	}

	#formatPathValue(value: string, options: { correctedFrom?: string; conflictCount?: number } = {}): string {
		const filePath = shortenPath(value);
		let pathDisplay = filePath ? theme.fg("accent", filePath) : theme.fg("toolOutput", "…");
		if (options.correctedFrom) {
			pathDisplay += theme.fg("dim", ` (corrected from ${shortenPath(options.correctedFrom)})`);
		}
		pathDisplay += this.#formatConflictBadge(options.conflictCount);
		return pathDisplay;
	}

	#formatConflictBadge(conflictCount: number | undefined): string {
		if (!conflictCount || conflictCount <= 0) return "";
		const n = conflictCount;
		return ` ${theme.fg("warning", `(⚠ ${n} conflict${n === 1 ? "" : "s"})`)}`;
	}

	/**
	 * Add a code-cell content preview below the entry summary.
	 * When collapsed: shows first COLLAPSED_PREVIEW_LINES lines with a "… N more lines ⟨<key>: Expand⟩" hint.
	 * When expanded: shows full content.
	 */
	#addContentPreview(entry: ReadEntry): void {
		const lang = getLanguageFromPath(splitPathAndSel(entry.path).path);
		const filePath = shortenPath(entry.path);
		const correctionSuffix = entry.correctedFrom ? ` (corrected from ${shortenPath(entry.correctedFrom)})` : "";
		const title = filePath ? `Read ${filePath}${correctionSuffix}` : "Read";
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		const expanded = this.#expanded;
		const component: Component = {
			render: (width: number) => {
				if (cachedLines && cachedWidth === width) return cachedLines;
				cachedLines = renderCodeCell(
					{
						code: entry.contentText ?? "",
						language: lang,
						title,
						status: entry.status === "success" ? "complete" : entry.status,
						expanded,
						codeMaxLines: expanded ? undefined : COLLAPSED_PREVIEW_LINES,
						width,
					},
					theme,
				);
				cachedWidth = width;
				return cachedLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
		};
		this.addChild(component);
	}

	#shouldRenderPreview(entry: ReadEntry): boolean {
		return this.#showContentPreview && entry.contentText !== undefined;
	}

	#formatStatus(status: ReadEntry["status"]): string {
		if (status === "success") {
			return theme.fg("text", theme.status.enabled);
		}
		if (status === "warning") {
			return theme.fg("warning", theme.status.warning);
		}
		if (status === "error") {
			return theme.fg("error", theme.status.error);
		}
		return theme.fg("dim", theme.status.pending);
	}
}

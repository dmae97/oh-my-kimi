import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { getLanguageFromPath, theme } from "../../modes/theme/theme";
import { PREVIEW_LIMITS, shortenPath } from "../../tools/render-utils";
import { renderCodeCell } from "../../tui";
import type { ToolExecutionHandle } from "./tool-execution";

type ReadRenderArgs = {
	path?: string;
	file_path?: string;
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
	sel?: string;
	status: "pending" | "success" | "warning" | "error";
	correctedFrom?: string;
	contentText?: string;
};

/** Number of code lines to show in collapsed preview mode */
const COLLAPSED_PREVIEW_LINES = PREVIEW_LIMITS.OUTPUT_COLLAPSED;

export class ReadToolGroupComponent extends Container implements ToolExecutionHandle {
	#entries = new Map<string, ReadEntry>();
	#text: Text;
	#expanded = false;

	constructor() {
		super();
		this.#text = new Text("", 0, 0);
		this.addChild(this.#text);
		this.#updateDisplay();
	}

	updateArgs(args: ReadRenderArgs, toolCallId?: string): void {
		if (!toolCallId) return;
		const rawPath = args.file_path || args.path || "";
		const entry: ReadEntry = this.#entries.get(toolCallId) ?? {
			toolCallId,
			path: rawPath,
			sel: args.sel,
			status: "pending",
		};
		entry.path = rawPath;
		entry.sel = args.sel;
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
		if (suffixResolution) {
			entry.path = suffixResolution.to;
			entry.correctedFrom = suffixResolution.from;
		} else {
			entry.correctedFrom = undefined;
		}
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

		// Clear previous children and re-add the text node
		this.clear();
		this.#text = new Text("", 0, 0);

		if (entries.length === 0) {
			this.#text.setText(` ${theme.format.bullet} ${theme.fg("toolTitle", theme.bold("Read"))}`);
			this.addChild(this.#text);
			return;
		}

		if (entries.length === 1) {
			const entry = entries[0];
			const statusSymbol = this.#formatStatus(entry.status);
			const pathDisplay = this.#formatPath(entry);
			this.#text.setText(` ${statusSymbol} ${theme.fg("toolTitle", theme.bold("Read"))} ${pathDisplay}`.trimEnd());
			this.addChild(this.#text);

			// Show content preview (collapsed) or full content (expanded)
			if (entry.contentText !== undefined) {
				this.#addContentPreview(entry);
			}
			return;
		}

		const header = `${theme.fg("toolTitle", theme.bold("Read"))}${theme.fg("dim", ` (${entries.length})`)}`;
		const lines = [` ${theme.format.bullet} ${header}`];
		const total = entries.length;
		for (const [index, entry] of entries.entries()) {
			const connector = index === total - 1 ? theme.tree.last : theme.tree.branch;
			const statusSymbol = this.#formatStatus(entry.status);
			const pathDisplay = this.#formatPath(entry);
			lines.push(`   ${theme.fg("dim", connector)} ${statusSymbol} ${pathDisplay}`.trimEnd());
		}

		this.#text.setText(lines.join("\n"));
		this.addChild(this.#text);

		// Show content for each entry: full when expanded, preview when collapsed
		for (const entry of entries) {
			if (entry.contentText !== undefined) {
				this.#addContentPreview(entry);
			}
		}
	}

	/**
	 * Add a code-cell content preview below the entry summary.
	 * When collapsed: shows first COLLAPSED_PREVIEW_LINES lines with "… N more lines (Ctrl+O for more)" hint.
	 * When expanded: shows full content.
	 */
	#addContentPreview(entry: ReadEntry): void {
		const lang = getLanguageFromPath(entry.path);
		const filePath = shortenPath(entry.path);
		const title = filePath ? `Read ${filePath}` : "Read";
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

	#formatPath(entry: ReadEntry): string {
		const filePath = shortenPath(entry.path);
		let pathDisplay = filePath ? theme.fg("accent", filePath) : theme.fg("toolOutput", "…");
		if (entry.sel) {
			pathDisplay += theme.fg("warning", `:${entry.sel}`);
		}
		if (entry.correctedFrom) {
			pathDisplay += theme.fg("dim", ` (corrected from ${shortenPath(entry.correctedFrom)})`);
		}
		return pathDisplay;
	}

	#formatStatus(status: ReadEntry["status"]): string {
		if (status === "success") {
			return theme.fg("success", theme.status.success);
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

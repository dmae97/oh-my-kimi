/**
 * Component for displaying user-initiated eval execution with streaming output.
 * Shares the same kernel session as the agent's eval tool.
 */

import { sanitizeText } from "@oh-my-pi/pi-natives";
import { Container, Loader, Spacer, Text, type TUI } from "@oh-my-pi/pi-tui";
import { getSymbolTheme, highlightCode, theme } from "../../modes/theme/theme";
import { formatTruncationMetaNotice, type TruncationMeta } from "../../tools/output-meta";
import { DynamicBorder } from "./dynamic-border";
import { truncateToVisualLines } from "./visual-truncate";

const PREVIEW_LINES = 20;
const MAX_DISPLAY_LINE_CHARS = 4000;

export type EvalExecutionLanguage = "python" | "js";

export class EvalExecutionComponent extends Container {
	#outputLines: string[] = [];
	#status: "running" | "complete" | "cancelled" | "error" = "running";
	#exitCode: number | undefined = undefined;
	#loader: Loader;
	#truncation?: TruncationMeta;
	#expanded = false;
	#contentContainer: Container;

	#highlightLang(): "python" | "javascript" {
		return this.language === "js" ? "javascript" : "python";
	}

	#formatHeader(colorKey: "dim" | "pythonMode"): Text {
		const prompt = theme.fg(colorKey, theme.bold(">>>"));
		const continuation = theme.fg(colorKey, "    ");
		const codeLines = highlightCode(this.code, this.#highlightLang());
		const headerLines = codeLines.map((line, index) =>
			index === 0 ? `${prompt} ${line}` : `${continuation}${line}`,
		);
		return new Text(headerLines.join("\n"), 1, 0);
	}

	constructor(
		private readonly code: string,
		ui: TUI,
		private readonly excludeFromContext = false,
		private readonly language: EvalExecutionLanguage = "python",
	) {
		super();

		const colorKey = this.excludeFromContext ? "dim" : "pythonMode";
		const borderColor = (str: string) => theme.fg(colorKey, str);

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(borderColor));

		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);
		this.#contentContainer.addChild(this.#formatHeader(colorKey));

		this.#loader = new Loader(
			ui,
			spinner => theme.fg(colorKey, spinner),
			text => theme.fg("muted", text),
			`Running… (esc to cancel)`,
			getSymbolTheme().spinnerFrames,
		);
		this.#contentContainer.addChild(this.#loader);

		this.addChild(new DynamicBorder(borderColor));
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	appendOutput(chunk: string): void {
		// Chunk is pre-sanitized by OutputSink.push() — no need to sanitize again.
		const newLines = chunk.split("\n").map(line => this.#clampDisplayLine(line));
		if (this.#outputLines.length > 0 && newLines.length > 0) {
			this.#outputLines[this.#outputLines.length - 1] = this.#clampDisplayLine(
				`${this.#outputLines[this.#outputLines.length - 1]}${newLines[0]}`,
			);
			this.#outputLines.push(...newLines.slice(1));
		} else {
			this.#outputLines.push(...newLines);
		}

		this.#updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: { output?: string; truncation?: TruncationMeta },
	): void {
		this.#exitCode = exitCode;
		this.#status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.#truncation = options?.truncation;
		if (options?.output !== undefined) {
			this.#setOutput(options.output);
		}

		this.#loader.stop();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		const availableLines = this.#outputLines;
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		this.#contentContainer.clear();

		const colorKey = this.excludeFromContext ? "dim" : "pythonMode";
		this.#contentContainer.addChild(this.#formatHeader(colorKey));

		if (availableLines.length > 0) {
			if (this.#expanded) {
				const displayText = availableLines.map(line => theme.fg("muted", line)).join("\n");
				this.#contentContainer.addChild(new Text(`\n${displayText}`, 1, 0));
			} else {
				const styledOutput = previewLogicalLines.map(line => theme.fg("muted", line)).join("\n");
				const previewText = `\n${styledOutput}`;
				this.#contentContainer.addChild({
					render: (width: number) => {
						const { visualLines } = truncateToVisualLines(previewText, PREVIEW_LINES, width, 1);
						return visualLines;
					},
					invalidate: () => {},
				});
			}
		}

		if (this.#status === "running") {
			this.#contentContainer.addChild(this.#loader);
		} else {
			const statusParts: string[] = [];

			if (hiddenLineCount > 0) {
				statusParts.push(theme.fg("dim", `… ${hiddenLineCount} more lines (ctrl+o to expand)`));
			}

			if (this.#status === "cancelled") {
				statusParts.push(theme.fg("warning", "(cancelled)"));
			} else if (this.#status === "error") {
				statusParts.push(theme.fg("error", `(exit ${this.#exitCode})`));
			}

			if (this.#truncation) {
				statusParts.push(theme.fg("warning", formatTruncationMetaNotice(this.#truncation)));
			}

			if (statusParts.length > 0) {
				this.#contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, 1, 0));
			}
		}
	}

	#clampDisplayLine(line: string): string {
		if (line.length <= MAX_DISPLAY_LINE_CHARS) {
			return line;
		}
		const omitted = line.length - MAX_DISPLAY_LINE_CHARS;
		return `${line.slice(0, MAX_DISPLAY_LINE_CHARS)}… [${omitted} chars omitted]`;
	}

	#setOutput(output: string): void {
		const clean = sanitizeText(output);
		this.#outputLines = clean ? clean.split("\n").map(line => this.#clampDisplayLine(line)) : [];
	}

	getOutput(): string {
		return this.#outputLines.join("\n");
	}

	getCode(): string {
		return this.code;
	}
}

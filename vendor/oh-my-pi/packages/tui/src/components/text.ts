import type { Component } from "../tui";
import {
	applyBackgroundToLine,
	getPaddingX,
	getWidthConfigEpoch,
	padding,
	publishLineWidths,
	replaceTabs,
	visibleWidth,
	wrapTextWithAnsi,
} from "../utils";

/**
 * Text component - displays multi-line text with word wrapping
 */
export class Text implements Component {
	#text: string;
	#paddingX: number; // Left/right padding
	#paddingY: number; // Top/bottom padding
	#customBgFn?: (text: string) => string;

	#ignoreTight = false;

	setIgnoreTight(ignore: boolean): this {
		this.#ignoreTight = ignore;
		this.invalidate();
		return this;
	}

	// Cache for rendered output
	#cachedText?: string;
	#cachedWidth?: number;
	#cachedWidthEpoch?: number;
	#cachedLines?: string[];

	constructor(text: string = "", paddingX: number = 1, paddingY: number = 1, customBgFn?: (text: string) => string) {
		this.#text = text;
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#customBgFn = customBgFn;
	}

	getText(): string {
		return this.#text;
	}

	setText(text: string): boolean {
		if (text === this.#text) {
			return false;
		}
		this.#text = text;
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedWidthEpoch = undefined;
		this.#cachedLines = undefined;
		return true;
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.#customBgFn = customBgFn;
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedWidthEpoch = undefined;
		this.#cachedLines = undefined;
	}

	invalidate(): void {
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedWidthEpoch = undefined;
		this.#cachedLines = undefined;
	}

	render(width: number): readonly string[] {
		// Check cache
		if (
			this.#cachedLines &&
			this.#cachedText === this.#text &&
			this.#cachedWidth === width &&
			this.#cachedWidthEpoch === getWidthConfigEpoch()
		) {
			return this.#cachedLines;
		}

		// Don't render anything if there's no actual text
		if (!this.#text || this.#text.trim() === "") {
			const result: string[] = [];
			this.#cachedText = this.#text;
			this.#cachedWidth = width;
			this.#cachedWidthEpoch = getWidthConfigEpoch();
			this.#cachedLines = result;
			return result;
		}

		// Replace tabs with 3 spaces
		const normalizedText = replaceTabs(this.#text);

		// Calculate content width (subtract left/right margins)
		const paddingX = this.#ignoreTight ? this.#paddingX : getPaddingX(this.#paddingX);
		const contentWidth = Math.max(1, width - paddingX * 2);
		// Wrap text (this preserves ANSI codes but does NOT pad)
		const wrappedLines = wrapTextWithAnsi(normalizedText, contentWidth);

		// Add margins and background to each line
		const leftMargin = padding(paddingX);
		const rightMargin = padding(paddingX);
		const contentLines: string[] = [];
		// Exact visible widths of `result` rows, published only when rows are
		// `content + spaces` (customBgFn output width is not knowable here).
		const resultWidths: number[] | undefined = this.#customBgFn ? undefined : [];

		for (const line of wrappedLines) {
			// Add margins
			const lineWithMargins = leftMargin + line + rightMargin;

			// Apply background if specified (this also pads to full width)
			if (this.#customBgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.#customBgFn));
			} else {
				// No background - just pad to width with spaces
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + padding(paddingNeeded));
				resultWidths?.push(visibleLen + paddingNeeded);
			}
		}

		// Add top/bottom padding (empty lines)
		const emptyLine = padding(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.#paddingY; i++) {
			const line = this.#customBgFn ? applyBackgroundToLine(emptyLine, width, this.#customBgFn) : emptyLine;
			emptyLines.push(line);
		}

		const result = [...emptyLines, ...contentLines, ...emptyLines];
		if (resultWidths !== undefined) {
			// Pad rows are exactly `width` cells wide.
			const emptyWidths = new Array<number>(emptyLines.length).fill(width);
			publishLineWidths(result, [...emptyWidths, ...resultWidths, ...emptyWidths]);
		}

		// Update cache
		this.#cachedText = this.#text;
		this.#cachedWidth = width;
		this.#cachedWidthEpoch = getWidthConfigEpoch();
		this.#cachedLines = result;

		return result.length > 0 ? result : [""];
	}
}

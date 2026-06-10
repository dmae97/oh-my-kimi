import type { Component } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";

/**
 * Dynamic border component that adjusts to viewport width.
 *
 * Note: When used from hooks loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for hook use.
 */
export class DynamicBorder implements Component {
	#color: (str: string) => string;
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;

	constructor(color: (str: string) => string = str => theme.fg("border", str)) {
		this.#color = color;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
	}

	render(width: number): readonly string[] {
		if (this.#cachedLines && this.#cachedWidth === width) {
			return this.#cachedLines;
		}
		const lines = [this.#color(theme.boxSharp.horizontal.repeat(Math.max(1, width)))];
		this.#cachedWidth = width;
		this.#cachedLines = lines;
		return lines;
	}
}

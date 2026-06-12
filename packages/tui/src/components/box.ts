import type { Component } from "../tui";
import { applyBackgroundToLine, padding, visibleWidth } from "../utils";

type Cache = {
	width: number;
	bgSample: string | undefined;
	childLines: (readonly string[])[];
	result: string[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	children: Component[] = [];
	#paddingX: number;
	#paddingY: number;
	#bgFn?: (text: string) => string;

	// Cache for rendered output
	#cached?: Cache;

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#bgFn = bgFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.#invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.#invalidateCache();
		}
	}

	clear(): void {
		this.children = [];
		this.#invalidateCache();
	}

	setPaddingX(paddingX: number): void {
		if (this.#paddingX === paddingX) return;
		this.#paddingX = paddingX;
		this.#invalidateCache();
	}

	setPaddingY(paddingY: number): void {
		if (this.#paddingY === paddingY) return;
		this.#paddingY = paddingY;
		this.#invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.#bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	#invalidateCache(): void {
		this.#cached = undefined;
	}

	invalidate(): void {
		this.#invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): readonly string[] {
		const children = this.children;
		const count = children.length;
		const contentWidth = Math.max(1, width - this.#paddingX * 2);
		// bgFn output can change without the function reference changing (theme
		// mutation); sample it so a silent palette swap still misses the cache.
		const bgSample = this.#bgFn ? this.#bgFn("test") : undefined;

		// Render every child every frame (renders may carry side effects); the
		// memo only skips re-deriving the padded/background rows. Per the
		// Component render contract, identical child array references prove the
		// content is unchanged.
		const cached = this.#cached;
		let unchanged =
			cached !== undefined &&
			cached.width === width &&
			cached.bgSample === bgSample &&
			cached.childLines.length === count;
		const childLines: (readonly string[])[] = new Array(count);
		let contentRows = 0;
		for (let i = 0; i < count; i++) {
			const lines = children[i]!.render(contentWidth);
			childLines[i] = lines;
			contentRows += lines.length;
			if (unchanged && cached!.childLines[i] !== lines) unchanged = false;
		}
		if (unchanged) return cached!.result;

		const result: string[] = [];
		if (contentRows > 0) {
			const leftPad = padding(this.#paddingX);
			// Top padding
			for (let i = 0; i < this.#paddingY; i++) {
				result.push(this.#applyBg("", width));
			}
			// Content
			for (const lines of childLines) {
				for (const line of lines) {
					result.push(this.#applyBg(leftPad + line, width));
				}
			}
			// Bottom padding
			for (let i = 0; i < this.#paddingY; i++) {
				result.push(this.#applyBg("", width));
			}
		}

		this.#cached = { width, bgSample, childLines, result };
		return result;
	}

	#applyBg(line: string, width: number): string {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + padding(padNeeded);

		if (this.#bgFn) {
			return applyBackgroundToLine(padded, width, this.#bgFn);
		}
		return padded;
	}
}

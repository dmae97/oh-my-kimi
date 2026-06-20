import type { Component } from "../tui";
import { applyBackgroundToLine, getPaddingX, padding, visibleWidth } from "../utils";

type Cache = {
	width: number;
	bgSample: string | undefined;
	borderSample: string | undefined;
	childLines: (readonly string[])[];
	result: string[];
};

/** Box-drawing glyphs plus an optional colorizer for an outline drawn around a {@link Box}. */
export interface BoxBorder {
	chars: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
		horizontal: string;
		vertical: string;
	};
	color?: (text: string) => string;
}

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	children: Component[] = [];
	#paddingX: number;
	#paddingY: number;
	#bgFn?: (text: string) => string;
	#border?: BoxBorder;

	#ignoreTight = false;

	setIgnoreTight(ignore: boolean): this {
		this.#ignoreTight = ignore;
		this.#invalidateCache();
		return this;
	}

	// Cache for rendered output
	#cached?: Cache;

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string, border?: BoxBorder) {
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#bgFn = bgFn;
		this.#border = border;
	}

	addChild(component: Component): void {
		this.children.push(component);
		if (this.#ignoreTight) {
			component.setIgnoreTight?.(true);
		}
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

	setBorder(border?: BoxBorder): void {
		this.#border = border;
		this.#invalidateCache();
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
		const paddingX = this.#ignoreTight ? this.#paddingX : getPaddingX(this.#paddingX);
		// A border eats one column on each side; skip it unless the interior can still
		// hold the horizontal padding plus at least one content column, so a bordered
		// Box never overflows the width it was given.
		const border = this.#border && width - 2 >= paddingX * 2 + 1 ? this.#border : undefined;
		const innerWidth = border ? width - 2 : width;
		const contentWidth = Math.max(1, innerWidth - paddingX * 2);
		// bgFn / border output can change without the function reference changing
		// (theme mutation); sample both so a silent palette swap still misses the cache.
		const bgSample = this.#bgFn ? this.#bgFn("test") : undefined;
		const borderSample = border
			? `${border.color ? border.color("|") : "|"}${border.chars.topLeft}${border.chars.vertical}`
			: undefined;

		// Render every child every frame (renders may carry side effects); the
		// memo only skips re-deriving the padded/background rows. Per the
		// Component render contract, identical child array references prove the
		// content is unchanged.
		const cached = this.#cached;
		let unchanged =
			cached !== undefined &&
			cached.width === width &&
			cached.bgSample === bgSample &&
			cached.borderSample === borderSample &&
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
			const leftPad = padding(paddingX);
			const interior: string[] = [];
			// Top padding
			for (let i = 0; i < this.#paddingY; i++) {
				interior.push(this.#applyBg("", innerWidth));
			}
			// Content
			for (const lines of childLines) {
				for (const line of lines) {
					interior.push(this.#applyBg(leftPad + line, innerWidth));
				}
			}
			// Bottom padding
			for (let i = 0; i < this.#paddingY; i++) {
				interior.push(this.#applyBg("", innerWidth));
			}

			if (border) {
				const paint = border.color ?? (s => s);
				const rule = border.chars.horizontal.repeat(Math.max(0, innerWidth));
				const side = paint(border.chars.vertical);
				result.push(paint(border.chars.topLeft + rule + border.chars.topRight));
				for (const row of interior) {
					result.push(side + row + side);
				}
				result.push(paint(border.chars.bottomLeft + rule + border.chars.bottomRight));
			} else {
				for (const row of interior) {
					result.push(row);
				}
			}
		}

		this.#cached = { width, bgSample, borderSample, childLines, result };
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

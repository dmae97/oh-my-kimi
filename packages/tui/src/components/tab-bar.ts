/**
 * Tab Bar Component
 *
 * A horizontal tab bar for switching between views/panels.
 * Renders as: "Label:  Tab1   Tab2   Tab3  (tab to cycle)"
 *
 * Navigation:
 * - Tab / Arrow Right: Next tab (wraps around)
 * - Shift+Tab / Arrow Left: Previous tab (wraps around)
 */
import { matchesKey } from "../keys";
import type { Component } from "../tui";
import { truncateToWidth, visibleWidth } from "../utils";

/** Tab definition */
export interface Tab {
	/** Unique identifier for the tab */
	id: string;
	/** Display label shown in the tab bar */
	label: string;
}

/** Theme for styling the tab bar */
export interface TabBarTheme {
	/** Style for the label prefix (e.g., "Settings:") */
	label: (text: string) => string;
	/** Style for the currently active tab */
	activeTab: (text: string) => string;
	/** Style for inactive tabs */
	inactiveTab: (text: string) => string;
	/** Style for the hint text (e.g., "(tab to cycle)") */
	hint: (text: string) => string;
}

/**
 * Horizontal tab bar component.
 *
 * @example
 * ```ts
 * const tabs = [
 *   { id: "config", label: "Config" },
 *   { id: "tools", label: "Tools" },
 * ];
 * const tabBar = new TabBar("Settings", tabs, theme);
 * tabBar.onTabChange = (tab) => console.log(`Switched to ${tab.id}`);
 * ```
 */
export class TabBar implements Component {
	#tabs: Tab[];
	#activeIndex: number = 0;
	#theme: TabBarTheme;
	#label: string;

	/** Callback fired when the active tab changes */
	onTabChange?: (tab: Tab, index: number) => void;

	constructor(label: string, tabs: Tab[], theme: TabBarTheme, initialIndex: number = 0) {
		this.#label = label;
		this.#tabs = tabs;
		this.#theme = theme;
		this.#activeIndex = initialIndex;
	}

	/** Get the currently active tab */
	getActiveTab(): Tab {
		return this.#tabs[this.#activeIndex];
	}

	/** Get the index of the currently active tab */
	getActiveIndex(): number {
		return this.#activeIndex;
	}

	/** Set the active tab by index (clamped to valid range) */
	setActiveIndex(index: number): void {
		const newIndex = Math.max(0, Math.min(index, this.#tabs.length - 1));
		if (newIndex !== this.#activeIndex) {
			this.#activeIndex = newIndex;
			this.onTabChange?.(this.#tabs[this.#activeIndex], this.#activeIndex);
		}
	}

	/** Move to the next tab (wraps to first tab after last) */
	nextTab(): void {
		this.setActiveIndex((this.#activeIndex + 1) % this.#tabs.length);
	}

	/** Move to the previous tab (wraps to last tab before first) */
	prevTab(): void {
		this.setActiveIndex((this.#activeIndex - 1 + this.#tabs.length) % this.#tabs.length);
	}

	invalidate(): void {
		// No cached state to invalidate
	}

	/**
	 * Handle keyboard input for tab navigation.
	 * @returns true if the input was handled, false otherwise
	 */
	handleInput(data: string): boolean {
		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			this.nextTab();
			return true;
		}
		if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
			this.prevTab();
			return true;
		}
		return false;
	}

	/** Render the tab bar, wrapping to multiple lines if needed */
	render(width: number): readonly string[] {
		const maxWidth = Math.max(1, width);
		const chunks: string[] = [];

		// Label prefix
		chunks.push(this.#theme.label(`${this.#label}:`));
		chunks.push("  ");

		// Tab buttons
		for (let i = 0; i < this.#tabs.length; i++) {
			const tab = this.#tabs[i];
			if (i === this.#activeIndex) {
				chunks.push(this.#theme.activeTab(` ${tab.label} `));
			} else {
				chunks.push(this.#theme.inactiveTab(` ${tab.label} `));
			}
			if (i < this.#tabs.length - 1) {
				chunks.push("  ");
			}
		}

		// Navigation hint
		chunks.push("  ");
		chunks.push(this.#theme.hint("(tab to cycle)"));

		const lines: string[] = [];
		let currentLine = "";
		let currentWidth = 0;

		for (const chunk of chunks) {
			const chunkWidth = visibleWidth(chunk);
			if (chunkWidth <= 0) {
				continue;
			}

			if (chunkWidth > maxWidth) {
				if (currentLine) {
					lines.push(currentLine);
					currentLine = "";
					currentWidth = 0;
				}
				lines.push(truncateToWidth(chunk, maxWidth));
				continue;
			}

			if (currentWidth > 0 && currentWidth + chunkWidth > maxWidth) {
				lines.push(currentLine);
				currentLine = "";
				currentWidth = 0;
			}

			currentLine += chunk;
			currentWidth += chunkWidth;
		}

		if (currentLine) {
			lines.push(currentLine);
		}

		return lines.length > 0 ? lines : [""];
	}
}

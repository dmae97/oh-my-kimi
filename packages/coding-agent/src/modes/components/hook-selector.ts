/**
 * Generic selector component for hooks.
 * Displays a list of string options with keyboard navigation.
 */
import {
	Container,
	extractPrintableText,
	fuzzyFilter,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	padding,
	renderInlineMarkdown,
	replaceTabs,
	Spacer,
	Text,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, type ThemeColor, theme } from "../../modes/theme/theme";
import {
	matchesAppExternalEditor,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectUp,
} from "../../modes/utils/keybinding-matchers";
import { CountdownTimer } from "./countdown-timer";
import { DynamicBorder } from "./dynamic-border";
import { renderSegmentTrack } from "./segment-track";

/** One segment of a {@link HookSelectorSlider} — a label, its accent color, and
 *  an optional detail line (e.g. the resolved model name) shown beneath the
 *  track while the segment is active. */
export interface HookSelectorSliderSegment {
	label: string;
	/** Theme color for the segment label; defaults to `accent`. */
	color?: ThemeColor;
	/** Secondary line rendered under the track when this segment is selected. */
	detail?: string;
}

/**
 * A horizontal left/right selector rendered above the option list. Unlike the
 * up/down option cursor, the slider is moved with the left/right arrows from
 * any list position, letting the caller capture an orthogonal choice (e.g. the
 * model tier to continue execution with) alongside the selected option.
 */
export interface HookSelectorSlider {
	/** Dim caption rendered before the slider track (e.g. "continue with"). */
	caption?: string;
	segments: HookSelectorSliderSegment[];
	/** Initially highlighted segment index. */
	index: number;
	/** Invoked with the new index whenever the slider moves. */
	onChange?: (index: number) => void;
}

export interface HookSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onTimeout?: () => void;
	initialIndex?: number;
	outline?: boolean;
	maxVisible?: number;
	onLeft?: () => void;
	onRight?: () => void;
	onExternalEditor?: () => void;
	helpText?: string;
	slider?: HookSelectorSlider;
}

export interface HookSelectorOption {
	label: string;
	description?: string;
}

export type HookSelectorOptionInput = string | HookSelectorOption;

function normalizeHookSelectorOption(option: HookSelectorOptionInput): HookSelectorOption {
	if (typeof option === "string") return { label: option };
	if (option.description?.trim()) {
		return { label: option.label, description: option.description.trim() };
	}
	return { label: option.label };
}

function splitLeadingSpacesForWrap(line: string, width: number): { indent: string; body: string } {
	let indentLength = 0;
	while (indentLength < line.length && line.charCodeAt(indentLength) === 32) {
		indentLength += 1;
	}
	const maxIndentLength = Math.max(0, width - 1);
	const clampedIndentLength = Math.min(indentLength, maxIndentLength);
	return {
		indent: line.slice(0, clampedIndentLength),
		body: line.slice(indentLength),
	};
}

class OutlinedList extends Container {
	#lines: string[] = [];

	setLines(lines: string[]): void {
		this.#lines = lines;
		this.invalidate();
	}

	render(width: number): string[] {
		const borderColor = (text: string) => theme.fg("border", text);
		const horizontal = borderColor(theme.boxSharp.horizontal.repeat(Math.max(1, width)));
		const innerWidth = Math.max(1, width - 2);
		const content: string[] = [];
		for (const line of this.#lines) {
			const normalized = replaceTabs(line);
			const { indent, body } = splitLeadingSpacesForWrap(normalized, innerWidth);
			const wrapped = wrapTextWithAnsi(body, Math.max(1, innerWidth - visibleWidth(indent)));
			for (const wrappedBody of wrapped.length > 0 ? wrapped : [""]) {
				const wrappedLine = `${indent}${wrappedBody}`;
				const pad = Math.max(0, innerWidth - visibleWidth(wrappedLine));
				content.push(
					`${borderColor(theme.boxSharp.vertical)}${wrappedLine}${padding(pad)}${borderColor(theme.boxSharp.vertical)}`,
				);
			}
		}
		return [horizontal, ...content, horizontal];
	}
}

export class HookSelectorComponent extends Container {
	#options: HookSelectorOption[];
	#filteredOptions: HookSelectorOption[];
	#searchQuery = "";
	#selectedIndex: number;
	#maxVisible: number;
	#listContainer: Container | undefined;
	#outlinedList: OutlinedList | undefined;
	#onSelectCallback: (option: string) => void;
	#onCancelCallback: () => void;
	#titleComponent: Markdown;
	#baseTitle: string;
	#countdown: CountdownTimer | undefined;
	#onLeftCallback: (() => void) | undefined;
	#onRightCallback: (() => void) | undefined;
	#onExternalEditorCallback: (() => void) | undefined;
	#slider: HookSelectorSlider | undefined;
	#sliderIndex: number = 0;
	#sliderComponent: Text | undefined;
	#lastRenderWidth: number | undefined;
	constructor(
		title: string,
		options: HookSelectorOptionInput[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: HookSelectorOptions,
	) {
		super();

		this.#options = options.map(normalizeHookSelectorOption);
		this.#filteredOptions = this.#options;
		this.#selectedIndex = Math.min(opts?.initialIndex ?? 0, this.#filteredOptions.length - 1);
		this.#maxVisible = Math.max(3, opts?.maxVisible ?? 12);
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#baseTitle = title;
		this.#onLeftCallback = opts?.onLeft;
		this.#onRightCallback = opts?.onRight;
		this.#onExternalEditorCallback = opts?.onExternalEditor;
		if (opts?.slider && opts.slider.segments.length > 0) {
			this.#slider = opts.slider;
			this.#sliderIndex = Math.max(0, Math.min(opts.slider.index, opts.slider.segments.length - 1));
		}

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.#titleComponent = new Markdown(title, 1, 0, getMarkdownTheme(), { color: t => theme.fg("accent", t) });
		this.addChild(this.#titleComponent);
		this.addChild(new Spacer(1));

		if (this.#slider) {
			this.#sliderComponent = new Text(this.#renderSliderLine(), 1, 0);
			this.addChild(this.#sliderComponent);
			this.addChild(new Spacer(1));
		}

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.#countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				s => this.#titleComponent.setText(`${this.#baseTitle} (${s}s)`),
				() => {
					opts?.onTimeout?.();
					const selected = this.#filteredOptions[this.#selectedIndex];
					if (selected) {
						this.#onSelectCallback(selected.label);
					} else {
						this.#onCancelCallback();
					}
				},
			);
		}

		if (opts?.outline) {
			this.#outlinedList = new OutlinedList();
			this.addChild(this.#outlinedList);
		} else {
			this.#listContainer = new Container();
			this.addChild(this.#listContainer);
		}
		this.addChild(new Spacer(1));
		const controlsHint = opts?.helpText ?? "up/down navigate  enter select  esc cancel";
		this.addChild(new Text(theme.fg("dim", controlsHint), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.#updateList();
	}

	#renderOptionLines(option: HookSelectorOption, isSelected: boolean, mdTheme: MarkdownTheme): string[] {
		const label = isSelected
			? renderInlineMarkdown(option.label, mdTheme, t => theme.fg("accent", t))
			: renderInlineMarkdown(option.label, mdTheme, t => theme.fg("text", t));
		const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
		const lines = [prefix + label];
		if (option.description) {
			const description = renderInlineMarkdown(option.description, mdTheme, t => theme.fg("muted", t));
			lines.push(`    ${description}`);
		}
		return lines;
	}

	#renderedLineRowCount(line: string, renderWidth: number): number {
		const normalized = replaceTabs(line);
		if (this.#outlinedList) {
			const innerWidth = Math.max(1, renderWidth - 2);
			const { indent, body } = splitLeadingSpacesForWrap(normalized, innerWidth);
			const wrapped = wrapTextWithAnsi(body, Math.max(1, innerWidth - visibleWidth(indent)));
			return Math.max(1, wrapped.length);
		}
		const wrapped = wrapTextWithAnsi(normalized, Math.max(1, renderWidth - 2));
		return Math.max(1, wrapped.length);
	}

	#optionRowCount(
		option: HookSelectorOption,
		renderWidth: number | undefined,
		isSelected: boolean,
		mdTheme: MarkdownTheme,
	): number {
		if (renderWidth === undefined) return option.description ? 2 : 1;
		let rows = 0;
		for (const line of this.#renderOptionLines(option, isSelected, mdTheme)) {
			rows += this.#renderedLineRowCount(line, renderWidth);
		}
		return rows;
	}

	#totalOptionRows(options: HookSelectorOption[], renderWidth?: number, mdTheme?: MarkdownTheme): number {
		const themeForRows = mdTheme ?? getMarkdownTheme();
		let rows = 0;
		for (const option of options) {
			rows += this.#optionRowCount(option, renderWidth, false, themeForRows);
		}
		return rows;
	}

	#getVisibleOptionRange(
		total: number,
		renderWidth?: number,
		mdTheme: MarkdownTheme = getMarkdownTheme(),
	): { startIndex: number; endIndex: number } {
		if (total === 0) return { startIndex: 0, endIndex: 0 };

		const rowBudget = Math.max(1, this.#maxVisible);
		const selectedIndex = Math.max(0, Math.min(this.#selectedIndex, total - 1));
		let startIndex = selectedIndex;
		let endIndex = selectedIndex + 1;
		let rows = this.#optionRowCount(this.#filteredOptions[selectedIndex]!, renderWidth, true, mdTheme);
		let beforeRows = 0;
		const targetBeforeRows = Math.max(0, Math.floor((rowBudget - rows) / 2));

		while (startIndex > 0) {
			const cost = this.#optionRowCount(this.#filteredOptions[startIndex - 1]!, renderWidth, false, mdTheme);
			if (beforeRows + cost > targetBeforeRows || rows + cost > rowBudget) break;
			startIndex--;
			beforeRows += cost;
			rows += cost;
		}

		while (endIndex < total) {
			const cost = this.#optionRowCount(this.#filteredOptions[endIndex]!, renderWidth, false, mdTheme);
			if (rows + cost > rowBudget) break;
			endIndex++;
			rows += cost;
		}

		while (startIndex > 0) {
			const cost = this.#optionRowCount(this.#filteredOptions[startIndex - 1]!, renderWidth, false, mdTheme);
			if (rows + cost > rowBudget) break;
			startIndex--;
			rows += cost;
		}

		return { startIndex, endIndex };
	}

	#updateList(renderWidth = this.#lastRenderWidth): void {
		const lines: string[] = [];
		const total = this.#filteredOptions.length;
		const mdTheme = getMarkdownTheme();
		const { startIndex, endIndex } = this.#getVisibleOptionRange(total, renderWidth, mdTheme);

		for (let i = startIndex; i < endIndex; i++) {
			const option = this.#filteredOptions[i];
			if (option === undefined) continue;
			lines.push(...this.#renderOptionLines(option, i === this.#selectedIndex, mdTheme));
		}

		if (total === 0) {
			lines.push(theme.fg("dim", "  No matching options"));
		}

		if (startIndex > 0 || endIndex < total || this.#shouldRenderSearchStatus(renderWidth, mdTheme)) {
			lines.push(this.#renderStatusLine(total));
		}
		if (this.#outlinedList) {
			this.#outlinedList.setLines(lines);
			return;
		}
		this.#listContainer?.clear();
		for (const line of lines) {
			this.#listContainer?.addChild(new Text(line, 1, 0));
		}
	}

	/** Render the slider block in the style of the status line: each option is a
	 *  distinctly colored segment, the active one filled as a powerline chip
	 *  (its accent as the background, a luminance-matched label, flanked by
	 *  triangle caps) and the rest shown as plain colored labels joined by a thin
	 *  separator. Edge arrows brighten while there is room to move. When the
	 *  active segment carries a `detail` (e.g. the resolved model name) a muted
	 *  second line is appended. Returns one or two `\n`-joined lines. */
	#renderSliderLine(): string {
		const slider = this.#slider;
		if (!slider) return "";
		const segments = slider.segments;
		const active = this.#sliderIndex;
		const track = renderSegmentTrack(segments, active);

		const leftArrow = theme.fg(active > 0 ? "accent" : "dim", "◂");
		const rightArrow = theme.fg(active < segments.length - 1 ? "accent" : "dim", "▸");
		const caption = slider.caption ? `${theme.fg("dim", slider.caption)}  ` : "";
		const trackLine = `${caption}${leftArrow}  ${track}  ${rightArrow}`;
		const detail = segments[active]?.detail;
		if (!detail) return trackLine;
		return `${trackLine}\n  ${theme.fg("dim", "↳")} ${theme.fg("muted", detail)}`;
	}

	/** Move the slider by `delta`, clamped to the segment range, refresh the
	 *  rendered track, and notify the caller only when the index actually moves. */
	#moveSlider(delta: number): void {
		const slider = this.#slider;
		if (!slider) return;
		const next = Math.max(0, Math.min(slider.segments.length - 1, this.#sliderIndex + delta));
		if (next === this.#sliderIndex) return;
		this.#sliderIndex = next;
		this.#sliderComponent?.setText(this.#renderSliderLine());
		slider.onChange?.(next);
	}

	#isSearchEnabled(renderWidth = this.#lastRenderWidth, mdTheme?: MarkdownTheme): boolean {
		return this.#totalOptionRows(this.#options, renderWidth, mdTheme) > this.#maxVisible;
	}

	#shouldRenderSearchStatus(renderWidth = this.#lastRenderWidth, mdTheme?: MarkdownTheme): boolean {
		return this.#isSearchEnabled(renderWidth, mdTheme) || this.#searchQuery.length > 0;
	}

	#renderStatusLine(total: number): string {
		const selectedCount = total === 0 ? 0 : this.#selectedIndex + 1;
		const count =
			this.#searchQuery.trim() && total !== this.#options.length
				? `${selectedCount}/${total} of ${this.#options.length}`
				: `${selectedCount}/${total}`;
		const suffix = this.#searchQuery.trim() ? `  Search: ${this.#searchQuery}` : "  Type to search";
		return theme.fg("dim", `  (${count})${suffix}`);
	}

	#setSearchQuery(query: string): void {
		this.#searchQuery = query;
		this.#filteredOptions = query.trim()
			? fuzzyFilter(this.#options, query, option => `${option.label} ${option.description ?? ""}`)
			: this.#options;
		this.#selectedIndex = 0;
		this.#updateList();
	}

	#handleSearchInput(keyData: string): boolean {
		if (!this.#isSearchEnabled()) return false;

		if (matchesKey(keyData, "backspace")) {
			if (this.#searchQuery.length === 0) return false;
			const chars = [...this.#searchQuery];
			chars.pop();
			this.#setSearchQuery(chars.join(""));
			return true;
		}

		const printableText = extractPrintableText(keyData);
		if (printableText === undefined) return false;
		if (this.#searchQuery.length === 0 && printableText.trim().length === 0) return false;

		this.#setSearchQuery(this.#searchQuery + printableText);
		return true;
	}

	handleInput(keyData: string): void {
		// Reset countdown on any interaction
		this.#countdown?.reset();

		if (matchesSelectCancel(keyData)) {
			this.#onCancelCallback();
			return;
		}

		if (this.#handleSearchInput(keyData)) {
			return;
		}

		if (matchesSelectUp(keyData) || (!this.#isSearchEnabled() && keyData === "k")) {
			if (this.#filteredOptions.length > 0) {
				this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
				this.#updateList();
			}
		} else if (matchesSelectDown(keyData) || (!this.#isSearchEnabled() && keyData === "j")) {
			if (this.#filteredOptions.length > 0) {
				this.#selectedIndex = Math.min(this.#filteredOptions.length - 1, this.#selectedIndex + 1);
				this.#updateList();
			}
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredOptions[this.#selectedIndex];
			if (selected) this.#onSelectCallback(selected.label);
		} else if (matchesKey(keyData, "left") || (this.#slider && !this.#isSearchEnabled() && keyData === "h")) {
			if (this.#slider) this.#moveSlider(-1);
			else this.#onLeftCallback?.();
		} else if (matchesKey(keyData, "right") || (this.#slider && !this.#isSearchEnabled() && keyData === "l")) {
			if (this.#slider) this.#moveSlider(1);
			else this.#onRightCallback?.();
		} else if (this.#onExternalEditorCallback && matchesAppExternalEditor(keyData)) {
			this.#onExternalEditorCallback();
		}
	}

	override render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		if (this.#lastRenderWidth !== renderWidth) {
			this.#lastRenderWidth = renderWidth;
			this.#updateList(renderWidth);
		}
		return super.render(renderWidth);
	}

	dispose(): void {
		this.#countdown?.dispose();
	}
}

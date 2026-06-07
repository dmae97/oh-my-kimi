/**
 * Fullscreen plan-review overlay. Replaces the old inline `PlanReviewBlock`
 * (which lived in the transcript and competed with the approval selector for
 * vertical space, clipping tall plans). The overlay owns its entire content: the
 * plan is rendered once via {@link Markdown} and windowed through a
 * {@link ScrollView}, while the approval options (plus the optional model-tier
 * slider) sit beneath it inside the same outlined box — one self-contained
 * surface in the spirit of the `/copy` picker.
 *
 * Key map mirrors the plan-mode hook selector so muscle memory carries over:
 * ↑/↓ (j/k) move the option cursor, ←/→ (h/l) drive the slider, Enter confirms,
 * Esc cancels, and the external-editor key opens the plan. PageUp/PageDown and
 * g/G scroll the plan body.
 */
import { type Component, Markdown, type MarkdownTheme, matchesKey, ScrollView } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme";
import {
	matchesAppExternalEditor,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import type { HookSelectorSlider } from "./hook-selector";
import { bottomBorder, divider, row, topBorder } from "./overlay-box";
import { renderSegmentTrack } from "./segment-track";

/** Title shown in the overlay's top border. */
const OVERLAY_TITLE = "Plan Review";
/** Minimum plan-body rows kept visible even on short terminals. */
const MIN_BODY_ROWS = 3;

export interface PlanReviewOverlayCallbacks {
	/** Invoked with the chosen option label (never a disabled one). */
	onPick: (label: string) => void;
	/** Invoked on Esc / cancel. */
	onCancel: () => void;
	/** Invoked when the external-editor key is pressed (overlay stays open). */
	onExternalEditor?: () => void;
}

export interface PlanReviewOverlayOptions {
	/** Prompt rendered above the options (e.g. "Plan mode - next step"). */
	promptTitle?: string;
	options: string[];
	/** Indices into `options` that render dimmed and cannot be selected. */
	disabledIndices?: number[];
	/** Footer hint line; falls back to a generic nav hint when omitted. */
	helpText?: string;
	/** Initially highlighted option index. */
	initialIndex?: number;
	/** Optional model-tier slider rendered between the plan body and options. */
	slider?: HookSelectorSlider;
}

/** Default footer hint when the caller supplies none. */
const DEFAULT_HELP = "up/down select  enter confirm  pgup/pgdn scroll  esc cancel";

export class PlanReviewOverlay implements Component {
	#md: Markdown;
	#mdTheme: MarkdownTheme;
	#scrollView: ScrollView;
	#options: string[];
	#disabled: Set<number>;
	#helpText: string;
	#promptTitle: string | undefined;
	#selectedIndex: number;
	#slider: HookSelectorSlider | undefined;
	#sliderIndex: number;

	constructor(
		planContent: string,
		options: PlanReviewOverlayOptions,
		private readonly callbacks: PlanReviewOverlayCallbacks,
	) {
		this.#mdTheme = getMarkdownTheme();
		this.#md = new Markdown(planContent, 1, 0, this.#mdTheme);
		this.#scrollView = new ScrollView([], {
			height: MIN_BODY_ROWS,
			scrollbar: "auto",
			theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
		});
		this.#options = options.options;
		this.#disabled = new Set(
			(options.disabledIndices ?? []).filter(i => Number.isInteger(i) && i >= 0 && i < this.#options.length),
		);
		this.#helpText = options.helpText ?? DEFAULT_HELP;
		this.#promptTitle = options.promptTitle;
		this.#selectedIndex = this.#coerceIndex(options.initialIndex ?? 0);
		if (options.slider && options.slider.segments.length > 0) {
			this.#slider = options.slider;
			this.#sliderIndex = Math.max(0, Math.min(options.slider.index, options.slider.segments.length - 1));
		} else {
			this.#sliderIndex = 0;
		}
	}

	invalidate(): void {
		this.#md.invalidate();
	}

	/** Swap the displayed plan (e.g. after an external-editor round-trip) and
	 *  reset the scroll position so the operator starts at the top. */
	setPlanContent(planContent: string): void {
		this.#md.setText(planContent);
		this.#scrollView.scrollToTop();
	}

	/** Clamp `index` to range, then walk to the nearest enabled option so the
	 *  cursor never rests on a disabled row. */
	#coerceIndex(index: number): number {
		const max = this.#options.length - 1;
		if (max < 0) return -1;
		const clamped = Math.max(0, Math.min(index, max));
		if (!this.#disabled.has(clamped)) return clamped;
		for (let i = clamped + 1; i <= max; i++) if (!this.#disabled.has(i)) return i;
		for (let i = clamped - 1; i >= 0; i--) if (!this.#disabled.has(i)) return i;
		return clamped;
	}

	/** Move the option cursor by `delta`, skipping disabled rows, stopping at the
	 *  list edge. */
	#moveSelection(delta: number): void {
		const max = this.#options.length - 1;
		if (max < 0) return;
		let index = this.#selectedIndex;
		while (true) {
			const next = Math.max(0, Math.min(index + delta, max));
			if (next === index) return;
			index = next;
			if (!this.#disabled.has(index)) {
				this.#selectedIndex = index;
				return;
			}
		}
	}

	#moveSlider(delta: number): void {
		const slider = this.#slider;
		if (!slider) return;
		const next = Math.max(0, Math.min(slider.segments.length - 1, this.#sliderIndex + delta));
		if (next === this.#sliderIndex) return;
		this.#sliderIndex = next;
		slider.onChange?.(next);
	}

	handleInput(keyData: string): void {
		if (matchesSelectCancel(keyData)) {
			this.callbacks.onCancel();
			return;
		}
		if (matchesSelectUp(keyData) || keyData === "k") {
			this.#moveSelection(-1);
		} else if (matchesSelectDown(keyData) || keyData === "j") {
			this.#moveSelection(1);
		} else if (matchesKey(keyData, "left") || (this.#slider && keyData === "h")) {
			this.#moveSlider(-1);
		} else if (matchesKey(keyData, "right") || (this.#slider && keyData === "l")) {
			this.#moveSlider(1);
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const index = this.#selectedIndex;
			if (index >= 0 && index < this.#options.length && !this.#disabled.has(index)) {
				this.callbacks.onPick(this.#options[index]!);
			}
		} else if (matchesSelectPageUp(keyData) || matchesKey(keyData, "pageUp")) {
			this.#scrollView.page(-1);
		} else if (matchesSelectPageDown(keyData) || matchesKey(keyData, "pageDown")) {
			this.#scrollView.page(1);
		} else if (keyData === "g") {
			this.#scrollView.scrollToTop();
		} else if (keyData === "G") {
			this.#scrollView.scrollToBottom();
		} else if (this.callbacks.onExternalEditor && matchesAppExternalEditor(keyData)) {
			this.callbacks.onExternalEditor();
		}
	}

	#renderSliderLines(): string[] {
		const slider = this.#slider;
		if (!slider) return [];
		const active = this.#sliderIndex;
		const track = renderSegmentTrack(slider.segments, active);
		const leftArrow = theme.fg(active > 0 ? "accent" : "dim", "◂");
		const rightArrow = theme.fg(active < slider.segments.length - 1 ? "accent" : "dim", "▸");
		const caption = slider.caption ? `${theme.fg("dim", slider.caption)}  ` : "";
		const trackLine = `${caption}${leftArrow}  ${track}  ${rightArrow}`;
		const detail = slider.segments[active]?.detail;
		if (!detail) return [trackLine];
		return [trackLine, `  ${theme.fg("dim", "↳")} ${theme.fg("muted", detail)}`];
	}

	#renderOptionLines(): string[] {
		return this.#options.map((label, i) => {
			const isSelected = i === this.#selectedIndex;
			const isDisabled = this.#disabled.has(i);
			const cursor = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isDisabled
				? theme.fg("dim", label)
				: isSelected
					? theme.bold(theme.fg("accent", label))
					: theme.fg("text", label);
			return cursor + text;
		});
	}

	render(width: number): string[] {
		const termHeight = process.stdout.rows || 40;
		const innerWidth = Math.max(1, width - 4);

		const planLines = this.#md.render(innerWidth);
		const sliderLines = this.#renderSliderLines();
		const optionLines = this.#renderOptionLines();
		const promptLines = this.#promptTitle ? [theme.bold(theme.fg("accent", this.#promptTitle))] : [];

		// Chrome rows around the scrollable body: top border, divider, prompt,
		// slider, options, divider, footer, bottom border.
		const chrome = 5 + promptLines.length + sliderLines.length + optionLines.length;
		const viewport = Math.max(MIN_BODY_ROWS, termHeight - chrome);

		this.#scrollView.setLines(planLines);
		this.#scrollView.setHeight(viewport);
		const body = this.#scrollView.render(innerWidth);

		return [
			topBorder(width, OVERLAY_TITLE),
			...body.map(line => row(line, width)),
			divider(width),
			...promptLines.map(line => row(line, width)),
			...sliderLines.map(line => row(line, width)),
			...optionLines.map(line => row(line, width)),
			divider(width),
			row(theme.fg("dim", this.#helpText), width),
			bottomBorder(width),
		];
	}
}

import { Container, Markdown } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { imageReferenceHyperlink, renderPlaceholders } from "../image-references";
import { highlightMagicKeywords } from "../magic-keywords";

// OSC 133 shell integration: marks prompt zones for terminal multiplexers
// Do not emit OSC 133 C ("command start") here: the transcript has no matching
// command-finished marker, so terminals can group later assistant/tool output
// under the first submitted prompt.
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	// Memoized OSC 133 zone wrapping keyed on the underlying container render
	// (same source ref ⇒ identical rows ⇒ reuse the wrapped copy). Keeps this
	// component reference-stable for the transcript's incremental assembly and
	// never mutates the container's cached array.
	#zoneSource: readonly string[] | undefined;
	#zoneLines: string[] | undefined;

	constructor(text: string, synthetic = false, imageLinks?: readonly (string | undefined)[]) {
		super();
		const bgColor = (value: string) => theme.bg("userMessageBg", value);
		// Paint the magic keywords ("ultrathink"/"orchestrate"/"workflowz") inside the rendered
		// bubble too — matching the live editor glow. The Markdown component routes code spans and
		// fenced blocks through its own code styling (never `color`), so those are already excluded;
		// `highlightMagicKeywords` additionally restores the bubble's own foreground after each
		// painted keyword so the gradient never bleeds into the rest of the line.
		const keywordReset = theme.getFgAnsi("userMessageText") || "\x1b[39m";
		const baseText = synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) => theme.fg("userMessageText", highlightMagicKeywords(value, keywordReset));
		const imageLabel = (value: string) => theme.fg("accent", `\x1b[1m\x1b[4m${value}\x1b[24m\x1b[22m`);
		const color = (value: string) =>
			renderPlaceholders(value, {
				renderText: baseText,
				renderReference: (label, kind, index) =>
					kind === "image"
						? imageReferenceHyperlink(label, index, imageLinks, imageLabel)
						: theme.fg("accent", `\x1b[1m${label}\x1b[22m`),
			});
		this.addChild(
			new Markdown(text, 1, 1, getMarkdownTheme(), {
				bgColor,
				color,
			}),
		);
	}

	override render(width: number): readonly string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}
		if (this.#zoneSource === lines && this.#zoneLines !== undefined) {
			return this.#zoneLines;
		}
		const wrapped = lines.slice();
		wrapped[0] = OSC133_ZONE_START + wrapped[0];
		wrapped[wrapped.length - 1] = wrapped[wrapped.length - 1] + OSC133_ZONE_END;
		this.#zoneSource = lines;
		this.#zoneLines = wrapped;
		return wrapped;
	}
}

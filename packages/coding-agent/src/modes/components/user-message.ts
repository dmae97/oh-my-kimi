import { Container, Markdown, Spacer } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { highlightMagicKeywords } from "../magic-keywords";

// OSC 133 shell integration: marks prompt zones for terminal multiplexers
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	constructor(text: string, synthetic = false) {
		super();
		const bgColor = (value: string) => theme.bg("userMessageBg", value);
		// Paint the magic keywords ("ultrathink"/"orchestrate"/"workflow") inside the rendered
		// bubble too — matching the live editor glow. The Markdown component routes code spans and
		// fenced blocks through its own code styling (never `color`), so those are already excluded;
		// `highlightMagicKeywords` additionally restores the bubble's own foreground after each
		// painted keyword so the gradient never bleeds into the rest of the line.
		const keywordReset = theme.getFgAnsi("userMessageText") || "\x1b[39m";
		const color = synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) => theme.fg("userMessageText", highlightMagicKeywords(value, keywordReset));
		this.addChild(new Spacer(1));
		this.addChild(
			new Markdown(text, 1, 1, getMarkdownTheme(), {
				bgColor,
				color,
			}),
		);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = lines[lines.length - 1] + OSC133_ZONE_END + OSC133_ZONE_FINAL;
		return lines;
	}
}

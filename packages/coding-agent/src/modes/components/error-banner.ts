import { Container, Spacer, Text } from "@oh-my-pi/pi-tui";
import { getPreviewLines, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

/** Max lines of the error message shown in the pinned banner. */
const MAX_BANNER_LINES = 3;

/**
 * A persistent error banner pinned above the editor. Unlike the transcript
 * "Error: …" line (which scrolls away as the conversation grows), this stays in
 * the fixed region directly above the input so a turn that ended on a provider
 * error — e.g. Anthropic's "Output blocked by content filtering policy" — cannot
 * be missed. It is cleared when the next turn starts.
 */
export class ErrorBannerComponent extends Container {
	constructor(message: string) {
		super();
		const lines = getPreviewLines(message, MAX_BANNER_LINES, TRUNCATE_LENGTHS.LINE);
		if (lines.length === 0) {
			lines.push("Unknown error");
		}

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(str => theme.fg("error", str)));
		this.addChild(new Text(theme.bold(theme.fg("error", `${theme.status.error} ${lines[0]}`)), 1, 0));
		for (const line of lines.slice(1)) {
			this.addChild(new Text(theme.fg("error", `  ${line}`), 1, 0));
		}
		this.addChild(new Text(theme.fg("dim", "Dismissed when you send your next message."), 1, 0));
		this.addChild(new DynamicBorder(str => theme.fg("error", str)));
	}
}

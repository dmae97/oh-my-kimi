import { Box, type Component, Markdown } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { CompactionSummaryMessage } from "../../session/messages";

/**
 * Compaction point in the transcript, rendered as a slim horizontal divider:
 *
 *   ──────── 📷 compacted · ctrl+o ────────
 *
 * The conversation above the divider stays visible (display transcript keeps
 * full history); only the LLM context was reset. Expanding (ctrl+o) reveals
 * the compaction summary below the divider.
 */
export class CompactionSummaryMessageComponent implements Component {
	#expanded = false;
	#cache?: { width: number; lines: string[] };
	#detail?: Box;

	constructor(private readonly message: CompactionSummaryMessage) {}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#cache = undefined;
	}

	invalidate(): void {
		this.#cache = undefined;
		// Theme may have changed — rebuild the detail box lazily on next render.
		this.#detail = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) {
			return this.#cache.lines;
		}
		const lines = this.#expanded
			? ["", this.#divider(width), "", ...this.#detailBox().render(width)]
			: ["", this.#divider(width), ""];
		this.#cache = { width, lines };
		return lines;
	}

	#divider(width: number): string {
		const rule = theme.tree.horizontal;
		const label = `${theme.icon.camera} compacted`;
		// sep.dot ships pre-padded (" · "); trim so the hint joins with single spaces.
		const hint = `${theme.sep.dot.trim()} ctrl+o`;
		const plainWidth = Bun.stringWidth(`${label} ${hint}`, { countAnsiEscapeCodes: false });
		// ` label hint ` framed by rules on both sides.
		const remaining = width - plainWidth - 2;
		if (remaining < 4) {
			// Too narrow for a framed rule — emit the bare label.
			return theme.fg("muted", label);
		}
		const left = Math.floor(remaining / 2);
		const right = remaining - left;
		return (
			theme.fg("dim", rule.repeat(left)) +
			` ${theme.fg("muted", label)} ${theme.fg("dim", hint)} ` +
			theme.fg("dim", rule.repeat(right))
		);
	}

	#detailBox(): Box {
		if (this.#detail) return this.#detail;
		const box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		const tokenStr = this.message.tokensBefore.toLocaleString();
		const frameCount = this.message.images?.length ?? 0;
		const frameNote =
			frameCount > 0 ? `\n\n_${frameCount} snapcompact frame${frameCount === 1 ? "" : "s"} attached_` : "";
		box.addChild(
			new Markdown(
				`**Compacted from ${tokenStr} tokens**\n\n${this.message.summary}${frameNote}`,
				0,
				0,
				getMarkdownTheme(),
				{
					color: (text: string) => theme.fg("customMessageText", text),
				},
			),
		);
		this.#detail = box;
		return box;
	}
}

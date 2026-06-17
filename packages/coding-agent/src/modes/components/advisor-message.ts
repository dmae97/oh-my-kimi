import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import type { AdvisorMessageDetails, AdvisorSeverity } from "../../advisor";
import {
	createCachedComponent,
	formatBadge,
	replaceTabs,
	type ToolUIColor,
	wrapTextWithAnsi,
} from "../../tools/render-utils";
import { Ellipsis, renderStatusLine, truncateToWidth } from "../../tui";
import type { Theme } from "../theme/theme";

const COLLAPSED_NOTES = 3;
const NOTE_LINE_WIDTH = 110;

function wrapVarying(text: string, w1: number, w2: number): string[] {
	if (text.length === 0) return [];
	const firstWrap = wrapTextWithAnsi(text, w1);
	if (firstWrap.length <= 1) {
		return firstWrap;
	}
	const firstLine = firstWrap[0];
	const idx = text.indexOf(firstLine);
	if (idx === -1) {
		return wrapTextWithAnsi(text, w2);
	}
	const remainder = text.slice(idx + firstLine.length).trimStart();
	const restWrap = wrapTextWithAnsi(remainder, w2);
	return [firstLine, ...restWrap];
}

function severityColor(severity: AdvisorSeverity | undefined): ToolUIColor {
	switch (severity) {
		case "blocker":
			return "error";
		case "concern":
			return "warning";
		default:
			return "muted";
	}
}

/**
 * Display-only transcript card for advisor notes injected into the primary
 * session. Mirrors the IRC card's glyph + quote-border conventions so passive
 * advice reads as a distinct, non-interrupting aside rather than a user turn.
 */
export function createAdvisorMessageCard(
	details: AdvisorMessageDetails | undefined,
	getExpanded: () => boolean,
	uiTheme: Theme,
): Component {
	const notes = details?.notes ?? [];
	const blockers = notes.filter(note => note.severity === "blocker").length;
	const meta: string[] = [`${notes.length} ${notes.length === 1 ? "note" : "notes"}`];
	if (blockers > 0) meta.push(uiTheme.fg("error", `${blockers} blocker${blockers === 1 ? "" : "s"}`));

	return createCachedComponent(
		getExpanded,
		(width, expanded) => {
			const glyph = uiTheme.styledSymbol("status.info", "accent");
			const lines = [renderStatusLine({ iconOverride: glyph, title: "Advisor", meta }, uiTheme)];
			const quote = uiTheme.fg("dim", uiTheme.md.quoteBorder);
			const shown = expanded ? notes : notes.slice(0, COLLAPSED_NOTES);
			for (const entry of shown) {
				const badge = entry.severity
					? `${formatBadge(entry.severity, severityColor(entry.severity), uiTheme)} `
					: "";
				const quotePrefix = `  ${quote} `;
				const quoteWidth = visibleWidth(quotePrefix);
				const badgeWidth = visibleWidth(badge);
				const w1 = Math.max(10, Math.min(NOTE_LINE_WIDTH, width) - quoteWidth - badgeWidth);
				const w2 = Math.max(10, Math.min(NOTE_LINE_WIDTH, width) - quoteWidth);

				const paragraphs = entry.note.split("\n").filter(p => p.trim());
				const bodyLines: string[] = [];
				for (let i = 0; i < paragraphs.length; i++) {
					const p = paragraphs[i];
					if (i === 0) {
						bodyLines.push(...wrapVarying(p, w1, w2));
					} else {
						bodyLines.push(...wrapTextWithAnsi(p, w2));
					}
				}

				bodyLines.forEach((line, index) => {
					const prefix = index === 0 ? badge : "";
					lines.push(`  ${quote} ${prefix}${uiTheme.fg("toolOutput", replaceTabs(line))}`);
				});
			}
			const hidden = notes.length - shown.length;
			if (hidden > 0) {
				lines.push(`  ${quote} ${uiTheme.fg("dim", `… +${hidden} more ${hidden === 1 ? "note" : "notes"}`)}`);
			}
			return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		},
		{ paddingX: 1 },
	);
}

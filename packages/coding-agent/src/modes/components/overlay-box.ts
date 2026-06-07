/**
 * Shared box-drawing chrome for fullscreen overlays (the `/copy` picker, the
 * plan-review overlay, …). Every helper paints with `theme.boxSharp` glyphs and
 * the `border`/`accent` theme colors so all outlined overlays read identically.
 */
import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";

/** Pad or truncate a (possibly ANSI-styled) string to exactly `width` columns. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w === width) return text;
	if (w < width) return text + padding(width - w);
	const cut = truncateToWidth(text, width);
	const cw = visibleWidth(cut);
	return cw < width ? cut + padding(width - cw) : cut;
}

function paint(s: string): string {
	return theme.fg("border", s);
}

/** Top border with an optional accent-colored title inset into the rule. */
export function topBorder(width: number, title: string): string {
	const box = theme.boxSharp;
	const inner = Math.max(0, width - 2);
	if (!title) return paint(box.topLeft + box.horizontal.repeat(inner) + box.topRight);
	const shown = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
	const fillWidth = Math.max(0, inner - 1 - visibleWidth(shown));
	return (
		paint(box.topLeft + box.horizontal) +
		theme.bold(theme.fg("accent", shown)) +
		paint(box.horizontal.repeat(fillWidth) + box.topRight)
	);
}

/** A horizontal rule with left/right tees, splitting overlay sections. */
export function divider(width: number): string {
	const box = theme.boxSharp;
	return paint(box.teeRight + box.horizontal.repeat(Math.max(0, width - 2)) + box.teeLeft);
}

export function bottomBorder(width: number): string {
	const box = theme.boxSharp;
	return paint(box.bottomLeft + box.horizontal.repeat(Math.max(0, width - 2)) + box.bottomRight);
}

/** Wrap pre-styled content in vertical borders with single-column insets. */
export function row(content: string, width: number): string {
	const box = theme.boxSharp;
	return `${paint(box.vertical)} ${fit(content, Math.max(0, width - 4))} ${paint(box.vertical)}`;
}

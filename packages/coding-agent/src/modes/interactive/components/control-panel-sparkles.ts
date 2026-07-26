import { type ThemeColor, theme } from "../theme/theme.ts";

/**
 * Neon sparkle starfield for the OMK hero banner.
 *
 * The twinkle cadence is adapted from bokub/chalk-animation's `neon` effect
 * (https://github.com/bokub/chalk-animation), which alternates a glyph between
 * a dim and a bold neon color every ~500ms frame. Here it is extended to a
 * three-state flicker (bold / lit / faint) with a per-sparkle phase offset so
 * the field shimmers out of sync instead of strobing in lockstep.
 */

export interface SparkleAnchor {
	/** Horizontal position across the inner banner width, 0..1. */
	readonly frac: number;
	readonly glyph: string;
	readonly color: ThemeColor;
	/** Phase offset (in frames) so sparkles twinkle independently. */
	readonly phase: number;
}

const SPARKLE_PERIOD_MS = 520;

function twinkle(glyph: string, color: ThemeColor, phase: number, frameMs: number): string {
	const frame = Math.floor(frameMs / SPARKLE_PERIOD_MS) + phase;
	const state = ((frame % 3) + 3) % 3;
	if (state === 0) return theme.bold(theme.fg(color, glyph));
	if (state === 1) return theme.fg(color, glyph);
	return theme.fg("dim", glyph);
}

/**
 * Render a full-inner-width row with sparkles stamped at their fractional
 * columns. Every non-sparkle cell stays a literal space, so the row keeps a
 * stable `visibleWidth` of `innerWidth` regardless of motion frame.
 */
export function sparkleRow(innerWidth: number, anchors: readonly SparkleAnchor[], frameMs: number): string {
	if (innerWidth <= 0) return "";
	const cells: string[] = new Array(innerWidth).fill(" ");
	for (const anchor of anchors) {
		const col = Math.round(anchor.frac * (innerWidth - 1));
		if (col >= 0 && col < innerWidth) {
			cells[col] = twinkle(anchor.glyph, anchor.color, anchor.phase, frameMs);
		}
	}
	return cells.join("");
}

/**
 * The starfield is deliberately monochrome: `dim` and `muted` ink with a single
 * accent star per row. Multi-hue confetti competed with the wordmark once the
 * frames were reduced to hairlines.
 */
export const SPARKLE_ROW_TOP: readonly SparkleAnchor[] = [
	{ frac: 0.1, glyph: "·", color: "dim", phase: 0 },
	{ frac: 0.28, glyph: "·", color: "muted", phase: 1 },
	{ frac: 0.73, glyph: "✦", color: "dim", phase: 2 },
	{ frac: 0.9, glyph: "·", color: "accent", phase: 0 },
];

export const SPARKLE_ROW_BOTTOM: readonly SparkleAnchor[] = [
	{ frac: 0.06, glyph: "·", color: "dim", phase: 2 },
	{ frac: 0.21, glyph: "·", color: "muted", phase: 1 },
	{ frac: 0.55, glyph: "✦", color: "dim", phase: 0 },
	{ frac: 0.82, glyph: "·", color: "muted", phase: 1 },
	{ frac: 0.96, glyph: "·", color: "accent", phase: 2 },
];

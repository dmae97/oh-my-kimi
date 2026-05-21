import type { Theme, ThemeColor } from "./theme";

const SHIMMER_PADDING = 10;
const SHIMMER_SWEEP_MS = 2000;
const SHIMMER_BAND_HALF_WIDTH = 5;

type ShimmerTheme = Pick<Theme, "bold" | "fg">;

/** Three-tier color stack a shimmer character cycles through as the band sweeps. */
export interface ShimmerPalette {
	/** Color for chars outside / at the edge of the band (intensity < 0.2). */
	low: ThemeColor;
	/** Color for chars approaching the crest (0.2 <= intensity < 0.6). */
	mid: ThemeColor;
	/** Color at the band's crest (intensity >= 0.6). */
	high: ThemeColor;
	/** Whether to bold the crest tier. Default `false`. */
	bold?: boolean;
}

/** One run of text that shares a palette inside a larger shimmer sweep. */
export interface ShimmerSegment {
	text: string;
	palette?: ShimmerPalette;
}

export const DEFAULT_SHIMMER_PALETTE: ShimmerPalette = {
	low: "dim",
	mid: "muted",
	high: "accent",
	bold: true,
};

function shimmerIntensity(index: number, length: number): number {
	const period = length + SHIMMER_PADDING * 2;
	const pos = Math.floor(((Date.now() % SHIMMER_SWEEP_MS) / SHIMMER_SWEEP_MS) * period);
	const dist = Math.abs(index + SHIMMER_PADDING - pos);
	if (dist > SHIMMER_BAND_HALF_WIDTH) return 0;

	const x = Math.PI * (dist / SHIMMER_BAND_HALF_WIDTH);
	return 0.5 * (1 + Math.cos(x));
}

function styleShimmerChar(ch: string, intensity: number, theme: ShimmerTheme, palette: ShimmerPalette): string {
	if (intensity < 0.2) return theme.fg(palette.low, ch);
	if (intensity < 0.6) return theme.fg(palette.mid, ch);
	const styled = theme.fg(palette.high, ch);
	return palette.bold ? theme.bold(styled) : styled;
}

/**
 * Apply a shimmer sweep across one or more segments, treating them as a single
 * continuous string for band positioning. Each segment can supply its own
 * palette so the gradient stays in lockstep while the colors differ.
 */
export function shimmerSegments(segments: readonly ShimmerSegment[], theme: ShimmerTheme): string {
	let total = 0;
	const expanded: Array<{ chars: string[]; palette: ShimmerPalette }> = [];
	for (const seg of segments) {
		const chars = [...seg.text];
		total += chars.length;
		expanded.push({ chars, palette: seg.palette ?? DEFAULT_SHIMMER_PALETTE });
	}
	if (total === 0) return "";

	const out: string[] = [];
	let index = 0;
	for (const { chars, palette } of expanded) {
		for (const ch of chars) {
			out.push(styleShimmerChar(ch, shimmerIntensity(index, total), theme, palette));
			index++;
		}
	}
	return out.join("");
}

export function shimmerText(text: string, theme: ShimmerTheme, palette?: ShimmerPalette): string {
	return shimmerSegments([{ text, palette }], theme);
}

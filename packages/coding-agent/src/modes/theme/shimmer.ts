import type { Theme } from "./theme";

const SHIMMER_PADDING = 10;
const SHIMMER_SWEEP_MS = 2000;
const SHIMMER_BAND_HALF_WIDTH = 5;

type ShimmerTheme = Pick<Theme, "bold" | "fg">;

function shimmerIntensity(index: number, length: number): number {
	const period = length + SHIMMER_PADDING * 2;
	const pos = Math.floor(((Date.now() % SHIMMER_SWEEP_MS) / SHIMMER_SWEEP_MS) * period);
	const dist = Math.abs(index + SHIMMER_PADDING - pos);
	if (dist > SHIMMER_BAND_HALF_WIDTH) return 0;

	const x = Math.PI * (dist / SHIMMER_BAND_HALF_WIDTH);
	return 0.5 * (1 + Math.cos(x));
}

function styleShimmerChar(ch: string, intensity: number, theme: ShimmerTheme): string {
	if (intensity < 0.2) return theme.fg("dim", ch);
	if (intensity < 0.6) return theme.fg("muted", ch);
	return theme.bold(theme.fg("accent", ch));
}

export function shimmerText(text: string, theme: ShimmerTheme): string {
	const chars = [...text];
	if (chars.length === 0) return text;

	return chars.map((ch, index) => styleShimmerChar(ch, shimmerIntensity(index, chars.length), theme)).join("");
}

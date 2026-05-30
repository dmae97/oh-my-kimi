import { theme } from "./theme/theme";

const FG_RESET = "\x1b[39m";

/** Declarative spec for {@link createGradientHighlighter}. */
export interface GradientHighlightSpec {
	/** Cheap, stateless presence probe used to skip the boundary regex on most lines. Must be non-global. */
	probe: RegExp;
	/** Global, word-bounded match regex walked by `.replace`. */
	highlight: RegExp;
	/** Number of color stops swept across the gradient. */
	stops: number;
	/** Maps a normalized position `t` in [0, 1) to an HSL hue in degrees. */
	hue: (t: number) => number;
	/** HSL saturation percentage. Default 90. */
	saturation?: number;
	/** HSL lightness percentage. Default 62. */
	lightness?: number;
}

/**
 * Build a stateless highlighter that paints each standalone match of `highlight`
 * with a smooth HSL gradient for editor display. The returned function adds only
 * zero-width SGR escapes — the visible width is unchanged — and returns the input
 * untouched when `probe` does not match. The palette is compiled lazily and
 * memoized per active color mode.
 */
export function createGradientHighlighter(spec: GradientHighlightSpec): (text: string) => string {
	const { probe, highlight, stops, hue, saturation = 90, lightness = 62 } = spec;

	let cachedMode: string | undefined;
	let cachedPalette: readonly string[] | undefined;

	/** Gradient foreground escapes for the active color mode, compiled once per mode. */
	const palette = (): readonly string[] => {
		const mode = theme.getColorMode();
		if (cachedPalette && cachedMode === mode) return cachedPalette;
		const format = mode === "truecolor" ? "ansi-16m" : "ansi-256";
		const next: string[] = [];
		for (let i = 0; i < stops; i++) {
			next.push(Bun.color(`hsl(${Math.round(hue(i / stops))}, ${saturation}%, ${lightness}%)`, format) ?? "");
		}
		cachedMode = mode;
		cachedPalette = next;
		return next;
	};

	/** Paint each character of `word` with the next gradient stop, resetting fg after. */
	const paint = (word: string): string => {
		const stopsArr = palette();
		const n = word.length;
		let out = "";
		let prev = "";
		for (let i = 0; i < n; i++) {
			const color = stopsArr[Math.floor((i / n) * stopsArr.length)] ?? stopsArr[0] ?? "";
			// Coalesce consecutive characters that resolve to the same stop.
			if (color !== prev) {
				out += color;
				prev = color;
			}
			out += word[i];
		}
		return `${out}${FG_RESET}`;
	};

	return (text: string): string => {
		if (!probe.test(text)) return text;
		return text.replace(highlight, paint);
	};
}

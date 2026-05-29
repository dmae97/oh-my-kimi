import ultrathinkNotice from "../prompts/system/ultrathink-notice.md" with { type: "text" };
import { theme } from "./theme/theme";

/**
 * "ultrathink" keyword support, mirroring Claude Code's affordance.
 *
 * Typing the standalone word in the input editor paints it with a rainbow
 * gradient ({@link highlightUltrathink}); submitting a message that mentions it
 * appends a hidden {@link ULTRATHINK_NOTICE} nudging the model toward careful
 * multi-step reasoning. Matching is word-bounded and case-insensitive, so
 * "ultrathinking"/"ultrathinks" never trigger either behavior.
 */

// Cheap, stateless presence probe used to skip the boundary regex on most lines.
const ULTRATHINK_PROBE = /ultrathink/i;
// Detection: standalone keyword, any case. Non-global so `.test` stays stateless.
const ULTRATHINK_WORD = /\bultrathink\b/i;
// Highlight: global so `.replace` walks every occurrence.
const ULTRATHINK_HIGHLIGHT = /\bultrathink\b/gi;

/** Hidden system notice appended after a user message that mentions "ultrathink". */
export const ULTRATHINK_NOTICE: string = ultrathinkNotice.trim();

/** Whether `text` contains the standalone keyword "ultrathink" (any case). */
export function containsUltrathink(text: string): boolean {
	return ULTRATHINK_WORD.test(text);
}

const FG_RESET = "\x1b[39m";
// Hue stops swept across the visible spectrum. More stops than the keyword has
// letters so the gradient resolves smoothly regardless of casing/match length.
const RAINBOW_STOPS = 14;

let cachedMode: string | undefined;
let cachedPalette: readonly string[] | undefined;

/** Rainbow foreground escapes for the active color mode, compiled once per mode. */
function rainbowPalette(): readonly string[] {
	const mode = theme.getColorMode();
	if (cachedPalette && cachedMode === mode) return cachedPalette;
	const format = mode === "truecolor" ? "ansi-16m" : "ansi-256";
	const palette: string[] = [];
	for (let i = 0; i < RAINBOW_STOPS; i++) {
		// Sweep red→violet (0..330°), stopping short of the wrap back to red.
		const hue = Math.round((i / RAINBOW_STOPS) * 330);
		palette.push(Bun.color(`hsl(${hue}, 90%, 62%)`, format) ?? "");
	}
	cachedMode = mode;
	cachedPalette = palette;
	return palette;
}

/** Paint each character of `word` with the next rainbow stop, resetting fg after. */
function rainbow(word: string): string {
	const palette = rainbowPalette();
	const n = word.length;
	let out = "";
	let prev = "";
	for (let i = 0; i < n; i++) {
		const color = palette[Math.floor((i / n) * palette.length)] ?? palette[0] ?? "";
		// Coalesce consecutive characters that resolve to the same stop.
		if (color !== prev) {
			out += color;
			prev = color;
		}
		out += word[i];
	}
	return `${out}${FG_RESET}`;
}

/**
 * Rainbow-highlight every standalone "ultrathink" in `text` for editor display.
 * Adds only zero-width SGR escapes — the visible width is unchanged — and returns
 * the input untouched when the keyword is absent.
 */
export function highlightUltrathink(text: string): string {
	if (!ULTRATHINK_PROBE.test(text)) return text;
	return text.replace(ULTRATHINK_HIGHLIGHT, rainbow);
}

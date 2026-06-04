import { hslToHex, relativeLuminance } from "@oh-my-pi/pi-utils";

/**
 * Derive a stable hue (0-359) from a string using djb2 hash.
 */
function nameToHue(name: string): number {
	let hash = 5381;
	for (let i = 0; i < name.length; i++) {
		hash = ((hash << 5) + hash) ^ name.charCodeAt(i);
		hash = hash >>> 0; // keep 32-bit unsigned
	}
	return hash % 360;
}

const ACCENT_SATURATION = 0.9;
const ACCENT_DARK_LIGHTNESS = 0.72;
/** Minimum contrast ratio (WCAG AA large text) between a light-theme accent and its surface. */
const ACCENT_MIN_CONTRAST = 3;

/**
 * Largest relative luminance an accent may have while still meeting
 * {@link ACCENT_MIN_CONTRAST} against a surface of the given luminance.
 */
function accentLuminanceCap(surfaceLuminance: number): number {
	return Math.max(0, (surfaceLuminance + 0.05) / ACCENT_MIN_CONTRAST - 0.05);
}

/**
 * Derive a stable CSS hex accent color from a session name.
 *
 * On dark themes (`surfaceLuminance` undefined) the accent is vivid (high
 * saturation, high lightness). On light themes the lightness is reduced until the
 * accent's perceived luminance clears {@link ACCENT_MIN_CONTRAST} against the
 * actual surface it renders on — so it stays legible on near-white *and* mid-light
 * backgrounds — while keeping the same per-session hue.
 */
export function getSessionAccentHex(name: string, surfaceLuminance?: number): string {
	const hue = nameToHue(name);
	if (surfaceLuminance === undefined) {
		return hslToHex(hue, ACCENT_SATURATION, ACCENT_DARK_LIGHTNESS);
	}

	const cap = accentLuminanceCap(surfaceLuminance);
	const top = hslToHex(hue, ACCENT_SATURATION, ACCENT_DARK_LIGHTNESS);
	if ((relativeLuminance(top) ?? 0) <= cap) return top;

	// Bisect lightness: `lo` always yields luminance <= cap, `hi` always above it.
	let lo = 0;
	let hi = ACCENT_DARK_LIGHTNESS;
	for (let i = 0; i < 20; i++) {
		const mid = (lo + hi) / 2;
		if ((relativeLuminance(hslToHex(hue, ACCENT_SATURATION, mid)) ?? 0) > cap) {
			hi = mid;
		} else {
			lo = mid;
		}
	}
	return hslToHex(hue, ACCENT_SATURATION, lo);
}

/**
 * Convert a hex accent color to an ANSI-16m foreground escape sequence.
 * Returns `undefined` if `hex` is nullish or Bun.color conversion fails.
 */
export function getSessionAccentAnsi(hex: string | undefined): string | undefined {
	if (!hex) return undefined;
	return Bun.color(hex, "ansi-16m") ?? undefined;
}

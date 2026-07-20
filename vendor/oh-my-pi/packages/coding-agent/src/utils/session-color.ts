import { hexToHsv, hslToHex, relativeLuminance } from "@oh-my-pi/pi-utils";

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

/** Minimum angular distance in hue degrees from any theme color to avoid visual collision. */
const MIN_HUE_DISTANCE = 10;
/** Saturation threshold below which hue is meaningless (near-gray). */
const MIN_SATURATION_FOR_HUE = 0.1;

/** Angular distance between two hue values (0-360). */
function hueDistance(a: number, b: number): number {
	const d = Math.abs(a - b);
	return Math.min(d, 360 - d);
}

/**
 * Parse hue (0-360) from a hex color string.
 * Returns undefined for near-gray colors where hue is not meaningful.
 */
function hexToHue(hex: string): number | undefined {
	const hsv = hexToHsv(hex);
	if (hsv.s < MIN_SATURATION_FOR_HUE) return undefined;
	return hsv.h;
}

/**
 * Find a hue at least {@link MIN_HUE_DISTANCE} from all occupied hues,
 * clamped to [lo, hi] to prevent leaving the intended hue band.
 * Returns `target` unchanged if no safe hue exists within bounds.
 */
function findSafeHue(target: number, occupied: number[], lo: number, hi: number): number {
	if (occupied.length === 0) return target;
	if (occupied.every(h => hueDistance(target, h) >= MIN_HUE_DISTANCE)) {
		return target;
	}
	for (let d = 1; d <= hi - lo; d++) {
		for (const dir of [1, -1]) {
			const candidate = Math.max(lo, Math.min(hi, target + d * dir));
			if (occupied.every(h => hueDistance(candidate, h) >= MIN_HUE_DISTANCE)) {
				return candidate;
			}
		}
	}
	// fallback: keep the original target if no safe spot exists within the band
	return target;
}

/** Hue range low and high for dark themes (warm: red → yellow → green). */
const DARK_HUE_START = 0;
const DARK_HUE_END = 120;
/** Hue range low and high for light themes (cool: cyan → blue → purple). */
const LIGHT_HUE_START = 180;
const LIGHT_HUE_END = 300;

/**
 * Derive a stable CSS hex accent color from a session name and the active theme.
 *
 * Picks a hue from a **dark/light-specific range** so the accent feels natural
 * for the theme type (warm on dark, cool on light). The session name hash
 * determines the exact hue within the range. The result is checked against
 * all theme color hues and shifted if it lands within {@link MIN_HUE_DISTANCE}
 * of an existing theme hue, but is clamped to the hue band so it never
 * drifts into an unrelated part of the spectrum.
 *
 * On dark themes (`surfaceLuminance` undefined) the accent is vivid (high
 * saturation, high lightness). On light themes the lightness is reduced until the
 * accent's perceived luminance clears {@link ACCENT_MIN_CONTRAST} against the
 * actual surface it renders on — so it stays legible on near-white *and* mid-light
 * backgrounds.
 *
 * @param name — session name for per-session uniqueness.
 * @param themeColorHexes — all theme colors to check collision against.
 * @param surfaceLuminance — undefined on dark themes; WCAG luminance of the
 *   status-line background on light themes.
 */
export function getSessionAccentHex(name: string, themeColorHexes: string[], surfaceLuminance?: number): string {
	// 1. Pick hue range based on theme mode
	const hueStart = surfaceLuminance === undefined ? DARK_HUE_START : LIGHT_HUE_START;
	const hueEnd = surfaceLuminance === undefined ? DARK_HUE_END : LIGHT_HUE_END;
	const range = hueEnd - hueStart;

	// 2. Session name picks within the range
	let targetHue = hueStart + (nameToHue(name) % range);

	// 3. Shift away if too close to any theme color — stays within [hueStart, hueEnd]
	const themeHues = themeColorHexes.map(hexToHue).filter((h): h is number => h !== undefined);
	targetHue = findSafeHue(targetHue, themeHues, hueStart, hueEnd);

	// 4. Lightness/contrast — vivid on dark, bisected for AA on light
	if (surfaceLuminance === undefined) {
		return hslToHex(targetHue, ACCENT_SATURATION, ACCENT_DARK_LIGHTNESS);
	}

	const cap = accentLuminanceCap(surfaceLuminance);
	const top = hslToHex(targetHue, ACCENT_SATURATION, ACCENT_DARK_LIGHTNESS);
	if ((relativeLuminance(top) ?? 0) <= cap) return top;

	// Bisect lightness: `lo` always yields luminance <= cap, `hi` always above it.
	let lo = 0;
	let hi = ACCENT_DARK_LIGHTNESS;
	for (let i = 0; i < 20; i++) {
		const mid = (lo + hi) / 2;
		if ((relativeLuminance(hslToHex(targetHue, ACCENT_SATURATION, mid)) ?? 0) > cap) {
			hi = mid;
		} else {
			lo = mid;
		}
	}
	return hslToHex(targetHue, ACCENT_SATURATION, lo);
}

/**
 * Convert a hex accent color to an ANSI-16m foreground escape sequence.
 * Returns `undefined` if `hex` is nullish or Bun.color conversion fails.
 */
export function getSessionAccentAnsi(hex: string | undefined): string | undefined {
	if (!hex) return undefined;
	return Bun.color(hex, "ansi-16m") ?? undefined;
}

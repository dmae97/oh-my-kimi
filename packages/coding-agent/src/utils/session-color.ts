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

/**
 * Convert HSL (h: 0-360, s: 0-1, l: 0-1) to a CSS hex string.
 */
function hslToHex(h: number, s: number, l: number): string {
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
		return Math.round(255 * color)
			.toString(16)
			.padStart(2, "0");
	};
	return `#${f(0)}${f(8)}${f(4)}`;
}

/** Relative luminance (ITU-R BT.709) of a #rrggbb hex string. */
function relativeLuminance(hex: string): number {
	const r = parseInt(hex.slice(1, 3), 16) / 255;
	const g = parseInt(hex.slice(3, 5), 16) / 255;
	const b = parseInt(hex.slice(5, 7), 16) / 255;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const ACCENT_SATURATION = 0.9;
const ACCENT_DARK_LIGHTNESS = 0.72;
/**
 * Maximum relative luminance for accents on light themes. HSL lightness alone
 * doesn't bound perceived brightness — high-luminance hues (yellow, lime, cyan)
 * stay near-invisible on a light background even at moderate lightness — so we
 * cap luminance directly to keep the accent legible on light statuslines/borders.
 */
const ACCENT_LIGHT_MAX_LUMINANCE = 0.2;

/**
 * Derive a stable CSS hex accent color from a session name.
 *
 * On dark themes the accent is vivid (high saturation, high lightness). On light
 * themes the lightness is reduced until the accent's perceived luminance falls
 * under {@link ACCENT_LIGHT_MAX_LUMINANCE}, so it stays readable instead of
 * washing out — while keeping the same per-session hue.
 */
export function getSessionAccentHex(name: string, light = false): string {
	const hue = nameToHue(name);
	if (!light) return hslToHex(hue, ACCENT_SATURATION, ACCENT_DARK_LIGHTNESS);

	const top = hslToHex(hue, ACCENT_SATURATION, ACCENT_DARK_LIGHTNESS);
	if (relativeLuminance(top) <= ACCENT_LIGHT_MAX_LUMINANCE) return top;

	// Bisect lightness: `lo` always yields luminance <= cap, `hi` always above it.
	let lo = 0;
	let hi = ACCENT_DARK_LIGHTNESS;
	for (let i = 0; i < 20; i++) {
		const mid = (lo + hi) / 2;
		if (relativeLuminance(hslToHex(hue, ACCENT_SATURATION, mid)) > ACCENT_LIGHT_MAX_LUMINANCE) {
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

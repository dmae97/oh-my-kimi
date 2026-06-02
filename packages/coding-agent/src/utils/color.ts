// Conventional xterm RGB for the 16 base ANSI colors. Terminals may remap these,
// so they're a best-effort approximation for light/dark classification.
const ANSI_16: readonly (readonly [number, number, number])[] = [
	[0, 0, 0],
	[128, 0, 0],
	[0, 128, 0],
	[128, 128, 0],
	[0, 0, 128],
	[128, 0, 128],
	[0, 128, 128],
	[192, 192, 192],
	[128, 128, 128],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[0, 0, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
];
const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;

/** Parse a 256-color palette index (0–255) to RGB (0..255). */
function paletteToRgb(index: number): [number, number, number] | undefined {
	if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
	if (index < 16) {
		const rgb = ANSI_16[index];
		return rgb ? [rgb[0], rgb[1], rgb[2]] : undefined;
	}
	if (index < 232) {
		const n = index - 16;
		return [CUBE_STEPS[Math.floor(n / 36) % 6] ?? 0, CUBE_STEPS[Math.floor(n / 6) % 6] ?? 0, CUBE_STEPS[n % 6] ?? 0];
	}
	const gray = 8 + (index - 232) * 10;
	return [gray, gray, gray];
}

/** Parse a hex string (`#rgb` shorthand or `#rrggbb`) to RGB (0..255). */
function hexToRgb(hex: string): [number, number, number] | undefined {
	if (hex[0] !== "#") return undefined;
	let r: number;
	let g: number;
	let b: number;
	if (hex.length === 4) {
		r = parseInt(hex[1] + hex[1], 16);
		g = parseInt(hex[2] + hex[2], 16);
		b = parseInt(hex[3] + hex[3], 16);
	} else if (hex.length === 7) {
		r = parseInt(hex.slice(1, 3), 16);
		g = parseInt(hex.slice(3, 5), 16);
		b = parseInt(hex.slice(5, 7), 16);
	} else {
		return undefined;
	}
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return undefined;
	return [r, g, b];
}

/** Parse a theme color value — hex string or 256-color palette index — to RGB (0..255). */
function toRgb(value: string | number): [number, number, number] | undefined {
	if (typeof value === "number") return paletteToRgb(value);
	if (typeof value === "string") return hexToRgb(value);
	return undefined;
}

/** Gamma-decode a single 0..255 sRGB channel to linear 0..1. */
function linearizeChannel(channel: number): number {
	const c = channel / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Perceptual luma (gamma-encoded BT.709 weights over raw sRGB), normalized to 0..1.
 *
 * Cheap and good enough for a light/dark *classification* threshold. NOT suitable
 * for contrast ratios — use {@link relativeLuminance} for those.
 */
export function colorLuma(value: string | number): number | undefined {
	const rgb = toRgb(value);
	if (!rgb) return undefined;
	return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

/**
 * WCAG 2.x relative luminance (BT.709 weights over linearized sRGB), normalized to
 * 0..1. This is the value the WCAG contrast-ratio formula expects.
 *
 * Accepts a hex string (`#rgb` / `#rrggbb`) or a 256-color palette index; returns
 * `undefined` for var refs, empty strings, or anything unparseable.
 */
export function relativeLuminance(value: string | number): number | undefined {
	const rgb = toRgb(value);
	if (!rgb) return undefined;
	return 0.2126 * linearizeChannel(rgb[0]) + 0.7152 * linearizeChannel(rgb[1]) + 0.0722 * linearizeChannel(rgb[2]);
}

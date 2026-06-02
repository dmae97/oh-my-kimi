/** Relative luminance (ITU-R BT.709) of 0..255 RGB channels, normalized to 0..1. */
function rgbLuminance(r: number, g: number, b: number): number {
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Relative luminance (ITU-R BT.709) of a hex color, normalized to 0..1.
 *
 * Accepts both `#rgb` shorthand and `#rrggbb`. Returns `undefined` for anything
 * it can't parse, so callers can decide how to treat unknown colors.
 */
export function hexLuminance(hex: string): number | undefined {
	if (typeof hex !== "string" || hex[0] !== "#") return undefined;
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
	return rgbLuminance(r, g, b);
}

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

/**
 * Relative luminance of a 256-color palette index (0–255), normalized to 0..1.
 *
 * 0–15 use conventional xterm defaults, 16–231 the 6×6×6 color cube, and 232–255
 * the grayscale ramp. Returns `undefined` for non-integer or out-of-range input.
 */
export function paletteLuminance(index: number): number | undefined {
	if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
	if (index < 16) {
		const rgb = ANSI_16[index];
		if (!rgb) return undefined;
		return rgbLuminance(rgb[0], rgb[1], rgb[2]);
	}
	if (index < 232) {
		const n = index - 16;
		const r = CUBE_STEPS[Math.floor(n / 36) % 6] ?? 0;
		const g = CUBE_STEPS[Math.floor(n / 6) % 6] ?? 0;
		const b = CUBE_STEPS[n % 6] ?? 0;
		return rgbLuminance(r, g, b);
	}
	const gray = 8 + (index - 232) * 10;
	return rgbLuminance(gray, gray, gray);
}

/**
 * Relative luminance of a theme color value — a hex string (`#rgb` / `#rrggbb`)
 * or a 256-color palette index. Returns `undefined` for var refs, empty strings,
 * or anything unparseable.
 */
export function colorLuminance(value: string | number | undefined): number | undefined {
	if (typeof value === "number") return paletteLuminance(value);
	if (typeof value === "string") return hexLuminance(value);
	return undefined;
}

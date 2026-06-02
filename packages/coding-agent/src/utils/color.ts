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
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

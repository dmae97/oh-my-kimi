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

/**
 * Derive a stable CSS hex accent color from a session name.
 * High saturation, vivid — suitable for both status bar text and border coloring.
 */
export function getSessionAccentHex(name: string): string {
	return hslToHex(nameToHue(name), 0.9, 0.72);
}

/**
 * Convert a hex accent color to an ANSI-16m foreground escape sequence.
 * Returns `undefined` if `hex` is nullish or Bun.color conversion fails.
 */
export function getSessionAccentAnsi(hex: string | undefined): string | undefined {
	if (!hex) return undefined;
	return Bun.color(hex, "ansi-16m") ?? undefined;
}

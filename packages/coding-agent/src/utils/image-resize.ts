import type { ImageContent } from "@oh-my-pi/pi-ai";

export interface ImageResizeOptions {
	maxWidth?: number;
	maxHeight?: number;
	maxBytes?: number;
	jpegQuality?: number;
}

export interface ResizedImage {
	buffer: Uint8Array;
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
	get data(): string;
}

// 500KB target — aggressive compression; Anthropic's 5MB per-image cap is rarely the
// binding constraint once images are downsized to 1568px (Anthropic's internal threshold).
const DEFAULT_MAX_BYTES = 500 * 1024;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	// Anthropic's "internal recommended size" — Claude internally caps images at
	// 1568px on the longest edge before vision processing.
	maxWidth: 1568,
	maxHeight: 1568,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
};

/** Pick the smallest of N encoded buffers. */
function pickSmallest(...candidates: Array<{ buffer: Uint8Array; mimeType: string }>): {
	buffer: Uint8Array;
	mimeType: string;
} {
	return candidates.reduce((best, c) => (c.buffer.length < best.buffer.length ? c : best));
}

/** Polyfill for Buffer.toBase64, technically since it derives from Uint8Array it should exist but Bun reasons... */
Buffer.prototype.toBase64 = function (this: Buffer) {
	return new Uint8Array(this.buffer, this.byteOffset, this.byteLength).toBase64();
};

/**
 * Resize and recompress an image to fit within the specified max dimensions and file size.
 *
 * Strategy:
 *  1. Probe metadata. If already within all limits, return original.
 *  2. Resize to fit max dimensions and encode at high quality across PNG/JPEG/WebP — return smallest.
 *  3. If still too large, walk a lossy JPEG/WebP quality ladder.
 *  4. If still too large, walk a dimension-scale ladder × quality ladder.
 *  5. If still too large, return the smallest variant produced.
 *
 * Backed by `Bun.Image`: a chainable native pipeline that runs decode/transform/encode
 * off the JS thread when the terminal (`.bytes()`) is awaited.
 */
export async function resizeImage(img: ImageContent, options?: ImageResizeOptions): Promise<ResizedImage> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const inputBuffer = Buffer.from(img.data, "base64");

	try {
		const { width: originalWidth, height: originalHeight, format } = await new Bun.Image(inputBuffer).metadata();
		const sourceMime = img.mimeType ?? `image/${format}`;

		// Fast path: already within dimensions AND well under budget.
		// Threshold is 1/4 of budget — if already that compact, don't re-encode.
		// Avoids wasted work on tiny icons/diagrams while ensuring larger PNGs
		// still get JPEG-compressed.
		const originalSize = inputBuffer.length;
		const comfortableSize = opts.maxBytes / 4;
		if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && originalSize <= comfortableSize) {
			return {
				buffer: inputBuffer,
				mimeType: sourceMime,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
				get data() {
					return img.data;
				},
			};
		}

		// Calculate initial dimensions respecting max limits
		let targetWidth = originalWidth;
		let targetHeight = originalHeight;

		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
			targetWidth = opts.maxWidth;
		}
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
			targetHeight = opts.maxHeight;
		}

		// First-attempt encoder: try PNG, JPEG, and lossy WebP — return whichever is smallest.
		// PNG wins for line art / few-color UI; JPEG and WebP win for photographic content;
		// WebP usually beats JPEG by 25–35% at the same perceptual quality.
		async function encodeSmallest(
			width: number,
			height: number,
			quality: number,
		): Promise<{ buffer: Uint8Array; mimeType: string }> {
			const [pngBuffer, jpegBuffer, webpBuffer] = await Promise.all([
				new Bun.Image(inputBuffer).resize(width, height).png().bytes(),
				new Bun.Image(inputBuffer).resize(width, height).jpeg({ quality }).bytes(),
				new Bun.Image(inputBuffer).resize(width, height).webp({ quality }).bytes(),
			]);
			return pickSmallest(
				{ buffer: pngBuffer, mimeType: "image/png" },
				{ buffer: jpegBuffer, mimeType: "image/jpeg" },
				{ buffer: webpBuffer, mimeType: "image/webp" },
			);
		}

		// Lossy-only encoder — used in quality/dimension fallback ladders where PNG can't shrink
		// further (PNG quality is a no-op). Picks the smaller of JPEG vs lossy WebP at the
		// requested quality.
		async function encodeLossy(
			width: number,
			height: number,
			quality: number,
		): Promise<{ buffer: Uint8Array; mimeType: string }> {
			const [jpegBuffer, webpBuffer] = await Promise.all([
				new Bun.Image(inputBuffer).resize(width, height).jpeg({ quality }).bytes(),
				new Bun.Image(inputBuffer).resize(width, height).webp({ quality }).bytes(),
			]);
			return pickSmallest(
				{ buffer: jpegBuffer, mimeType: "image/jpeg" },
				{ buffer: webpBuffer, mimeType: "image/webp" },
			);
		}

		// Quality ladder — more aggressive steps for tighter budgets
		const qualitySteps = [70, 60, 50, 40];
		const scaleSteps = [1.0, 0.75, 0.5, 0.35, 0.25];

		let best: { buffer: Uint8Array; mimeType: string };
		let finalWidth = targetWidth;
		let finalHeight = targetHeight;

		// First attempt: resize to target, try PNG/JPEG/WebP, pick smallest
		best = await encodeSmallest(targetWidth, targetHeight, opts.jpegQuality);

		if (best.buffer.length <= opts.maxBytes) {
			return {
				buffer: best.buffer,
				mimeType: best.mimeType,
				originalWidth,
				originalHeight,
				width: finalWidth,
				height: finalHeight,
				wasResized: true,
				get data() {
					return Buffer.from(best.buffer).toBase64();
				},
			};
		}

		// Still too large — lossy ladder (JPEG vs WebP, smallest wins) with decreasing quality
		for (const quality of qualitySteps) {
			best = await encodeLossy(targetWidth, targetHeight, quality);

			if (best.buffer.length <= opts.maxBytes) {
				return {
					buffer: best.buffer,
					mimeType: best.mimeType,
					originalWidth,
					originalHeight,
					width: finalWidth,
					height: finalHeight,
					wasResized: true,
					get data() {
						return Buffer.from(best.buffer).toBase64();
					},
				};
			}
		}

		// Still too large — reduce dimensions progressively with the lossy ladder
		for (const scale of scaleSteps) {
			finalWidth = Math.round(targetWidth * scale);
			finalHeight = Math.round(targetHeight * scale);

			if (finalWidth < 100 || finalHeight < 100) {
				break;
			}

			for (const quality of qualitySteps) {
				best = await encodeLossy(finalWidth, finalHeight, quality);

				if (best.buffer.length <= opts.maxBytes) {
					return {
						buffer: best.buffer,
						mimeType: best.mimeType,
						originalWidth,
						originalHeight,
						width: finalWidth,
						height: finalHeight,
						wasResized: true,
						get data() {
							return Buffer.from(best.buffer).toBase64();
						},
					};
				}
			}
		}

		// Last resort: return smallest version we produced
		return {
			buffer: best.buffer,
			mimeType: best.mimeType,
			originalWidth,
			originalHeight,
			width: finalWidth,
			height: finalHeight,
			wasResized: true,
			get data() {
				return Buffer.from(best.buffer).toBase64();
			},
		};
	} catch {
		// Failed to load image
		return {
			buffer: inputBuffer,
			mimeType: img.mimeType,
			originalWidth: 0,
			originalHeight: 0,
			width: 0,
			height: 0,
			wasResized: false,
			get data() {
				return img.data;
			},
		};
	}
}

/**
 * Format a dimension note for resized images.
 * This helps the model understand the coordinate mapping.
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}
	if (!result.originalWidth || !result.originalHeight || !result.width || !result.height) {
		return undefined;
	}
	if (result.width === result.originalWidth && result.height === result.originalHeight) {
		return undefined;
	}
	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}

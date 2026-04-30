import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ImageFormat, PhotonImage, SamplingFilter } from "@oh-my-pi/pi-natives";

export interface ImageResizeOptions {
	maxWidth?: number; // Default: 1568
	maxHeight?: number; // Default: 1568
	maxBytes?: number; // Default: 500KB
	jpegQuality?: number; // Default: 75
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
	// 1568px — Anthropic downscales anything larger; OpenAI tiles at 768px;
	// sending bigger pixels wastes bandwidth the model never sees.
	maxWidth: 1568,
	maxHeight: 1568,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 75,
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
 * Defaults target Anthropic's internal 1568px downscale threshold and produce small
 * lossy JPEG output suitable for tool-call payloads (~100–500KB typical).
 *
 * Strategy:
 * 1. Fast path — if input already fits dimensions AND is at <=25% of byte budget,
 *    return as-is. Avoids re-encoding tiny icons/diagrams.
 * 2. Resize to maxWidth/maxHeight, encode both PNG and JPEG at default quality,
 *    pick whichever is smaller. PNG wins for line art / few-color UI; JPEG wins
 *    for photographic content.
 * 3. If still too large, JPEG-only quality ladder (PNG quality is a no-op).
 * 4. If still too large, progressively reduce dimensions and retry the JPEG ladder.
 * 5. Last resort: ship the smallest variant produced.
 *
 * On any decode failure, returns the original bytes unchanged with wasResized=false.
 */
export async function resizeImage(img: ImageContent, options?: ImageResizeOptions): Promise<ResizedImage> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const inputBuffer = Buffer.from(img.data, "base64");

	try {
		const image = await PhotonImage.parse(inputBuffer);

		const originalWidth = image.width;
		const originalHeight = image.height;
		const format = img.mimeType?.split("/")[1] ?? "png";

		// Check if already within all limits (dimensions AND size)
		const originalSize = inputBuffer.length;
		// Fast path: skip if already within dimensions AND well under budget.
		// Threshold is 1/4 of budget — if already that compact, don't re-encode.
		// Avoids wasted work on tiny icons/diagrams while ensuring larger PNGs
		// still get JPEG-compressed.
		const comfortableSize = opts.maxBytes / 4;
		if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && originalSize <= comfortableSize) {
			return {
				buffer: inputBuffer,
				mimeType: img.mimeType ?? `image/${format}`,
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
			const resized = await image.resize(width, height, SamplingFilter.Lanczos3);

			const [pngBuffer, jpegBuffer, webpBuffer] = await Promise.all([
				resized.encode(ImageFormat.PNG, quality),
				resized.encode(ImageFormat.JPEG, quality),
				resized.encode(ImageFormat.WEBP, quality),
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
			const resized = await image.resize(width, height, SamplingFilter.Lanczos3);
			const [jpegBuffer, webpBuffer] = await Promise.all([
				resized.encode(ImageFormat.JPEG, quality),
				resized.encode(ImageFormat.WEBP, quality),
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

		// First attempt: resize to target, try both PNG and JPEG, pick smaller
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

	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${
		result.height
	}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}

/**
 * First-class prompt image attachments.
 *
 * Pure validation/metadata layer between clipboard/file acquisition and
 * `AgentSession.prompt(text, { images })`. Attachments are content-addressed
 * (sha256), validated by magic bytes — clipboard MIME metadata is never
 * trusted — and carry decoded dimensions for preview and pixel-budget checks.
 */

import { createHash, randomUUID } from "node:crypto";

export type PromptAttachmentSource = "clipboard" | "file" | "browser-capture";

export const PROMPT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type PromptImageMimeType = (typeof PROMPT_IMAGE_MIME_TYPES)[number];

export interface PromptImageAttachment {
	readonly id: string;
	readonly kind: "image";
	readonly source: PromptAttachmentSource;
	readonly mimeType: PromptImageMimeType;
	readonly byteLength: number;
	/** 0 when dimensions cannot be parsed from the container header. */
	readonly width: number;
	/** 0 when dimensions cannot be parsed from the container header. */
	readonly height: number;
	readonly sha256: string;
	readonly createdAt: number;
}

/** Defaults from the attachment roadmap (§validation). */
export const PROMPT_ATTACHMENT_LIMITS = {
	maxAttachments: 8,
	maxImageBytes: 10 * 1024 * 1024,
	maxDraftBytes: 32 * 1024 * 1024,
	maxPixels: 40_000_000,
} as const;

export type PromptAttachmentValidationCode =
	| "empty"
	| "unsupported"
	| "too-large"
	| "too-many-pixels"
	| "limit-reached";

export class PromptAttachmentError extends Error {
	readonly code: PromptAttachmentValidationCode;

	constructor(code: PromptAttachmentValidationCode, message: string) {
		super(message);
		this.name = "PromptAttachmentError";
		this.code = code;
	}
}

interface ImageHeaderInfo {
	mimeType: PromptImageMimeType;
	width: number;
	height: number;
}

/** Detect the image container from magic bytes. Clipboard metadata is not trusted. */
export function sniffImageMimeType(bytes: Uint8Array): PromptImageMimeType | null {
	if (bytes.length < 12) return null;
	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38 &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) &&
		bytes[5] === 0x61
	) {
		return "image/gif";
	}
	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	return null;
}

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } {
	// IHDR: width u32BE at 16, height u32BE at 20.
	if (bytes.length < 24) return { width: 0, height: 0 };
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readGifDimensions(bytes: Uint8Array): { width: number; height: number } {
	if (bytes.length < 10) return { width: 0, height: 0 };
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function readWebpDimensions(bytes: Uint8Array): { width: number; height: number } {
	if (bytes.length < 30) return { width: 0, height: 0 };
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
	if (chunk === "VP8X") {
		const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
		const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
		return { width, height };
	}
	if (chunk === "VP8 ") {
		// Lossy bitstream: frame tag skips 3 bytes, then 3-byte start code, then dims.
		const width = view.getUint16(26, true) & 0x3fff;
		const height = view.getUint16(28, true) & 0x3fff;
		return { width, height };
	}
	if (chunk === "VP8L") {
		const bits = view.getUint32(21, true);
		const width = (bits & 0x3fff) + 1;
		const height = ((bits >> 14) & 0x3fff) + 1;
		return { width, height };
	}
	return { width: 0, height: 0 };
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } {
	// Walk SOF markers; height/width are u16BE at marker offset +5/+7.
	let index = 2;
	while (index + 9 < bytes.length) {
		if (bytes[index] !== 0xff) {
			index += 1;
			continue;
		}
		const marker = bytes[index + 1];
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
			index += 2;
			continue;
		}
		const length = (bytes[index + 2] << 8) | bytes[index + 3];
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			const height = (bytes[index + 5] << 8) | bytes[index + 6];
			const width = (bytes[index + 7] << 8) | bytes[index + 8];
			return { width, height };
		}
		index += 2 + length;
	}
	return { width: 0, height: 0 };
}

function readImageHeader(bytes: Uint8Array, mimeType: PromptImageMimeType): ImageHeaderInfo {
	let dims = { width: 0, height: 0 };
	switch (mimeType) {
		case "image/png":
			dims = readPngDimensions(bytes);
			break;
		case "image/gif":
			dims = readGifDimensions(bytes);
			break;
		case "image/webp":
			dims = readWebpDimensions(bytes);
			break;
		case "image/jpeg":
			dims = readJpegDimensions(bytes);
			break;
		default:
			break;
	}
	return { mimeType, ...dims };
}

export interface PromptAttachmentLimits {
	maxImageBytes?: number;
	maxPixels?: number;
}

/**
 * Validate raw image bytes and build the attachment record. Throws
 * {@link PromptAttachmentError} with a stable code so callers can surface a
 * precise message instead of silently dropping the paste.
 */
export function createPromptImageAttachment(
	bytes: Uint8Array,
	source: PromptAttachmentSource,
	limits: PromptAttachmentLimits = {},
): PromptImageAttachment {
	const maxImageBytes = limits.maxImageBytes ?? PROMPT_ATTACHMENT_LIMITS.maxImageBytes;
	const maxPixels = limits.maxPixels ?? PROMPT_ATTACHMENT_LIMITS.maxPixels;

	if (bytes.length === 0) {
		throw new PromptAttachmentError("empty", "Clipboard image is empty.");
	}
	if (bytes.length > maxImageBytes) {
		throw new PromptAttachmentError(
			"too-large",
			`Image is ${(bytes.length / (1024 * 1024)).toFixed(1)} MiB — limit is ${(maxImageBytes / (1024 * 1024)).toFixed(0)} MiB.`,
		);
	}
	const mimeType = sniffImageMimeType(bytes);
	if (!mimeType) {
		throw new PromptAttachmentError(
			"unsupported",
			"Clipboard content is not a supported image (PNG, JPEG, WebP, GIF).",
		);
	}
	const header = readImageHeader(bytes, mimeType);
	const pixels = header.width * header.height;
	if (pixels > maxPixels) {
		throw new PromptAttachmentError(
			"too-many-pixels",
			`Image is ${header.width}×${header.height} (${(pixels / 1_000_000).toFixed(0)} MP) — limit is ${(maxPixels / 1_000_000).toFixed(0)} MP.`,
		);
	}
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	return {
		id: randomUUID(),
		kind: "image",
		source,
		mimeType,
		byteLength: bytes.length,
		width: header.width,
		height: header.height,
		sha256,
		createdAt: Date.now(),
	};
}

/** Human summary for preview footers: `1280×720 · PNG · 312 KiB`. */
export function describePromptImageAttachment(attachment: PromptImageAttachment): string {
	const dims = attachment.width > 0 && attachment.height > 0 ? `${attachment.width}×${attachment.height} · ` : "";
	const kib = attachment.byteLength / 1024;
	const size = kib >= 1024 ? `${(kib / 1024).toFixed(1)} MiB` : `${Math.round(kib)} KiB`;
	const mime = attachment.mimeType.replace("image/", "").toUpperCase();
	return `${dims}${mime} · ${size}`;
}

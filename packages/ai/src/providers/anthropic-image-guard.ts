/**
 * Pre-send image dimension guard for the Anthropic API.
 *
 * Anthropic rejects requests where any image dimension exceeds 2000px
 * for many-image requests. OMK's resize pipeline (coding-agent) only
 * covers read/file-attach paths — screenshots, image-generation tools,
 * and clipboard pastes can bypass it and brick sessions with sticky
 * 400 errors (the oversized image stays in the transcript and every
 * retry fails identically).
 *
 * This guard parses image dimensions synchronously from base64 headers
 * (PNG/JPEG/GIF/WebP) and replaces recognized oversized image blocks with
 * text placeholders. Unknown formats remain unchanged for the API to handle.
 */

import type { ImageContent, Message, TextContent } from "../types.ts";

/** Safety margin below Anthropic's 2000px many-image limit. */
const IMAGE_GUARD_MAX_DIM = 1900;

type ImageDimensions = {
	readonly width: number;
	readonly height: number;
};

/**
 * Parse image dimensions from base64-encoded image data without decoding
 * the full image. Reads only the header bytes (≤64KB slice for JPEG
 * marker scanning past EXIF data).
 *
 * Returns null when the format is unrecognized or the slice is too short —
 * callers should treat null as "let the API decide" (no replacement).
 */
export function parseImageDimensions(base64: string, _mimeType: string): ImageDimensions | null {
	const maxBytes = 64 * 1024;
	const sliceLen = Math.min(base64.length, Math.ceil(maxBytes / 3) * 4);
	const slice = base64.slice(0, sliceLen);

	let bytes: Buffer;
	try {
		bytes = Buffer.from(slice, "base64");
	} catch {
		return null;
	}
	if (bytes.length < 10) return null;

	// PNG: 89 50 4E 47 — width/height at bytes 16-23 (BE uint32)
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		if (bytes.length < 24) return null;
		return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	}

	// GIF: 47 49 46 38 — width/height at bytes 6-9 (LE uint16)
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
		return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
	}

	// JPEG: FF D8 — scan segments for SOF0-SOF15 (FF C0-CF except C4, C8, CC)
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < bytes.length) {
			if (bytes[offset] !== 0xff) {
				offset++;
				continue;
			}
			const marker = bytes[offset + 1];
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return {
					height: bytes.readUInt16BE(offset + 5),
					width: bytes.readUInt16BE(offset + 7),
				};
			}
			if (offset + 4 > bytes.length) break;
			const segLen = bytes.readUInt16BE(offset + 2);
			if (segLen < 2) break;
			offset += 2 + segLen;
		}
		return null;
	}

	// WebP: RIFF....WEBP
	if (
		bytes.length >= 30 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
		if (fourcc === "VP8X") {
			return {
				width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
				height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
			};
		}
		if (fourcc === "VP8 ") {
			return {
				width: bytes.readUInt16LE(26) & 0x3fff,
				height: bytes.readUInt16LE(28) & 0x3fff,
			};
		}
		if (fourcc === "VP8L" && bytes.length >= 25) {
			const b0 = bytes[21];
			const b1 = bytes[22];
			const b2 = bytes[23];
			const b3 = bytes[24];
			return {
				width: 1 + (((b1 & 0x3f) << 8) | b0),
				height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
			};
		}
		return null;
	}

	return null;
}

function sanitizeContentBlocks(
	content: readonly (TextContent | ImageContent)[],
	maxDim: number,
): { content: (TextContent | ImageContent)[]; replaced: number } {
	let replaced = 0;
	const out = content.map((block) => {
		if (block.type !== "image") return block;
		const dims = parseImageDimensions(block.data, block.mimeType);
		if (!dims) return block; // unknown format — let the API decide
		if (dims.width <= maxDim && dims.height <= maxDim) return block;
		replaced++;
		const placeholder: TextContent = {
			type: "text",
			text: `[image omitted: ${dims.width}x${dims.height} exceeds the Anthropic ${maxDim}px dimension limit. The image was replaced to keep the request valid — ask the user to resize and re-attach it if its content is needed.]`,
		};
		return placeholder;
	});
	return { content: out, replaced };
}

/**
 * Scan all messages for image blocks exceeding maxDim and replace them
 * with text placeholders. Returns a new message array; the input array
 * and its messages are never mutated.
 *
 * Covers both user-message image attachments and tool-result images
 * (screenshots, read-tool image results, generated images).
 */
export function sanitizeOversizedImages(
	messages: readonly Message[],
	maxDim: number = IMAGE_GUARD_MAX_DIM,
): { messages: Message[]; replaced: number } {
	let replaced = 0;
	const out = messages.map<Message>((message) => {
		if (message.role !== "user" && message.role !== "toolResult") return message;
		if (typeof message.content === "string" || !Array.isArray(message.content)) return message;

		const result = sanitizeContentBlocks(message.content, maxDim);
		if (result.replaced === 0) return message;
		replaced += result.replaced;
		return { ...message, content: result.content };
	});

	return { messages: out, replaced };
}

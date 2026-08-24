import { describe, expect, it } from "vitest";
import { AttachmentStore } from "../src/core/attachment-store.ts";
import {
	createPromptImageAttachment,
	PromptAttachmentError,
	sniffImageMimeType,
} from "../src/core/prompt-attachment.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Minimal header-only PNG whose IHDR claims the given dimensions. */
function pngWithDimensions(width: number, height: number, extraBytes = 32): Uint8Array {
	const bytes = new Uint8Array(24 + extraBytes);
	PNG_SIGNATURE.forEach((value, index) => {
		bytes[index] = value;
	});
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

function jpegWithDimensions(width: number, height: number): Uint8Array {
	// SOI followed directly by SOF0 so the marker walk reaches it immediately.
	return new Uint8Array([
		0xff,
		0xd8,
		0xff,
		0xc0,
		0x00,
		0x11,
		0x08,
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
		0x01,
		0x01,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
	]);
}

function gifWithDimensions(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(13);
	[0x47, 0x49, 0x46, 0x38, 0x39, 0x61].forEach((value, index) => {
		bytes[index] = value;
	});
	const view = new DataView(bytes.buffer);
	view.setUint16(6, width, true);
	view.setUint16(8, height, true);
	return bytes;
}

function webpVp8xWithDimensions(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(30);
	[0x52, 0x49, 0x46, 0x46].forEach((value, index) => {
		bytes[index] = value;
	});
	[0x57, 0x45, 0x42, 0x50].forEach((value, index) => {
		bytes[8 + index] = value;
	});
	[0x56, 0x50, 0x38, 0x58].forEach((value, index) => {
		bytes[12 + index] = value;
	});
	bytes[24] = (width - 1) & 0xff;
	bytes[25] = ((width - 1) >> 8) & 0xff;
	bytes[26] = ((width - 1) >> 16) & 0xff;
	bytes[27] = (height - 1) & 0xff;
	bytes[28] = ((height - 1) >> 8) & 0xff;
	bytes[29] = ((height - 1) >> 16) & 0xff;
	return bytes;
}

describe("sniffImageMimeType (magic bytes)", () => {
	it("detects supported containers", () => {
		expect(sniffImageMimeType(pngWithDimensions(1, 1))).toBe("image/png");
		expect(sniffImageMimeType(jpegWithDimensions(2, 2))).toBe("image/jpeg");
		expect(sniffImageMimeType(gifWithDimensions(3, 3))).toBe("image/gif");
		expect(sniffImageMimeType(webpVp8xWithDimensions(4, 4))).toBe("image/webp");
	});

	it("rejects non-image and truncated content", () => {
		expect(sniffImageMimeType(new Uint8Array([1, 2, 3, 4]))).toBeNull();
		expect(sniffImageMimeType(new TextEncoder().encode("not an image at all"))).toBeNull();
		expect(sniffImageMimeType(new Uint8Array(PNG_SIGNATURE.slice(0, 4)))).toBeNull();
		expect(sniffImageMimeType(new Uint8Array(0))).toBeNull();
	});
});

describe("createPromptImageAttachment", () => {
	it("extracts dimensions from PNG/GIF headers", () => {
		const png = createPromptImageAttachment(pngWithDimensions(1280, 720), "clipboard");
		expect(png.mimeType).toBe("image/png");
		expect(png.width).toBe(1280);
		expect(png.height).toBe(720);
		expect(png.sha256).toMatch(/^[0-9a-f]{64}$/);

		const gif = createPromptImageAttachment(gifWithDimensions(320, 240), "clipboard");
		expect(gif.width).toBe(320);
		expect(gif.height).toBe(240);
	});

	it("extracts dimensions from JPEG SOF and WebP VP8X headers", () => {
		const jpeg = createPromptImageAttachment(jpegWithDimensions(640, 480), "clipboard");
		expect(jpeg.mimeType).toBe("image/jpeg");
		expect(jpeg.width).toBe(640);
		expect(jpeg.height).toBe(480);

		const webp = createPromptImageAttachment(webpVp8xWithDimensions(800, 600), "clipboard");
		expect(webp.mimeType).toBe("image/webp");
		expect(webp.width).toBe(800);
		expect(webp.height).toBe(600);
	});

	it("rejects empty, unsupported, oversized, and over-resolution content", () => {
		expect(() => createPromptImageAttachment(new Uint8Array(0), "clipboard")).toThrowError(PromptAttachmentError);

		try {
			createPromptImageAttachment(new TextEncoder().encode("definitely not an image"), "clipboard");
			expect.unreachable();
		} catch (error) {
			expect((error as PromptAttachmentError).code).toBe("unsupported");
		}

		try {
			createPromptImageAttachment(new Uint8Array(11 * 1024 * 1024).fill(0x89), "clipboard");
			expect.unreachable();
		} catch (error) {
			// Size budget is checked before magic-byte sniffing.
			expect((error as PromptAttachmentError).code).toBe("too-large");
		}

		try {
			createPromptImageAttachment(pngWithDimensions(9000, 9000), "clipboard", { maxPixels: 40_000_000 });
			expect.unreachable();
		} catch (error) {
			// 81 MP > default 40 MP cap.
			expect((error as PromptAttachmentError).code).toBe("too-many-pixels");
		}
	});
});

describe("AttachmentStore", () => {
	it("stores, dedupes by content hash, and removes attachments", () => {
		const store = new AttachmentStore();
		const first = store.put(pngWithDimensions(10, 10), "clipboard");
		const duplicate = store.put(pngWithDimensions(10, 10), "clipboard");

		expect(duplicate.id).toBe(first.id);
		expect(store.list()).toHaveLength(1);
		expect(store.getBytes(first.id)?.length).toBeGreaterThan(0);

		store.remove(first.id);
		expect(store.get(first.id)).toBeUndefined();
		expect(store.list()).toHaveLength(0);
	});

	it("enforces the attachment-count and draft-size limits", () => {
		const store = new AttachmentStore({ maxAttachments: 2 });
		store.put(pngWithDimensions(1, 1), "clipboard");
		store.put(pngWithDimensions(2, 2), "clipboard");
		expect(() => store.put(pngWithDimensions(3, 3), "clipboard")).toThrowError(/limit reached/i);

		const tiny = new AttachmentStore({ maxDraftBytes: 100 });
		tiny.put(pngWithDimensions(1, 1), "file");
		expect(() => tiny.put(new Uint8Array(200).fill(PNG_SIGNATURE[0]), "file")).toThrowError();
	});

	it("materializes ImageContent payloads for session.prompt({ images })", () => {
		const store = new AttachmentStore();
		const attachment = store.put(pngWithDimensions(8, 8), "clipboard");
		const [image] = store.materializeImages([attachment.id]);

		expect(image.type).toBe("image");
		expect(image.mimeType).toBe("image/png");
		expect(Buffer.from(image.data, "base64").subarray(0, 8)).toEqual(Buffer.from(PNG_SIGNATURE));

		expect(() => store.materializeImages(["missing-id"])).toThrowError(/no longer available/);
		expect(store.totalBytes()).toBeGreaterThan(0);
		store.clear();
		expect(store.totalBytes()).toBe(0);
	});
});

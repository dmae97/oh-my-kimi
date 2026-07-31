import { describe, expect, it } from "vitest";
import { parseImageDimensions, sanitizeOversizedImages } from "../src/providers/anthropic-image-guard.ts";
import type { ImageContent, Message } from "../src/types.ts";

function asBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

function png(width: number, height: number): string {
	const bytes = Buffer.alloc(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47]);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return asBase64(bytes);
}

function gif(width: number, height: number): string {
	const bytes = Buffer.alloc(10);
	bytes.write("GIF89a", 0, "ascii");
	bytes.writeUInt16LE(width, 6);
	bytes.writeUInt16LE(height, 8);
	return asBase64(bytes);
}

function jpeg(width: number, height: number): string {
	const bytes = Buffer.alloc(12);
	bytes.set([0xff, 0xd8, 0xff, 0xc0]);
	bytes.writeUInt16BE(8, 4);
	bytes.writeUInt16BE(height, 7);
	bytes.writeUInt16BE(width, 9);
	return asBase64(bytes);
}

function webp(width: number, height: number): string {
	const bytes = Buffer.alloc(30);
	bytes.write("RIFF", 0, "ascii");
	bytes.write("WEBP", 8, "ascii");
	bytes.write("VP8X", 12, "ascii");
	const encodedWidth = width - 1;
	const encodedHeight = height - 1;
	bytes[24] = encodedWidth & 0xff;
	bytes[25] = (encodedWidth >> 8) & 0xff;
	bytes[26] = (encodedWidth >> 16) & 0xff;
	bytes[27] = encodedHeight & 0xff;
	bytes[28] = (encodedHeight >> 8) & 0xff;
	bytes[29] = (encodedHeight >> 16) & 0xff;
	return asBase64(bytes);
}

function image(data: string, mimeType = "image/png"): ImageContent {
	return { type: "image", data, mimeType };
}

describe("Anthropic image guard", () => {
	it.each([
		["PNG", png(2400, 1200), "image/png", { width: 2400, height: 1200 }],
		["GIF", gif(640, 480), "image/gif", { width: 640, height: 480 }],
		["JPEG", jpeg(1920, 1080), "image/jpeg", { width: 1920, height: 1080 }],
		["WebP", webp(2048, 1024), "image/webp", { width: 2048, height: 1024 }],
	])("reads %s dimensions from the encoded header", (_name, data, mimeType, expected) => {
		expect(parseImageDimensions(data, mimeType)).toEqual(expected);
	});

	it("leaves malformed or unknown image data to the provider", () => {
		expect(parseImageDimensions("not-base64", "image/png")).toBeNull();
		expect(parseImageDimensions(asBase64(Buffer.alloc(24)), "image/png")).toBeNull();
	});

	it("replaces oversized user and tool-result images without mutating the transcript", () => {
		const oversized = image(png(2400, 1200));
		const small = image(png(800, 600));
		const messages: Message[] = [
			{ role: "user", content: [oversized, small], timestamp: 1 },
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "screenshot",
				content: [oversized],
				isError: false,
				timestamp: 2,
			},
		];

		const result = sanitizeOversizedImages(messages);

		expect(result.replaced).toBe(2);
		expect(result.messages[0]?.content).toEqual([
			{
				type: "text",
				text: expect.stringContaining("2400x1200 exceeds the Anthropic 1900px dimension limit"),
			},
			small,
		]);
		expect(result.messages[1]?.content).toEqual([
			{
				type: "text",
				text: expect.stringContaining("2400x1200 exceeds the Anthropic 1900px dimension limit"),
			},
		]);
		expect(messages[0]?.content).toEqual([oversized, small]);
		expect(messages[1]?.content).toEqual([oversized]);
	});
});

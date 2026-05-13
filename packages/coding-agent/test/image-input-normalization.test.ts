import { describe, expect, test } from "bun:test";
import { ensureSupportedImageInput } from "../src/utils/image-loading";

// 1x1 red PNG (69 bytes). Bun.Image sniffs format from bytes, so we can pass
// this with a non-supported MIME type and the conversion path runs over the
// real native pipeline.
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

describe("ensureSupportedImageInput", () => {
	test("passes supported mime types through unchanged", async () => {
		const input = { type: "image" as const, data: RED_1X1_PNG_BASE64, mimeType: "image/png" };
		const result = await ensureSupportedImageInput(input);
		expect(result).toEqual(input);
	});

	test("converts unsupported image input to png", async () => {
		const result = await ensureSupportedImageInput({
			type: "image",
			data: RED_1X1_PNG_BASE64,
			mimeType: "image/bmp",
		});
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		// PNG re-encode of a 1x1 image must yield a valid (non-empty) PNG signature
		// (`89 50 4E 47`) when decoded from base64.
		const bytes = Buffer.from(result!.data, "base64");
		expect(bytes.length).toBeGreaterThan(0);
		expect(bytes[0]).toBe(0x89);
		expect(bytes[1]).toBe(0x50);
		expect(bytes[2]).toBe(0x4e);
		expect(bytes[3]).toBe(0x47);
	});

	test("returns null when input bytes are not a decodable image", async () => {
		const result = await ensureSupportedImageInput({
			type: "image",
			data: Buffer.from("not an image").toString("base64"),
			mimeType: "image/bmp",
		});
		expect(result).toBeNull();
	});
});

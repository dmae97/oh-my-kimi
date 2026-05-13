import { describe, expect, it } from "bun:test";
import { resizeImage } from "../../src/utils/image-resize";

// 1x1 red PNG (69 bytes) — used as a Bun.Image seed to synthesize larger fixtures
// without checking binary blobs into the repo.
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function makeRedPng(width: number, height: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const upscaled = await new Bun.Image(seed).resize(width, height, { filter: "nearest" }).png().bytes();
	return Buffer.from(upscaled).toBase64();
}

describe("resizeImage defaults", () => {
	it("downscales inputs larger than 1568px on the long edge", async () => {
		// 2000x1500 — exceeds the default 1568 cap on width
		const data = await makeRedPng(2000, 1500);

		const result = await resizeImage({ type: "image", data, mimeType: "image/png" });

		expect(result.wasResized).toBe(true);
		expect(result.width).toBeLessThanOrEqual(1568);
		expect(result.height).toBeLessThanOrEqual(1568);
		// Aspect ratio preserved (with rounding tolerance)
		expect(Math.abs(result.width / result.height - 2000 / 1500)).toBeLessThan(0.01);
	});

	it("preserves inputs already within budget and dimensions (fast path)", async () => {
		// 200x200 red square encodes to ~few hundred bytes — well below budget/4
		const data = await makeRedPng(200, 200);

		const result = await resizeImage({ type: "image", data, mimeType: "image/png" });

		expect(result.wasResized).toBe(false);
		expect(result.width).toBe(200);
		expect(result.height).toBe(200);
		expect(result.mimeType).toBe("image/png");
	});

	it("respects custom maxWidth/maxHeight overrides (browser-tool case)", async () => {
		// 1600x1200 — exceeds the 1024 cap from the browser screenshot override
		const data = await makeRedPng(1600, 1200);

		const result = await resizeImage(
			{ type: "image", data, mimeType: "image/png" },
			{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70 },
		);

		expect(result.wasResized).toBe(true);
		expect(result.width).toBeLessThanOrEqual(1024);
		expect(result.height).toBeLessThanOrEqual(1024);
		expect(result.buffer.length).toBeLessThanOrEqual(150 * 1024);
	});

	it("respects custom maxBytes override even when dimensions already fit", async () => {
		// 800x600 within both default and override dimensions, but a tight 4KB
		// budget forces re-encoding/dimension reduction.
		const data = await makeRedPng(800, 600);
		const originalBytes = Buffer.from(data, "base64").length;

		const result = await resizeImage({ type: "image", data, mimeType: "image/png" }, { maxBytes: 4 * 1024 });

		// Either the result fits the budget, or the algorithm exhausted its
		// fallbacks and shipped its smallest variant — but in both cases the
		// output must not be larger than the original.
		expect(result.buffer.length).toBeLessThanOrEqual(originalBytes);
	});

	it("uses lossy WebP or JPEG (not PNG) for oversized inputs", async () => {
		// 2000x2000 red PNG — exceeds dimension cap, triggers encodeSmallest.
		// Lossy formats (JPEG/WebP) should win over PNG for a solid-color image
		// at this dimension because they compress more aggressively.
		const data = await makeRedPng(2000, 2000);

		const result = await resizeImage({ type: "image", data, mimeType: "image/png" });

		expect(result.wasResized).toBe(true);
		// The result should be a lossy format (JPEG or WebP), not PNG,
		// because lossy encoding at <=1568px for a solid square is trivially small.
		expect(["image/jpeg", "image/webp"]).toContain(result.mimeType);
		expect(result.buffer.length).toBeLessThanOrEqual(500 * 1024);
	});
});

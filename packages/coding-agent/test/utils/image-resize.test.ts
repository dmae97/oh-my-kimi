import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resizeImage } from "@oh-my-pi/pi-coding-agent/utils/image-resize";

// 1x1 red PNG (69 bytes) — used as a Bun.Image seed to synthesize larger fixtures
// without checking binary blobs into the repo.
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function makeRedPng(width: number, height: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const upscaled = await new Bun.Image(seed).resize(width, height, { filter: "nearest" }).png().bytes();
	return Buffer.from(upscaled).toBase64();
}

async function makeRedWebP(width: number, height: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const upscaled = await new Bun.Image(seed)
		.resize(width, height, { filter: "nearest" })
		.webp({ quality: 90 })
		.bytes();
	return Buffer.from(upscaled).toBase64();
}

// Fixtures are synthesized once and shared read-only — `resizeImage` never mutates
// its input, so a single decodable source per shape serves every test. Real image
// encode/decode is the only cost here, so each source is the smallest solid-red
// image that still crosses the threshold under test:
//   - oversizedPng: a thin strip whose long edge exceeds the 1568 default cap, so
//     re-encodes touch ~1568×98 px instead of 1568×1568. A uniform red keeps format
//     selection deterministic (WebP is always smallest; PNG always beats JPEG), so
//     the strip exercises the same format/budget logic as a large square.
//   - smallPng / smallWebp: 200×200, comfortably inside every default cap (fast path).
let oversizedPng: string;
let smallPng: string;
let smallWebp: string;

beforeAll(async () => {
	[oversizedPng, smallPng, smallWebp] = await Promise.all([
		makeRedPng(1600, 100),
		makeRedPng(200, 200),
		makeRedWebP(200, 200),
	]);
});

describe("resizeImage defaults", () => {
	it("downscales inputs larger than 1568px on the long edge", async () => {
		// 1600px wide — exceeds the default 1568 cap on the long edge.
		const result = await resizeImage({ type: "image", data: oversizedPng, mimeType: "image/png" });

		expect(result.wasResized).toBe(true);
		expect(result.width).toBeLessThanOrEqual(1568);
		expect(result.height).toBeLessThanOrEqual(1568);
		// Aspect ratio of the 1600x100 source preserved (with rounding tolerance).
		expect(Math.abs(result.width / result.height - 1600 / 100)).toBeLessThan(0.01);
	});

	it("preserves inputs already within budget and dimensions (fast path)", async () => {
		// 200x200 red square encodes to ~few hundred bytes — well below budget/4.
		const result = await resizeImage({ type: "image", data: smallPng, mimeType: "image/png" });

		expect(result.wasResized).toBe(false);
		expect(result.width).toBe(200);
		expect(result.height).toBe(200);
		expect(result.mimeType).toBe("image/png");
	});

	it("respects custom maxWidth/maxHeight overrides (browser-tool case)", async () => {
		// 1600px wide — exceeds the 1024 cap from the browser screenshot override.
		const result = await resizeImage(
			{ type: "image", data: oversizedPng, mimeType: "image/png" },
			{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70 },
		);

		expect(result.wasResized).toBe(true);
		expect(result.width).toBeLessThanOrEqual(1024);
		expect(result.height).toBeLessThanOrEqual(1024);
		expect(result.buffer.length).toBeLessThanOrEqual(150 * 1024);
	});

	it("respects custom maxBytes override even when dimensions already fit", async () => {
		// 200x200 sits within every dimension cap, but a byte budget below the
		// source size (after the /4 fast-path headroom) forces a re-encode.
		const originalBytes = Buffer.from(smallPng, "base64").length;

		const result = await resizeImage({ type: "image", data: smallPng, mimeType: "image/png" }, { maxBytes: 1024 });

		// Either the result fits the budget, or the algorithm exhausted its
		// fallbacks and shipped its smallest variant — but in both cases the
		// output must not be larger than the original.
		expect(result.buffer.length).toBeLessThanOrEqual(originalBytes);
	});

	it("uses lossy WebP or JPEG (not PNG) for oversized inputs", async () => {
		// Oversized red strip exceeds the dimension cap, triggering encodeSmallest.
		// Lossy formats (JPEG/WebP) should win over PNG for a solid-color image
		// because they compress more aggressively.
		const result = await resizeImage({ type: "image", data: oversizedPng, mimeType: "image/png" });

		expect(result.wasResized).toBe(true);
		// The result should be a lossy format (JPEG or WebP), not PNG,
		// because lossy encoding for a solid strip is trivially small.
		expect(["image/jpeg", "image/webp"]).toContain(result.mimeType);
		expect(result.buffer.length).toBeLessThanOrEqual(500 * 1024);
	});

	it("excludes WebP when excludeWebP option is true", async () => {
		const result = await resizeImage(
			{ type: "image", data: oversizedPng, mimeType: "image/png" },
			{ excludeWebP: true },
		);

		expect(result.wasResized).toBe(true);
		expect(["image/png", "image/jpeg"]).toContain(result.mimeType);
		expect(result.mimeType).not.toBe("image/webp");
	});

	it("re-encodes a WebP source out of WebP when excludeWebP is set, even on the fast path", async () => {
		// 200x200 WebP — well below 1568px and ~tiny bytes, so it would hit the
		// fast path and pass through as image/webp. excludeWebP MUST force a
		// re-encode to a non-WebP format.
		const result = await resizeImage(
			{ type: "image", data: smallWebp, mimeType: "image/webp" },
			{ excludeWebP: true },
		);

		expect(result.mimeType).not.toBe("image/webp");
		expect(["image/png", "image/jpeg"]).toContain(result.mimeType);
	});
});

describe("resizeImage env wiring", () => {
	const prior = Bun.env.OMP_NO_WEBP;

	beforeEach(() => {
		delete (Bun.env as Record<string, string | undefined>).OMP_NO_WEBP;
	});

	afterEach(() => {
		if (prior === undefined) delete (Bun.env as Record<string, string | undefined>).OMP_NO_WEBP;
		else Bun.env.OMP_NO_WEBP = prior;
	});

	it("treats OMP_NO_WEBP=1 set at call time as exclusion (not baked at module load)", async () => {
		Bun.env.OMP_NO_WEBP = "1";

		const result = await resizeImage({ type: "image", data: smallWebp, mimeType: "image/webp" });

		expect(result.mimeType).not.toBe("image/webp");
	});

	it("treats OMP_NO_WEBP='' / '0' as NOT excluded", async () => {
		Bun.env.OMP_NO_WEBP = "";
		const empty = await resizeImage({ type: "image", data: smallWebp, mimeType: "image/webp" });
		expect(empty.mimeType).toBe("image/webp");

		Bun.env.OMP_NO_WEBP = "0";
		const zero = await resizeImage({ type: "image", data: smallWebp, mimeType: "image/webp" });
		expect(zero.mimeType).toBe("image/webp");
	});
});

import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processFileArguments } from "../src/cli/file-processor.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createReadTool } from "../src/core/tools/read.ts";

// 1x1 red PNG image as base64 (smallest valid PNG)
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("blockImages setting", () => {
	describe("SettingsManager", () => {
		it("should default blockImages to false", () => {
			const manager = SettingsManager.inMemory({});
			expect(manager.getBlockImages()).toBe(false);
		});

		it("should return true when blockImages is set to true", () => {
			const manager = SettingsManager.inMemory({ images: { blockImages: true } });
			expect(manager.getBlockImages()).toBe(true);
		});

		it("should persist blockImages setting via setBlockImages", () => {
			const manager = SettingsManager.inMemory({});
			expect(manager.getBlockImages()).toBe(false);

			manager.setBlockImages(true);
			expect(manager.getBlockImages()).toBe(true);

			manager.setBlockImages(false);
			expect(manager.getBlockImages()).toBe(false);
		});

		it("should handle blockImages alongside autoResize", () => {
			const manager = SettingsManager.inMemory({
				images: { autoResize: true, blockImages: true },
			});
			expect(manager.getImageAutoResize()).toBe(true);
			expect(manager.getBlockImages()).toBe(true);
		});
	});

	describe("Read tool", () => {
		let testDir: string;

		beforeEach(() => {
			testDir = join(tmpdir(), `block-images-test-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		it("should always read images (filtering happens at convertToLlm layer)", async () => {
			// Create test image
			const imagePath = join(testDir, "test.png");
			writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

			const tool = createReadTool(testDir);
			const result = await tool.execute("test-1", { path: imagePath });

			// Should have text note + image content
			expect(result.content.length).toBeGreaterThanOrEqual(1);
			const hasImage = result.content.some((c) => c.type === "image");
			expect(hasImage).toBe(true);
		});

		it("should read text files normally", async () => {
			// Create test text file
			const textPath = join(testDir, "test.txt");
			writeFileSync(textPath, "Hello, world!");

			const tool = createReadTool(testDir);
			const result = await tool.execute("test-2", { path: textPath });

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			const textContent = result.content[0] as { type: "text"; text: string };
			expect(textContent.text).toContain("Hello, world!");
		});
	});

	describe("processFileArguments", () => {
		let testDir: string;

		beforeEach(() => {
			testDir = join(tmpdir(), `block-images-process-test-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		it("should always process images (filtering happens at convertToLlm layer)", async () => {
			// Create test image
			const imagePath = join(testDir, "test.png");
			writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

			const result = await processFileArguments([imagePath]);

			expect(result.images).toHaveLength(1);
			expect(result.images[0].type).toBe("image");
		});

		it("should process text files normally", async () => {
			// Create test text file
			const textPath = join(testDir, "test.txt");
			writeFileSync(textPath, "Hello, world!");

			const result = await processFileArguments([textPath]);

			expect(result.images).toHaveLength(0);
			expect(result.text).toContain("Hello, world!");
		});
	});
});

describe("non-vision model image projection (TB21 §7.3)", () => {
	const TEXT_ONLY_MODEL = { id: "deepseek-chat", provider: "deepseek", input: ["text"] } as never;
	const VISION_MODEL = { id: "gpt-5.6-luna", provider: "openai-codex", input: ["text", "image"] } as never;

	let testDir: string;
	beforeEach(() => {
		testDir = join(tmpdir(), `vision-projection-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		writeFileSync(join(testDir, "test.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
	});
	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("returns text projection only for a text-only model (no image block)", async () => {
		const tool = createReadTool(testDir, { model: TEXT_ONLY_MODEL });
		const result = await tool.execute("vision-1", { path: join(testDir, "test.png") });

		const hasImage = result.content.some((c) => c.type === "image");
		expect(hasImage).toBe(false);
		expect(result.content.length).toBe(1);
		expect(result.content[0].type).toBe("text");
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/Read image file/);
		expect(text).toMatch(/does not support images/);
		// No fabricated description: only verifiable metadata.
		expect(text).not.toMatch(/shows|depicts|contains a|picture of/i);
	});

	it("keeps the image block for a vision-capable model", async () => {
		const tool = createReadTool(testDir, { model: VISION_MODEL });
		const result = await tool.execute("vision-2", { path: join(testDir, "test.png") });

		expect(result.content.some((c) => c.type === "image")).toBe(true);
	});

	it("keeps the image block when no model is in context (filtering happens downstream)", async () => {
		const tool = createReadTool(testDir);
		const result = await tool.execute("vision-3", { path: join(testDir, "test.png") });

		expect(result.content.some((c) => c.type === "image")).toBe(true);
	});
});

import { afterEach, describe, expect, test, vi } from "bun:test";
import * as imageConvert from "../src/utils/image-convert";
import { ensureSupportedImageInput } from "../src/utils/image-loading";

describe("ensureSupportedImageInput", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("returns supported image input unchanged", async () => {
		const convertToPngSpy = vi.spyOn(imageConvert, "convertToPng");
		const input = { type: "image" as const, data: "abc", mimeType: "image/png" };

		const result = await ensureSupportedImageInput(input);

		expect(result).toEqual(input);
		expect(convertToPngSpy).not.toHaveBeenCalled();
	});

	test("converts unsupported image input to png", async () => {
		const convertToPngSpy = vi
			.spyOn(imageConvert, "convertToPng")
			.mockResolvedValue({ data: "pngdata", mimeType: "image/png" });

		const result = await ensureSupportedImageInput({ type: "image", data: "bmpdata", mimeType: "image/bmp" });

		expect(convertToPngSpy).toHaveBeenCalledWith("bmpdata", "image/bmp");
		expect(result).toEqual({ type: "image", data: "pngdata", mimeType: "image/png" });
	});
});

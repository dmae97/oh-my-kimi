import { describe, expect, it } from "bun:test";
import { ffmpegAssetName } from "./tools-manager";

describe("ffmpegAssetName", () => {
	it("maps supported platform/arch pairs to direct-binary asset names", () => {
		expect(ffmpegAssetName("b6.1.1", "darwin", "arm64")).toBe("ffmpeg-darwin-arm64");
		expect(ffmpegAssetName("b6.1.1", "darwin", "x64")).toBe("ffmpeg-darwin-x64");
		expect(ffmpegAssetName("b6.1.1", "linux", "arm64")).toBe("ffmpeg-linux-arm64");
		expect(ffmpegAssetName("b6.1.1", "linux", "x64")).toBe("ffmpeg-linux-x64");
		expect(ffmpegAssetName("b6.1.1", "win32", "x64")).toBe("ffmpeg-win32-x64");
	});

	it("returns null for win32 on arm64 (no static asset published)", () => {
		expect(ffmpegAssetName("b6.1.1", "win32", "arm64")).toBeNull();
	});

	it("returns null for unsupported arch", () => {
		expect(ffmpegAssetName("b6.1.1", "darwin", "ia32")).toBeNull();
		expect(ffmpegAssetName("b6.1.1", "linux", "ppc64")).toBeNull();
	});

	it("returns null for unsupported platform", () => {
		expect(ffmpegAssetName("b6.1.1", "freebsd", "x64")).toBeNull();
	});
});

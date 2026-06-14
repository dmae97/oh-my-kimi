import { describe, expect, it } from "bun:test";
import { streamingPlayerCommandsFor } from "./streaming-player";

// The exact argv matters: a wrong flag means ffmpeg/paplay/aplay produce no
// audio. These pin the raw-PCM stdin contract (32-bit float, mono, the chunk's
// rate) and the per-platform backend selection. macOS/Windows have no streaming
// backend (file-only players), so they fall back to per-file playback.
describe("streamingPlayerCommandsFor", () => {
	const ffmpegOnly = { which: () => null, ffmpeg: () => "/opt/ffmpeg" };

	it("has no streaming backend on macOS (afplay is file-only)", () => {
		expect(streamingPlayerCommandsFor("darwin", 24_000, ffmpegOnly)).toEqual([]);
	});

	it("has no streaming backend on Windows", () => {
		expect(streamingPlayerCommandsFor("win32", 24_000, ffmpegOnly)).toEqual([]);
	});

	it("streams raw f32le mono PCM via ffmpeg (pulse then alsa) on Linux", () => {
		const cmds = streamingPlayerCommandsFor("linux", 24_000, { which: () => null, ffmpeg: () => "/usr/bin/ffmpeg" });
		expect(cmds).toHaveLength(2);
		expect(cmds[0]?.cmd).toBe("/usr/bin/ffmpeg");
		expect(cmds[0]?.args).toEqual(
			expect.arrayContaining(["-f", "f32le", "-ar", "24000", "-ac", "1", "-i", "pipe:0", "-f", "pulse"]),
		);
		expect(cmds[1]?.args).toContain("alsa");
	});

	it("prefers ffmpeg, then paplay/aplay raw fallbacks on Linux", () => {
		const cmds = streamingPlayerCommandsFor("linux", 24_000, {
			which: bin => (bin === "paplay" ? "/usr/bin/paplay" : bin === "aplay" ? "/usr/bin/aplay" : null),
			ffmpeg: () => "/usr/bin/ffmpeg",
		});
		const labels = cmds.map(c =>
			c.cmd === "/usr/bin/ffmpeg" ? (c.args.includes("pulse") ? "ffmpeg:pulse" : "ffmpeg:alsa") : c.cmd,
		);
		expect(labels).toEqual(["ffmpeg:pulse", "ffmpeg:alsa", "/usr/bin/paplay", "/usr/bin/aplay"]);
	});

	it("falls back to aplay raw when ffmpeg is absent on Linux", () => {
		const cmds = streamingPlayerCommandsFor("linux", 48_000, {
			which: bin => (bin === "aplay" ? "/usr/bin/aplay" : null),
			ffmpeg: () => null,
		});
		expect(cmds).toHaveLength(1);
		expect(cmds[0]?.cmd).toBe("/usr/bin/aplay");
		expect(cmds[0]?.args).toEqual(["-q", "-f", "FLOAT_LE", "-r", "48000", "-c", "1", "-"]);
	});

	it("encodes the chunk's sample rate into the command", () => {
		const cmds = streamingPlayerCommandsFor("linux", 16_000, { which: () => null, ffmpeg: () => "/usr/bin/ffmpeg" });
		expect(cmds[0]?.args).toContain("16000");
		expect(cmds[0]?.args).not.toContain("24000");
	});
});

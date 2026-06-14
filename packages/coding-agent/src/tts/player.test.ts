import { describe, expect, it } from "bun:test";
import { playerCommandsFor } from "./player";

describe("playerCommandsFor", () => {
	const noTools = { which: () => null, ffmpeg: () => null };

	it("uses the built-in afplay on darwin", () => {
		expect(playerCommandsFor("darwin", "/tmp/a.wav", noTools)).toEqual([{ cmd: "afplay", args: ["/tmp/a.wav"] }]);
	});

	it("uses PowerShell SoundPlayer on win32", () => {
		const cmds = playerCommandsFor("win32", "C:\\tmp\\a.wav", noTools);
		expect(cmds).toEqual([
			{
				cmd: "powershell",
				args: ["-NoProfile", "-Command", "(New-Object Media.SoundPlayer 'C:\\tmp\\a.wav').PlaySync()"],
			},
		]);
	});

	it("prefers paplay then aplay on linux", () => {
		const cmds = playerCommandsFor("linux", "/tmp/a.wav", {
			which: bin => (bin === "paplay" ? "/usr/bin/paplay" : bin === "aplay" ? "/usr/bin/aplay" : null),
			ffmpeg: () => null,
		});
		expect(cmds).toEqual([
			{ cmd: "/usr/bin/paplay", args: ["/tmp/a.wav"] },
			{ cmd: "/usr/bin/aplay", args: ["/tmp/a.wav"] },
		]);
	});

	it("skips missing players and keeps the ones present", () => {
		const cmds = playerCommandsFor("linux", "/tmp/a.wav", {
			which: bin => (bin === "aplay" ? "/usr/bin/aplay" : null),
			ffmpeg: () => null,
		});
		expect(cmds).toEqual([{ cmd: "/usr/bin/aplay", args: ["/tmp/a.wav"] }]);
	});

	it("falls back to the bundled ffmpeg (pulse then alsa) on linux", () => {
		const cmds = playerCommandsFor("linux", "/tmp/a.wav", {
			which: () => null,
			ffmpeg: () => "/tools/ffmpeg",
		});
		expect(cmds).toEqual([
			{
				cmd: "/tools/ffmpeg",
				args: ["-loglevel", "error", "-nostdin", "-i", "/tmp/a.wav", "-f", "pulse", "default"],
			},
			{
				cmd: "/tools/ffmpeg",
				args: ["-loglevel", "error", "-nostdin", "-i", "/tmp/a.wav", "-f", "alsa", "default"],
			},
		]);
	});

	it("returns no commands when no linux player is available", () => {
		expect(playerCommandsFor("linux", "/tmp/a.wav", noTools)).toEqual([]);
	});
});

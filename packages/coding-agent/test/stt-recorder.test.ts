import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startRecording } from "@oh-my-pi/pi-coding-agent/stt/recorder";
import * as toolsManager from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import * as piUtils from "@oh-my-pi/pi-utils";

let tmp = "";

async function installFakeFFmpeg(options: { demuxers: string; capture: string }): Promise<string> {
	const bin = path.join(tmp, "ffmpeg");
	const argsPath = path.join(tmp, "args.json");
	await Bun.write(
		bin,
		`#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args.includes("-demuxers")) {
	await Bun.write(Bun.stdout, ${JSON.stringify(options.demuxers)});
} else {
	await Bun.write(${JSON.stringify(argsPath)}, JSON.stringify(args));
	${options.capture}
}
`,
	);
	await fs.chmod(bin, 0o755);
	return bin;
}

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stt-recorder-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("Linux ffmpeg recording", () => {
	it("uses ALSA when ffmpeg has no PulseAudio demuxer", async () => {
		const bin = await installFakeFFmpeg({
			demuxers: " D d alsa            ALSA audio input\n",
			capture: "await Bun.stdin.text();",
		});
		vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "ffmpeg" ? bin : null));
		vi.spyOn(toolsManager, "getToolPath").mockReturnValue(bin);

		const recording = await startRecording(path.join(tmp, "recording.wav"));
		await recording.stop();

		const args = await Bun.file(path.join(tmp, "args.json")).text();
		expect(args).toContain('"-f","alsa","-i","default"');
		expect(args).not.toContain('"pulse"');
	});

	it("reports ffmpeg stderr when capture exits immediately", async () => {
		const bin = await installFakeFFmpeg({
			demuxers: " D d pulse           Pulse audio input\n D d alsa            ALSA audio input\n",
			capture: 'await Bun.write(Bun.stderr, "Unknown input format: pulse\\n"); process.exit(234);',
		});
		vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "ffmpeg" ? bin : null));
		vi.spyOn(toolsManager, "getToolPath").mockReturnValue(bin);

		await expect(startRecording(path.join(tmp, "recording.wav"))).rejects.toThrow(
			"ffmpeg exited immediately (code 234): Unknown input format: pulse",
		);
	});
});

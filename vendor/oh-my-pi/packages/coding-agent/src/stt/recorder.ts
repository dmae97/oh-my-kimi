import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, logger, Snowflake } from "@oh-my-pi/pi-utils";
import { $, type Subprocess } from "bun";
import { ensureTool, getToolPath } from "../utils/tools-manager";
import { decodePcmS16LE } from "./wav";

export interface RecordingHandle {
	stop(): Promise<void>;
}

const isWindows = process.platform === "win32";
const linuxFFmpegFormats = new Map<string, "pulse" | "alsa">();
const ffmpegCaptureFlags = ["-hide_banner", "-loglevel", "error", "-nostats"];

/**
 * Returns available recording tools in priority order.
 */
export function detectRecordingTools(): string[] {
	return [...new Set(detectRecorders().map(recorder => recorder.tool))];
}

// ── ffmpeg dshow device detection ──────────────────────────────────

async function detectWindowsAudioDevice(bin: string): Promise<string> {
	const result = await $`${bin} -f dshow -list_devices true -i dummy`.quiet().nothrow();
	const output = result.stderr.toString();
	const audioDevices: string[] = [];
	const re = /"([^"]+)"\s*\(audio\)/gi;
	for (const match of output.matchAll(re)) {
		audioDevices.push(match[1]);
	}
	if (audioDevices.length === 0) {
		throw new Error("No audio input device found via ffmpeg dshow. Ensure a microphone is connected.");
	}
	logger.debug("Detected dshow audio devices", { devices: audioDevices });
	return audioDevices[0];
}

async function ffmpegInputArgs(bin: string): Promise<string[]> {
	if (isWindows) {
		return ["-f", "dshow", "-i", `audio=${await detectWindowsAudioDevice(bin)}`];
	}
	if (process.platform === "darwin") {
		return ["-f", "avfoundation", "-i", ":default"];
	}

	let format = linuxFFmpegFormats.get(bin);
	if (!format) {
		const result = await $`${bin} -hide_banner -demuxers`.quiet().nothrow();
		if (result.exitCode !== 0) {
			const stderr = result.stderr.toString().trim();
			throw new Error(
				`Could not inspect ffmpeg input formats (code ${result.exitCode}): ${stderr || "(no output)"}`,
			);
		}
		const demuxers = result.stdout.toString();
		if (/^\s*D\s+(?:d\s+)?pulse(?:\s|$)/m.test(demuxers)) {
			format = "pulse";
		} else if (/^\s*D\s+(?:d\s+)?alsa(?:\s|$)/m.test(demuxers)) {
			format = "alsa";
		} else {
			throw new Error("ffmpeg supports neither PulseAudio nor ALSA input on Linux");
		}
		linuxFFmpegFormats.set(bin, format);
	}
	return ["-f", format, "-i", "default"];
}

// ── Recording implementations ──────────────────────────────────────

async function startSoxRecording(bin: string, outputPath: string): Promise<RecordingHandle> {
	// On Windows, "-d" (default device) often fails. Use "-t waveaudio 0" for the first input.
	const inputArgs = isWindows ? ["-t", "waveaudio", "0"] : ["-d"];

	const proc = Bun.spawn([bin, ...inputArgs, "-r", "16000", "-c", "1", "-b", "16", "-t", "wav", outputPath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await verifyProcessAlive(proc, "sox");
	return {
		async stop() {
			proc.kill("SIGTERM");
			await proc.exited;
		},
	};
}

async function startFFmpegRecording(bin: string, outputPath: string): Promise<RecordingHandle> {
	const args = [
		bin,
		...ffmpegCaptureFlags,
		...(await ffmpegInputArgs(bin)),
		"-ar",
		"16000",
		"-ac",
		"1",
		"-sample_fmt",
		"s16",
		"-y",
		outputPath,
	];

	const proc = Bun.spawn(args, {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	await verifyProcessAlive(proc, "ffmpeg");

	return {
		async stop() {
			try {
				proc.stdin.write("q");
				proc.stdin.end();
			} catch {
				// stdin may already be closed
			}
			const killTimer = setTimeout(() => proc.kill(), 3000);
			await proc.exited;
			clearTimeout(killTimer);
		},
	};
}

async function startArecordRecording(bin: string, outputPath: string): Promise<RecordingHandle> {
	const proc = Bun.spawn([bin, "-f", "S16_LE", "-r", "16000", "-c", "1", outputPath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await verifyProcessAlive(proc, "arecord");
	return {
		async stop() {
			proc.kill("SIGTERM");
			await proc.exited;
		},
	};
}

// ── PowerShell mci recorder (Windows zero-dep fallback) ────────────

const PS_RECORD_SCRIPT = `
param([string]$outPath)

if ($outPath -match '["\r\n]') {
    [Console]::Error.WriteLine("Invalid output path: $outPath")
    exit 1
}


Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class MciAudio {
    [DllImport("winmm.dll", CharSet=CharSet.Auto)]
    public static extern int mciSendString(
        string command, StringBuilder buffer, int bufferSize, IntPtr callback);
}
"@

function Mci([string]$cmd) {
    $buf = New-Object System.Text.StringBuilder 256
    $r = [MciAudio]::mciSendString($cmd, $buf, 256, [IntPtr]::Zero)
    if ($r -ne 0) {
        [Console]::Error.WriteLine("MCI error $r for: $cmd")
    }
    return $r
}

$r = Mci "open new type waveaudio alias omp_rec"
if ($r -ne 0) { exit 1 }

Mci "set omp_rec channels 1 samplespersec 16000 bitspersample 16"

$r = Mci "record omp_rec"
if ($r -ne 0) {
    Mci "close omp_rec"
    exit 1
}

Write-Output "RECORDING"
[Console]::Out.Flush()

# Block until parent closes stdin or writes a line
try { [Console]::In.ReadLine() | Out-Null } catch {}

# Stop and save
Mci "stop omp_rec"
$saveCmd = 'save omp_rec "' + $outPath + '"'
$r = Mci $saveCmd
if ($r -ne 0) {
    [Console]::Error.WriteLine("Save failed for: $saveCmd")
}
Mci "close omp_rec"

if (Test-Path $outPath) {
    Write-Output "SAVED"
} else {
    Write-Error "Output file was not created: $outPath"
    exit 1
}
`;

async function startPowerShellRecording(outputPath: string): Promise<RecordingHandle> {
	// Write script to temp file — avoids quoting/escaping issues with -Command
	const scriptPath = path.join(os.tmpdir(), `omp-stt-record-${Snowflake.next()}.ps1`);
	await Bun.write(scriptPath, PS_RECORD_SCRIPT);

	const proc = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, outputPath], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});

	proc.exited.then(() => {
		fs.unlink(scriptPath).catch(() => {});
	});

	// Wait for "RECORDING" on stdout to confirm it started
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let output = "";
	const deadline = Date.now() + 8000; // PowerShell + Add-Type is slow

	while (Date.now() < deadline) {
		const readPromise = reader.read();
		const timeoutPromise = Bun.sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined }));
		const { done, value } = await Promise.race([readPromise, timeoutPromise]);
		if (done || !value) break;
		output += decoder.decode(value, { stream: true });
		if (output.includes("RECORDING")) break;
	}
	reader.releaseLock();

	if (!output.includes("RECORDING")) {
		proc.kill();
		await proc.exited;
		let stderrText = "";
		if (proc.stderr && typeof proc.stderr !== "number") {
			stderrText = await new Response(proc.stderr as ReadableStream).text();
		}
		// Clean up temp script
		fs.unlink(scriptPath).catch(() => {});
		throw new Error(
			`PowerShell audio recording failed to start: ${stderrText.trim() || output.trim() || "(no output)"}`,
		);
	}

	return {
		async stop() {
			try {
				proc.stdin.write("stop\n");
				proc.stdin.end();
			} catch {
				// stdin may already be closed
			}
			// Give PowerShell time to save the file
			const killTimer = setTimeout(() => proc.kill(), 8000);
			await proc.exited;
			clearTimeout(killTimer);
			// Clean up temp script
			fs.unlink(scriptPath).catch(() => {});
		},
	};
}

// ── Health check ───────────────────────────────────────────────────

type RecorderProcess = Subprocess<"ignore" | "pipe", "pipe", "pipe">;

async function verifyProcessAlive(proc: RecorderProcess, tool: string): Promise<void> {
	await Bun.sleep(300);

	const exited = await Promise.race([proc.exited.then(code => code), Bun.sleep(0).then(() => "running" as const)]);
	if (exited === "running") {
		void proc.stderr.pipeTo(new WritableStream<Uint8Array>()).catch(() => {});
		return;
	}

	const stderr = await new Response(proc.stderr).text();
	throw new Error(`${tool} exited immediately (code ${exited}): ${stderr.trim() || "(no output)"}`);
}

// ── Public API ─────────────────────────────────────────────────────

export interface ResolvedRecorder {
	tool: "sox" | "ffmpeg" | "arecord" | "powershell";
	bin: string;
}

/**
 * Resolve a usable recorder without triggering any download. Priority:
 * sox (PATH) → ffmpeg (PATH or previously-downloaded static binary) →
 * arecord (PATH, non-Windows) → PowerShell mci fallback (Windows) → none.
 */
function detectRecorders(): ResolvedRecorder[] {
	const recorders: ResolvedRecorder[] = [];
	const sox = $which("sox");
	if (sox) recorders.push({ tool: "sox", bin: sox });

	const pathFfmpeg = $which("ffmpeg");
	if (pathFfmpeg) recorders.push({ tool: "ffmpeg", bin: pathFfmpeg });
	const bundledFfmpeg = getToolPath("ffmpeg");
	if (bundledFfmpeg && bundledFfmpeg !== pathFfmpeg) recorders.push({ tool: "ffmpeg", bin: bundledFfmpeg });

	if (!isWindows) {
		const arecord = $which("arecord");
		if (arecord) recorders.push({ tool: "arecord", bin: arecord });
	}

	if (isWindows) recorders.push({ tool: "powershell", bin: "powershell" });
	return recorders;
}

export function detectRecorder(): ResolvedRecorder | null {
	return detectRecorders()[0] ?? null;
}

/**
 * Ensure a recorder is available, downloading the static ffmpeg binary when
 * nothing is already present. Returns the resolved recorder.
 */
export async function ensureRecorder(
	onProgress?: (p: { stage: string; percent?: number }) => void,
	signal?: AbortSignal,
): Promise<ResolvedRecorder> {
	const existing = detectRecorder();
	if (existing) return existing;

	const bin = await ensureTool("ffmpeg", { signal, notify: m => onProgress?.({ stage: m }) });
	if (bin) return { tool: "ffmpeg", bin };

	if (isWindows) return { tool: "powershell", bin: "powershell" };

	throw new Error(
		"No audio recorder available and automatic ffmpeg download failed. " +
			"Install SoX or FFmpeg manually and add it to PATH.",
	);
}

function recorderFailure(recorder: ResolvedRecorder, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `${recorder.tool} (${recorder.bin}): ${message}`;
}

async function startRecordingWithRecorder(recorder: ResolvedRecorder, outputPath: string): Promise<RecordingHandle> {
	logger.debug("Starting audio recording", { tool: recorder.tool, bin: recorder.bin, outputPath });
	switch (recorder.tool) {
		case "sox":
			return startSoxRecording(recorder.bin, outputPath);
		case "ffmpeg":
			return startFFmpegRecording(recorder.bin, outputPath);
		case "arecord":
			return startArecordRecording(recorder.bin, outputPath);
		case "powershell":
			return startPowerShellRecording(outputPath);
	}
}

export async function startRecording(outputPath: string): Promise<RecordingHandle> {
	const recorders = detectRecorders();
	if (recorders.length === 0) {
		throw new Error("No audio recorder available — run `omp setup speech`");
	}

	const failures: string[] = [];
	for (const recorder of recorders) {
		try {
			return await startRecordingWithRecorder(recorder, outputPath);
		} catch (error) {
			const failure = recorderFailure(recorder, error);
			failures.push(failure);
			logger.warn("STT recorder failed to start; trying fallback", {
				recorder: recorder.tool,
				bin: recorder.bin,
				error: failure,
			});
		}
	}
	throw new Error(`No audio recorder could start — run \`omp setup speech\`.\n${failures.join("\n")}`);
}

/**
 * Verify a recorded audio file is usable.
 * Returns the file size in bytes, or throws.
 */
export async function verifyRecordingFile(filePath: string): Promise<number> {
	try {
		const stat = await fs.stat(filePath);
		if (stat.size < 100) {
			throw new Error(
				`Recording file is too small (${stat.size} bytes) — audio may not have been captured. ` +
					"Check that a microphone is connected and permissions are granted.",
			);
		}
		return stat.size;
	} catch (err) {
		if (err instanceof Error && err.message.includes("too small")) throw err;
		throw new Error(
			"Recording file was not created. The recording process may have failed silently. " +
				"Check that a microphone is connected.",
		);
	}
}

// ── Streaming (live) capture ───────────────────────────────────────

export interface StreamingRecordingHandle {
	stop(): Promise<void>;
}

/** Build the argv for a recorder that emits raw 16 kHz mono s16le PCM to stdout. */
async function streamingRecorderArgs(recorder: ResolvedRecorder): Promise<string[]> {
	const { tool, bin } = recorder;
	switch (tool) {
		case "sox": {
			const input = isWindows ? ["-t", "waveaudio", "0"] : ["-d"];
			return [bin, ...input, "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw", "-"];
		}
		case "arecord":
			return [bin, "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-"];
		case "ffmpeg": {
			return [
				bin,
				...ffmpegCaptureFlags,
				...(await ffmpegInputArgs(bin)),
				"-ar",
				"16000",
				"-ac",
				"1",
				"-f",
				"s16le",
				"pipe:1",
			];
		}
		case "powershell":
			throw new Error("PowerShell recorder cannot stream PCM to a pipe");
	}
}

/**
 * Start a recorder that streams raw 16 kHz mono s16le PCM to stdout, decoding it
 * to float frames delivered through `onAudio` as they arrive. Returns `null`
 * when the only available recorder (Windows PowerShell mci) records to a file
 * and cannot pipe — the caller then falls back to file-based batch capture.
 */
async function startStreamingRecordingWithRecorder(
	recorder: ResolvedRecorder,
	onAudio: (samples: Float32Array) => void,
): Promise<StreamingRecordingHandle> {
	const args = await streamingRecorderArgs(recorder);
	logger.debug("Starting streaming audio recording", { tool: recorder.tool, bin: recorder.bin });
	const proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });

	// Read s16le bytes off stdout, carrying any trailing odd byte across chunk
	// boundaries so a sample is never split. Runs until the process closes stdout.
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	let leftover: Uint8Array | null = null;
	const pump = async (): Promise<void> => {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value || value.length === 0) continue;
				let bytes = value;
				if (leftover) {
					const merged = new Uint8Array(leftover.length + value.length);
					merged.set(leftover, 0);
					merged.set(value, leftover.length);
					bytes = merged;
					leftover = null;
				}
				const usable = bytes.length - (bytes.length % 2);
				if (usable < bytes.length) leftover = bytes.slice(usable);
				if (usable > 0) onAudio(decodePcmS16LE(bytes.subarray(0, usable)));
			}
		} catch (error) {
			logger.debug("stt: streaming recorder read ended", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	void pump();

	try {
		await verifyProcessAlive(proc, recorder.tool);
	} catch (error) {
		try {
			proc.kill("SIGKILL");
		} catch {
			// Already gone.
		}
		throw error;
	}

	let stopped = false;
	return {
		async stop() {
			if (stopped) return;
			stopped = true;
			if (recorder.tool === "ffmpeg") {
				try {
					proc.stdin.write("q");
					proc.stdin.end();
				} catch {
					// stdin may already be closed.
				}
				const killTimer = setTimeout(() => proc.kill(), 3000);
				await proc.exited;
				clearTimeout(killTimer);
			} else {
				proc.kill("SIGTERM");
				await proc.exited;
			}
			try {
				await reader.cancel();
			} catch {
				// Reader already released when stdout closed.
			}
		},
	};
}

export async function startStreamingRecording(
	onAudio: (samples: Float32Array) => void,
): Promise<StreamingRecordingHandle | null> {
	const recorders = detectRecorders();
	if (recorders.length === 0) {
		throw new Error("No audio recorder available — run `omp setup speech`");
	}
	const streamingRecorders = recorders.filter(recorder => recorder.tool !== "powershell");
	if (streamingRecorders.length === 0) return null;

	const failures: string[] = [];
	for (const recorder of streamingRecorders) {
		try {
			return await startStreamingRecordingWithRecorder(recorder, onAudio);
		} catch (error) {
			const failure = recorderFailure(recorder, error);
			failures.push(failure);
			logger.warn("STT streaming recorder failed to start; trying fallback", {
				recorder: recorder.tool,
				bin: recorder.bin,
				error: failure,
			});
		}
	}
	throw new Error(`No streaming audio recorder could start.\n${failures.join("\n")}`);
}

/**
 * Cross-platform audio-file playback via the system's built-in players.
 *
 * The selection logic is split into a pure, injectable builder
 * ({@link playerCommandsFor}) so it can be unit-tested without spawning a
 * process or touching PATH, and a thin runtime wrapper ({@link playAudioFile})
 * that walks the resulting fallback chain.
 */
import * as fs from "node:fs/promises";
import { $which } from "@oh-my-pi/pi-utils";
import { getToolPath } from "../utils/tools-manager";

export interface PlayerCommand {
	cmd: string;
	args: string[];
}

/** Injection seam for {@link playerCommandsFor} — defaults to real PATH/tools lookups. */
export interface PlayerLookup {
	which?: (bin: string) => string | null;
	ffmpeg?: () => string | null;
}

/**
 * Build the ordered list of playback commands to try for `filePath` on the
 * given platform. Pure + injectable so the selection logic is testable without
 * spawning anything.
 *
 * - darwin: `afplay` (always present on macOS).
 * - win32: PowerShell `Media.SoundPlayer.PlaySync()` (no extra deps).
 * - linux/other POSIX: `paplay` (PulseAudio) → `aplay` (ALSA) → the bundled
 *   static `ffmpeg` (`-f pulse` then `-f alsa`). Empty result means nothing is
 *   available and the caller should surface an install hint.
 */
export function playerCommandsFor(
	platform: NodeJS.Platform,
	filePath: string,
	lookup: PlayerLookup = {},
): PlayerCommand[] {
	const which = lookup.which ?? $which;
	const ffmpeg = lookup.ffmpeg ?? ((): string | null => getToolPath("ffmpeg"));

	if (platform === "darwin") {
		return [{ cmd: "afplay", args: [filePath] }];
	}
	if (platform === "win32") {
		return [
			{
				cmd: "powershell",
				args: ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${filePath}').PlaySync()`],
			},
		];
	}

	// Linux and other POSIX desktops share the PulseAudio/ALSA fallback chain.
	const commands: PlayerCommand[] = [];
	const paplay = which("paplay");
	if (paplay) commands.push({ cmd: paplay, args: [filePath] });
	const aplay = which("aplay");
	if (aplay) commands.push({ cmd: aplay, args: [filePath] });
	const ffmpegBin = ffmpeg();
	if (ffmpegBin) {
		commands.push({
			cmd: ffmpegBin,
			args: ["-loglevel", "error", "-nostdin", "-i", filePath, "-f", "pulse", "default"],
		});
		commands.push({
			cmd: ffmpegBin,
			args: ["-loglevel", "error", "-nostdin", "-i", filePath, "-f", "alsa", "default"],
		});
	}
	return commands;
}

export interface PlayAudioOptions {
	signal?: AbortSignal;
}

function playbackAbortError(signal: AbortSignal): Error {
	const reason = signal.reason;
	return reason instanceof Error ? reason : new DOMException("Audio playback aborted", "AbortError");
}

/**
 * Play `filePath` through the speakers, trying each candidate command in order
 * and returning on the first clean exit. Throws an actionable Error if no
 * player exists or every candidate fails (with the collected stderr).
 */
export async function playAudioFile(filePath: string, options: PlayAudioOptions = {}): Promise<void> {
	const { signal } = options;
	if (signal?.aborted) throw playbackAbortError(signal);
	const commands = playerCommandsFor(process.platform, filePath);
	if (commands.length === 0) {
		throw new Error(
			"No audio player available. Install PulseAudio (paplay) or ALSA (aplay), " +
				"or run `omp setup speech` to download a bundled ffmpeg.",
		);
	}

	const failures: string[] = [];
	for (const command of commands) {
		if (signal?.aborted) throw playbackAbortError(signal);
		try {
			const proc = Bun.spawn([command.cmd, ...command.args], { stdout: "ignore", stderr: "pipe" });
			let killTimer: NodeJS.Timeout | undefined;
			const abort = (): void => {
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => proc.kill("SIGKILL"), 500);
				killTimer.unref?.();
			};
			signal?.addEventListener("abort", abort, { once: true });
			try {
				const code = await proc.exited;
				if (signal?.aborted) throw playbackAbortError(signal);
				if (code === 0) return;
				let stderr = "";
				if (proc.stderr && typeof proc.stderr !== "number") {
					stderr = await new Response(proc.stderr as ReadableStream).text();
				}
				failures.push(`${command.cmd} exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
			} finally {
				signal?.removeEventListener("abort", abort);
				if (killTimer) clearTimeout(killTimer);
			}
		} catch (err) {
			if (signal?.aborted) throw playbackAbortError(signal);
			failures.push(`${command.cmd}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	throw new Error(`Audio playback failed:\n${failures.join("\n")}`);
}

/** Best-effort temp-file cleanup used by callers after playback. */
export async function removeTempFile(filePath: string): Promise<void> {
	await fs.unlink(filePath).catch(() => {});
}

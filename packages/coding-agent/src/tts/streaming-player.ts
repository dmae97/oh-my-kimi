/**
 * Gapless streaming audio output for assistant speech.
 *
 * Replaces the spawn-`afplay`-per-sentence approach (a fresh process per chunk
 * meant audible gaps, per-spawn latency, and no way to interrupt a clip mid-play)
 * with a single persistent player process fed raw 32-bit-float mono PCM over
 * stdin. Chunks are queued and drained by one writer so segments play back to
 * back; writes are paced to stay only {@link LEAD_SECONDS} ahead of realtime so
 * ducking and stop take effect promptly instead of after seconds of buffered
 * audio. {@link StreamingAudioPlayer.stop} kills the process for instant silence.
 *
 * Where no streaming backend exists (Windows, or a host without ffmpeg/sox), it
 * degrades to the per-file {@link playAudioFile} path so speech still works —
 * just without gapless playback or mid-clip interruption. A backend that spawns
 * but dies early (e.g. an ffmpeg built without its platform audio device) is
 * detected via its exit and the session downgrades to per-file playback without
 * dropping the chunk being played.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { FileSink, Subprocess } from "bun";
import { getToolPath } from "../utils/tools-manager";
import { type PlayerCommand, playAudioFile } from "./player";
import { encodeWav } from "./wav";

/** Kokoro emits 24 kHz mono; used when a chunk does not declare a rate. */
const DEFAULT_SAMPLE_RATE = 24_000;
/** Cap how far ahead of realtime we buffer into the player so duck/stop are responsive. */
const LEAD_SECONDS = 0.6;
/** Output gain applied while ducked (the user is speaking over the assistant). */
export const DUCK_GAIN = 0.25;

/** Injection seam for {@link streamingPlayerCommandsFor} — defaults to real PATH/tools lookups. */
export interface StreamingPlayerLookup {
	which?: (bin: string) => string | null;
	ffmpeg?: () => string | null;
}

/**
 * Ordered candidate commands for a persistent raw-PCM player on `platform`: each
 * reads 32-bit-float little-endian mono PCM at `sampleRate` from stdin (`pipe:0`)
 * and plays it to the default output device. An empty list means no streaming
 * backend is available and the caller should fall back to per-file playback.
 *
 * - darwin: `ffmpeg` (AudioToolbox output device) → sox's `play` (coreaudio).
 * - linux/other POSIX: `ffmpeg` (`-f pulse` then `-f alsa`) → `paplay`/`aplay`
 *   raw fallbacks.
 * - win32: none (PowerShell `SoundPlayer` is file-only).
 */
export function streamingPlayerCommandsFor(
	platform: NodeJS.Platform,
	sampleRate: number,
	lookup: StreamingPlayerLookup = {},
): PlayerCommand[] {
	const which = lookup.which ?? $which;
	const ffmpeg = lookup.ffmpeg ?? ((): string | null => getToolPath("ffmpeg"));
	const rate = String(sampleRate > 0 ? sampleRate : DEFAULT_SAMPLE_RATE);
	const input = ["-loglevel", "error", "-nostdin", "-f", "f32le", "-ar", rate, "-ac", "1", "-i", "pipe:0"];

	if (platform === "darwin") {
		const commands: PlayerCommand[] = [];
		const ffmpegBin = ffmpeg();
		if (ffmpegBin) commands.push({ cmd: ffmpegBin, args: [...input, "-f", "audiotoolbox", "default"] });
		const play = which("play");
		if (play) {
			commands.push({
				cmd: play,
				args: ["-q", "-t", "raw", "-e", "floating-point", "-b", "32", "-r", rate, "-c", "1", "-"],
			});
		}
		return commands;
	}
	if (platform === "win32") {
		return [];
	}

	const commands: PlayerCommand[] = [];
	const ffmpegBin = ffmpeg();
	if (ffmpegBin) {
		commands.push({ cmd: ffmpegBin, args: [...input, "-f", "pulse", "default"] });
		commands.push({ cmd: ffmpegBin, args: [...input, "-f", "alsa", "default"] });
	}
	const paplay = which("paplay");
	if (paplay) commands.push({ cmd: paplay, args: ["--raw", `--rate=${rate}`, "--format=float32le", "--channels=1"] });
	const aplay = which("aplay");
	if (aplay) commands.push({ cmd: aplay, args: ["-q", "-f", "FLOAT_LE", "-r", rate, "-c", "1", "-"] });
	return commands;
}

/**
 * Single-session gapless player. Lifecycle: {@link start} once, {@link write}
 * chunks in order, then {@link end} to drain or {@link stop} to abort. Not
 * reusable after stop/end — create a new instance per utterance.
 */
export class StreamingAudioPlayer {
	#queue: Float32Array[] = [];
	#sampleRate = DEFAULT_SAMPLE_RATE;
	#gain = 1;
	#mode: "stream" | "file" = "file";
	#proc: Subprocess<"pipe", "ignore", "ignore"> | null = null;
	#sink: FileSink | null = null;
	/** Streaming backends not yet tried; consumed head-first by {@link #spawnStream}. */
	#candidates: PlayerCommand[] | null = null;
	#writtenSec = 0;
	#startedAt = 0;
	#started = false;
	#inputClosed = false;
	#stopped = false;
	#abortController = new AbortController();
	#wake: (() => void) | null = null;
	#drain: Promise<void> = Promise.resolve();

	/** Pick a backend and begin draining. Idempotent; the first call's rate wins. */
	start(sampleRate: number): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		this.#sampleRate = sampleRate > 0 ? sampleRate : DEFAULT_SAMPLE_RATE;
		this.#mode = this.#spawnStream() ? "stream" : "file";
		this.#startedAt = performance.now();
		this.#drain = this.#drainLoop();
	}

	/** Queue a mono float32 PCM chunk for playback in arrival order. */
	write(pcm: Float32Array): void {
		if (this.#stopped) return;
		this.#queue.push(pcm);
		this.#signal();
	}

	/** Scale subsequent output (1 = normal, <1 = ducked). Applies within {@link LEAD_SECONDS}. */
	setGain(gain: number): void {
		this.#gain = gain < 0 ? 0 : gain;
	}

	/** Close the input; resolves once all queued audio has finished playing. */
	async end(): Promise<void> {
		this.#inputClosed = true;
		this.#signal();
		await this.#drain;
	}

	/** Stop immediately: kill the player, drop everything still queued. */
	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#queue.length = 0;
		this.#abortController.abort();
		this.#signal();
		try {
			// end() flushes asynchronously; the SIGKILL below races it, so a broken
			// pipe here is expected — swallow the rejection (it otherwise surfaces
			// as an unhandled EPIPE right as speech ends).
			void Promise.resolve(this.#sink?.end()).catch(() => {});
		} catch {}
		try {
			this.#proc?.kill("SIGKILL");
		} catch {}
	}

	/**
	 * Spawn the next untried streaming backend; false once the list is
	 * exhausted. A backend that spawns but dies early (e.g. an ffmpeg built
	 * without this platform's audio output device) would otherwise swallow PCM
	 * into a dead pipe, so its exit advances to the next candidate — or to
	 * per-file playback — and #writeStream's failure path replays the
	 * in-flight chunk.
	 */
	#spawnStream(): boolean {
		this.#candidates ??= streamingPlayerCommandsFor(process.platform, this.#sampleRate);
		for (let command = this.#candidates.shift(); command; command = this.#candidates.shift()) {
			const { cmd, args } = command;
			try {
				const proc = Bun.spawn([cmd, ...args], {
					stdin: "pipe",
					stdout: "ignore",
					stderr: "ignore",
				});
				this.#proc = proc;
				this.#sink = proc.stdin;
				void proc.exited.then(code => {
					if (this.#proc !== proc || this.#stopped || this.#inputClosed) return;
					logger.debug("tts: streaming backend exited early; trying next backend", { cmd, code });
					this.#proc = null;
					this.#sink = null;
					this.#mode = this.#spawnStream() ? "stream" : "file";
				});
				return true;
			} catch (error) {
				logger.debug("tts: streaming player spawn failed", {
					cmd,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return false;
	}

	#signal(): void {
		const wake = this.#wake;
		this.#wake = null;
		wake?.();
	}

	async #drainLoop(): Promise<void> {
		try {
			while (!this.#stopped) {
				const chunk = this.#queue.shift();
				if (!chunk) {
					if (this.#inputClosed) break;
					await this.#waitForWork();
					continue;
				}
				if (this.#mode === "stream") {
					// Pace writes so the player buffers ~LEAD_SECONDS, no more, keeping
					// ducking and stop responsive instead of locked behind buffered audio.
					const ahead = this.#writtenSec - (performance.now() - this.#startedAt) / 1000;
					if (ahead > LEAD_SECONDS) {
						await Bun.sleep((ahead - LEAD_SECONDS) * 1000);
						if (this.#stopped) return;
					}
					if (await this.#writeStream(chunk)) {
						this.#writtenSec += chunk.length / this.#sampleRate;
						continue;
					}
					// Backend died mid-write: move to the next streaming candidate
					// (or the file path) and replay this exact chunk so nothing is
					// dropped.
					this.#mode = this.#spawnStream() ? "stream" : "file";
					if (this.#mode === "stream" && (await this.#writeStream(chunk))) {
						this.#writtenSec += chunk.length / this.#sampleRate;
					} else {
						this.#mode = "file";
						await this.#playFile(chunk);
					}
				} else {
					await this.#playFile(chunk);
				}
			}
			if (!this.#stopped && this.#mode === "stream") {
				try {
					await this.#sink?.end();
				} catch {}
				if (this.#proc) {
					try {
						await this.#proc.exited;
					} catch {}
				}
			}
		} catch (error) {
			logger.debug("tts: streaming player drain failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Block until a chunk is queued, the input closes, or stop is called. */
	#waitForWork(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#wake = resolve;
		// Re-check after arming to close the gap between the empty shift and here.
		if (this.#queue.length > 0 || this.#inputClosed || this.#stopped) {
			this.#wake = null;
			resolve();
		}
		return promise;
	}

	/**
	 * Write one chunk into the backend's stdin and await the flush — a broken
	 * pipe rejects here (not as an unhandled rejection later), so the caller
	 * can replay the exact chunk on the next backend.
	 */
	async #writeStream(pcm: Float32Array): Promise<boolean> {
		const sink = this.#sink;
		if (!sink) return false;
		try {
			sink.write(this.#bytes(pcm));
			await sink.flush();
			return true;
		} catch (error) {
			logger.debug("tts: streaming write failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	async #playFile(pcm: Float32Array): Promise<void> {
		const wavPath = path.join(os.tmpdir(), `omp-speech-${Snowflake.next()}.wav`);
		try {
			await fs.writeFile(wavPath, encodeWav(this.#scaled(pcm), this.#sampleRate));
			if (!this.#stopped) await playAudioFile(wavPath, { signal: this.#abortController.signal });
		} catch (error) {
			logger.debug("tts: file playback failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			await fs.unlink(wavPath).catch(() => {});
		}
	}

	/** Raw f32le bytes for the stream sink, applying gain only when ducked (avoids a copy at unity). */
	#bytes(pcm: Float32Array): Uint8Array {
		if (this.#gain === 1) return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		return new Uint8Array(this.#scaled(pcm).buffer);
	}

	#scaled(pcm: Float32Array): Float32Array {
		if (this.#gain === 1) return pcm;
		const out = new Float32Array(pcm.length);
		for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) * this.#gain;
		return out;
	}
}

/** Factory the vocalizer calls; a function so tests can stub it without spawning a player. */
export function createStreamingPlayer(): StreamingAudioPlayer {
	return new StreamingAudioPlayer();
}

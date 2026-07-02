/**
 * Streaming assistant speech-vocalization.
 *
 * The vocalizer turns the assistant's STREAMING output into spoken audio as a
 * side effect of the normal turn. Text deltas run through a
 * {@link SpeakableStream} — which drops code/tables/markup, speaks link labels
 * and URL hosts instead of raw URLs, and cuts speakable segments the moment a
 * boundary appears — and each ready segment is pushed to the TTS worker, which
 * synthesizes it into one audio chunk. A single {@link StreamingAudioPlayer}
 * plays the chunks back gaplessly, so the assistant starts speaking the first
 * clause while later sentences are still being generated.
 *
 * An idle timer covers generation stalls: when no delta arrives for
 * {@link IDLE_FLUSH_MS} (tool call, thinking block) the buffered partial
 * sentence is spoken rather than held silent.
 *
 * Overspeech control:
 * - {@link clear} stops playback instantly (kills the player) and aborts
 *   in-flight synthesis — wired to a new turn, an Esc/Ctrl+C interrupt, and a
 *   sent message.
 * - {@link duck}/{@link unduck} lower/restore the volume while the user is
 *   speaking (push-to-talk), so the assistant doesn't talk over them.
 * - Sessions are chained, so sequential utterances queue and drain in order
 *   rather than overlapping.
 *
 * Errors are swallowed (debug-logged) so a synthesis or playback failure never
 * throws into the turn. A process-level singleton ({@link vocalizer}) is shared
 * by the event controller (streaming deltas) and the ask tool (spoken questions).
 */
import { logger } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import { DEFAULT_TTS_VOICE } from "./models";
import { SpeakableStream } from "./speakable";
import { createStreamingPlayer, DUCK_GAIN } from "./streaming-player";
import { type TtsStreamHandle, ttsClient } from "./tts-client";

/** Quiet time on the delta stream before the buffered partial is spoken. */
const IDLE_FLUSH_MS = 1000;

export interface VocalizerPlayer {
	start(sampleRate: number): void;
	write(pcm: Float32Array): void;
	setGain(gain: number): void;
	end(): Promise<void>;
	stop(): void;
}

export class Vocalizer {
	/** Open stream session for the current utterance; null when none is active. */
	#handle: TtsStreamHandle | null = null;
	/** Markdown → speakable-segment transform for the current utterance. */
	#speakable: SpeakableStream | null = null;
	/** Fires when the delta stream goes quiet mid-sentence; speaks the partial. */
	#idleTimer: NodeJS.Timeout | null = null;
	/** Aborts the in-flight session on {@link clear}; replaced per session. */
	#abort: AbortController | null = null;
	/** The current session's player; stopped on {@link clear}, gain-tracked for ducking. */
	#player: VocalizerPlayer | null = null;
	/** Serialized playback chain across sessions; awaited by {@link idle}. */
	#chain: Promise<void> = Promise.resolve();
	/** Whether the user is currently speaking; new sessions open ducked. */
	#ducked = false;
	#createPlayer: () => VocalizerPlayer;

	constructor(createPlayer: () => VocalizerPlayer = createStreamingPlayer) {
		this.#createPlayer = createPlayer;
	}

	/**
	 * Stream a delta of assistant text into the pipeline. No-op when
	 * vocalization is disabled. The synthesis session (worker, player) is only
	 * opened once the first speakable segment exists, so a reply that
	 * normalizes to silence (pure code, tables, URLs) costs nothing. The
	 * trailing partial is flushed by {@link flush} or the idle timer.
	 */
	pushDelta(text: string): void {
		if (!settings.get("speech.enabled")) return;
		if (!text) return;
		this.#speakable ??= new SpeakableStream();
		this.#pushSegments(this.#speakable.push(text));
		this.#armIdleFlush(this.#speakable);
	}

	/**
	 * Close the current input stream (call at message/turn end). Drains the
	 * trailing partial as final segments; the player keeps draining queued
	 * audio until it completes.
	 */
	flush(): void {
		this.#clearIdleTimer();
		const speakable = this.#speakable;
		this.#speakable = null;
		if (speakable) this.#pushSegments(speakable.flush());
		this.#handle?.end();
		this.#handle = null;
	}

	/**
	 * Speak a complete piece of text in one shot (ask questions, yield-mode final
	 * message): stream it in and immediately close the input. No-op when disabled.
	 */
	speak(text: string): void {
		this.pushDelta(text);
		this.flush();
	}

	/**
	 * Interrupt and drop the current session, killing in-flight playback and
	 * synthesis (new turn / user message / Esc interrupt). Audio stops at once.
	 */
	clear(): void {
		this.#clearIdleTimer();
		this.#speakable = null;
		this.#handle = null;
		this.#abort?.abort();
		this.#abort = null;
		this.#player?.stop();
		this.#player = null;
	}

	/** Lower the volume while the user is speaking (push-to-talk), so speech doesn't drown them out. */
	duck(): void {
		this.#ducked = true;
		this.#player?.setGain(DUCK_GAIN);
	}

	/** Restore full volume once the user stops speaking. */
	unduck(): void {
		this.#ducked = false;
		this.#player?.setGain(1);
	}

	/** Resolve once the playback chain has drained (tests / shutdown). */
	idle(): Promise<void> {
		return this.#chain;
	}

	/** Feed ready segments to the synthesizer, opening the session lazily. */
	#pushSegments(segments: string[]): void {
		if (segments.length === 0) return;
		const handle = this.#ensureSession();
		for (const segment of segments) handle.push(segment);
	}

	/**
	 * Open a streaming-synthesis session lazily on the first speakable segment
	 * and chain its playback after any prior session's, so sequential
	 * utterances never overlap.
	 */
	#ensureSession(): TtsStreamHandle {
		if (this.#handle) return this.#handle;
		const modelKey = settings.get("tts.localModel");
		const voice = settings.get("speech.voice") || DEFAULT_TTS_VOICE;
		const abort = new AbortController();
		this.#abort = abort;
		const handle = ttsClient.synthesizeStream(modelKey, { voice, signal: abort.signal });
		this.#handle = handle;
		const player = this.#createPlayer();
		player.setGain(this.#ducked ? DUCK_GAIN : 1);
		this.#player = player;
		this.#chain = this.#chain.then(() => this.#play(handle, player, abort.signal));
		return handle;
	}

	/**
	 * (Re)arm the stall timer: if no delta arrives for {@link IDLE_FLUSH_MS},
	 * speak the buffered partial sentence instead of holding it through a tool
	 * call or thinking block. No-op by the time it fires if the utterance moved on.
	 */
	#armIdleFlush(speakable: SpeakableStream): void {
		this.#clearIdleTimer();
		const timer = setTimeout(() => {
			this.#idleTimer = null;
			if (this.#speakable !== speakable) return;
			this.#pushSegments(speakable.flushIdle());
		}, IDLE_FLUSH_MS);
		timer.unref?.();
		this.#idleTimer = timer;
	}

	#clearIdleTimer(): void {
		if (this.#idleTimer === null) return;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = null;
	}

	/** Feed each synthesized sentence into the player in arrival order; abort stops it. */
	async #play(handle: TtsStreamHandle, player: VocalizerPlayer, signal: AbortSignal): Promise<void> {
		let started = false;
		try {
			for await (const chunk of handle.chunks) {
				if (signal.aborted) break;
				if (!started) {
					player.start(chunk.sampleRate);
					started = true;
				}
				player.write(chunk.pcm);
			}
			if (started && !signal.aborted) {
				await player.end();
				return;
			}
		} catch (error) {
			logger.debug("vocalizer: stream failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		player.stop();
	}
}

/** Process-level vocalizer shared by the event controller and the ask tool. */
export const vocalizer = new Vocalizer();

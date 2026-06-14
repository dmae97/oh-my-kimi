import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "../config/settings";
import { DUCK_GAIN } from "./streaming-player";
import { type TtsAudioChunk, type TtsStreamOptions, ttsClient } from "./tts-client";
import { Vocalizer, type VocalizerPlayer } from "./vocalizer";

// Exercises the streaming contract: the vocalizer feeds assistant deltas
// straight into the engine's incremental text input (`synthesizeStream`) instead
// of pre-chunking in JS, so sentence segmentation lives in the worker. We spy
// `ttsClient.synthesizeStream` to observe the text pushed in, the input close,
// and the model/voice the session opens with, and drive the returned chunk
// iterator to assert ordered playback — no real worker, no audio device.
class FakePlayer implements VocalizerPlayer {
	starts: number[] = [];
	writes: Float32Array[] = [];
	gains: number[] = [];
	ended = false;
	stopped = false;

	start(sampleRate: number): void {
		this.starts.push(sampleRate);
	}

	write(pcm: Float32Array): void {
		this.writes.push(pcm);
	}

	setGain(gain: number): void {
		this.gains.push(gain);
	}

	async end(): Promise<void> {
		this.ended = true;
	}

	stop(): void {
		this.stopped = true;
	}
}

describe("vocalizer streaming", () => {
	let stream: Mock<typeof ttsClient.synthesizeStream>;
	let audio: TtsAudioChunk[];
	let vocalizer: Vocalizer;
	const probe: { pushed: string[]; ended: boolean; modelKey?: string; options?: TtsStreamOptions } = {
		pushed: [],
		ended: false,
	};
	const players: FakePlayer[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		settings.override("speech.enabled", true);
		settings.override("speech.voice", "af_heart");
		settings.override("tts.localModel", "kokoro");
		audio = [];
		players.length = 0;
		probe.pushed = [];
		probe.ended = false;
		probe.modelKey = undefined;
		probe.options = undefined;
		vocalizer = new Vocalizer(() => {
			const player = new FakePlayer();
			players.push(player);
			return player;
		});
		stream = spyOn(ttsClient, "synthesizeStream").mockImplementation((modelKey, options) => {
			probe.modelKey = modelKey;
			probe.options = options;
			async function* chunks(): AsyncIterableIterator<TtsAudioChunk> {
				for (const chunk of audio) yield chunk;
			}
			return {
				push: (text: string) => {
					probe.pushed.push(text);
				},
				end: () => {
					probe.ended = true;
				},
				chunks: chunks(),
			};
		});
		vocalizer.clear();
	});

	afterEach(() => {
		stream.mockRestore();
		vocalizer.clear();
		resetSettingsForTest();
	});

	it("streams deltas straight into the engine and closes the input on flush", async () => {
		vocalizer.pushDelta("Hello wor");
		vocalizer.pushDelta("ld. How are you?");
		vocalizer.flush();
		await vocalizer.idle();
		expect(stream).toHaveBeenCalledTimes(1);
		expect(probe.pushed).toEqual(["Hello wor", "ld. How are you?"]);
		expect(probe.ended).toBe(true);
	});

	it("opens the stream with the configured local model and speech voice", async () => {
		settings.override("speech.voice", "am_michael");
		vocalizer.speak("Ready now.");
		await vocalizer.idle();
		expect(probe.modelKey).toBe("kokoro");
		expect(probe.options?.voice).toBe("am_michael");
		expect(probe.pushed).toEqual(["Ready now."]);
		expect(probe.ended).toBe(true);
	});

	it("plays each synthesized sentence chunk in arrival order", async () => {
		audio = [
			{ index: 0, text: "one. ", pcm: new Float32Array([0]), sampleRate: 24_000 },
			{ index: 1, text: "two.", pcm: new Float32Array([1]), sampleRate: 24_000 },
		];
		vocalizer.speak("one. two.");
		await vocalizer.idle();
		expect(players).toHaveLength(1);
		expect(players[0]?.starts).toEqual([24_000]);
		expect(players[0]?.writes.map(chunk => Array.from(chunk))).toEqual([[0], [1]]);
		expect(players[0]?.ended).toBe(true);
	});

	it("stops playback when cleared", async () => {
		audio = [{ index: 0, text: "one.", pcm: new Float32Array([0]), sampleRate: 24_000 }];
		vocalizer.speak("one.");
		await vocalizer.idle();
		vocalizer.clear();
		expect(players[0]?.stopped).toBe(true);
	});

	it("ducks the active player while the user speaks and restores afterward", async () => {
		vocalizer.pushDelta("Talking over me.");
		expect(players[0]?.gains).toEqual([1]);
		vocalizer.duck();
		vocalizer.unduck();
		expect(players[0]?.gains).toEqual([1, DUCK_GAIN, 1]);
		vocalizer.flush();
		await vocalizer.idle();
	});

	it("opens a new session ducked while the user is still speaking", async () => {
		vocalizer.duck();
		vocalizer.pushDelta("Should start quiet.");
		expect(players[0]?.gains).toEqual([DUCK_GAIN]);
		vocalizer.flush();
		await vocalizer.idle();
	});

	it("does not open a session when speech is disabled", async () => {
		settings.override("speech.enabled", false);
		vocalizer.pushDelta("This is a full sentence. ");
		vocalizer.flush();
		vocalizer.speak("Another sentence.");
		await vocalizer.idle();
		expect(stream).not.toHaveBeenCalled();
	});

	it("aborts the in-flight session on clear", async () => {
		vocalizer.pushDelta("Interrupt me mid-turn.");
		const signal = probe.options?.signal;
		expect(signal?.aborted).toBe(false);
		vocalizer.clear();
		expect(signal?.aborted).toBe(true);
		await vocalizer.idle();
	});
});

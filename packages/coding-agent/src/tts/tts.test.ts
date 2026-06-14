import { describe, expect, it } from "bun:test";
import { resolveLocalWavPath, resolveTtsBackend } from "../tools/tts";
import {
	DEFAULT_TTS_LOCAL_MODEL_KEY,
	DEFAULT_TTS_VOICE,
	getTtsLocalModelSpec,
	isTtsLocalModelKey,
	KOKORO_VOICES,
	resolveTtsRepo,
	resolveTtsVoice,
	TTS_LOCAL_VOICE_OPTIONS,
} from "./models";
import { type TtsAudioChunk, TtsClient } from "./tts-client";
import type { TtsTransport, TtsWorkerInbound, TtsWorkerOutbound } from "./tts-protocol";
import { startTtsWorker } from "./tts-worker";
import { encodeWav } from "./wav";

// ── Backend resolution (auto/local/xai × creds × mp3) ───────────────

describe("resolveTtsBackend", () => {
	it("honors an explicit xai preference regardless of creds/codec", () => {
		expect(resolveTtsBackend({ preference: "xai", wantsMp3: false, hasXaiCreds: false })).toBe("xai");
		expect(resolveTtsBackend({ preference: "xai", wantsMp3: true, hasXaiCreds: true })).toBe("xai");
	});

	it("honors an explicit local preference regardless of creds/codec", () => {
		expect(resolveTtsBackend({ preference: "local", wantsMp3: true, hasXaiCreds: true })).toBe("local");
		expect(resolveTtsBackend({ preference: "local", wantsMp3: false, hasXaiCreds: false })).toBe("local");
	});

	it("auto prefers local for WAV output", () => {
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: false, hasXaiCreds: true })).toBe("local");
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: false, hasXaiCreds: false })).toBe("local");
	});

	it("auto routes mp3 to xai only when credentials exist", () => {
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: true, hasXaiCreds: true })).toBe("xai");
		expect(resolveTtsBackend({ preference: "auto", wantsMp3: true, hasXaiCreds: false })).toBe("local");
	});

	it("treats an unknown preference like auto", () => {
		expect(resolveTtsBackend({ preference: "garbage", wantsMp3: false, hasXaiCreds: true })).toBe("local");
		expect(resolveTtsBackend({ preference: "garbage", wantsMp3: true, hasXaiCreds: true })).toBe("xai");
	});
});

// ── Local output path / codec substitution ──────────────────────────

describe("resolveLocalWavPath", () => {
	it("keeps a .wav path unchanged", () => {
		expect(resolveLocalWavPath("voice.wav")).toEqual({ wavPath: "voice.wav", substituted: false });
		expect(resolveLocalWavPath("dir/voice.WAV")).toEqual({ wavPath: "dir/voice.WAV", substituted: false });
	});

	it("rewrites .mp3 to a sibling .wav and flags substitution", () => {
		expect(resolveLocalWavPath("voice.mp3")).toEqual({ wavPath: "voice.wav", substituted: true });
		expect(resolveLocalWavPath("a/b/clip.mp3")).toEqual({ wavPath: "a/b/clip.wav", substituted: true });
	});

	it("appends .wav when there is no extension", () => {
		expect(resolveLocalWavPath("voice")).toEqual({ wavPath: "voice.wav", substituted: true });
		expect(resolveLocalWavPath("a.b/clip")).toEqual({ wavPath: "a.b/clip.wav", substituted: true });
	});
});

// ── WAV container assembly ──────────────────────────────────────────

function readAscii(view: DataView, offset: number, length: number): string {
	let out = "";
	for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
	return out;
}

describe("encodeWav", () => {
	it("writes a canonical 16-bit mono PCM RIFF/WAVE header", () => {
		const samples = new Float32Array([0, 0.5, -0.5, 1]);
		const wav = encodeWav(samples, 16_000);
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

		// 44-byte header + 2 bytes per sample
		expect(wav.length).toBe(44 + samples.length * 2);
		expect(readAscii(view, 0, 4)).toBe("RIFF");
		expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
		expect(readAscii(view, 8, 4)).toBe("WAVE");
		expect(readAscii(view, 12, 4)).toBe("fmt ");
		expect(view.getUint32(16, true)).toBe(16); // PCM fmt chunk size
		expect(view.getUint16(20, true)).toBe(1); // PCM format
		expect(view.getUint16(22, true)).toBe(1); // mono
		expect(view.getUint32(24, true)).toBe(16_000); // sample rate
		expect(view.getUint32(28, true)).toBe(16_000 * 2); // byte rate (mono, 16-bit)
		expect(view.getUint16(32, true)).toBe(2); // block align
		expect(view.getUint16(34, true)).toBe(16); // bits per sample
		expect(readAscii(view, 36, 4)).toBe("data");
		expect(view.getUint32(40, true)).toBe(samples.length * 2);
	});

	it("quantizes and clamps float samples to signed 16-bit", () => {
		const samples = new Float32Array([0, 1, -1, 0.5, 2, -2]);
		const wav = encodeWav(samples, 24_000);
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
		const at = (i: number): number => view.getInt16(44 + i * 2, true);
		expect(at(0)).toBe(0);
		expect(at(1)).toBe(32_767); // +1 → max
		expect(at(2)).toBe(-32_768); // -1 → min
		expect(at(3)).toBe(Math.round(0.5 * 32_767)); // 16384
		expect(at(4)).toBe(32_767); // +2 clamped
		expect(at(5)).toBe(-32_768); // -2 clamped
		expect(view.getUint32(24, true)).toBe(24_000);
	});
});

// ── Model-key → repo / voice mapping ────────────────────────────────

describe("tts model registry", () => {
	const KOKORO_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";

	it("maps the default model key to the Kokoro ONNX repo at 24 kHz", () => {
		expect(DEFAULT_TTS_LOCAL_MODEL_KEY).toBe("kokoro");
		expect(resolveTtsRepo(DEFAULT_TTS_LOCAL_MODEL_KEY)).toBe(KOKORO_REPO);
		expect(getTtsLocalModelSpec("kokoro")?.repo).toBe(KOKORO_REPO);
		expect(getTtsLocalModelSpec("kokoro")?.sampleRate).toBe(24_000);
	});

	it("falls back to the default repo for unknown keys", () => {
		expect(resolveTtsRepo("does-not-exist")).toBe(KOKORO_REPO);
		expect(resolveTtsRepo(undefined)).toBe(KOKORO_REPO);
		expect(getTtsLocalModelSpec("does-not-exist")).toBeUndefined();
	});

	it("narrows known keys with the type guard", () => {
		expect(isTtsLocalModelKey("kokoro")).toBe(true);
		expect(isTtsLocalModelKey("mms-en")).toBe(false);
	});

	it("defaults to the flagship voice and exposes it as the first catalog entry", () => {
		expect(DEFAULT_TTS_VOICE).toBe("af_heart");
		expect(KOKORO_VOICES[0]?.id).toBe("af_heart");
		expect(TTS_LOCAL_VOICE_OPTIONS.map(o => o.value)).toEqual(KOKORO_VOICES.map(v => v.id));
	});

	it("resolves known voices verbatim and falls back to the default voice otherwise", () => {
		expect(resolveTtsVoice("kokoro", "af_bella")).toBe("af_bella");
		expect(resolveTtsVoice("kokoro", "bf_emma")).toBe("bf_emma");
		expect(resolveTtsVoice("kokoro", "default")).toBe("af_heart");
		expect(resolveTtsVoice("kokoro", undefined)).toBe("af_heart");
		expect(resolveTtsVoice("kokoro", "not-a-voice")).toBe("af_heart");
		expect(resolveTtsVoice(undefined, "am_michael")).toBe("am_michael");
	});
});

// ── Protocol round-trip: in-memory transport + injected worker ──────

function transportPair(): {
	workerTransport: TtsTransport;
	sendToWorker: (message: TtsWorkerInbound) => void;
	onParent: (handler: (message: TtsWorkerOutbound) => void) => void;
} {
	const workerListeners = new Set<(message: TtsWorkerInbound) => void>();
	const parentListeners = new Set<(message: TtsWorkerOutbound) => void>();
	return {
		workerTransport: {
			send: message => {
				for (const listener of parentListeners) listener(message);
			},
			onMessage: handler => {
				workerListeners.add(handler);
				return () => workerListeners.delete(handler);
			},
		},
		sendToWorker: message => {
			for (const listener of workerListeners) listener(message);
		},
		onParent: handler => {
			parentListeners.add(handler);
		},
	};
}

interface FakeWorkerHandle {
	send(message: TtsWorkerInbound): void;
	onMessage(handler: (message: TtsWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	ref(): void;
	unref(): void;
	terminate(): Promise<void>;
}

function fakeWorker(
	respond: (message: TtsWorkerInbound, emit: (out: TtsWorkerOutbound) => void) => void,
): FakeWorkerHandle {
	const listeners = new Set<(message: TtsWorkerOutbound) => void>();
	return {
		send(message) {
			queueMicrotask(() =>
				respond(message, out => {
					for (const listener of listeners) listener(out);
				}),
			);
		},
		onMessage(handler) {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		onError() {
			return () => {};
		},
		ref() {},
		unref() {},
		async terminate() {
			listeners.clear();
		},
	};
}

describe("tts protocol round-trip", () => {
	it("worker pongs to a ping over the transport (no model load)", () => {
		const { workerTransport, sendToWorker, onParent } = transportPair();
		startTtsWorker(workerTransport);
		const received: TtsWorkerOutbound[] = [];
		onParent(message => received.push(message));
		sendToWorker({ type: "ping", id: "p1" });
		expect(received).toEqual([{ type: "pong", id: "p1" }]);
	});

	it("client resolves a synthesize request to the worker's audio response", async () => {
		const pcm = new Float32Array([0, 0.25, -0.25]);
		const client = new TtsClient(() =>
			fakeWorker((message, emit) => {
				if (message.type === "synthesize") emit({ type: "audio", id: message.id, pcm, sampleRate: 24_000 });
			}),
		);
		const audio = await client.synthesize("kokoro", "hello world", { voice: "af_heart" });
		expect(audio).not.toBeNull();
		expect(audio?.sampleRate).toBe(24_000);
		expect(Array.from(audio?.pcm ?? [])).toEqual([0, 0.25, -0.25]);
		await client.terminate();
	});

	it("client rejects unknown model keys without spawning a worker", async () => {
		let spawned = false;
		const client = new TtsClient(() => {
			spawned = true;
			return fakeWorker(() => {});
		});
		expect(await client.synthesize("not-a-model", "hi")).toBeNull();
		expect(spawned).toBe(false);
		await client.terminate();
	});

	it("client maps a worker error to null", async () => {
		const client = new TtsClient(() =>
			fakeWorker((message, emit) => {
				if (message.type === "synthesize") emit({ type: "error", id: message.id, error: "boom" });
			}),
		);
		expect(await client.synthesize("kokoro", "hi")).toBeNull();
		await client.terminate();
	});

	it("client resolves a download request to true", async () => {
		const client = new TtsClient(() =>
			fakeWorker((message, emit) => {
				if (message.type === "download") emit({ type: "downloaded", id: message.id });
			}),
		);
		expect(await client.downloadModel("kokoro")).toBe(true);
		await client.terminate();
	});

	it("client streams audio chunks in emission order and ends on stream-done", async () => {
		const pushed: string[] = [];
		const client = new TtsClient(() =>
			fakeWorker((message, emit) => {
				if (message.type === "stream-push") {
					pushed.push(message.text);
				} else if (message.type === "stream-end") {
					// Simulate the worker synthesizing one sentence per pushed fragment.
					for (const [index, text] of pushed.entries()) {
						emit({
							type: "audio-chunk",
							id: message.id,
							index,
							text,
							pcm: new Float32Array([index]),
							sampleRate: 24_000,
						});
					}
					emit({ type: "stream-done", id: message.id });
				}
			}),
		);
		const handle = client.synthesizeStream("kokoro", { voice: "af_heart" });
		handle.push("one. ");
		handle.push("two. ");
		handle.end();
		const chunks: TtsAudioChunk[] = [];
		for await (const chunk of handle.chunks) chunks.push(chunk);
		expect(chunks.map(c => c.text)).toEqual(["one. ", "two. "]);
		expect(chunks.map(c => c.index)).toEqual([0, 1]);
		expect(Array.from(chunks[0]?.pcm ?? [])).toEqual([0]);
		await client.terminate();
	});
	it("sends stream-cancel and closes the iterator when aborted", async () => {
		const controller = new AbortController();
		const sent: TtsWorkerInbound[] = [];
		const client = new TtsClient(() =>
			fakeWorker(message => {
				sent.push(message);
			}),
		);
		const handle = client.synthesizeStream("kokoro", { signal: controller.signal });
		handle.push("one. ");
		controller.abort();
		handle.push("two. ");
		handle.end();
		const chunks: TtsAudioChunk[] = [];
		for await (const chunk of handle.chunks) chunks.push(chunk);
		expect(chunks).toEqual([]);
		expect(sent.some(message => message.type === "stream-cancel")).toBe(true);
		expect(sent.some(message => message.type === "stream-end")).toBe(false);
		await client.terminate();
	});

	it("client surfaces a worker error on the stream iterator", async () => {
		const client = new TtsClient(() =>
			fakeWorker((message, emit) => {
				if (message.type === "stream-end") emit({ type: "error", id: message.id, error: "boom" });
			}),
		);
		const handle = client.synthesizeStream("kokoro");
		handle.end();
		let caught: unknown;
		try {
			for await (const _chunk of handle.chunks) {
				// drain — the iterator must reject before yielding anything
			}
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toBe("boom");
		await client.terminate();
	});

	it("client returns an inert, empty stream for unknown models without spawning", async () => {
		let spawned = false;
		const client = new TtsClient(() => {
			spawned = true;
			return fakeWorker(() => {});
		});
		const handle = client.synthesizeStream("not-a-model");
		handle.push("hi");
		handle.end();
		const chunks: TtsAudioChunk[] = [];
		for await (const chunk of handle.chunks) chunks.push(chunk);
		expect(chunks).toEqual([]);
		expect(spawned).toBe(false);
		await client.terminate();
	});
});

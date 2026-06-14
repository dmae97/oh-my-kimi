import { describe, expect, it } from "bun:test";
import { SttClient } from "./asr-client";
import type { SttTransport, SttWorkerInbound, SttWorkerOutbound } from "./asr-protocol";
import { startSttWorker } from "./asr-worker";
import { StreamEndpointer } from "./endpointer";
import { DEFAULT_STT_MODEL_KEY, getSttModelSpec, isSttModelKey, resolveSttModelSpec } from "./models";
import { decodePcmS16LE, decodeWavToMono16k, resampleLinear, TARGET_SAMPLE_RATE } from "./wav";

// ── WAV building helpers ────────────────────────────────────────────

function writeAscii(view: DataView, offset: number, text: string): void {
	for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

function buildWav(opts: {
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
	format?: number;
	body: Uint8Array;
}): ArrayBuffer {
	const { sampleRate, channels, bitsPerSample, format = 1, body } = opts;
	const blockAlign = channels * (bitsPerSample / 8);
	const buffer = new ArrayBuffer(44 + body.length);
	const view = new DataView(buffer);
	writeAscii(view, 0, "RIFF");
	view.setUint32(4, 36 + body.length, true);
	writeAscii(view, 8, "WAVE");
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, format, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * blockAlign, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bitsPerSample, true);
	writeAscii(view, 36, "data");
	view.setUint32(40, body.length, true);
	new Uint8Array(buffer).set(body, 44);
	return buffer;
}

function bytesFromInt16(values: number[]): Uint8Array {
	const out = new Uint8Array(values.length * 2);
	const view = new DataView(out.buffer);
	values.forEach((value, i) => {
		view.setInt16(i * 2, value, true);
	});
	return out;
}

function bytesFromInt32(values: number[]): Uint8Array {
	const out = new Uint8Array(values.length * 4);
	const view = new DataView(out.buffer);
	values.forEach((value, i) => {
		view.setInt32(i * 4, value, true);
	});
	return out;
}

// ── WAV decoding ────────────────────────────────────────────────────

describe("decodeWavToMono16k", () => {
	it("decodes 16-bit PCM to normalized [-1, 1] floats", () => {
		const wav = buildWav({
			sampleRate: TARGET_SAMPLE_RATE,
			channels: 1,
			bitsPerSample: 16,
			body: bytesFromInt16([16_384, -16_384, 0]),
		});
		const audio = decodeWavToMono16k(wav);
		expect(audio.length).toBe(3);
		expect(audio[0]).toBeCloseTo(0.5, 4);
		expect(audio[1]).toBeCloseTo(-0.5, 4);
		expect(audio[2]).toBeCloseTo(0, 6);
	});

	it("decodes 8-bit unsigned PCM centered at 128", () => {
		const wav = buildWav({
			sampleRate: TARGET_SAMPLE_RATE,
			channels: 1,
			bitsPerSample: 8,
			body: new Uint8Array([192, 64, 128]),
		});
		const audio = decodeWavToMono16k(wav);
		expect(audio[0]).toBeCloseTo(0.5, 4);
		expect(audio[1]).toBeCloseTo(-0.5, 4);
		expect(audio[2]).toBeCloseTo(0, 6);
	});

	it("decodes 32-bit PCM", () => {
		const wav = buildWav({
			sampleRate: TARGET_SAMPLE_RATE,
			channels: 1,
			bitsPerSample: 32,
			body: bytesFromInt32([1_073_741_824, -1_073_741_824]),
		});
		const audio = decodeWavToMono16k(wav);
		expect(audio[0]).toBeCloseTo(0.5, 4);
		expect(audio[1]).toBeCloseTo(-0.5, 4);
	});

	it("mixes stereo down to mono by averaging channels", () => {
		// Two stereo frames: (L=1.0, R=0.0) -> 0.5, (L=-1.0, R=0.0) -> -0.5
		const wav = buildWav({
			sampleRate: TARGET_SAMPLE_RATE,
			channels: 2,
			bitsPerSample: 16,
			body: bytesFromInt16([32_767, 0, -32_768, 0]),
		});
		const audio = decodeWavToMono16k(wav);
		expect(audio.length).toBe(2);
		expect(audio[0]).toBeCloseTo(0.5, 3);
		expect(audio[1]).toBeCloseTo(-0.5, 3);
	});

	it("resamples to 16 kHz, preserving endpoints and bounds", () => {
		const frames = 8;
		const values: number[] = [];
		for (let i = 0; i < frames; i += 1) values.push(Math.round(Math.sin((i / frames) * Math.PI) * 20_000));
		const wav = buildWav({ sampleRate: 8_000, channels: 1, bitsPerSample: 16, body: bytesFromInt16(values) });
		const audio = decodeWavToMono16k(wav);
		// 8 kHz -> 16 kHz doubles the sample count.
		expect(audio.length).toBe(frames * 2);
		expect(audio[0]).toBeCloseTo(values[0]! / 32_768, 4);
		expect(audio[audio.length - 1]).toBeCloseTo(values[frames - 1]! / 32_768, 4);
		for (const sample of audio) expect(Math.abs(sample)).toBeLessThanOrEqual(1);
	});

	it("rejects non-RIFF input", () => {
		expect(() => decodeWavToMono16k(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).toThrow();
	});
});

describe("resampleLinear", () => {
	it("interpolates between samples", () => {
		const out = resampleLinear(new Float32Array([0, 1]), 1, 2);
		expect(out.length).toBe(4);
		expect(out[0]).toBeCloseTo(0, 6);
		expect(out[1]).toBeCloseTo(1 / 3, 5);
		expect(out[2]).toBeCloseTo(2 / 3, 5);
		expect(out[3]).toBeCloseTo(1, 6);
	});

	it("returns the input unchanged when rates match", () => {
		const input = new Float32Array([0.1, 0.2]);
		expect(resampleLinear(input, 16_000, 16_000)).toBe(input);
	});
});

// ── Model key → repo mapping ────────────────────────────────────────

describe("stt model registry", () => {
	it("maps tier keys onto their engine + repo", () => {
		expect(getSttModelSpec("fast")?.repo).toBe("onnx-community/whisper-base");
		expect(getSttModelSpec("fast")?.engine).toBe("transformers");
		expect(getSttModelSpec("balanced")?.repo).toBe("onnx-community/whisper-small");
		expect(getSttModelSpec("turbo")?.repo).toBe("onnx-community/whisper-large-v3-turbo");
		expect(getSttModelSpec("turbo")?.engine).toBe("transformers");
		expect(getSttModelSpec("parakeet")?.repo).toBe("csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8");
		expect(getSttModelSpec("parakeet")?.engine).toBe("sherpa");
		expect(getSttModelSpec("nonexistent")).toBeUndefined();
	});

	it("defaults to the SoTA Parakeet tier", () => {
		expect(DEFAULT_STT_MODEL_KEY).toBe("parakeet");
		expect(getSttModelSpec(DEFAULT_STT_MODEL_KEY)?.engine).toBe("sherpa");
	});

	it("describes the sherpa tier's model files for the downloader/worker", () => {
		const spec = getSttModelSpec("parakeet");
		expect(spec?.engine).toBe("sherpa");
		if (spec?.engine !== "sherpa") throw new Error("expected sherpa spec");
		expect(spec.modelType).toBe("nemo_transducer");
		expect(spec.files).toEqual({
			encoder: "encoder.int8.onnx",
			decoder: "decoder.int8.onnx",
			joiner: "joiner.int8.onnx",
			tokens: "tokens.txt",
		});
	});

	it("flags multilingual checkpoints (no English-only tiers in the ladder)", () => {
		expect(getSttModelSpec("fast")?.englishOnly).toBe(false);
		expect(getSttModelSpec("turbo")?.englishOnly).toBe(false);
		expect(getSttModelSpec("parakeet")?.englishOnly).toBe(false);
	});

	it("resolves legacy/unknown keys to the SoTA default", () => {
		expect(resolveSttModelSpec("base.en").key).toBe("parakeet"); // legacy whisper size
		expect(resolveSttModelSpec("accurate").key).toBe("parakeet"); // retired tier key
		expect(resolveSttModelSpec("fast-en").key).toBe("parakeet"); // retired tier key
		expect(resolveSttModelSpec(undefined).key).toBe("parakeet");
		expect(resolveSttModelSpec("balanced").key).toBe("balanced");
	});

	it("recognizes valid tier keys", () => {
		expect(isSttModelKey("balanced")).toBe(true);
		expect(isSttModelKey("parakeet")).toBe(true);
		expect(isSttModelKey("accurate")).toBe(false);
	});
});

// ── Protocol round-trips ────────────────────────────────────────────

interface FakeWorker {
	send(message: SttWorkerInbound): void;
	onMessage(handler: (message: SttWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

function makeFakeWorker(
	onSend: (message: SttWorkerInbound, emit: (out: SttWorkerOutbound) => void) => void,
): FakeWorker {
	let emit: (out: SttWorkerOutbound) => void = () => {};
	return {
		send(message) {
			onSend(message, out => emit(out));
		},
		onMessage(handler) {
			emit = handler;
			return () => {
				emit = () => {};
			};
		},
		onError() {
			return () => {};
		},
		async terminate() {},
	};
}

describe("worker protocol (in-memory transport)", () => {
	it("answers ping with pong via startSttWorker", () => {
		const sent: SttWorkerOutbound[] = [];
		let handler: ((message: SttWorkerInbound) => void) | undefined;
		const transport: SttTransport = {
			send: message => sent.push(message),
			onMessage: h => {
				handler = h;
				return () => {};
			},
		};
		startSttWorker(transport);
		handler?.({ type: "ping", id: "p1" });
		expect(sent).toEqual([{ type: "pong", id: "p1" }]);
	});
});

describe("SttClient request/response correlation", () => {
	it("resolves a transcribe request with the matching transcription", async () => {
		const client = new SttClient(() =>
			makeFakeWorker((message, emit) => {
				if (message.type === "transcribe") emit({ type: "transcription", id: message.id, text: "  hi there  " });
			}),
		);
		// Client returns the raw worker text (transcriber.ts owns trimming).
		expect(await client.transcribe("fast", new Float32Array([0.1]), {})).toBe("  hi there  ");
		await client.terminate();
	});

	it("rejects with the worker error message", async () => {
		const client = new SttClient(() =>
			makeFakeWorker((message, emit) => {
				if (message.type === "transcribe") emit({ type: "error", id: message.id, error: "model exploded" });
			}),
		);
		await expect(client.transcribe("fast", new Float32Array([0]), {})).rejects.toThrow("model exploded");
		await client.terminate();
	});

	it("throws synchronously on an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const client = new SttClient(() => makeFakeWorker(() => {}));
		await expect(client.transcribe("fast", new Float32Array([0]), { signal: controller.signal })).rejects.toThrow();
		await client.terminate();
	});

	it("correlates concurrent requests by id regardless of reply order", async () => {
		const inbound: Array<Extract<SttWorkerInbound, { type: "transcribe" }>> = [];
		let emit: ((out: SttWorkerOutbound) => void) | undefined;
		const client = new SttClient(() =>
			makeFakeWorker((message, e) => {
				emit = e;
				if (message.type === "transcribe") inbound.push(message);
			}),
		);
		const first = client.transcribe("fast", new Float32Array([0]), { language: "a" });
		const second = client.transcribe("fast", new Float32Array([0]), { language: "b" });
		expect(inbound.length).toBe(2);
		expect(inbound[0]!.id).not.toBe(inbound[1]!.id);
		// Reply out of order.
		emit?.({ type: "transcription", id: inbound[1]!.id, text: "second" });
		emit?.({ type: "transcription", id: inbound[0]!.id, text: "first" });
		expect(await first).toBe("first");
		expect(await second).toBe("second");
		await client.terminate();
	});

	it("downloadModel resolves true on a downloaded ack", async () => {
		const client = new SttClient(() =>
			makeFakeWorker((message, emit) => {
				if (message.type === "download") emit({ type: "downloaded", id: message.id });
			}),
		);
		expect(await client.downloadModel("fast")).toBe(true);
		await client.terminate();
	});
});

// ── Raw PCM decoding ────────────────────────────────────────────────

describe("decodePcmS16LE", () => {
	it("decodes little-endian s16 frames to normalized [-1, 1] floats", () => {
		const audio = decodePcmS16LE(bytesFromInt16([16_384, -16_384, 0, 32_767]));
		expect(audio.length).toBe(4);
		expect(audio[0]).toBeCloseTo(0.5, 4);
		expect(audio[1]).toBeCloseTo(-0.5, 4);
		expect(audio[2]).toBeCloseTo(0, 6);
		expect(audio[3]).toBeCloseTo(32_767 / 32_768, 4);
	});

	it("ignores a trailing odd byte (callers carry it across chunks)", () => {
		const bytes = new Uint8Array([0x00, 0x40, 0x7f]); // one whole sample + one stray byte
		const audio = decodePcmS16LE(bytes.subarray(0, bytes.length - (bytes.length % 2)));
		expect(audio.length).toBe(1);
		expect(audio[0]).toBeCloseTo(0.5, 4);
	});
});

// ── Energy endpointer (live segmentation) ───────────────────────────

function silenceFrames(ms: number, sampleRate = 16_000): Float32Array {
	return new Float32Array(Math.round((sampleRate * ms) / 1000));
}

function toneFrames(ms: number, amplitude = 0.3, sampleRate = 16_000): Float32Array {
	const n = Math.round((sampleRate * ms) / 1000);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
	return out;
}

describe("StreamEndpointer", () => {
	const base = {
		frameMs: 10,
		endSilenceMs: 50,
		minSpeechMs: 20,
		maxSegmentMs: 5_000,
		preRollMs: 0,
		partialIntervalMs: 10_000,
		energyRatio: 2,
		floorAttack: 0.1,
		minThreshold: 0.01,
	} as const;

	it("commits one segment for a speech burst bounded by silence", () => {
		const ep = new StreamEndpointer(base);
		const events = [...ep.push(silenceFrames(80)), ...ep.push(toneFrames(120)), ...ep.push(silenceFrames(80))];
		const segments = events.filter(e => e.kind === "segment");
		expect(segments.length).toBe(1);
		expect(segments[0]!.audio.length).toBeGreaterThan(0);
	});

	it("splits two phrases separated by a pause into two segments", () => {
		const ep = new StreamEndpointer(base);
		const events = [
			...ep.push(silenceFrames(80)),
			...ep.push(toneFrames(120)),
			...ep.push(silenceFrames(80)),
			...ep.push(toneFrames(120)),
			...ep.push(silenceFrames(80)),
		];
		expect(events.filter(e => e.kind === "segment").length).toBe(2);
	});

	it("discards a sub-minimum blip as noise", () => {
		const ep = new StreamEndpointer({ ...base, minSpeechMs: 80 });
		const events = [...ep.push(silenceFrames(80)), ...ep.push(toneFrames(30)), ...ep.push(silenceFrames(80))];
		expect(events.filter(e => e.kind === "segment").length).toBe(0);
	});

	it("flush commits in-progress speech with no trailing silence", () => {
		const ep = new StreamEndpointer(base);
		const live = [...ep.push(silenceFrames(40)), ...ep.push(toneFrames(120))];
		expect(live.filter(e => e.kind === "segment").length).toBe(0);
		expect(ep.flush().filter(e => e.kind === "segment").length).toBe(1);
	});

	it("emits volatile partials while a long phrase is still in progress", () => {
		const ep = new StreamEndpointer({ ...base, partialIntervalMs: 30, endSilenceMs: 400 });
		ep.push(silenceFrames(40));
		const events = ep.push(toneFrames(120));
		expect(events.filter(e => e.kind === "partial").length).toBeGreaterThanOrEqual(2);
	});
});

// ── Streaming session correlation ───────────────────────────────────

describe("SttClient.startStream", () => {
	it("routes partials/segments and resolves stop() with the final transcript", async () => {
		let emit: ((out: SttWorkerOutbound) => void) | undefined;
		let streamId: string | undefined;
		const sent: SttWorkerInbound[] = [];
		const client = new SttClient(() =>
			makeFakeWorker((message, e) => {
				emit = e;
				sent.push(message);
				if (message.type === "stream_start") streamId = message.id;
			}),
		);
		const partials: string[] = [];
		const segments: Array<{ text: string; index: number }> = [];
		const handle = client.startStream("parakeet", {
			onPartial: text => partials.push(text),
			onSegment: (text, index) => segments.push({ text, index }),
		});
		expect(streamId).toBeDefined();
		handle.pushAudio(new Float32Array([0.1, 0.2]));
		emit?.({ type: "partial", id: streamId!, text: "hel" });
		emit?.({ type: "segment", id: streamId!, index: 0, text: "hello" });
		emit?.({ type: "segment", id: streamId!, index: 1, text: "world" });
		const final = handle.stop();
		emit?.({ type: "stream_done", id: streamId!, text: "hello world" });
		expect(await final).toBe("hello world");
		expect(partials).toEqual(["hel"]);
		expect(segments).toEqual([
			{ text: "hello", index: 0 },
			{ text: "world", index: 1 },
		]);
		expect(sent.some(m => m.type === "stream_audio")).toBe(true);
		expect(sent.some(m => m.type === "stream_stop")).toBe(true);
		await client.terminate();
	});

	it("rejects stop() when the worker reports a stream error", async () => {
		let emit: ((out: SttWorkerOutbound) => void) | undefined;
		let streamId: string | undefined;
		const client = new SttClient(() =>
			makeFakeWorker((message, e) => {
				emit = e;
				if (message.type === "stream_start") streamId = message.id;
			}),
		);
		const result = client.startStream("parakeet", {}).stop();
		emit?.({ type: "error", id: streamId!, error: "decode blew up" });
		await expect(result).rejects.toThrow("decode blew up");
		await client.terminate();
	});

	it("cancels on an aborted signal, resolving stop() empty and emitting no segments", async () => {
		const controller = new AbortController();
		const sent: SttWorkerInbound[] = [];
		const client = new SttClient(() =>
			makeFakeWorker(message => {
				sent.push(message);
			}),
		);
		const segments: string[] = [];
		const handle = client.startStream("parakeet", { signal: controller.signal, onSegment: t => segments.push(t) });
		controller.abort();
		expect(await handle.stop()).toBe("");
		expect(segments).toEqual([]);
		expect(sent.some(m => m.type === "stream_cancel")).toBe(true);
		await client.terminate();
	});
});

describe("worker streaming dispatch", () => {
	it("rejects a streaming start for an unknown model", () => {
		const sent: SttWorkerOutbound[] = [];
		let handler: ((message: SttWorkerInbound) => void) | undefined;
		const transport: SttTransport = {
			send: message => sent.push(message),
			onMessage: h => {
				handler = h;
				return () => {};
			},
		};
		startSttWorker(transport);
		handler?.({ type: "stream_start", id: "s1", modelKey: "bogus" } as unknown as SttWorkerInbound);
		expect(sent.length).toBe(1);
		expect(sent[0]).toMatchObject({ type: "error", id: "s1" });
		expect((sent[0] as Extract<SttWorkerOutbound, { type: "error" }>).error).toContain("Unknown stt model");
	});
});

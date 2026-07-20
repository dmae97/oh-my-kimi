import { logger } from "@oh-my-pi/pi-utils";
import { sttClient } from "./asr-client";
import { resolveSttModelSpec } from "./models";
import { decodeWavToMono16k } from "./wav";

export interface TranscribeOptions {
	modelName?: string;
	language?: string;
	signal?: AbortSignal;
}

const TRANSCRIBE_TIMEOUT_MS = 120_000;

/**
 * Transcribe a WAV file using the local ONNX Whisper worker.
 *
 * Decodes the WAV to a 16 kHz mono Float32Array in-process (no Python, no
 * ffmpeg) and routes it to the warm speech worker, which keeps the model loaded
 * across calls. Honors `options.signal` (abort) and applies an internal timeout
 * with the same semantics as the previous Python path.
 */
export async function transcribe(audioPath: string, options?: TranscribeOptions): Promise<string> {
	const audioFile = Bun.file(audioPath);
	if (audioFile.size < 100) {
		throw new Error(`Audio file is empty or too small (${audioFile.size} bytes). Check microphone.`);
	}
	options?.signal?.throwIfAborted();

	const spec = resolveSttModelSpec(options?.modelName);
	const language = options?.language || undefined;
	const audio = decodeWavToMono16k(await audioFile.arrayBuffer());
	if (audio.length === 0) return "";

	logger.debug("Transcribing with local ONNX whisper", {
		audioPath,
		modelKey: spec.key,
		repo: spec.repo,
		language,
		samples: audio.length,
	});

	// Bound runaway inference. Abort the request on timeout; the warm worker
	// keeps the model loaded (the request promise just rejects).
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), TRANSCRIBE_TIMEOUT_MS);
	const signal = options?.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
	try {
		const text = (await sttClient.transcribe(spec.key, audio, { language, signal })).trim();
		logger.debug("Transcription complete", { length: text.length });
		return text;
	} catch (error) {
		if (timeout.signal.aborted && !options?.signal?.aborted) {
			logger.error("Local whisper transcription timed out", { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
			throw new Error(`Transcription timed out after ${Math.round(TRANSCRIBE_TIMEOUT_MS / 1000)}s`);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

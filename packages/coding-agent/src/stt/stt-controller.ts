import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import { type SttStreamHandle, sttClient } from "./asr-client";
import { downloadSttModel, isSttModelCached } from "./downloader";
import { resolveSttModelSpec } from "./models";
import {
	detectRecorder,
	ensureRecorder,
	type RecordingHandle,
	type StreamingRecordingHandle,
	startRecording,
	startStreamingRecording,
	verifyRecordingFile,
} from "./recorder";
import { transcribe } from "./transcriber";

export type SttState = "idle" | "recording" | "transcribing";

interface ToggleOptions {
	showWarning(msg: string): void;
	showStatus(msg: string): void;
	onStateChange(state: SttState): void;
	/** Force a redraw after async edits to the composer (live segment/preview inserts). */
	requestRender?(): void;
}

/** The slice of the composer editor the controller drives. */
interface Editor {
	insertText(text: string): void;
	setVolatileText(text: string): void;
	clearVolatileText(): void;
	commitVolatileText(text: string): void;
}

export class STTController {
	#state: SttState = "idle";
	#resolvedModelKey: string | null = null;
	#toggling = false;
	#stopAfterStart = false;
	#disposed = false;

	// Batch (single-shot) capture.
	#recordingHandle: RecordingHandle | null = null;
	#tempFile: string | null = null;
	#transcriptionAbort: AbortController | null = null;

	// Live streaming capture.
	#stream: SttStreamHandle | null = null;
	#streamRecorder: StreamingRecordingHandle | null = null;
	#streamEditor: Editor | null = null;
	#streamCommitted = false;
	#streamAbort: AbortController | null = null;

	get state(): SttState {
		return this.#state;
	}

	#setState(state: SttState, options: ToggleOptions): void {
		this.#state = state;
		options.onStateChange(state);
	}

	async toggle(editor: Editor, options: ToggleOptions): Promise<void> {
		if (this.#toggling) {
			if (this.#state === "idle" || this.#state === "recording") this.#stopAfterStart = true;
			return;
		}
		this.#toggling = true;
		try {
			switch (this.#state) {
				case "idle":
					await this.#start(editor, options);
					break;
				case "recording":
					await this.#stop(editor, options);
					break;
				case "transcribing":
					options.showStatus("Transcription in progress...");
					break;
			}
			if (this.#stopAfterStart && this.#state === "recording") {
				this.#stopAfterStart = false;
				await this.#stop(editor, options);
			} else if (this.#state !== "recording") {
				this.#stopAfterStart = false;
			}
		} finally {
			this.#toggling = false;
		}
	}

	async #ensureDeps(options: ToggleOptions): Promise<boolean> {
		const modelKey = resolveSttModelSpec(settings.get("stt.modelName") as string | undefined).key;
		// Keyed on the model rather than a one-shot flag: switching stt.modelName
		// mid-session must re-run preflight so an uncached new tier downloads here
		// (with progress) instead of blocking silently at stop.
		if (this.#resolvedModelKey === modelKey) return true;
		try {
			// Only clear the status line if we actually wrote to it: the cached
			// fast path (recorder on PATH, model present) emits nothing, so an
			// unconditional clear would be a stray write.
			let wroteStatus = false;
			const status = (msg: string): void => {
				wroteStatus = true;
				options.showStatus(msg);
			};
			// A recorder is required to capture audio; startRecording /
			// startStreamingRecording only *detect* a recorder and throw when none
			// exists, so provision one here. Instant when sox/ffmpeg/arecord is on
			// PATH — only a first-run static-ffmpeg download actually blocks.
			await ensureRecorder(p => status(p.stage + (p.percent != null ? ` (${p.percent}%)` : "")));
			// Loading the multi-hundred-MB speech model into the worker is what made
			// the old "Checking STT dependencies…" step slow. Don't pay it before
			// recording: when the weights are already cached, start now and warm the
			// model in the background — the stream/transcribe paths load it on demand
			// (memoized in the worker) and it is hot by the time recording stops.
			// Only a genuine first-use download blocks, with explicit progress, so we
			// never record silently against missing weights.
			if (await isSttModelCached(modelKey)) {
				this.#warmModel(modelKey);
			} else {
				await downloadSttModel(modelKey, p => status(`Downloading speech model ${p.label} (${p.percent}%)`));
			}
			if (wroteStatus) options.showStatus("");
			this.#resolvedModelKey = modelKey;
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to setup STT dependencies";
			options.showWarning(msg);
			logger.error("STT dependency setup failed", { error: msg });
			return false;
		}
	}

	/** Warm the speech model in the worker without blocking recording. The worker
	 *  memoizes the load, so the stream/transcribe path reuses it and the model is
	 *  hot by the time recording stops. Only called when the weights are already
	 *  cached, so no network fetch happens. On load failure (corrupt cache, OOM,
	 *  runtime install) invalidate the resolved key so the next toggle re-runs
	 *  preflight and retries instead of skipping it forever. */
	#warmModel(modelKey: string): void {
		void downloadSttModel(modelKey).catch(err => {
			// Guard against a concurrent model switch clobbering a newer resolution.
			if (!this.#disposed && this.#resolvedModelKey === modelKey) this.#resolvedModelKey = null;
			logger.debug("stt: background model warmup failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	async #start(editor: Editor, options: ToggleOptions): Promise<void> {
		if (!(await this.#ensureDeps(options))) return;
		// Live transcription needs a recorder that can pipe PCM; the Windows
		// PowerShell mci fallback records to a file, so it stays single-shot.
		if (this.#recorderCanStream()) {
			await this.#startStreaming(editor, options);
			return;
		}
		await this.#startBatchRecording(options);
	}

	async #stop(editor: Editor, options: ToggleOptions): Promise<void> {
		if (this.#stream) {
			await this.#stopStreaming(options);
			return;
		}
		await this.#stopBatch(editor, options);
	}

	// ── Live streaming ──────────────────────────────────────────────

	#recorderCanStream(): boolean {
		const recorder = detectRecorder();
		return recorder !== null && recorder.tool !== "powershell";
	}

	/** Segment text gets a leading space once a prior segment is committed, so
	 *  phrases join naturally; the first phrase is inserted at the cursor as-is. */
	#prefixed(text: string): string {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (!normalized) return "";
		return this.#streamCommitted ? ` ${normalized}` : normalized;
	}

	async #startStreaming(editor: Editor, options: ToggleOptions): Promise<void> {
		const modelKey = resolveSttModelSpec(settings.get("stt.modelName") as string | undefined).key;
		const language = settings.get("stt.language") as string | undefined;
		this.#streamEditor = editor;
		this.#streamCommitted = false;
		this.#streamAbort = new AbortController();
		const stream = sttClient.startStream(modelKey, {
			language: language || undefined,
			signal: this.#streamAbort.signal,
			onPartial: text => {
				if (this.#disposed || this.#state !== "recording") return;
				this.#streamEditor?.setVolatileText(this.#prefixed(text));
				options.requestRender?.();
			},
			onSegment: text => {
				if (this.#disposed) return;
				const prefixed = this.#prefixed(text);
				if (prefixed) {
					this.#streamEditor?.commitVolatileText(prefixed);
					this.#streamCommitted = true;
				} else {
					this.#streamEditor?.clearVolatileText();
				}
				options.requestRender?.();
			},
		});
		this.#stream = stream;
		let recorder: StreamingRecordingHandle | null = null;
		try {
			recorder = await startStreamingRecording(samples => stream.pushAudio(samples));
		} catch (err) {
			logger.warn("STT streaming recorder failed to start; falling back to batch recording", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		if (!recorder) {
			stream.cancel();
			this.#cleanupStream();
			await this.#startBatchRecording(options);
			return;
		}
		this.#streamRecorder = recorder;
		this.#setState("recording", options);
		logger.debug("STT live recording started", { modelKey });
	}

	async #stopStreaming(options: ToggleOptions): Promise<void> {
		const stream = this.#stream;
		const recorder = this.#streamRecorder;
		if (!stream) {
			this.#setState("idle", options);
			return;
		}
		this.#setState("transcribing", options);
		// Stop the mic first so no further audio is fed, then flush the worker.
		try {
			await recorder?.stop();
		} catch (err) {
			logger.debug("stt: streaming recorder stop failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		this.#streamRecorder = null;

		let failed = false;
		let finalText = "";
		try {
			finalText = (await stream.stop()).trim();
		} catch (err) {
			failed = true;
			if (!this.#disposed) {
				const msg = err instanceof Error ? err.message : "Transcription failed";
				options.showWarning(msg);
				logger.error("STT live transcription failed", { error: msg });
			}
		}
		if (this.#disposed) {
			this.#cleanupStream();
			return;
		}
		if (!this.#streamCommitted && finalText) {
			this.#streamEditor?.commitVolatileText(this.#prefixed(finalText));
			this.#streamCommitted = true;
		} else {
			this.#streamEditor?.clearVolatileText();
		}
		options.requestRender?.();
		if (!failed) options.showStatus(this.#streamCommitted ? "" : "No speech detected.");
		this.#cleanupStream();
		this.#setState("idle", options);
	}

	#cleanupStream(): void {
		this.#stream = null;
		this.#streamRecorder = null;
		this.#streamEditor = null;
		this.#streamCommitted = false;
		this.#streamAbort = null;
	}

	// ── Batch (single-shot) ─────────────────────────────────────────

	async #startBatchRecording(options: ToggleOptions): Promise<void> {
		const id = Snowflake.next();
		this.#tempFile = path.join(os.tmpdir(), `omp-stt-${id}.wav`);
		try {
			this.#recordingHandle = await startRecording(this.#tempFile);
			this.#setState("recording", options);
			logger.debug("STT recording started", { tempFile: this.#tempFile });
		} catch (err) {
			this.#tempFile = null;
			const msg = err instanceof Error ? err.message : "Failed to start recording";
			options.showWarning(msg);
			logger.error("STT recording failed to start", { error: msg });
		}
	}

	async #stopBatch(editor: Editor, options: ToggleOptions): Promise<void> {
		const handle = this.#recordingHandle;
		const tempFile = this.#tempFile;
		this.#recordingHandle = null;

		if (!handle || !tempFile) {
			this.#setState("idle", options);
			return;
		}

		try {
			await handle.stop();
			// Validate the recording produced a usable file
			await verifyRecordingFile(tempFile);
			this.#setState("transcribing", options);

			const sttSettings = {
				modelName: settings.get("stt.modelName") as string | undefined,
				language: settings.get("stt.language") as string | undefined,
			};
			this.#transcriptionAbort = new AbortController();
			const text = await transcribe(tempFile, { ...sttSettings, signal: this.#transcriptionAbort.signal });
			this.#transcriptionAbort = null;
			if (this.#disposed) return;
			if (text.length > 0) {
				editor.insertText(text);
				options.showStatus("");
			} else {
				options.showStatus("No speech detected.");
			}
			if (!this.#disposed) this.#setState("idle", options);
		} catch (err) {
			if (this.#disposed) return;
			if (err instanceof DOMException && err.name === "AbortError") {
				this.#setState("idle", options);
				return;
			}
			const msg = err instanceof Error ? err.message : "Transcription failed";
			options.showWarning(msg);
			logger.error("STT transcription failed", { error: msg });
			this.#setState("idle", options);
		} finally {
			try {
				await fs.rm(tempFile, { force: true });
			} catch {
				// best effort cleanup
			}
			this.#tempFile = null;
		}
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#transcriptionAbort) {
			this.#transcriptionAbort.abort();
			this.#transcriptionAbort = null;
		}
		if (this.#streamAbort) {
			this.#streamAbort.abort();
			this.#streamAbort = null;
		}
		this.#stream?.cancel();
		this.#streamRecorder?.stop().catch(() => {});
		this.#cleanupStream();
		if (this.#recordingHandle) {
			this.#recordingHandle.stop().catch(() => {});
			this.#recordingHandle = null;
		}
		if (this.#tempFile) {
			fs.rm(this.#tempFile, { force: true }).catch(() => {});
			this.#tempFile = null;
		}
		this.#state = "idle";
		this.#resolvedModelKey = null;
	}
}

import * as path from "node:path";
import { $env, isBunTestRuntime, isCompiledBinary, logger, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { settings } from "../config/settings";
import { tinyWorkerEnvOverlay } from "../tiny/title-client";
import type { SttProgressEvent, SttWorkerInbound, SttWorkerOutbound } from "./asr-protocol";
import type { SttModelKey } from "./models";

/**
 * Abstraction over the speech-recognition subprocess. Modelled as a worker
 * interface so the parent composes lifecycle, ping/pong, and request/response
 * correlation uniformly; the runtime implementation is a Bun child process so
 * `onnxruntime-node`'s NAPI finalizer never runs inside the main agent address
 * space — that destructor segfaults Bun on shutdown (issue #1606).
 */
interface WorkerHandle {
	send(message: SttWorkerInbound): void;
	onMessage(handler: (message: SttWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

type PendingRequest =
	| { kind: "transcribe"; modelKey: SttModelKey; resolve: (text: string) => void; reject: (error: Error) => void }
	| { kind: "download"; modelKey: SttModelKey; resolve: (ok: boolean) => void };

export interface SttTranscribeOptions {
	language?: string;
	signal?: AbortSignal;
}

export interface SttDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: SttProgressEvent) => void;
}

/** Live streaming session handle returned by {@link SttClient.startStream}. */
export interface SttStreamHandle {
	/** Feed 16 kHz mono float samples as the recorder produces them. */
	pushAudio(audio: Float32Array): void;
	/** Flush the trailing segment and resolve with the full joined transcript. */
	stop(): Promise<string>;
	/** Tear the session down without a final flush (resolves `stop()` with ""). */
	cancel(): void;
}

export interface SttStreamOptions {
	language?: string;
	signal?: AbortSignal;
	/** Volatile transcript of the in-progress segment, refreshed as audio arrives. */
	onPartial?: (text: string) => void;
	/** A finalized segment, emitted once when the endpointer commits it. */
	onSegment?: (text: string, index: number) => void;
}

interface StreamState {
	modelKey: SttModelKey;
	onPartial: ((text: string) => void) | undefined;
	onSegment: ((text: string, index: number) => void) | undefined;
	resolve: (text: string) => void;
	reject: (error: Error) => void;
	/** Run `apply` (resolve/reject) once, then unregister the stream. */
	finish: (apply: () => void) => void;
}

// Cold-starting the worker subprocess from a compiled binary (decompress +
// module graph load) is slow on contended CI runners; the probe only needs to
// prove the worker spawns and ponges, so a generous bound removes the flake.
const SMOKE_TEST_TIMEOUT_MS = 30_000;

/**
 * Hidden subcommand on the main CLI that boots the speech-recognition worker in
 * the spawned subprocess. Kept in sync with the dispatch in `cli.ts`.
 */
export const STT_WORKER_ARG = "__omp_stt_worker";

function readTinyModelSetting(key: "providers.tinyModelDevice" | "providers.tinyModelDtype"): string | undefined {
	try {
		const value = settings.get(key);
		return typeof value === "string" ? value : undefined;
	} catch {
		// Settings may be uninitialized (e.g. `omp --smoke-test`); fall back to env/default.
		return undefined;
	}
}

/**
 * Env handed to the speech subprocess. The `PI_TINY_DEVICE` / `PI_TINY_DTYPE`
 * env vars win; otherwise the persisted `providers.tinyModelDevice` /
 * `providers.tinyModelDtype` settings are mapped onto those vars so the
 * subprocess's env-based resolution picks them up (shared with tiny models).
 */
function sttWorkerEnv(): Record<string, string> {
	const overlay = tinyWorkerEnvOverlay(
		$env,
		readTinyModelSetting("providers.tinyModelDevice"),
		readTinyModelSetting("providers.tinyModelDtype"),
	);
	const base = $env as Record<string, string | undefined>;
	const merged: Record<string, string> = {};
	for (const key in base) {
		const value = base[key];
		if (typeof value === "string") merged[key] = value;
	}
	for (const key in overlay) merged[key] = overlay[key];
	return merged;
}

interface SttWorkerSpawnCommand {
	cmd: string[];
	cwd?: string;
}

/**
 * Resolve the command used to relaunch the agent CLI into stt-worker mode. In a
 * compiled binary the entry point is the binary itself; otherwise re-enter the
 * declared worker-host entry with a cwd-relative script path (Bun's subprocess
 * IPC is more reliable that way under `bun test`), falling back to this
 * package's own `src/cli.ts` when no host entry is declared.
 */
function sttWorkerSpawnCmd(): SttWorkerSpawnCommand {
	if (isCompiledBinary()) return { cmd: [process.execPath, STT_WORKER_ARG] };
	const hostEntry = workerHostEntry();
	if (hostEntry) {
		return { cmd: [process.execPath, path.basename(hostEntry), STT_WORKER_ARG], cwd: path.dirname(hostEntry) };
	}
	const packageRoot = path.resolve(import.meta.dir, "..", "..");
	return { cmd: [process.execPath, "src/cli.ts", STT_WORKER_ARG], cwd: packageRoot };
}

interface SpawnedSubprocess {
	proc: Subprocess<"ignore", "ignore", "ignore">;
	inbound: Set<(message: SttWorkerOutbound) => void>;
	errors: Set<(error: Error) => void>;
	/**
	 * Flipped to `true` right before the parent SIGKILLs the child so `onExit`
	 * can distinguish the expected hard-kill from a crash/OOM/external signal.
	 */
	intentionalExit: { value: boolean };
}

/**
 * Spawn the speech worker as a subprocess. Exported for tests and the smoke
 * probe; production callers go through {@link spawnSttWorker}.
 */
export function createSttSubprocess(): SpawnedSubprocess {
	const inbound = new Set<(message: SttWorkerOutbound) => void>();
	const errors = new Set<(error: Error) => void>();
	const intentionalExit = { value: false };
	const spawnCommand = sttWorkerSpawnCmd();
	const proc = Bun.spawn({
		cmd: spawnCommand.cmd,
		cwd: spawnCommand.cwd,
		env: sttWorkerEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		serialization: "advanced",
		windowsHide: true,
		ipc(message) {
			for (const handler of inbound) handler(message as SttWorkerOutbound);
		},
		onExit(_proc, exitCode, signalCode) {
			if (exitCode === 0) return;
			// Swallow only the expected SIGKILL from `terminate()`; every other
			// signal exit is a real worker death that must fault in-flight
			// requests so callers don't await forever.
			if (exitCode === null && intentionalExit.value) return;
			const reason = exitCode !== null ? `code ${exitCode}` : `signal ${signalCode ?? "unknown"}`;
			const err = new Error(`stt subprocess exited with ${reason}`);
			for (const handler of errors) handler(err);
		},
	});
	// Don't keep the parent event loop alive on an idle worker; dispose calls
	// `terminate()` explicitly. Bun's test runner can starve IPC delivery for
	// unref'd subprocesses, so keep it referenced under tests.
	if (!isBunTestRuntime()) proc.unref();
	return { proc, inbound, errors, intentionalExit };
}

function wrapSubprocess({ proc, inbound, errors, intentionalExit }: SpawnedSubprocess): WorkerHandle {
	return {
		send(message) {
			try {
				proc.send(message);
			} catch (error) {
				logger.debug("stt: send to subprocess failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
		onMessage(handler) {
			inbound.add(handler);
			return () => inbound.delete(handler);
		},
		onError(handler) {
			errors.add(handler);
			return () => errors.delete(handler);
		},
		async terminate() {
			// SIGKILL: the whole point of subprocess isolation is that the parent
			// never runs `onnxruntime-node`'s NAPI finalizer. Hard-kill instead —
			// the model lives in process memory and the OS reclaims everything.
			intentionalExit.value = true;
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		},
	};
}

function spawnInlineUnavailableWorker(error: unknown): WorkerHandle {
	const listeners = new Set<(message: SttWorkerOutbound) => void>();
	const errorMessage = error instanceof Error ? error.message : String(error);
	const emit = (message: SttWorkerOutbound): void => {
		for (const listener of listeners) listener(message);
	};
	return {
		send(message) {
			queueMicrotask(() => {
				if (message.type === "ping") {
					emit({ type: "pong", id: message.id });
					return;
				}
				emit({ type: "error", id: message.id, error: errorMessage });
			});
		},
		onMessage(handler) {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		onError() {
			return () => {};
		},
		async terminate() {
			listeners.clear();
		},
	};
}

function spawnSttWorker(): WorkerHandle {
	try {
		return wrapSubprocess(createSttSubprocess());
	} catch (error) {
		logger.warn("stt worker spawn failed; speech-to-text disabled", {
			error: error instanceof Error ? error.message : String(error),
		});
		return spawnInlineUnavailableWorker(error);
	}
}

function logWorkerMessage(message: Extract<SttWorkerOutbound, { type: "log" }>): void {
	if (message.level === "debug") logger.debug(message.msg, message.meta);
	else if (message.level === "warn") logger.warn(message.msg, message.meta);
	else logger.error(message.msg, message.meta);
}

export class SttClient {
	#worker: WorkerHandle | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#streams = new Map<string, StreamState>();
	#progressListeners = new Set<(event: SttProgressEvent) => void>();
	#nextRequestId = 0;
	#spawnWorker: () => WorkerHandle;

	constructor(spawnWorker: () => WorkerHandle = spawnSttWorker) {
		this.#spawnWorker = spawnWorker;
	}

	onProgress(listener: (event: SttProgressEvent) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	/**
	 * Transcribe 16 kHz mono audio on the warm worker. Rejects with the worker
	 * error on failure and with an `AbortError` when the signal fires (the warm
	 * worker keeps the model loaded across calls — the model is never reloaded).
	 */
	async transcribe(modelKey: SttModelKey, audio: Float32Array, options: SttTranscribeOptions = {}): Promise<string> {
		options.signal?.throwIfAborted();
		const worker = this.#ensureWorker();
		const id = String(++this.#nextRequestId);
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#pending.set(id, { kind: "transcribe", modelKey, resolve, reject });
		const abort = (): void => {
			const pending = this.#pending.get(id);
			if (pending?.kind !== "transcribe") return;
			this.#pending.delete(id);
			pending.reject(new DOMException("The operation was aborted.", "AbortError"));
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		try {
			worker.send({ type: "transcribe", id, modelKey, audio, language: options.language });
			return await promise;
		} finally {
			options.signal?.removeEventListener("abort", abort);
			this.#pending.delete(id);
		}
	}

	/**
	 * Open a live streaming session on the warm worker. Audio fed through the
	 * returned handle is segmented by the worker's endpointer: `onSegment` fires
	 * once per committed segment and `onPartial` for the volatile in-progress
	 * preview. `stop()` resolves with the full joined transcript; `cancel()` (or
	 * an aborted signal) tears the session down and resolves `stop()` with "".
	 */
	startStream(modelKey: SttModelKey, options: SttStreamOptions = {}): SttStreamHandle {
		const worker = this.#ensureWorker();
		const id = String(++this.#nextRequestId);
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const signal = options.signal;
		let settled = false;
		const onAbort = (): void => handle.cancel();
		const finish = (apply: () => void): void => {
			if (settled) return;
			settled = true;
			this.#streams.delete(id);
			signal?.removeEventListener("abort", onAbort);
			apply();
		};
		this.#streams.set(id, {
			modelKey,
			onPartial: options.onPartial,
			onSegment: options.onSegment,
			resolve,
			reject,
			finish,
		});
		worker.send({ type: "stream_start", id, modelKey, language: options.language });
		const handle: SttStreamHandle = {
			pushAudio: audio => {
				if (!settled) worker.send({ type: "stream_audio", id, audio });
			},
			stop: () => {
				if (!settled) worker.send({ type: "stream_stop", id });
				return promise;
			},
			cancel: () => {
				if (settled) return;
				worker.send({ type: "stream_cancel", id });
				finish(() => resolve(""));
			},
		};
		if (signal?.aborted) handle.cancel();
		else signal?.addEventListener("abort", onAbort, { once: true });
		return handle;
	}

	async downloadModel(modelKey: SttModelKey, options: SttDownloadOptions = {}): Promise<boolean> {
		if (options.signal?.aborted) return false;
		const unsubscribe = options.onProgress ? this.onProgress(options.onProgress) : undefined;
		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			this.#pending.set(id, { kind: "download", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "download") return;
				this.#pending.delete(id);
				pending.resolve(false);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				worker.send({ type: "download", id, modelKey });
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#pending.delete(id);
			}
		} catch (error) {
			logger.debug("stt: local model download failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		} finally {
			unsubscribe?.();
		}
	}

	async terminate(): Promise<void> {
		const worker = this.#worker;
		this.#worker = null;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = null;
		this.#unsubscribeError?.();
		this.#unsubscribeError = null;
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "transcribe") pending.reject(new Error("stt worker terminated"));
			else pending.resolve(false);
		}
		this.#pending.clear();
		this.#failStreams(new Error("stt worker terminated"));
		try {
			await worker?.terminate();
		} catch {
			// Already gone.
		}
	}

	#ensureWorker(): WorkerHandle {
		if (this.#worker) return this.#worker;
		const worker = this.#spawnWorker();
		this.#worker = worker;
		this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		return worker;
	}

	#handleMessage(message: SttWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "progress") {
			this.#emitProgress(message.event);
			return;
		}
		if (message.type === "pong") return;

		if (message.type === "partial" || message.type === "segment" || message.type === "stream_done") {
			const stream = this.#streams.get(message.id);
			if (!stream) return;
			if (message.type === "partial") stream.onPartial?.(message.text);
			else if (message.type === "segment") stream.onSegment?.(message.text, message.index);
			else stream.finish(() => stream.resolve(message.text));
			return;
		}

		const pending = this.#pending.get(message.id);
		if (!pending) {
			if (message.type === "error") {
				const stream = this.#streams.get(message.id);
				if (stream) {
					this.#emitProgress({ modelKey: stream.modelKey, status: "error" });
					stream.finish(() => stream.reject(new Error(message.error)));
				}
			}
			return;
		}
		this.#pending.delete(message.id);
		if (message.type === "transcription") {
			if (pending.kind === "transcribe") pending.resolve(message.text);
			return;
		}
		if (message.type === "downloaded") {
			if (pending.kind === "download") pending.resolve(true);
			return;
		}
		// message.type === "error"
		this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
		if (pending.kind === "transcribe") pending.reject(new Error(message.error));
		else pending.resolve(false);
	}

	#emitProgress(event: SttProgressEvent): void {
		for (const listener of this.#progressListeners) listener(event);
	}

	#failStreams(error: Error): void {
		for (const stream of [...this.#streams.values()]) {
			this.#emitProgress({ modelKey: stream.modelKey, status: "error" });
			stream.finish(() => stream.reject(error));
		}
	}

	#handleWorkerError(error: Error): void {
		logger.warn("stt: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "transcribe") pending.reject(error);
			else pending.resolve(false);
		}
		this.#pending.clear();
		this.#failStreams(error);
		void this.terminate();
	}
}

export const sttClient = new SttClient();

export async function shutdownSttClient(): Promise<void> {
	await sttClient.terminate();
}

export async function smokeTestSttWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	const handle = wrapSubprocess(createSttSubprocess());
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => reject(new Error(`stt worker did not pong within ${timeoutMs}ms`)), timeoutMs);
	const unsubscribeMessage = handle.onMessage(message => {
		if (message.type === "pong") {
			resolve();
			return;
		}
		if (message.type === "log") return;
		reject(new Error(`stt worker: expected pong, got ${JSON.stringify(message)}`));
	});
	const unsubscribeError = handle.onError(reject);
	try {
		handle.send({ type: "ping", id: "smoke" } satisfies SttWorkerInbound);
		await promise;
	} finally {
		clearTimeout(timer);
		unsubscribeMessage();
		unsubscribeError();
		await handle.terminate();
	}
}

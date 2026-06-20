import * as path from "node:path";
import { $env, isBunTestRuntime, isCompiledBinary, logger, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { settings } from "../config/settings";
import { tinyWorkerEnvOverlay } from "../tiny/title-client";
import { safeSend } from "../utils/ipc";
import { isTtsLocalModelKey, type TtsLocalModelKey } from "./models";
import type { TtsProgressEvent, TtsWorkerInbound, TtsWorkerOutbound } from "./tts-protocol";

/** Decoded PCM returned by a local synthesis request. */
export interface TtsAudio {
	pcm: Float32Array;
	sampleRate: number;
}

/**
 * Abstraction over the TTS subprocess. The runtime implementation is a Bun child
 * process so `onnxruntime-node`'s NAPI finalizer never runs inside the main agent
 * address space — that destructor segfaults Bun during shutdown (issue #1606).
 */
interface WorkerHandle {
	send(message: TtsWorkerInbound): void;
	onMessage(handler: (message: TtsWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	/** Re-reference the subprocess so a pending request keeps the parent event loop alive. */
	ref(): void;
	/** Drop the reference once the worker is idle so it never blocks process exit. */
	unref(): void;
	terminate(): Promise<void>;
}

type PendingRequest =
	| { kind: "synthesize"; modelKey: TtsLocalModelKey; resolve: (audio: TtsAudio | null) => void }
	| { kind: "download"; modelKey: TtsLocalModelKey; resolve: (ok: boolean) => void }
	| { kind: "stream"; modelKey: TtsLocalModelKey; channel: AudioChunkChannel };

export interface TtsSynthesizeOptions {
	voice?: string;
	signal?: AbortSignal;
}

export interface TtsDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: TtsProgressEvent) => void;
}

export interface TtsStreamOptions {
	voice?: string;
	signal?: AbortSignal;
}

/** One synthesized sentence of a streaming session, in emission order. */
export interface TtsAudioChunk {
	index: number;
	text: string;
	pcm: Float32Array;
	sampleRate: number;
}

/**
 * A live streaming-synthesis session. Feed text incrementally with {@link push}
 * and close the input with {@link end}; `chunks` yields each synthesized
 * sentence's audio as soon as it is ready, then completes once the worker
 * finishes draining the closed input.
 */
export interface TtsStreamHandle {
	push(text: string): void;
	end(): void;
	chunks: AsyncIterableIterator<TtsAudioChunk>;
}

/**
 * Single-producer/single-consumer async queue bridging the worker's IPC
 * `audio-chunk` messages to an async iterator. Chunks pushed while no consumer
 * is awaiting are buffered in order; {@link close} ends the iterator and
 * {@link fail} surfaces an error to the awaiting (or next) consumer.
 */
class AudioChunkChannel {
	#queue: TtsAudioChunk[] = [];
	#waiters: Array<{
		resolve: (result: IteratorResult<TtsAudioChunk>) => void;
		reject: (error: Error) => void;
	}> = [];
	#error: Error | null = null;
	#settled = false;
	#onSettle: (() => void) | undefined;

	constructor(onSettle?: () => void) {
		this.#onSettle = onSettle;
	}

	push(chunk: TtsAudioChunk): void {
		if (this.#settled) return;
		const waiter = this.#waiters.shift();
		if (waiter) waiter.resolve({ value: chunk, done: false });
		else this.#queue.push(chunk);
	}

	close(): void {
		this.#settle(null);
	}

	fail(error: Error): void {
		this.#settle(error);
	}

	#settle(error: Error | null): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#error = error;
		for (const waiter of this.#waiters) {
			if (error) waiter.reject(error);
			else waiter.resolve({ value: undefined, done: true });
		}
		this.#waiters = [];
		this.#onSettle?.();
	}

	async *iterator(): AsyncIterableIterator<TtsAudioChunk> {
		while (true) {
			const buffered = this.#queue.shift();
			if (buffered) {
				yield buffered;
				continue;
			}
			if (this.#error) throw this.#error;
			if (this.#settled) return;
			const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<TtsAudioChunk>>();
			this.#waiters.push({ resolve, reject });
			const result = await promise;
			if (result.done) return;
			yield result.value;
		}
	}
}

// Cold-starting the worker from a compiled binary (decompress + module graph load)
// is slow on contended CI runners; the probe only proves the worker spawns and
// ponges, so a generous bound removes flakes without weakening the check.
const SMOKE_TEST_TIMEOUT_MS = 30_000;

/**
 * Hidden subcommand on the main CLI that boots the TTS worker in the spawned
 * subprocess. Kept in sync with the dispatch in `cli.ts` (Main-owned).
 */
export const TTS_WORKER_ARG = "__omp_worker_tts";

function readTinyModelSetting(path: "providers.tinyModelDevice" | "providers.tinyModelDtype"): string | undefined {
	try {
		const value = settings.get(path);
		return typeof value === "string" ? value : undefined;
	} catch {
		// Settings may be uninitialized (e.g. `omp --smoke-test`); fall back to env/default.
		return undefined;
	}
}

/**
 * Env handed to the TTS subprocess. The `PI_TINY_DEVICE` / `PI_TINY_DTYPE` env
 * vars win; otherwise the persisted `providers.tinyModelDevice` /
 * `providers.tinyModelDtype` settings are mapped onto those vars so the
 * subprocess's env-based resolution governs speech the same way it governs the
 * tiny LLM worker.
 */
function ttsWorkerEnv(): Record<string, string> {
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

interface TtsWorkerSpawnCommand {
	cmd: string[];
	cwd?: string;
}

/**
 * Resolve the command used to relaunch the agent CLI into TTS-worker mode. In a
 * compiled binary the entry point is the binary itself; otherwise re-enter the
 * declared worker-host entry (cwd-relative for reliable Bun IPC), falling back
 * to this package's own `src/cli.ts` when no host entry is declared (bun test).
 */
function ttsWorkerSpawnCmd(): TtsWorkerSpawnCommand {
	if (isCompiledBinary()) return { cmd: [process.execPath, TTS_WORKER_ARG] };
	const hostEntry = workerHostEntry();
	if (hostEntry) {
		return { cmd: [process.execPath, path.basename(hostEntry), TTS_WORKER_ARG], cwd: path.dirname(hostEntry) };
	}
	const packageRoot = path.resolve(import.meta.dir, "..", "..");
	return { cmd: [process.execPath, "src/cli.ts", TTS_WORKER_ARG], cwd: packageRoot };
}

interface SpawnedSubprocess {
	proc: Subprocess<"ignore", "ignore", "ignore">;
	inbound: Set<(message: TtsWorkerOutbound) => void>;
	errors: Set<(error: Error) => void>;
	/** Flipped to `true` right before the deliberate SIGKILL so `onExit` can tell it apart from a crash. */
	intentionalExit: { value: boolean };
}

/**
 * Spawn the TTS worker as a subprocess. Exported for tests and the smoke probe;
 * production callers go through {@link spawnTtsWorker}.
 */
export function createTtsSubprocess(): SpawnedSubprocess {
	const inbound = new Set<(message: TtsWorkerOutbound) => void>();
	const errors = new Set<(error: Error) => void>();
	const intentionalExit = { value: false };
	const spawnCommand = ttsWorkerSpawnCmd();
	const proc = Bun.spawn({
		cmd: spawnCommand.cmd,
		cwd: spawnCommand.cwd,
		env: ttsWorkerEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		serialization: "advanced",
		windowsHide: true,
		ipc(message) {
			for (const handler of inbound) handler(message as TtsWorkerOutbound);
		},
		onExit(_proc, exitCode, signalCode) {
			if (exitCode === 0) return;
			if (exitCode === null && intentionalExit.value) return;
			const reason = exitCode !== null ? `code ${exitCode}` : `signal ${signalCode ?? "unknown"}`;
			const err = new Error(`tts subprocess exited with ${reason}`);
			for (const handler of errors) handler(err);
		},
	});
	// Don't keep the parent event loop alive on an idle worker; the dispose path
	// calls `terminate()` explicitly. Bun's test runner starves IPC for unref'd
	// subprocesses, so keep it referenced only under tests.
	if (!isBunTestRuntime()) proc.unref();
	return { proc, inbound, errors, intentionalExit };
}

function wrapSubprocess({ proc, inbound, errors, intentionalExit }: SpawnedSubprocess): WorkerHandle {
	return {
		send(message) {
			safeSend(proc, message, "tts");
		},
		onMessage(handler) {
			inbound.add(handler);
			return () => inbound.delete(handler);
		},
		onError(handler) {
			errors.add(handler);
			return () => errors.delete(handler);
		},
		ref() {
			try {
				proc.ref();
			} catch {
				// Already gone.
			}
		},
		unref() {
			try {
				proc.unref();
			} catch {
				// Already gone.
			}
		},
		async terminate() {
			// SIGKILL: the point of subprocess isolation is that the parent never
			// runs `onnxruntime-node`'s NAPI finalizer (it crashes Bun on Windows).
			// Hard-kill instead; the OS reclaims the model memory.
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
	const listeners = new Set<(message: TtsWorkerOutbound) => void>();
	const errorMessage = error instanceof Error ? error.message : String(error);
	const emit = (message: TtsWorkerOutbound): void => {
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
		ref() {},
		unref() {},
		async terminate() {
			listeners.clear();
		},
	};
}

function spawnTtsWorker(): WorkerHandle {
	try {
		return wrapSubprocess(createTtsSubprocess());
	} catch (error) {
		logger.warn("TTS worker spawn failed; local TTS disabled", {
			error: error instanceof Error ? error.message : String(error),
		});
		return spawnInlineUnavailableWorker(error);
	}
}

function logWorkerMessage(message: Extract<TtsWorkerOutbound, { type: "log" }>): void {
	if (message.level === "debug") logger.debug(message.msg, message.meta);
	else if (message.level === "warn") logger.warn(message.msg, message.meta);
	else logger.error(message.msg, message.meta);
}

export class TtsClient {
	#worker: WorkerHandle | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#progressListeners = new Set<(event: TtsProgressEvent) => void>();
	#nextRequestId = 0;
	#refed = false;
	#spawnWorker: () => WorkerHandle;

	constructor(spawnWorker: () => WorkerHandle = spawnTtsWorker) {
		this.#spawnWorker = spawnWorker;
	}

	onProgress(listener: (event: TtsProgressEvent) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	async synthesize(modelKey: string, text: string, options: TtsSynthesizeOptions = {}): Promise<TtsAudio | null> {
		if (!isTtsLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted) return null;

		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<TtsAudio | null>();
			this.#addPending(id, { kind: "synthesize", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "synthesize") return;
				this.#deletePending(id);
				pending.resolve(null);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				const request: TtsWorkerInbound = options.voice
					? { type: "synthesize", id, modelKey, text, voice: options.voice }
					: { type: "synthesize", id, modelKey, text };
				worker.send(request);
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
		} catch (error) {
			logger.debug("tts: local synthesis failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * Open a streaming-synthesis session. Text is fed incrementally through the
	 * returned handle's `push`/`end`; audio is emitted one synthesized sentence at
	 * a time via `chunks`, so playback can begin before the full text is known.
	 * Returns an inert handle (immediately-ended `chunks`) for unknown models or
	 * an already-aborted signal, and fails the iterator if the worker cannot spawn.
	 */
	synthesizeStream(modelKey: string, options: TtsStreamOptions = {}): TtsStreamHandle {
		if (!isTtsLocalModelKey(modelKey) || options.signal?.aborted) {
			const channel = new AudioChunkChannel();
			channel.close();
			return { push: () => {}, end: () => {}, chunks: channel.iterator() };
		}

		let worker: WorkerHandle;
		try {
			worker = this.#ensureWorker();
		} catch (error) {
			logger.debug("tts: stream synthesis failed to start", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			const channel = new AudioChunkChannel();
			channel.fail(error instanceof Error ? error : new Error(String(error)));
			return { push: () => {}, end: () => {}, chunks: channel.iterator() };
		}

		const id = String(++this.#nextRequestId);
		const signal = options.signal;
		let closed = false;
		let ended = false;
		const abort = (): void => {
			if (closed) return;
			closed = true;
			ended = true;
			if (!this.#pending.has(id)) return;
			this.#deletePending(id);
			worker.send({ type: "stream-cancel", id });
			channel.close();
		};
		const channel = new AudioChunkChannel(() => signal?.removeEventListener("abort", abort));
		this.#addPending(id, { kind: "stream", modelKey, channel });
		signal?.addEventListener("abort", abort, { once: true });

		const start: TtsWorkerInbound = options.voice
			? { type: "stream-start", id, modelKey, voice: options.voice }
			: { type: "stream-start", id, modelKey };
		worker.send(start);

		return {
			push: (text: string) => {
				if (!closed && !ended) worker.send({ type: "stream-push", id, text });
			},
			end: () => {
				if (closed || ended) return;
				ended = true;
				worker.send({ type: "stream-end", id });
			},
			chunks: channel.iterator(),
		};
	}

	async downloadModel(modelKey: string, options: TtsDownloadOptions = {}): Promise<boolean> {
		if (!isTtsLocalModelKey(modelKey)) return false;
		if (options.signal?.aborted) return false;

		const unsubscribe = options.onProgress ? this.onProgress(options.onProgress) : undefined;
		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			this.#addPending(id, { kind: "download", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "download") return;
				this.#deletePending(id);
				pending.resolve(false);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				worker.send({ type: "download", id, modelKey });
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
		} catch (error) {
			logger.debug("tts: local model download failed", {
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
			if (pending.kind === "synthesize") pending.resolve(null);
			else if (pending.kind === "download") pending.resolve(false);
			else pending.channel.close();
		}
		this.#pending.clear();
		this.#refed = false;
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

	/** Register a pending request and keep the worker referenced while work is in flight. */
	#addPending(id: string, request: PendingRequest): void {
		this.#pending.set(id, request);
		this.#syncWorkerRef();
	}

	/** Drop a pending request and unref the worker once nothing is in flight. */
	#deletePending(id: string): void {
		if (this.#pending.delete(id)) this.#syncWorkerRef();
	}

	/**
	 * The TTS subprocess is spawned `unref`'d so an idle worker never blocks
	 * process exit. A short-lived CLI command (`omp say`) awaiting a request would
	 * otherwise let the event loop drain and exit before the audio arrives, so we
	 * `ref` the worker exactly while at least one request is pending.
	 */
	#syncWorkerRef(): void {
		const worker = this.#worker;
		if (!worker) return;
		const shouldRef = this.#pending.size > 0;
		if (shouldRef === this.#refed) return;
		this.#refed = shouldRef;
		if (shouldRef) worker.ref();
		else worker.unref();
	}

	#handleMessage(message: TtsWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "progress") {
			this.#emitProgress(message.event);
			return;
		}
		if (message.type === "pong") return;

		const pending = this.#pending.get(message.id);
		if (!pending) return;

		// Streaming chunks are non-terminal: keep the session registered until
		// `stream-done` (or an error) so later chunks still route to its channel.
		if (message.type === "audio-chunk") {
			if (pending.kind === "stream") {
				pending.channel.push({
					index: message.index,
					text: message.text,
					pcm: message.pcm,
					sampleRate: message.sampleRate,
				});
			}
			return;
		}

		this.#deletePending(message.id);
		if (message.type === "stream-done") {
			if (pending.kind === "stream") pending.channel.close();
			return;
		}
		if (message.type === "audio") {
			if (pending.kind === "synthesize") pending.resolve({ pcm: message.pcm, sampleRate: message.sampleRate });
			return;
		}
		if (message.type === "downloaded") {
			if (pending.kind === "download") pending.resolve(true);
			return;
		}
		logger.debug("tts: worker returned error", { error: message.error });
		this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
		if (pending.kind === "synthesize") pending.resolve(null);
		else if (pending.kind === "download") pending.resolve(false);
		else pending.channel.fail(new Error(message.error));
		void this.terminate();
	}

	#emitProgress(event: TtsProgressEvent): void {
		for (const listener of this.#progressListeners) listener(event);
	}

	#handleWorkerError(error: Error): void {
		logger.warn("tts: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "synthesize") pending.resolve(null);
			else if (pending.kind === "download") pending.resolve(false);
			else pending.channel.fail(error);
		}
		this.#pending.clear();
		void this.terminate();
	}
}

export const ttsClient = new TtsClient();

export async function shutdownTtsClient(): Promise<void> {
	await ttsClient.terminate();
}

export async function smokeTestTtsWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	const handle = wrapSubprocess(createTtsSubprocess());
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => reject(new Error(`tts worker did not pong within ${timeoutMs}ms`)), timeoutMs);
	const unsubscribeMessage = handle.onMessage(message => {
		if (message.type === "pong") {
			resolve();
			return;
		}
		if (message.type === "log") return;
		reject(new Error(`tts worker: expected pong, got ${JSON.stringify(message)}`));
	});
	const unsubscribeError = handle.onError(reject);
	try {
		handle.send({ type: "ping", id: "smoke" } satisfies TtsWorkerInbound);
		await promise;
	} finally {
		clearTimeout(timer);
		unsubscribeMessage();
		unsubscribeError();
		await handle.terminate();
	}
}

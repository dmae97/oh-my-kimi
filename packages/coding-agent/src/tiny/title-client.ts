import { isCompiledBinary, logger } from "@oh-my-pi/pi-utils";
import {
	isTinyLocalModelKey,
	isTinyMemoryLocalModelKey,
	isTinyTitleLocalModelKey,
	type TinyLocalModelKey,
	type TinyMemoryLocalModelKey,
	type TinyTitleLocalModelKey,
} from "./models";
import type { TinyTitleProgressEvent, TinyTitleWorkerInbound, TinyTitleWorkerOutbound } from "./title-protocol";

interface WorkerHandle {
	send(message: TinyTitleWorkerInbound): void;
	onMessage(handler: (message: TinyTitleWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

type PendingRequest =
	| { kind: "generate"; modelKey: TinyTitleLocalModelKey; resolve: (title: string | null) => void }
	| { kind: "complete"; modelKey: TinyMemoryLocalModelKey; resolve: (text: string | null) => void }
	| { kind: "download"; modelKey: TinyLocalModelKey; resolve: (ok: boolean) => void };

export interface TinyTitleDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: TinyTitleProgressEvent) => void;
}

const SMOKE_TEST_TIMEOUT_MS = 5_000;

export function createTinyTitleWorker(): Worker {
	return isCompiledBinary()
		? new Worker("./packages/coding-agent/src/tiny/worker.ts", { type: "module" })
		: new Worker(new URL("./worker.ts", import.meta.url).href, { type: "module" });
}

function wrapBunWorker(worker: Worker): WorkerHandle {
	(worker as Worker & { unref?: () => void }).unref?.();
	return {
		send(message) {
			worker.postMessage(message);
		},
		onMessage(handler) {
			const wrap = (event: MessageEvent): void => handler(event.data as TinyTitleWorkerOutbound);
			worker.addEventListener("message", wrap);
			return () => worker.removeEventListener("message", wrap);
		},
		onError(handler) {
			const wrap = (event: ErrorEvent): void => {
				handler(event.error instanceof Error ? event.error : new Error(event.message || "tiny title worker error"));
			};
			worker.addEventListener("error", wrap);
			return () => worker.removeEventListener("error", wrap);
		},
		async terminate() {
			worker.terminate();
		},
	};
}

function spawnInlineUnavailableWorker(error: unknown): WorkerHandle {
	const listeners = new Set<(message: TinyTitleWorkerOutbound) => void>();
	const errorMessage = error instanceof Error ? error.message : String(error);
	const emit = (message: TinyTitleWorkerOutbound): void => {
		for (const listener of listeners) listener(message);
	};
	return {
		send(message) {
			queueMicrotask(() => {
				if (message.type === "ping") {
					emit({ type: "pong", id: message.id });
					return;
				}
				if (message.type === "close") {
					emit({ type: "closed" });
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

function spawnTinyTitleWorker(): WorkerHandle {
	try {
		return wrapBunWorker(createTinyTitleWorker());
	} catch (error) {
		logger.warn("Tiny title Worker spawn failed; local titles disabled", {
			error: error instanceof Error ? error.message : String(error),
		});
		return spawnInlineUnavailableWorker(error);
	}
}

function logWorkerMessage(message: Extract<TinyTitleWorkerOutbound, { type: "log" }>): void {
	if (message.level === "debug") logger.debug(message.msg, message.meta);
	else if (message.level === "warn") logger.warn(message.msg, message.meta);
	else logger.error(message.msg, message.meta);
}

export class TinyTitleClient {
	#worker: WorkerHandle | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#progressListeners = new Set<(event: TinyTitleProgressEvent) => void>();
	#nextRequestId = 0;

	onProgress(listener: (event: TinyTitleProgressEvent) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	async generate(modelKey: string, message: string, signal?: AbortSignal): Promise<string | null> {
		if (!isTinyTitleLocalModelKey(modelKey)) return null;
		if (signal?.aborted) return null;

		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<string | null>();
			this.#pending.set(id, { kind: "generate", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "generate") return;
				this.#pending.delete(id);
				pending.resolve(null);
			};
			signal?.addEventListener("abort", abort, { once: true });
			try {
				worker.send({ type: "generate", id, modelKey, message });
				return await promise;
			} finally {
				signal?.removeEventListener("abort", abort);
				this.#pending.delete(id);
			}
		} catch (error) {
			logger.debug("tiny-title: local generation failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	async complete(
		modelKey: string,
		prompt: string,
		options: { maxTokens?: number; signal?: AbortSignal } = {},
	): Promise<string | null> {
		if (!isTinyMemoryLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted) return null;

		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<string | null>();
			this.#pending.set(id, { kind: "complete", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "complete") return;
				this.#pending.delete(id);
				pending.resolve(null);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				worker.send({ type: "complete", id, modelKey, prompt, maxTokens: options.maxTokens });
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#pending.delete(id);
			}
		} catch (error) {
			logger.debug("tiny-model: local completion failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	async downloadModel(modelKey: string, options: TinyTitleDownloadOptions = {}): Promise<boolean> {
		if (!isTinyLocalModelKey(modelKey)) return false;
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
			logger.debug("tiny-title: local model download failed", {
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
			if (pending.kind === "generate" || pending.kind === "complete") pending.resolve(null);
			else pending.resolve(false);
		}
		this.#pending.clear();
		try {
			worker?.send({ type: "close" });
		} catch {
			// Worker may already be gone.
		}
	}

	#ensureWorker(): WorkerHandle {
		if (this.#worker) return this.#worker;
		const worker = spawnTinyTitleWorker();
		this.#worker = worker;
		this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		return worker;
	}

	#handleMessage(message: TinyTitleWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "progress") {
			this.#emitProgress(message.event);
			return;
		}
		if (message.type === "closed") return;
		if (message.type === "pong") return;

		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		if (message.type === "title") {
			if (pending.kind === "generate") pending.resolve(message.title);
			return;
		}
		if (message.type === "downloaded") {
			if (pending.kind === "download") pending.resolve(true);
			return;
		}
		if (message.type === "completion") {
			if (pending.kind === "complete") pending.resolve(message.text);
			return;
		}
		logger.debug("tiny-title: worker returned error", { error: message.error });
		this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
		if (pending.kind === "generate" || pending.kind === "complete") pending.resolve(null);
		else pending.resolve(false);
	}

	#emitProgress(event: TinyTitleProgressEvent): void {
		for (const listener of this.#progressListeners) listener(event);
	}

	#handleWorkerError(error: Error): void {
		logger.warn("tiny-title: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "generate" || pending.kind === "complete") pending.resolve(null);
			else pending.resolve(false);
		}
		this.#pending.clear();
		void this.terminate();
	}
}

export const tinyTitleClient = new TinyTitleClient();

/** Alias for the shared tiny-model worker client (titles + memory completions). */
export const tinyModelClient = tinyTitleClient;

export async function shutdownTinyTitleClient(): Promise<void> {
	await tinyTitleClient.terminate();
}

export async function smokeTestTinyTitleWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	const worker = createTinyTitleWorker();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => reject(new Error(`tiny title worker did not pong within ${timeoutMs}ms`)), timeoutMs);
	worker.onmessage = (event: MessageEvent<TinyTitleWorkerOutbound>) => {
		const message = event.data;
		if (message.type === "pong") {
			resolve();
			return;
		}
		reject(new Error(`tiny title worker: expected pong, got ${JSON.stringify(message)}`));
	};
	worker.onerror = (event: ErrorEvent) => {
		reject(event.error instanceof Error ? event.error : new Error(event.message || "tiny title worker error"));
	};
	try {
		worker.postMessage({ type: "ping", id: "smoke" } satisfies TinyTitleWorkerInbound);
		await promise;
	} finally {
		clearTimeout(timer);
		worker.terminate();
	}
}

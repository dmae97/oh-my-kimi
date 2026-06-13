import assert from "node:assert/strict";

export class AbortError extends Error {
	constructor(signal: AbortSignal) {
		assert(signal.aborted, "Abort signal must be aborted");

		const message = signal.reason instanceof Error ? signal.reason.message : "Cancelled";
		super(`Aborted: ${message}`, { cause: signal.reason });
		this.name = "AbortError";
	}
}

type AbortableStreamReadResult<T> = { done: true; value?: T } | { done: false; value: T };

interface AbortableStreamReader<T> {
	read(): Promise<AbortableStreamReadResult<T>>;
	cancel(reason?: unknown): Promise<void>;
	releaseLock(): void;
}

/**
 * Creates an abortable stream from a given stream and signal.
 *
 * Unlike `stream.pipeThrough(..., { signal })`, this explicitly cancels the
 * source reader when the signal aborts. That propagates HTTP-client disconnects
 * and stream watchdog timeouts all the way to the backend request instead of
 * only stopping the local consumer.
 *
 * @param stream - The stream to make abortable
 * @param signal - The signal to abort the stream
 * @returns The abortable stream
 */
export function createAbortableStream<T>(stream: ReadableStream<T>, signal?: AbortSignal): ReadableStream<T> {
	if (!signal) return stream;
	let reader: AbortableStreamReader<T> | undefined;
	let closed = false;
	let onAbort: (() => void) | undefined;

	const cleanup = () => {
		if (onAbort) signal.removeEventListener("abort", onAbort);
		onAbort = undefined;
		const currentReader = reader;
		reader = undefined;
		try {
			currentReader?.releaseLock();
		} catch {}
	};

	const cancelReader = (reason: unknown): Promise<void> => {
		if (closed) return Promise.resolve();
		closed = true;
		const currentReader = reader;
		reader = undefined;
		if (onAbort) signal.removeEventListener("abort", onAbort);
		onAbort = undefined;
		if (!currentReader) return Promise.resolve();
		return currentReader
			.cancel(reason)
			.catch(() => {})
			.finally(() => {
				try {
					currentReader.releaseLock();
				} catch {}
			});
	};

	return new ReadableStream<T>({
		start(controller) {
			reader = stream.getReader();
			onAbort = () => {
				void cancelReader(signal.reason);
				try {
					controller.error(new AbortError(signal));
				} catch {}
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
			void (async () => {
				try {
					for (;;) {
						const currentReader = reader;
						if (!currentReader) return;
						const { value, done } = await currentReader.read();
						if (closed) return;
						if (done) {
							closed = true;
							cleanup();
							controller.close();
							return;
						}
						controller.enqueue(value);
					}
				} catch (error) {
					if (closed) return;
					closed = true;
					cleanup();
					controller.error(signal.aborted ? new AbortError(signal) : error);
				}
			})();
		},
		cancel(reason) {
			return cancelReader(reason);
		},
	});
}

/**
 * Runs a promise-returning function (`pr`). If the given AbortSignal is aborted before or during
 * execution, the promise is rejected with a standard error.
 *
 * @param signal - Optional AbortSignal to cancel the operation
 * @param pr - Function returning a promise to run
 * @returns Promise resolving as `pr` would, or rejecting on abort
 */
export function untilAborted<T>(
	signal: AbortSignal | undefined | null,
	pr: Promise<T> | (() => Promise<T>),
): Promise<T> {
	if (!signal) return typeof pr === "function" ? pr() : pr;
	if (signal.aborted) return Promise.reject(new AbortError(signal));

	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const onAbort = () => reject(new AbortError(signal));
	signal.addEventListener("abort", onAbort, { once: true });

	void (async () => {
		try {
			resolve(await (typeof pr === "function" ? pr() : pr));
		} catch (err) {
			reject(err);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	})();

	return promise;
}

/**
 * Memoizes a function with no arguments, calling it once and caching the result.
 *
 * @param fn - Function to be called once
 * @returns A function that returns the cached result of `fn`
 */
export function once<T>(fn: () => T): () => T {
	let store = undefined as { value: T } | undefined;
	return () => {
		if (store) {
			return store.value;
		}
		const value = fn();
		store = { value };
		return value;
	};
}

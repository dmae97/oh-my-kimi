function abortReason(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	if (typeof reason === "string") return new Error(reason);
	return new Error("Request was aborted");
}

/**
 * Iterates a provider stream until it yields, ends, errors, or the caller aborts.
 */
export async function* iterateUntilAbort<T>(iterable: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
	const iterator = iterable[Symbol.asyncIterator]();
	const closeIterator = (): void => {
		const returnPromise = iterator.return?.();
		if (returnPromise) {
			void returnPromise.catch(() => {});
		}
	};

	if (signal?.aborted) {
		closeIterator();
		throw abortReason(signal);
	}

	const withResult = (promise: Promise<IteratorResult<T>>) =>
		promise.then(
			result => ({ kind: "next" as const, result }),
			error => ({ kind: "error" as const, error }),
		);

	while (true) {
		if (signal?.aborted) {
			closeIterator();
			throw abortReason(signal);
		}
		const racers: Array<
			Promise<{ kind: "next"; result: IteratorResult<T> } | { kind: "error"; error: unknown } | { kind: "abort" }>
		> = [withResult(iterator.next())];
		let abortListener: (() => void) | undefined;
		let resolveAbort: ((value: { kind: "abort" }) => void) | undefined;
		if (signal) {
			const { promise, resolve } = Promise.withResolvers<{ kind: "abort" }>();
			resolveAbort = resolve;
			abortListener = () => resolve({ kind: "abort" });
			signal.addEventListener("abort", abortListener, { once: true });
			racers.push(promise);
		}

		try {
			const outcome = await Promise.race(racers);
			if (outcome.kind === "abort") {
				closeIterator();
				throw abortReason(signal!);
			}
			if (outcome.kind === "error") {
				throw outcome.error;
			}
			if (outcome.result.done) {
				return;
			}
			yield outcome.result.value;
		} finally {
			if (abortListener && signal) {
				signal.removeEventListener("abort", abortListener);
			}
			resolveAbort?.({ kind: "abort" });
		}
	}
}

export function getAbortReason(signal: AbortSignal | undefined, fallbackReason: string): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	if (typeof signal?.reason === "string" && signal.reason.length > 0) {
		return new Error(signal.reason);
	}

	return new Error(fallbackReason);
}

export function createCancellationError(name: "AbortError" | "TimeoutError", message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

export function getExecutionCancellationError(
	result: { timedOut?: boolean },
	signal: AbortSignal | undefined,
	fallbackReason: string,
): Error {
	if (signal?.aborted) {
		return getAbortReason(signal, fallbackReason);
	}
	if (result.timedOut) {
		return createCancellationError("TimeoutError", fallbackReason);
	}
	return createCancellationError("AbortError", fallbackReason);
}

import { $env } from "@oh-my-pi/pi-utils";

const DEFAULT_OPENAI_STREAM_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS = 100_000;

function normalizeIdleTimeoutMs(value: string | undefined, fallback: number): number | undefined {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	if (parsed <= 0) return undefined;
	return Math.trunc(parsed);
}

/**
 * Returns the idle timeout used for OpenAI-family streaming transports.
 *
 * Set `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS=0` to disable the watchdog.
 */
export function getOpenAIStreamIdleTimeoutMs(): number | undefined {
	return normalizeIdleTimeoutMs($env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS, DEFAULT_OPENAI_STREAM_IDLE_TIMEOUT_MS);
}

/**
 * Returns the timeout used while waiting for the first stream event.
 * The first token can legitimately take longer than later inter-event gaps,
 * so the default never undershoots the steady-state idle timeout.
 *
 * Set `PI_STREAM_FIRST_EVENT_TIMEOUT_MS=0` to disable the watchdog.
 */
export function getStreamFirstEventTimeoutMs(idleTimeoutMs?: number): number | undefined {
	const fallback =
		idleTimeoutMs === undefined
			? DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS
			: Math.max(DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS, idleTimeoutMs);
	return normalizeIdleTimeoutMs($env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS, fallback);
}

export type Watchdog = NodeJS.Timeout | undefined;

const dummyWatchdog = setTimeout(() => {}, 1);
clearTimeout(dummyWatchdog);

/**
 * Starts a watchdog that aborts a request if no first stream event arrives in time.
 * Call `markFirstEventReceived()` as soon as the first event is observed.
 */
export function createWatchdog(timeoutMs: number | undefined, onTimeout: () => void): Watchdog {
	if (timeoutMs !== undefined && timeoutMs > 0) {
		return setTimeout(onTimeout, timeoutMs);
	}
	return undefined;
}

export interface IdleTimeoutIteratorOptions {
	watchdog?: Watchdog;
	idleTimeoutMs?: number;
	firstItemTimeoutMs?: number;
	errorMessage: string;
	firstItemErrorMessage?: string;
	onIdle?: () => void;
	onFirstItemTimeout?: () => void;
}

/**
 * Yields items from an async iterable while enforcing a maximum idle gap between items.
 *
 * The first item may use a shorter timeout so stuck requests can be aborted and retried
 * before any user-visible content has streamed.
 */
export async function* iterateWithIdleTimeout<T>(
	iterable: AsyncIterable<T>,
	options: IdleTimeoutIteratorOptions,
): AsyncGenerator<T> {
	let watchdog = options.watchdog;
	const firstItemTimeoutMs = options.firstItemTimeoutMs ?? options.idleTimeoutMs;
	if (
		(firstItemTimeoutMs === undefined || firstItemTimeoutMs <= 0) &&
		(options.idleTimeoutMs === undefined || options.idleTimeoutMs <= 0)
	) {
		for await (const item of iterable) {
			watchdog && clearTimeout(watchdog);
			watchdog = undefined;
			yield item;
		}
		return;
	}

	const iterator = iterable[Symbol.asyncIterator]();

	const withRacy = <T>(promise: Promise<T>) =>
		promise.then(
			result => ({ kind: "next" as const, result }),
			error => ({ kind: "error" as const, error }),
		);

	let onFirst: (() => void) | null = () => {
		watchdog && clearTimeout(watchdog);
		onFirst = null;
	};

	while (true) {
		const nextResultPromise = withRacy(iterator.next());
		const activeTimeoutMs = !onFirst ? options.idleTimeoutMs : firstItemTimeoutMs;

		if (activeTimeoutMs === undefined || activeTimeoutMs <= 0) {
			const outcome = await nextResultPromise;
			if (outcome.kind === "error") {
				throw outcome.error;
			}
			if (outcome.result.done) {
				return;
			}
			onFirst?.();
			yield outcome.result.value;
			continue;
		}

		const { promise: timeoutPromise, resolve: resolveTimeout } = Promise.withResolvers<{
			kind: "timeout";
		}>();
		const timer = setTimeout(() => resolveTimeout({ kind: "timeout" }), activeTimeoutMs);

		try {
			const outcome = await Promise.race([nextResultPromise, timeoutPromise]);
			if (outcome.kind === "timeout") {
				if (!onFirst) {
					options.onIdle?.();
				} else {
					options.onFirstItemTimeout?.();
				}
				const returnPromise = iterator.return?.();
				if (returnPromise) {
					void returnPromise.catch(() => {});
				}
				throw new Error(!onFirst ? options.errorMessage : (options.firstItemErrorMessage ?? options.errorMessage));
			}
			watchdog && clearTimeout(watchdog);
			watchdog = undefined;
			if (outcome.kind === "error") {
				throw outcome.error;
			}
			if (outcome.result.done) {
				return;
			}
			onFirst?.();
			yield outcome.result.value;
		} finally {
			clearTimeout(timer);
		}
	}
}

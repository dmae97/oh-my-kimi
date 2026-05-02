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
	/**
	 * Cancel iteration as soon as this signal aborts. Required for caller-driven
	 * cancellation (ESC) when the underlying transport does not surface signal
	 * aborts to the iterator (HTTP/2 proxies, native sockets, mocked fetch).
	 * Without this, the consumer sleeps on iterator.next() until the idle/first
	 * -event watchdog fires — observable as the issue #912 "Working… forever"
	 * symptom on the github-copilot provider.
	 */
	abortSignal?: AbortSignal;
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
	const abortSignal = options.abortSignal;
	const iterator = iterable[Symbol.asyncIterator]();

	const closeIterator = (): void => {
		const returnPromise = iterator.return?.();
		if (returnPromise) {
			void returnPromise.catch(() => {});
		}
	};

	if (abortSignal?.aborted) {
		closeIterator();
		throw abortReason(abortSignal);
	}

	const withRacy = <T>(promise: Promise<T>) =>
		promise.then(
			result => ({ kind: "next" as const, result }),
			error => ({ kind: "error" as const, error }),
		);

	let onFirst: (() => void) | null = () => {
		watchdog && clearTimeout(watchdog);
		onFirst = null;
	};

	const noTimeoutEnforced =
		(firstItemTimeoutMs === undefined || firstItemTimeoutMs <= 0) &&
		(options.idleTimeoutMs === undefined || options.idleTimeoutMs <= 0);

	while (true) {
		const nextResultPromise = withRacy(iterator.next());
		const activeTimeoutMs = !onFirst ? options.idleTimeoutMs : firstItemTimeoutMs;

		const racers: Array<
			Promise<
				| { kind: "next"; result: IteratorResult<T> }
				| { kind: "error"; error: unknown }
				| { kind: "timeout" }
				| { kind: "abort" }
			>
		> = [nextResultPromise];

		let timer: NodeJS.Timeout | undefined;
		let resolveTimeout: ((value: { kind: "timeout" }) => void) | undefined;
		const enforceTimeout = !noTimeoutEnforced && activeTimeoutMs !== undefined && activeTimeoutMs > 0;
		if (enforceTimeout) {
			const { promise, resolve } = Promise.withResolvers<{ kind: "timeout" }>();
			resolveTimeout = resolve;
			timer = setTimeout(() => resolve({ kind: "timeout" }), activeTimeoutMs);
			racers.push(promise);
		}

		let abortListener: (() => void) | undefined;
		let resolveAbort: ((value: { kind: "abort" }) => void) | undefined;
		if (abortSignal) {
			const { promise, resolve } = Promise.withResolvers<{ kind: "abort" }>();
			resolveAbort = resolve;
			abortListener = () => resolve({ kind: "abort" });
			abortSignal.addEventListener("abort", abortListener, { once: true });
			racers.push(promise);
		}

		try {
			const outcome = await Promise.race(racers);
			if (outcome.kind === "abort") {
				closeIterator();
				throw abortReason(abortSignal!);
			}
			if (outcome.kind === "timeout") {
				if (!onFirst) {
					options.onIdle?.();
				} else {
					options.onFirstItemTimeout?.();
				}
				closeIterator();
				throw new Error(!onFirst ? options.errorMessage : (options.firstItemErrorMessage ?? options.errorMessage));
			}
			if (outcome.kind === "error") {
				throw outcome.error;
			}
			watchdog && clearTimeout(watchdog);
			watchdog = undefined;
			if (outcome.result.done) {
				return;
			}
			onFirst?.();
			yield outcome.result.value;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			// Resolve dangling promises so the racers don't leak (Promise.race is one-shot).
			resolveTimeout?.({ kind: "timeout" });
			if (abortListener && abortSignal) {
				abortSignal.removeEventListener("abort", abortListener);
			}
			resolveAbort?.({ kind: "abort" });
		}
	}
}

function abortReason(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	if (typeof reason === "string") return new Error(reason);
	return new Error("Request was aborted");
}

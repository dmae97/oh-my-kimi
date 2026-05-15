import { $env } from "@oh-my-pi/pi-utils";

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS = 100_000;

function normalizeIdleTimeoutMs(value: string | undefined, fallback: number): number | undefined {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	if (parsed <= 0) return undefined;
	return Math.trunc(parsed);
}

/**
 * Returns the idle timeout used for provider streaming transports.
 *
 * `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` is accepted as a backward-compatible alias.
 * Set `PI_STREAM_IDLE_TIMEOUT_MS=0` to disable the watchdog.
 */
export function getStreamIdleTimeoutMs(): number | undefined {
	return normalizeIdleTimeoutMs(
		$env.PI_STREAM_IDLE_TIMEOUT_MS ?? $env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS,
		DEFAULT_STREAM_IDLE_TIMEOUT_MS,
	);
}

/**
 * Returns the idle timeout used for OpenAI-family streaming transports.
 *
 * Set `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS=0` to disable the watchdog.
 */
export function getOpenAIStreamIdleTimeoutMs(): number | undefined {
	return normalizeIdleTimeoutMs(
		$env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS ?? $env.PI_STREAM_IDLE_TIMEOUT_MS,
		DEFAULT_STREAM_IDLE_TIMEOUT_MS,
	);
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
	 * Optional semantic-progress predicate. Non-progress items are still yielded,
	 * but they do not reset the idle deadline. This prevents provider
	 * keepalive/no-op events from keeping a stalled tool call alive forever.
	 */
	isProgressItem?: (item: unknown) => boolean;
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

	let awaitingFirstItem = true;
	const markFirstItemReceived = () => {
		watchdog && clearTimeout(watchdog);
		watchdog = undefined;
		awaitingFirstItem = false;
	};
	const isProgressItem = (item: T): boolean => {
		if (!options.isProgressItem) return true;
		try {
			return options.isProgressItem(item);
		} catch {
			return true;
		}
	};
	let lastProgressAt = Date.now();

	const noTimeoutEnforced =
		(firstItemTimeoutMs === undefined || firstItemTimeoutMs <= 0) &&
		(options.idleTimeoutMs === undefined || options.idleTimeoutMs <= 0);

	while (true) {
		let activeTimeoutMs: number | undefined;
		if (awaitingFirstItem) {
			activeTimeoutMs = firstItemTimeoutMs;
		} else if (options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0) {
			activeTimeoutMs = options.idleTimeoutMs - (Date.now() - lastProgressAt);
			if (activeTimeoutMs <= 0) {
				options.onIdle?.();
				closeIterator();
				throw new Error(options.errorMessage);
			}
		}

		const nextResultPromise = withRacy(iterator.next());

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
				if (!awaitingFirstItem) {
					options.onIdle?.();
				} else {
					options.onFirstItemTimeout?.();
				}
				closeIterator();
				throw new Error(
					!awaitingFirstItem ? options.errorMessage : (options.firstItemErrorMessage ?? options.errorMessage),
				);
			}
			if (outcome.kind === "error") {
				throw outcome.error;
			}
			if (outcome.result.done) {
				markFirstItemReceived();
				return;
			}
			const item = outcome.result.value;
			markFirstItemReceived();
			if (isProgressItem(item)) {
				lastProgressAt = Date.now();
			}
			yield item;
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

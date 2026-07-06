import { untilAborted } from "@oh-my-pi/pi-utils";
import { throwIfAborted } from "../tool-errors";

/**
 * Marks a run-scoped promise as observed without changing its behavior for awaited callers.
 *
 * Browser run teardown aborts can reject promises created for evaluated code after user code
 * has stopped observing them (for example fire-and-forget `wait()`/facade calls). In 16.3.0
 * those zero-consumer rejections reached the process-level `unhandledRejection` handler and
 * killed every subagent sharing the process (issues #4499/#4672). Attaching a no-op rejection
 * handler at creation makes the promise observed while returning the original promise so callers
 * that do await it still receive the rejection.
 */
export function markHandled<T>(promise: Promise<T>): Promise<T> {
	void promise.catch(() => undefined);
	return promise;
}

/** Sleeps inside evaluated browser code while honoring the owning run's cancellation signal. */
export function waitForBrowserRun(ms: number, signal: AbortSignal): Promise<void> {
	const promise = (async (): Promise<void> => {
		throwIfAborted(signal);
		await untilAborted(signal, () => Bun.sleep(ms));
		throwIfAborted(signal);
	})();
	return markHandled(promise);
}

/** Binds a long-lived browser facade to one evaluated run's abort signal. */
export function bindBrowserRunFacade<T extends object>(target: T, signal: AbortSignal): T {
	const cache = new Map<PropertyKey, unknown>();
	return new Proxy(target, {
		get(current, prop) {
			throwIfAborted(signal);
			const cached = cache.get(prop);
			if (cached) return cached;
			const value = Reflect.get(current, prop, current);
			if (typeof value === "function") {
				const wrapped = (...args: unknown[]): unknown => {
					throwIfAborted(signal);
					const result = Reflect.apply(value, current, args);
					if (result && typeof result === "object") {
						const then = Reflect.get(result, "then");
						if (typeof then === "function") {
							return markHandled(
								Promise.resolve(result).then(resolved => {
									throwIfAborted(signal);
									return resolved;
								}),
							);
						}
					}
					throwIfAborted(signal);
					return result;
				};
				cache.set(prop, wrapped);
				return wrapped;
			}
			if (value && typeof value === "object") {
				const wrapped = bindBrowserRunFacade(value, signal);
				cache.set(prop, wrapped);
				return wrapped;
			}
			return value;
		},
	});
}

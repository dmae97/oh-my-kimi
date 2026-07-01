import { untilAborted } from "@oh-my-pi/pi-utils";
import { throwIfAborted } from "../tool-errors";

/** Sleeps inside evaluated browser code while honoring the owning run's cancellation signal. */
export async function waitForBrowserRun(ms: number, signal: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await untilAborted(signal, () => Bun.sleep(ms));
	throwIfAborted(signal);
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
							return Promise.resolve(result).then(resolved => {
								throwIfAborted(signal);
								return resolved;
							});
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

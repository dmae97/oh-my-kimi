import { afterEach, describe, expect, it, vi } from "bun:test";
import { iterateUntilAbort } from "../src/utils/abortable-iterator";

function makeSource<T>(handlers: { next: () => Promise<IteratorResult<T>>; onReturn?: () => void }): AsyncIterable<T> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<T> {
			return {
				next: handlers.next,
				async return(): Promise<IteratorResult<T>> {
					handlers.onReturn?.();
					return { done: true, value: undefined as unknown as T };
				},
			};
		},
	};
}

describe("iterateUntilAbort", () => {
	it("observes aborts that happen between yielded items and calls iterator.return()", async () => {
		const controller = new AbortController();
		let nextCalls = 0;
		let returnCalled = false;
		const source = makeSource<number>({
			next: async () => {
				nextCalls += 1;
				if (nextCalls === 1) return { done: false, value: 1 };
				const { promise } = Promise.withResolvers<IteratorResult<number>>();
				return promise;
			},
			onReturn: () => {
				returnCalled = true;
			},
		});
		const iterator = iterateUntilAbort(source, controller.signal);

		await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 });
		controller.abort();
		await expect(iterator.next()).rejects.toThrow(/abort/i);
		expect(nextCalls).toBe(1);
		expect(returnCalled).toBe(true);
	});

	it("observes aborts that fire DURING an in-flight iterator.next()", async () => {
		const controller = new AbortController();
		let returnCalled = false;
		const source = makeSource<number>({
			next: async () => {
				const { promise } = Promise.withResolvers<IteratorResult<number>>();
				return promise; // never resolves
			},
			onReturn: () => {
				returnCalled = true;
			},
		});
		const iterator = iterateUntilAbort(source, controller.signal);

		const pending = iterator.next();
		setTimeout(() => controller.abort(new Error("torn down")), 5);

		await expect(pending).rejects.toThrow(/torn down/);
		expect(returnCalled).toBe(true);
	});

	it("rejects immediately when the signal is already aborted before the first next()", async () => {
		const controller = new AbortController();
		controller.abort(new Error("preflight"));
		let returnCalled = false;
		const source = makeSource<number>({
			next: async () => ({ done: false, value: 1 }),
			onReturn: () => {
				returnCalled = true;
			},
		});

		const iterator = iterateUntilAbort(source, controller.signal);
		await expect(iterator.next()).rejects.toThrow(/preflight/);
		expect(returnCalled).toBe(true);
	});

	it("yields every item and terminates cleanly when the source completes naturally", async () => {
		const items = [1, 2, 3];
		let i = 0;
		const source = makeSource<number>({
			next: async () =>
				i < items.length
					? { done: false, value: items[i++]! }
					: { done: true, value: undefined as unknown as number },
		});

		const collected: number[] = [];
		for await (const item of iterateUntilAbort(source)) {
			collected.push(item);
		}
		expect(collected).toEqual(items);
	});

	it("propagates errors from the underlying iterator.next()", async () => {
		const source = makeSource<number>({
			next: async () => {
				throw new Error("upstream blew up");
			},
		});

		await expect(async () => {
			for await (const _ of iterateUntilAbort(source)) {
				// no body
			}
		}).toThrow("upstream blew up");
	});

	it("does not leak abort listeners across iterations", async () => {
		const controller = new AbortController();
		const addSpy = vi.spyOn(controller.signal, "addEventListener");
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

		const items = [1, 2, 3, 4, 5];
		let i = 0;
		const source = makeSource<number>({
			next: async () =>
				i < items.length
					? { done: false, value: items[i++]! }
					: { done: true, value: undefined as unknown as number },
		});

		for await (const _ of iterateUntilAbort(source, controller.signal)) {
			// no body
		}
		// Every addEventListener("abort", ...) must be paired with a removeEventListener
		// call (no leaks across iterations).
		const adds = addSpy.mock.calls.filter(([type]) => type === "abort").length;
		const removes = removeSpy.mock.calls.filter(([type]) => type === "abort").length;
		expect(adds).toBe(removes);
		expect(adds).toBeGreaterThan(0);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

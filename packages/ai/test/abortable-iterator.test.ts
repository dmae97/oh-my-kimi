import { describe, expect, it } from "bun:test";
import { iterateUntilAbort } from "../src/utils/abortable-iterator";

describe("iterateUntilAbort", () => {
	it("observes aborts that happen between yielded items", async () => {
		const controller = new AbortController();
		let nextCalls = 0;
		let returnCalled = false;
		const source: AsyncIterable<number> = {
			[Symbol.asyncIterator](): AsyncIterator<number> {
				return {
					async next(): Promise<IteratorResult<number>> {
						nextCalls += 1;
						if (nextCalls === 1) return { done: false, value: 1 };
						const { promise } = Promise.withResolvers<IteratorResult<number>>();
						return promise;
					},
					async return(): Promise<IteratorResult<number>> {
						returnCalled = true;
						return { done: true, value: 0 };
					},
				};
			},
		};
		const iterator = iterateUntilAbort(source, controller.signal);

		await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 });
		controller.abort();
		await expect(iterator.next()).rejects.toThrow(/abort/i);
		expect(nextCalls).toBe(1);
		expect(returnCalled).toBe(true);
	});
});

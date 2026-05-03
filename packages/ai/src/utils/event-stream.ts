import type { AssistantMessage, AssistantMessageEvent } from "../types";

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	queue: T[] = [];
	waiting: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (err: unknown) => void }> = [];
	done = false;
	#failed = false;
	#error: unknown = undefined;
	finalResultPromise: Promise<R>;
	resolveFinalResult!: (result: R) => void;
	rejectFinalResult!: (err: unknown) => void;
	isComplete: (event: T) => boolean;
	extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		const { promise, resolve, reject } = Promise.withResolvers<R>();
		// Prevent an unhandled rejection when fail() is called but nobody awaits result().
		// Callers who do await result() still receive the rejection normally.
		promise.catch(() => {});
		this.finalResultPromise = promise;
		this.resolveFinalResult = resolve;
		this.rejectFinalResult = reject;
		this.isComplete = isComplete;
		this.extractResult = extractResult;
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter.resolve({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	deliver(event: T): void {
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter.resolve({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter.resolve({ value: undefined as any, done: true });
		}
	}

	endWaiting(): void {
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter.resolve({ value: undefined as any, done: true });
		}
	}

	fail(err: unknown): void {
		if (this.done) return;
		this.done = true;
		this.#failed = true;
		this.#error = err;
		this.rejectFinalResult(err);
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter.reject(err);
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.#failed) {
				throw this.#error;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve, reject) =>
					this.waiting.push({ resolve, reject }),
				);
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

// Delta events that can be batched for throttling
type DeltaEvent =
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage };

function isDeltaEvent(event: AssistantMessageEvent): event is DeltaEvent {
	return event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta";
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	// Throttling state
	#deltaBuffer: DeltaEvent[] = [];
	#flushTimer?: NodeJS.Timeout;
	#lastFlushTime = 0;
	readonly #throttleMs = 50; // 20 updates/sec

	constructor() {
		super(
			event => event.type === "done" || event.type === "error",
			event => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}

	override push(event: AssistantMessageEvent): void {
		if (this.done) return;

		// Check for completion first
		if (this.isComplete(event)) {
			this.#flushDeltas(); // Flush any pending deltas before completing
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Delta events get batched and throttled
		if (isDeltaEvent(event)) {
			this.#deltaBuffer.push(event);
			this.#scheduleFlush();
			return;
		}

		// Non-delta events flush pending deltas immediately, then emit
		this.#flushDeltas();
		this.deliver(event);
	}

	override end(result?: AssistantMessage): void {
		this.#flushDeltas();
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		this.endWaiting();
	}

	override fail(err: unknown): void {
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}
		this.#deltaBuffer = [];
		super.fail(err);
	}

	#scheduleFlush(): void {
		if (this.#flushTimer) return; // Already scheduled

		const now = Bun.nanoseconds();
		const timeSinceLastFlush = (now - this.#lastFlushTime) / 1e6;

		if (timeSinceLastFlush >= this.#throttleMs) {
			// Flush immediately if throttle window has passed
			this.#flushDeltas();
		} else {
			// Schedule flush for when throttle window expires
			const delay = this.#throttleMs - timeSinceLastFlush;
			this.#flushTimer = setTimeout(() => {
				this.#flushTimer = undefined;
				this.#flushDeltas();
			}, delay);
		}
	}

	#flushDeltas(): void {
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}

		if (this.#deltaBuffer.length === 0) return;

		// Merge consecutive deltas for the same content block and type
		const merged = this.#mergeDeltas(this.#deltaBuffer);
		this.#deltaBuffer = [];
		this.#lastFlushTime = Bun.nanoseconds();

		for (const event of merged) {
			this.deliver(event);
		}
	}

	#mergeDeltas(deltas: DeltaEvent[]): AssistantMessageEvent[] {
		if (deltas.length === 0) return [];
		if (deltas.length === 1) return [deltas[0]];

		const result: AssistantMessageEvent[] = [];
		let current = deltas[0];

		for (let i = 1; i < deltas.length; i++) {
			const next = deltas[i];
			// Can merge if same type, same content index
			if (next.type === current.type && next.contentIndex === current.contentIndex) {
				current = {
					...current,
					delta: current.delta + next.delta,
					partial: next.partial, // Use latest partial
				} as DeltaEvent;
			} else {
				result.push(current);
				current = next;
			}
		}
		result.push(current);

		return result;
	}
}

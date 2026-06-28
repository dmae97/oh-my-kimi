/**
 * Regression for [#3749](https://github.com/can1357/oh-my-pi/issues/3749):
 * the per-provider concurrency cap used to bracket the whole subagent
 * lifecycle (acquired before session creation, released only after the
 * subagent yielded), so any spawn tree wider than `maxConcurrency`
 * deadlocked — parents held every slot while they waited for children
 * that were queued on the same cap. The fix moves the bracket to each
 * LLM HTTP request; this file exercises the new contract.
 */
import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { wrapStreamFnWithProviderConcurrency } from "@oh-my-pi/pi-coding-agent/task/provider-concurrency";

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

function requireModel(provider: string, id: string): Model {
	const model = getBundledModel(provider as Parameters<typeof getBundledModel>[0], id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

/**
 * Build a base StreamFn that gates each invocation through an externally
 * resolved Deferred, so the test can interleave parent and child turns
 * deterministically without leaning on wall-clock timers.
 */
function makeGatedStream(): {
	stream: StreamFn;
	gates: Deferred[];
	invocations: () => number;
	inFlight: () => number;
	peakInFlight: () => number;
} {
	let inFlight = 0;
	let peakInFlight = 0;
	let invocations = 0;
	const gates: Deferred[] = [];
	const stream: StreamFn = model => {
		const gate = deferred();
		gates.push(gate);
		invocations++;
		inFlight++;
		peakInFlight = Math.max(peakInFlight, inFlight);
		const events = new AssistantMessageEventStream();
		void gate.promise.then(() => {
			inFlight--;
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			events.push({ type: "done", reason: "stop", message });
			events.end();
		});
		return events;
	};
	return {
		stream,
		gates,
		invocations: () => invocations,
		inFlight: () => inFlight,
		peakInFlight: () => peakInFlight,
	};
}

/**
 * Drain microtasks until `check()` is true. Uses `Promise.resolve()` (a
 * microtask hop, not a real-time delay), so the wait is bounded by the
 * number of pending continuations and never burns wall-clock seconds.
 */
async function waitFor(check: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 1000 && !check(); i++) {
		await Promise.resolve();
	}
	if (!check()) {
		throw new Error(`Timed out waiting for: ${label}`);
	}
}

describe("issue #3749: provider semaphore deadlock", () => {
	it("releases the slot between LLM turns so a child can acquire while the parent is mid-conversation", async () => {
		const model = requireModel("ollama-cloud", "gpt-oss:120b");
		const settings = Settings.isolated({ "providers.ollama-cloud.maxConcurrency": 1 });
		const { stream, gates, invocations, inFlight, peakInFlight } = makeGatedStream();
		const wrapped = wrapStreamFnWithProviderConcurrency(settings, stream);

		// Parent's first turn acquires the only slot.
		const parentTurn1 = wrapped(model, { messages: [] }, {});
		await waitFor(() => invocations() === 1, "parent turn 1 invoked");
		expect(inFlight()).toBe(1);

		// Child tries to acquire while parent's first turn is in flight.
		// Under the old lifetime-scoped bracket the child would queue and
		// the parent (waiting for the child) would deadlock. The wrapper
		// bounds only the HTTP request, so the child waits one parent turn,
		// not the parent's whole lifetime.
		const childTurn = wrapped(model, { messages: [] }, {});
		await waitFor(() => gates.length === 1, "child queued");
		expect(invocations()).toBe(1);

		// Parent's first LLM stream completes → slot frees → child acquires.
		gates[0]!.resolve();
		await parentTurn1;
		await waitFor(() => invocations() === 2, "child admitted after parent turn");
		expect(inFlight()).toBe(1);

		// Child completes. Parent's second turn can now start.
		gates[1]!.resolve();
		await childTurn;

		const parentTurn2 = wrapped(model, { messages: [] }, {});
		await waitFor(() => invocations() === 3, "parent turn 2 invoked");
		gates[2]!.resolve();
		await parentTurn2;

		expect(peakInFlight()).toBe(1);
	});

	it("admits a deeper spawn tree than maxConcurrency without deadlocking", async () => {
		const model = requireModel("ollama-cloud", "gpt-oss:120b");
		const settings = Settings.isolated({ "providers.ollama-cloud.maxConcurrency": 2 });
		const { stream, gates, invocations, peakInFlight } = makeGatedStream();
		const wrapped = wrapStreamFnWithProviderConcurrency(settings, stream);

		// 3 "parents" + 6 "children" all sharing a cap of 2. The old bracket
		// would freeze after the first two parents acquired both slots.
		const parents = [0, 1, 2].map(async () => wrapped(model, { messages: [] }, {}));
		const children: Promise<unknown>[] = [];
		for (let i = 0; i < 3; i++) {
			children.push(Promise.resolve(wrapped(model, { messages: [] }, {})));
			children.push(Promise.resolve(wrapped(model, { messages: [] }, {})));
		}

		// Drain by resolving gates in submission order as they appear.
		for (let i = 0; i < 9; i++) {
			await waitFor(() => gates.length > i, `gate ${i} created`);
			gates[i]!.resolve();
		}

		await Promise.all([...parents, ...children]);
		expect(invocations()).toBe(9);
		expect(peakInFlight()).toBe(2);
	});
});

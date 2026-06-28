/**
 * Regression for the [#3751](https://github.com/can1357/oh-my-pi/pull/3751)
 * chatgpt-codex follow-up: the per-LLM-turn provider concurrency wrapper
 * (`wrapStreamFnWithProviderConcurrency`) was only attached to
 * `Agent.streamFn` / `Agent.sideStreamFn`, so direct compaction oneshots
 * (`#compactWithFallbackModel` → `compact()` → `instrumentedCompleteSimple`)
 * still went through the default `completeSimple` transport and bypassed
 * `providers.ollama-cloud.maxConcurrency`.
 *
 * The fix threads a `completeImpl` through `SummaryOptions` /
 * `GenerateBranchSummaryOptions`, and agent-session wires it to the same
 * `#sideStreamFn` the handoff path already uses. This test asserts both
 * halves of the contract:
 *  1. `SummaryOptions.completeImpl` is honored by every fan-out
 *     summarizer (history + turn-prefix + short), so the default
 *     `completeSimple` is never reached.
 *  2. When that override is built from the limiter-wrapped sideStreamFn —
 *     the exact shape agent-session installs — peak in-flight HTTP
 *     requests respect the configured cap even with a concurrent
 *     unrelated provider call.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
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

function makeAssistantMessage(text: string, model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
}

function makePreparation(model: Model): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [
			{ role: "user", content: "history msg", timestamp: 1 } satisfies AgentMessage,
			makeAssistantMessage("history reply", model),
		],
		turnPrefixMessages: [{ role: "user", content: "turn prefix msg", timestamp: 3 } satisfies AgentMessage],
		recentMessages: [{ role: "user", content: "recent msg", timestamp: 4 } satisfies AgentMessage],
		isSplitTurn: true,
		tokensBefore: 12_345,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
	};
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 1000 && !check(); i++) {
		await Promise.resolve();
	}
	if (!check()) throw new Error(`Timed out waiting for: ${label}`);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("issue #3751: compaction summaries respect provider concurrency cap", () => {
	it("compact() routes every fan-out summarizer through SummaryOptions.completeImpl", async () => {
		const model = requireModel("ollama-cloud", "gpt-oss:120b");
		const defaultSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(makeAssistantMessage("default transport must not run", model));

		const overrideCalls: { model: Model; system: string | undefined }[] = [];
		const override = async (requestModel: Model, ctx: ai.Context): Promise<AssistantMessage> => {
			overrideCalls.push({ model: requestModel, system: ctx.systemPrompt?.[0] });
			return makeAssistantMessage("summary text", requestModel);
		};

		await compact(makePreparation(model), model, "test-key", undefined, undefined, {
			completeImpl: override,
		});

		// Split-turn preparation fans out into history + turn-prefix + short.
		expect(overrideCalls).toHaveLength(3);
		expect(defaultSpy).not.toHaveBeenCalled();
		// Each summarizer ships the system prompt that documents the compaction
		// contract; we just sanity-check the override actually saw the request
		// instead of being short-circuited by remote compaction or hook paths.
		for (const call of overrideCalls) {
			expect(call.model.provider).toBe(model.provider);
			expect(typeof call.system).toBe("string");
		}
	});

	it("limiter-wrapped sideStreamFn caps compaction HTTP requests at maxConcurrency=1", async () => {
		const model = requireModel("ollama-cloud", "gpt-oss:120b");
		const settings = Settings.isolated({ "providers.ollama-cloud.maxConcurrency": 1 });

		let inFlight = 0;
		let peakInFlight = 0;
		const gates: Deferred[] = [];
		const base: StreamFn = streamModel => {
			const gate = deferred();
			gates.push(gate);
			inFlight++;
			peakInFlight = Math.max(peakInFlight, inFlight);
			const events = new AssistantMessageEventStream();
			void gate.promise.then(() => {
				inFlight--;
				events.push({ type: "done", reason: "stop", message: makeAssistantMessage("ok", streamModel) });
				events.end();
			});
			return events;
		};
		const sideStreamFn = wrapStreamFnWithProviderConcurrency(settings, base);

		// Exactly the shape agent-session.ts:#compactWithFallbackModel installs.
		const completeImpl = async (
			requestModel: Model,
			requestContext: ai.Context,
			requestOptions: ai.SimpleStreamOptions,
		): Promise<AssistantMessage> => {
			const stream = await sideStreamFn(requestModel, requestContext, requestOptions);
			return stream.result();
		};

		const defaultSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(makeAssistantMessage("default transport must not run", model));

		// Kick off compaction; it must immediately try to acquire the slot.
		const compaction = compact(makePreparation(model), model, "test-key", undefined, undefined, {
			completeImpl,
		});
		await waitFor(() => gates.length === 1, "first compaction summarizer in flight");
		expect(inFlight).toBe(1);

		// A direct sideStreamFn call (e.g. /btw, IRC reply) issued while
		// compaction is mid-flight must queue behind the held slot — proving
		// the cap is shared. Under the pre-fix wiring this would bypass the
		// limiter and run immediately, pushing peakInFlight to 2.
		const concurrent = sideStreamFn(model, { messages: [] }, {});
		await Promise.resolve();
		await Promise.resolve();
		expect(gates).toHaveLength(1);

		// Drain in submission order: 4 HTTP requests total = 3 compaction
		// summarizers + 1 concurrent side request. We intentionally do NOT
		// distinguish which gate is which — that's the whole point of the
		// shared cap. Whatever order the limiter admits them in, peak
		// in-flight must never exceed 1.
		for (let i = 0; i < 4; i++) {
			await waitFor(() => gates.length > i, `request ${i + 1} admitted`);
			expect(inFlight).toBe(1);
			gates[i]!.resolve();
		}
		await Promise.all([compaction, concurrent]);

		expect(peakInFlight).toBe(1);
		expect(defaultSpy).not.toHaveBeenCalled();
	});
});

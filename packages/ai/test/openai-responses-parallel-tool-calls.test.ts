// Regression for https://github.com/can1357/oh-my-pi/issues/1880.
//
// llama.cpp (and any OpenAI-Responses-compatible host that interleaves
// multiple function_call items) emits `output_item.added` for every parallel
// call before the deltas arrive, then routes deltas via `item_id`/`output_index`
// instead of relying on a single in-flight item. `processResponsesStream`
// previously kept a singleton `currentBlock` reference and ignored those
// identifiers, so deltas for the first call were folded into the buffer of the
// most-recently-added block. The dispatcher then received empty `{}` arguments
// for every call except the last one.
//
// These tests pin the contract: each `function_call_arguments.{delta,done}` and
// `output_item.done` event must be routed by `output_index`/`item_id`, not by
// arrival order.
import { describe, expect, test } from "bun:test";
import { processResponsesStream } from "@oh-my-pi/pi-ai/providers/openai-responses-shared";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai/types";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

function makeModel(): Model<"openai-responses"> {
	return {
		api: "openai-responses",
		name: "Llama",
		id: "llama-3",
		provider: "llama.cpp",
		baseUrl: "http://127.0.0.1:8080/v1",
		contextWindow: 8192,
		maxTokens: 2048,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function makeOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		timestamp: Date.now(),
		provider: "llama.cpp",
		model: "llama-3",
		api: "openai-responses",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

async function* makeStream(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const e of events) yield e as ResponseStreamEvent;
}

type EmittedEvent = { type?: string } & Record<string, unknown>;

describe("processResponsesStream: parallel function_call items", () => {
	test("routes deltas to the correct block when both items are added before any delta", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		const argsA = JSON.stringify({ _i: "Reading test", path: "test.txt" });
		const argsB = JSON.stringify({ _i: "Reading test", path: "test.md" });

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "read", arguments: "" },
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "read", arguments: "" },
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: 0,
					item_id: "fc_a",
					delta: argsA,
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: 1,
					item_id: "fc_b",
					delta: argsB,
				},
				{
					type: "response.function_call_arguments.done",
					output_index: 0,
					item_id: "fc_a",
					arguments: argsA,
				},
				{
					type: "response.function_call_arguments.done",
					output_index: 1,
					item_id: "fc_b",
					arguments: argsB,
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "read", arguments: argsA },
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "read", arguments: argsB },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.content).toHaveLength(2);
		const [blockA, blockB] = output.content;
		expect(blockA?.type).toBe("toolCall");
		expect(blockB?.type).toBe("toolCall");
		if (blockA?.type !== "toolCall" || blockB?.type !== "toolCall") throw new Error("expected toolCalls");
		expect(blockA.arguments).toEqual({ _i: "Reading test", path: "test.txt" });
		expect(blockB.arguments).toEqual({ _i: "Reading test", path: "test.md" });

		const ends = emitted.filter(e => e.type === "toolcall_end") as Array<{
			toolCall: { id: string; arguments: Record<string, unknown> };
			contentIndex: number;
		}>;
		expect(ends).toHaveLength(2);
		const byCallId = new Map(ends.map(e => [e.toolCall.id.split("|")[0], e]));
		expect(byCallId.get("call_a")?.toolCall.arguments).toEqual({ _i: "Reading test", path: "test.txt" });
		expect(byCallId.get("call_b")?.toolCall.arguments).toEqual({ _i: "Reading test", path: "test.md" });
		expect(byCallId.get("call_a")?.contentIndex).toBe(0);
		expect(byCallId.get("call_b")?.contentIndex).toBe(1);

		// Delta events must also carry the per-block contentIndex — otherwise the
		// streaming UI updates the wrong block while args are still arriving.
		const deltas = emitted.filter(e => e.type === "toolcall_delta") as Array<{
			delta: string;
			contentIndex: number;
		}>;
		expect(deltas).toHaveLength(2);
		const deltaForA = deltas.find(d => d.delta === argsA);
		const deltaForB = deltas.find(d => d.delta === argsB);
		expect(deltaForA?.contentIndex).toBe(0);
		expect(deltaForB?.contentIndex).toBe(1);
	});

	test("routes done-only finalization to the correct block when arguments stream as a single chunk on each item", async () => {
		// Some local Responses-compat hosts skip the per-delta protocol entirely
		// and stash the full arguments string on `output_item.added`/`done`.
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		const argsA = JSON.stringify({ path: "test.txt" });
		const argsB = JSON.stringify({ path: "test.md" });

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "read", arguments: argsA },
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "read", arguments: argsB },
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "read", arguments: argsA },
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "read", arguments: argsB },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const [blockA, blockB] = output.content;
		if (blockA?.type !== "toolCall" || blockB?.type !== "toolCall") throw new Error("expected toolCalls");
		expect(blockA.arguments).toEqual({ path: "test.txt" });
		expect(blockB.arguments).toEqual({ path: "test.md" });

		const ends = emitted.filter(e => e.type === "toolcall_end") as Array<{
			toolCall: { id: string; arguments: Record<string, unknown> };
		}>;
		expect(ends).toHaveLength(2);
		const byCallId = new Map(ends.map(e => [e.toolCall.id.split("|")[0], e]));
		expect(byCallId.get("call_a")?.toolCall.arguments).toEqual({ path: "test.txt" });
		expect(byCallId.get("call_b")?.toolCall.arguments).toEqual({ path: "test.md" });
	});

	test("routes identifierless final argument events in item order", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		const argsA = JSON.stringify({ command: "printf a" });
		const argsB = JSON.stringify({ command: "printf b" });

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash", arguments: "" },
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "bash", arguments: "" },
				},
				{
					type: "response.function_call_arguments.done",
					arguments: argsA,
				},
				{
					type: "response.function_call_arguments.done",
					arguments: argsB,
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash", arguments: "" },
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "bash", arguments: "" },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const [blockA, blockB] = output.content;
		if (blockA?.type !== "toolCall" || blockB?.type !== "toolCall") throw new Error("expected toolCalls");
		expect(blockA.arguments).toEqual({ command: "printf a" });
		expect(blockB.arguments).toEqual({ command: "printf b" });

		const ends = emitted.filter(e => e.type === "toolcall_end") as Array<{
			toolCall: { id: string; arguments: Record<string, unknown> };
		}>;
		expect(ends).toHaveLength(2);
		const byCallId = new Map(ends.map(e => [e.toolCall.id.split("|")[0], e]));
		expect(byCallId.get("call_a")?.toolCall.arguments).toEqual({ command: "printf a" });
		expect(byCallId.get("call_b")?.toolCall.arguments).toEqual({ command: "printf b" });
	});
});

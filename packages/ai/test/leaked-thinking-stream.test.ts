import { describe, expect, it } from "bun:test";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { wrapLeakedThinkingStream } from "@oh-my-pi/pi-ai/utils/leaked-thinking-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** Minimal assistant message; `content`/`stopReason` overridden per event. */
function msg(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

/**
 * Drive the wrapper: push inner events synchronously, then drain the healed
 * output. Returns every emitted event plus the resolved final message.
 */
async function runWrapper(
	feed: (inner: AssistantMessageEventStream) => void,
): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
	const inner = new AssistantMessageEventStream();
	const out = wrapLeakedThinkingStream(inner);
	feed(inner);
	const events: AssistantMessageEvent[] = [];
	for await (const event of out) events.push(event);
	const result = await out.result();
	return { events, result };
}

function texts(message: AssistantMessage): string[] {
	return message.content.filter((b): b is TextContent => b.type === "text").map(b => b.text);
}

function thinks(message: AssistantMessage): ThinkingContent[] {
	return message.content.filter((b): b is ThinkingContent => b.type === "thinking");
}

describe("wrapLeakedThinkingStream", () => {
	async function runLeakedText(chunks: readonly string[]): Promise<{
		events: AssistantMessageEvent[];
		result: AssistantMessage;
	}> {
		let text = "";
		return runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({ type: "text_start", contentIndex: 0, partial: msg({ content: [{ type: "text", text: "" }] }) });
			for (const chunk of chunks) {
				text += chunk;
				inner.push({
					type: "text_delta",
					contentIndex: 0,
					delta: chunk,
					partial: msg({ content: [{ type: "text", text }] }),
				});
			}
			inner.push({
				type: "text_end",
				contentIndex: 0,
				content: text,
				partial: msg({ content: [{ type: "text", text }] }),
			});
			inner.push({ type: "done", reason: "stop", message: msg({ content: [{ type: "text", text }] }) });
		});
	}

	it("splits a leaked fence into structured blocks live during streaming", async () => {
		const leaked = "Visible before.```thinking\nplan\n```Visible after.";
		const { events, result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({ type: "text_start", contentIndex: 0, partial: msg({ content: [{ type: "text", text: "" }] }) });
			inner.push({
				type: "text_delta",
				contentIndex: 0,
				delta: leaked,
				partial: msg({ content: [{ type: "text", text: leaked }] }),
			});
			inner.push({
				type: "text_end",
				contentIndex: 0,
				content: leaked,
				partial: msg({ content: [{ type: "text", text: leaked }] }),
			});
			inner.push({ type: "done", reason: "stop", message: msg({ content: [{ type: "text", text: leaked }] }) });
		});

		expect(result.content.map(b => b.type)).toEqual(["text", "thinking", "text"]);
		expect(texts(result)).toEqual(["Visible before.", "Visible after."]);
		expect(thinks(result).map(b => b.thinking)).toEqual(["plan\n"]);
		// The split happened live, not only in the terminal message.
		expect(events.some(e => e.type === "thinking_delta")).toBe(true);
	});

	for (const { name, chunks } of [
		{
			name: "whole chunk",
			chunks: ["Intro.```thinking\nPlan:\n```rs\nfn main() {}\n```\nThen decide.\n```Visible after"],
		},
		{
			name: "character stream",
			chunks: [..."Intro.```thinking\nPlan:\n```rs\nfn main() {}\n```\nThen decide.\n```Visible after"],
		},
	]) {
		it(`keeps nested Markdown fences inside leaked thinking in ${name}`, async () => {
			const { events, result } = await runLeakedText(chunks);
			expect(result.content.map(b => b.type)).toEqual(["text", "thinking", "text"]);
			expect(texts(result)).toEqual(["Intro.", "Visible after"]);
			expect(thinks(result).map(b => b.thinking)).toEqual(["Plan:\n```rs\nfn main() {}\n```\nThen decide.\n"]);
			expect(texts(result).join("")).not.toContain("fn main");
			expect(events.some(e => e.type === "thinking_delta")).toBe(true);
		});
	}

	for (const { suffix, visible } of [
		{ suffix: "Visible after", visible: "Visible after" },
		{ suffix: " after", visible: " after" },
		{ suffix: "Done", visible: "Done" },
	]) {
		for (const { name, chunks } of [
			{ name: "whole chunk", chunks: [`\`\`\`thinking\nplan\n\`\`\`${suffix}`] },
			{ name: "character stream", chunks: [...`\`\`\`thinking\nplan\n\`\`\`${suffix}`] },
		]) {
			it(`treats leaked inline close plus ${JSON.stringify(suffix)} as visible reply in ${name}`, async () => {
				const { result } = await runLeakedText(chunks);
				expect(result.content.map(b => b.type)).toEqual(["thinking", "text"]);
				expect(thinks(result).map(b => b.thinking)).toEqual(["plan\n"]);
				expect(texts(result)).toEqual([visible]);
			});
		}
	}

	it("preserves text, thinking, and tool-call signatures across the split", async () => {
		const leaked = "before ```thinking\nhmm\n``` after";
		const call: ToolCall = {
			type: "toolCall",
			id: "call_1",
			name: "read",
			arguments: { path: "x" },
			thoughtSignature: "tsig",
		};
		const { result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({
				type: "text_start",
				contentIndex: 0,
				partial: msg({ content: [{ type: "text", text: "", textSignature: "sig" }] }),
			});
			inner.push({
				type: "text_delta",
				contentIndex: 0,
				delta: leaked,
				partial: msg({ content: [{ type: "text", text: leaked, textSignature: "sig" }] }),
			});
			const withCall = msg({
				content: [{ type: "text", text: leaked, textSignature: "sig" }, call],
				stopReason: "toolUse",
			});
			inner.push({ type: "toolcall_start", contentIndex: 1, partial: withCall });
			inner.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: withCall });
			inner.push({ type: "done", reason: "toolUse", message: withCall });
		});

		const textBlocks = result.content.filter((b): b is TextContent => b.type === "text");
		expect(textBlocks.map(b => b.text)).toEqual(["before ", " after"]);
		expect(textBlocks.map(b => b.textSignature)).toEqual(["sig", "sig"]);
		// Healed (leaked) thinking carries no signature.
		expect(thinks(result).every(b => b.thinkingSignature === undefined)).toBe(true);
		const calls = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(calls[0]?.thoughtSignature).toBe("tsig");
	});

	it("heals a fence that only appears in the terminal message (no prior text deltas)", async () => {
		const leaked = "Intro.```thinking\nquiet\n```Outro.";
		const { result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({
				type: "done",
				reason: "stop",
				message: msg({ content: [{ type: "text", text: leaked, textSignature: "sig" }] }),
			});
		});

		expect(result.content.map(b => b.type)).toEqual(["text", "thinking", "text"]);
		expect(texts(result)).toEqual(["Intro.", "Outro."]);
		// Tail-replayed text still carries the source signature.
		expect(result.content.filter((b): b is TextContent => b.type === "text").map(b => b.textSignature)).toEqual([
			"sig",
			"sig",
		]);
	});

	it("passes clean text through unchanged and forwards native thinking", async () => {
		const clean = "Just a normal answer.";
		const cleanRun = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({ type: "text_start", contentIndex: 0, partial: msg({ content: [{ type: "text", text: "" }] }) });
			inner.push({
				type: "text_delta",
				contentIndex: 0,
				delta: clean,
				partial: msg({ content: [{ type: "text", text: clean }] }),
			});
			inner.push({ type: "done", reason: "stop", message: msg({ content: [{ type: "text", text: clean }] }) });
		});
		expect(cleanRun.result.content.map(b => b.type)).toEqual(["text"]);
		expect(texts(cleanRun.result)).toEqual([clean]);

		const nativeThinking = msg({
			content: [
				{ type: "thinking", thinking: "native reasoning", thinkingSignature: "tk" },
				{ type: "text", text: "answer" },
			],
		});
		const nativeRun = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({
				type: "thinking_start",
				contentIndex: 0,
				partial: msg({ content: [{ type: "thinking", thinking: "" }] }),
			});
			inner.push({
				type: "thinking_delta",
				contentIndex: 0,
				delta: "native reasoning",
				partial: msg({ content: [{ type: "thinking", thinking: "native reasoning", thinkingSignature: "tk" }] }),
			});
			inner.push({
				type: "thinking_end",
				contentIndex: 0,
				content: "native reasoning",
				partial: msg({ content: [{ type: "thinking", thinking: "native reasoning", thinkingSignature: "tk" }] }),
			});
			inner.push({ type: "text_start", contentIndex: 1, partial: nativeThinking });
			inner.push({ type: "text_delta", contentIndex: 1, delta: "answer", partial: nativeThinking });
			inner.push({ type: "done", reason: "stop", message: nativeThinking });
		});
		expect(nativeRun.result.content.map(b => b.type)).toEqual(["thinking", "text"]);
		expect(thinks(nativeRun.result)[0]?.thinking).toBe("native reasoning");
		expect(thinks(nativeRun.result)[0]?.thinkingSignature).toBe("tk");
		expect(texts(nativeRun.result)).toEqual(["answer"]);
	});

	it("heals a terminal error message and keeps its error stop reason", async () => {
		const leaked = "Partial.```thinking\noops\n```Recovered.";
		const { result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({
				type: "error",
				reason: "error",
				error: msg({ content: [{ type: "text", text: leaked }], stopReason: "error" }),
			});
		});

		expect(result.content.map(b => b.type)).toEqual(["text", "thinking", "text"]);
		expect(texts(result)).toEqual(["Partial.", "Recovered."]);
		expect(result.stopReason).toBe("error");
	});
});

describe("leaked thinking healing through stream()", () => {
	function sseFrame(event: string, data: unknown): string {
		return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	}

	function anthropicLeakFetch(text: string): FetchImpl {
		const body = [
			sseFrame("message_start", {
				type: "message_start",
				message: { id: "msg_leak", usage: { input_tokens: 5, output_tokens: 0 } },
			}),
			sseFrame("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseFrame("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text },
			}),
			sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
			sseFrame("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 5, output_tokens: 4 },
			}),
			sseFrame("message_stop", { type: "message_stop" }),
		].join("");
		const fn = async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
			new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream", "request-id": "req_mock" },
			});
		return Object.assign(fn, { preconnect: fetch.preconnect });
	}

	it("splits a leaked fence from a provider with no own healer", async () => {
		// Anthropic has no provider-local visible-text healer, so a split here
		// proves the central wrapper is composed into stream().
		const model: Model<"anthropic-messages"> = buildModel({
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		});
		const leaked = "```thinking\nDeliberate.\n```\nFinal answer.";
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
		const result = await stream(model, context, {
			apiKey: "test",
			fetch: anthropicLeakFetch(leaked),
		}).result();

		expect(result.content.map(b => b.type)).toEqual(["thinking", "text"]);
		const thinking = thinks(result)
			.map(b => b.thinking)
			.join("");
		expect(thinking).toContain("Deliberate.");
		expect(texts(result).join("").trim()).toBe("Final answer.");
	});
});

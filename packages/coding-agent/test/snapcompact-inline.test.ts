import { describe, expect, it, spyOn } from "bun:test";
import type { Context, ImageContent, Message, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { SnapcompactInlineTransformer } from "@oh-my-pi/pi-coding-agent/session/snapcompact-inline";
import * as snapcompact from "@oh-my-pi/snapcompact";

/**
 * Token-dense deterministic word salad. 3000 words ≈ 20.6k normalized chars
 * → 2 anthropic-shape frames (capacity 19208) whose ~6600 estimated image
 * tokens clear the savings gate against ~8900 text tokens.
 */
function denseText(words: number): string {
	return Array.from({ length: words }, (_, i) => `w${(i * 7919) % 100000}`).join(" ");
}

const LARGE = denseText(3000);
const SMALL = "12 lines OK";

function toolResult(id: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function userMessage(text: string): Message {
	return { role: "user", content: text, timestamp: 0 };
}

function makeModel(
	overrides: {
		provider?: string;
		input?: ("text" | "image")[];
		api?: "anthropic-messages" | "google-generative-ai";
	} = {},
) {
	return buildModel({
		id: "test-model",
		name: "Test Model",
		api: overrides.api ?? "anthropic-messages",
		provider: overrides.provider ?? "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: overrides.input ?? ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

function makeContext(): Context {
	return {
		systemPrompt: ["You are a coding agent.", "Follow the rules."],
		messages: [
			userMessage("first user prompt"),
			toolResult("call_1", LARGE),
			toolResult("call_2", SMALL),
			toolResult("call_3", LARGE),
		],
	};
}

function imageCount(context: Context): number {
	let count = 0;
	for (const message of context.messages) {
		if (typeof message.content === "string") continue;
		for (const block of message.content) if (block.type === "image") count++;
	}
	return count;
}

describe("SnapcompactInlineTransformer", () => {
	it("is a no-op for text-only models", () => {
		const transformer = new SnapcompactInlineTransformer({ renderSystemPrompt: true, renderToolResults: true });
		const context = makeContext();
		expect(transformer.transform(context, makeModel({ input: ["text"] }))).toBe(context);
	});

	it("images large historical tool results, keeping small and most-recent ones as text", () => {
		const transformer = new SnapcompactInlineTransformer({ renderSystemPrompt: false, renderToolResults: true });
		const context = makeContext();
		const result = transformer.transform(context, makeModel());

		// Large historical result → leading text note + image frames.
		const imaged = result.messages[1] as ToolResultMessage;
		expect(imaged.content[0].type).toBe("text");
		expect(imaged.content.length).toBeGreaterThan(1);
		expect(imaged.content.slice(1).every(block => block.type === "image")).toBe(true);
		for (const block of imaged.content.slice(1) as ImageContent[]) {
			expect(block.mimeType).toBe("image/png");
			expect(block.data.length).toBeGreaterThan(0);
		}

		// Small result fails the savings gate; the most-recent stays crisp text.
		expect(result.messages[2]).toBe(context.messages[2]);
		expect(result.messages[3]).toBe(context.messages[3]);
		expect((result.messages[3] as ToolResultMessage).content[0]).toEqual({ type: "text", text: LARGE });

		// System prompt untouched when only tool results are enabled.
		expect(result.systemPrompt).toBe(context.systemPrompt);
	});

	it("never mutates the input context (persisted history shares these references)", () => {
		const transformer = new SnapcompactInlineTransformer({ renderSystemPrompt: true, renderToolResults: true });
		const context = makeContext();
		const originalMessages = context.messages;
		const originalSystemPrompt = context.systemPrompt;
		const original = context.messages[1] as ToolResultMessage;
		const originalContent = original.content;

		const result = transformer.transform(context, makeModel());
		expect(result).not.toBe(context);

		expect(context.messages).toBe(originalMessages);
		expect(context.systemPrompt).toBe(originalSystemPrompt);
		expect(context.systemPrompt).toEqual(["You are a coding agent.", "Follow the rules."]);
		expect(original.content).toBe(originalContent);
		expect(originalContent).toEqual([{ type: "text", text: LARGE }]);
		expect((context.messages[0] as { content: string }).content).toBe("first user prompt");
	});

	it("leaves tool results that already carry images untouched", () => {
		const transformer = new SnapcompactInlineTransformer({ renderSystemPrompt: false, renderToolResults: true });
		const withImage: ToolResultMessage = {
			...toolResult("call_img", LARGE),
			content: [
				{ type: "text", text: LARGE },
				{ type: "image", data: "aGk=", mimeType: "image/png" },
			],
		};
		const context: Context = {
			messages: [userMessage("hi"), withImage, toolResult("call_tail", LARGE)],
		};
		const result = transformer.transform(context, makeModel());
		expect(result.messages[1]).toBe(withImage);
	});

	it("replaces a large system prompt with a stub and rides frames on the first user message", () => {
		const transformer = new SnapcompactInlineTransformer({ renderSystemPrompt: true, renderToolResults: false });
		const longPrompt = denseText(3000);
		const context: Context = {
			systemPrompt: [longPrompt],
			messages: [userMessage("do the thing"), toolResult("call_1", SMALL)],
		};
		const result = transformer.transform(context, makeModel());

		expect(result.systemPrompt).toHaveLength(1);
		expect(result.systemPrompt![0]).not.toBe(longPrompt);
		expect(result.systemPrompt![0].length).toBeLessThan(500);

		const carrier = result.messages[0] as { content: (TextContent | ImageContent)[] };
		expect(carrier.content[0].type).toBe("text");
		const images = carrier.content.filter(block => block.type === "image");
		expect(images.length).toBeGreaterThan(0);
		// Original user text survives at the tail.
		expect(carrier.content[carrier.content.length - 1]).toEqual({ type: "text", text: "do the thing" });
	});

	it("keeps a small system prompt as text and skips when no user message exists", () => {
		const transformer = new SnapcompactInlineTransformer({ renderSystemPrompt: true, renderToolResults: false });
		const small: Context = { systemPrompt: ["Be terse."], messages: [userMessage("hi")] };
		expect(transformer.transform(small, makeModel())).toBe(small);

		const noUser: Context = { systemPrompt: [denseText(3000)], messages: [toolResult("call_1", SMALL)] };
		expect(transformer.transform(noUser, makeModel())).toBe(noUser);
	});

	it("never rasterizes tool results under the 3k-token floor, even when frames are cheaper", () => {
		const transformer = new SnapcompactInlineTransformer({ renderSystemPrompt: false, renderToolResults: true });
		// ~1.5k tokens: the google shape estimates 1 frame ≈ 1100 tokens, so the
		// savings gate alone would rasterize this — the floor must keep it text.
		const midsize = denseText(500);
		const context: Context = {
			messages: [userMessage("go"), toolResult("call_1", midsize), toolResult("call_2", LARGE)],
		};
		const result = transformer.transform(context, makeModel({ api: "google-generative-ai", provider: "google" }));
		expect(result).toBe(context);
	});

	it("respects the per-provider image budget for unknown providers", () => {
		const transformer = new SnapcompactInlineTransformer({ renderSystemPrompt: false, renderToolResults: true });
		const context: Context = {
			messages: [
				userMessage("go"),
				toolResult("call_1", LARGE),
				toolResult("call_2", LARGE),
				toolResult("call_3", LARGE),
				toolResult("call_4", LARGE),
			],
		};
		// Unknown provider → default budget 5. Each LARGE needs 2 frames:
		// call_1 (2) + call_2 (2) fit, call_3 needs 2 > 1 remaining → text.
		const result = transformer.transform(context, makeModel({ provider: "groq" }));
		expect(imageCount(result)).toBeLessThanOrEqual(5);
		expect(result.messages[3]).toBe(context.messages[3]);
		expect(result.messages[4]).toBe(context.messages[4]);
	});

	it("caches renders across turns: identical input does not re-rasterize", () => {
		const spy = spyOn(snapcompact, "renderMany");
		try {
			const transformer = new SnapcompactInlineTransformer({ renderSystemPrompt: true, renderToolResults: true });
			const context = makeContext();
			const model = makeModel();

			const first = transformer.transform(context, model);
			const callsAfterFirst = spy.mock.calls.length;
			expect(callsAfterFirst).toBeGreaterThan(0);

			const second = transformer.transform(context, model);
			expect(spy.mock.calls.length).toBe(callsAfterFirst);

			const firstFrames = (first.messages[1] as ToolResultMessage).content.slice(1);
			const secondFrames = (second.messages[1] as ToolResultMessage).content.slice(1);
			expect(secondFrames.length).toBe(firstFrames.length);
			for (let i = 0; i < firstFrames.length; i++) {
				expect(secondFrames[i]).toBe(firstFrames[i]);
			}
		} finally {
			spy.mockRestore();
		}
	});
});

import { describe, expect, it } from "bun:test";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type { AssistantMessageEvent, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// A Gemini turn that finishes with `finishReason: STOP` but carries only an empty text part —
// the well-known "empty response" failure. Delivered as-is, the agent receives a blank message
// and silently halts, so the provider must retry instead of surfacing it.

function sse(...chunks: unknown[]): Response {
	const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Top-level `candidates` shape (public Generative Language + Vertex). */
function genaiChunk(text: string): Record<string, unknown> {
	return {
		candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: text ? 5 : 0, totalTokenCount: 15 },
	};
}

/** `{ response: { candidates } }` envelope (Cloud Code Assist: google-gemini-cli / antigravity). */
function ccaChunk(text: string): Record<string, unknown> {
	return { response: genaiChunk(text) };
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, starts: events.filter(e => e.type === "start").length };
}

function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content
		.filter(b => b.type === "text")
		.map(b => b.text ?? "")
		.join("");
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const genaiModel: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const cliModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (CCA)",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://example.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

describe("Google empty-response retry (public + Vertex path)", () => {
	it("retries a STOP-with-empty-text response and delivers the real follow-up content", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return calls === 1 ? sse(genaiChunk("")) : sse(genaiChunk("Hello!"));
		};

		const stream = streamGoogle(genaiModel, context, { apiKey: "k", fetch: fetchMock });
		const { events, starts } = await drain(stream);
		const result = await stream.result();

		expect(calls).toBe(2); // one empty attempt + one successful retry
		expect(starts).toBe(1); // exactly one start across the retry — no duplicate partials
		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("Hello!");
		void events;
	});

	it("surfaces an error after exhausting retries when every attempt is empty", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return sse(genaiChunk(""));
		};

		const stream = streamGoogle(genaiModel, context, { apiKey: "k", fetch: fetchMock });
		const result = await stream.result();

		expect(calls).toBe(3); // MAX_EMPTY_STREAM_RETRIES (2) + 1 initial attempt
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("empty response");
	});
});

describe("Google empty-response retry (Cloud Code Assist path)", () => {
	it("retries a STOP-with-empty-text response (the reported gemini-3-flash hang)", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			// Cloud Code Assist re-fetches `response.url` on retry; synthetic Responses default it to "".
			const response = calls === 1 ? sse(ccaChunk("")) : sse(ccaChunk("Done."));
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});
		const { events, starts } = await drain(stream);
		const result = await stream.result();

		expect(calls).toBe(2);
		expect(starts).toBe(1); // the empty attempt must not leave a dangling duplicate start
		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("Done.");
		void events;
	});
});

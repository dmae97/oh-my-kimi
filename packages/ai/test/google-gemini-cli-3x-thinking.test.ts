import { afterEach, describe, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { enrichModelThinking } from "@oh-my-pi/pi-ai/model-thinking";
import { hookFetch } from "@oh-my-pi/pi-utils";
import { streamSimple } from "../src/stream";
import type { Context, Model } from "../src/types";

interface GeminiCliThinkingConfig {
	thinkingLevel?: string;
	thinkingBudget?: number;
}

interface CapturedRequestBody {
	request?: {
		generationConfig?: {
			thinkingConfig?: GeminiCliThinkingConfig;
		};
	};
}

function createModel(id: string): Model<"google-gemini-cli"> {
	return enrichModelThinking({
		id,
		name: id,
		api: "google-gemini-cli",
		provider: "google-gemini-cli",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	});
}

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function extractThinking(bodyText: string | undefined): GeminiCliThinkingConfig | undefined {
	if (!bodyText) return undefined;
	const parsed = JSON.parse(bodyText) as CapturedRequestBody;
	return parsed.request?.generationConfig?.thinkingConfig;
}

describe("google-gemini-cli Gemini 3.x thinking mapping", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it("uses thinkingLevel for gemini-3.1-pro-preview when the effort is supported", async () => {
		let requestBody: string | undefined;
		using _hook = hookFetch((_input, init) => {
			requestBody = typeof init?.body === "string" ? init.body : undefined;
			return new Response('{"error":{"message":"bad request"}}', { status: 400 });
		});

		const stream = streamSimple(createModel("gemini-3.1-pro-preview"), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.High,
		});
		await stream.result();

		const thinking = extractThinking(requestBody);
		expect(thinking?.thinkingLevel).toBe("HIGH");
		expect(thinking?.thinkingBudget).toBeUndefined();
	});

	it("rejects unsupported gemini-3.1-pro-preview efforts instead of promoting them", () => {
		let requestBody: string | undefined;
		using _hook = hookFetch((_input, init) => {
			requestBody = typeof init?.body === "string" ? init.body : undefined;
			return new Response('{"error":{"message":"bad request"}}', { status: 400 });
		});

		expect(() =>
			streamSimple(createModel("gemini-3.1-pro-preview"), context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				reasoning: Effort.Medium,
			}),
		).toThrow(/Supported efforts: low, high/);
		expect(requestBody).toBeUndefined();
	});

	it("uses thinkingLevel for gemini-3.1-flash-preview", async () => {
		let requestBody: string | undefined;
		using _hook = hookFetch((_input, init) => {
			requestBody = typeof init?.body === "string" ? init.body : undefined;
			return new Response('{"error":{"message":"bad request"}}', { status: 400 });
		});

		const stream = streamSimple(createModel("gemini-3.1-flash-preview"), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.Medium,
		});
		await stream.result();

		const thinking = extractThinking(requestBody);
		expect(thinking?.thinkingLevel).toBe("MEDIUM");
		expect(thinking?.thinkingBudget).toBeUndefined();
	});

	it("keeps thinkingBudget for gemini-2.5-pro", async () => {
		let requestBody: string | undefined;
		using _hook = hookFetch((_input, init) => {
			requestBody = typeof init?.body === "string" ? init.body : undefined;
			return new Response('{"error":{"message":"bad request"}}', { status: 400 });
		});

		const stream = streamSimple(createModel("gemini-2.5-pro"), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.Medium,
		});
		await stream.result();

		const thinking = extractThinking(requestBody);
		expect(thinking?.thinkingLevel).toBeUndefined();
		expect(thinking?.thinkingBudget).toBeDefined();
	});
});

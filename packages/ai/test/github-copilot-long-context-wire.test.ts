/**
 * Copilot long-context catalog variants (e.g. `claude-opus-4.7-1m`) are local
 * entries for a tier of the same upstream model: the wire request MUST carry
 * `requestModelId`, never the local variant id, on every Copilot API path.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Api, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { COPILOT_API_HEADERS } from "@oh-my-pi/pi-catalog/wire/github-copilot";

afterEach(() => {
	vi.restoreAllMocks();
});

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function makeLongContextVariant<TApi extends Api>(spec: Partial<ModelSpec<TApi>> & { api: TApi }): Model<TApi> {
	return buildModel({
		id: "claude-opus-4.7-1m",
		requestModelId: "claude-opus-4.7",
		name: "Claude Opus 4.7 (1M)",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		headers: { ...COPILOT_API_HEADERS },
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		...spec,
	} as ModelSpec<TApi>);
}

async function getRequestBody(input: string | URL | Request, init?: RequestInit): Promise<Record<string, unknown>> {
	if (input instanceof Request) {
		return (await input.clone().json()) as Record<string, unknown>;
	}
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function createUnauthorizedResponse(): Response {
	return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
		status: 401,
		headers: { "Content-Type": "application/json" },
	});
}

describe("GitHub Copilot long-context variant wire model id", () => {
	it("anthropic-messages sends requestModelId", async () => {
		const wireModelIds: unknown[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			wireModelIds.push((await getRequestBody(input, init)).model);
			return createUnauthorizedResponse();
		});

		const model = makeLongContextVariant({ api: "anthropic-messages" });
		const result = await streamAnthropic(model, testContext, {
			apiKey: "ghu_test_copilot_token",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(wireModelIds[0]).toBe("claude-opus-4.7");
	});

	it("openai-responses sends requestModelId", async () => {
		const wireModelIds: unknown[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			wireModelIds.push((await getRequestBody(input, init)).model);
			return createUnauthorizedResponse();
		});

		const model = makeLongContextVariant({
			api: "openai-responses",
			id: "gpt-5.5-1m",
			requestModelId: "gpt-5.5",
			name: "GPT-5.5 (1M)",
		});
		const result = await streamOpenAIResponses(model, testContext, {
			apiKey: "ghu_test_copilot_token",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(wireModelIds[0]).toBe("gpt-5.5");
	});

	it("openai-completions sends requestModelId", async () => {
		const wireModelIds: unknown[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			wireModelIds.push((await getRequestBody(input, init)).model);
			return createUnauthorizedResponse();
		});

		const model = makeLongContextVariant({
			api: "openai-completions",
			id: "gemini-3.1-pro-preview-1m",
			requestModelId: "gemini-3.1-pro-preview",
			name: "Gemini 3.1 Pro (1M)",
		});
		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: "ghu_test_copilot_token",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(wireModelIds[0]).toBe("gemini-3.1-pro-preview");
	});
});

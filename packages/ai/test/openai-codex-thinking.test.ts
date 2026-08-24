import { afterEach, describe, expect, it, vi } from "vitest";
import { getModels } from "../src/models.ts";
import { streamSimpleOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

const context: Context = {
	systemPrompt: "Answer accurately.",
	messages: [{ role: "user", content: "Solve this.", timestamp: 0 }],
};

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function reasoningEffort(init: RequestInit | undefined): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(init?.body));
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	if (typeof parsed !== "object" || parsed === null || !("reasoning" in parsed)) return undefined;
	const reasoning = parsed.reasoning;
	return typeof reasoning === "object" && reasoning !== null && "effort" in reasoning
		? String(reasoning.effort)
		: undefined;
}

function sseResponse(): Response {
	const event = {
		type: "response.completed",
		response: {
			status: "completed",
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	};
	return new Response(`data: ${JSON.stringify(event)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function getCodexModel(id: string): Model<"openai-codex-responses"> {
	const model = getModels("openai-codex").find((candidate) => candidate.id === id);
	if (!model) throw new Error(`Missing openai-codex model: ${id}`);
	return model;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("GPT-5.6 Codex thinking metadata", () => {
	it("advertises a 1M context window for every GPT-5.6 Codex model", () => {
		for (const modelId of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-moa", "gpt-5.6-luna"] as const) {
			expect(getCodexModel(modelId).contextWindow).toBe(1_000_000);
		}
	});

	it.each([
		["gpt-5.6-sol", "max"],
		["gpt-5.6-sol", "ultra"],
		["gpt-5.6-terra", "max"],
		["gpt-5.6-terra", "ultra"],
		["gpt-5.6-luna", "max"],
	] as const)("maps %s %s to the backend-supported xhigh effort", async (modelId, reasoning) => {
		const requests: Array<string | undefined> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				requests.push(reasoningEffort(init));
				return sseResponse();
			}),
		);

		await streamSimpleOpenAICodexResponses(getCodexModel(modelId), context, {
			apiKey: mockToken(),
			reasoning,
			transport: "sse",
		}).result();

		expect(requests).toEqual(["xhigh"]);
	});
});

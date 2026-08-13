import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModels } from "../src/models.ts";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

interface RequestCapture {
	readonly model: string;
	readonly reasoningEffort: string | undefined;
	readonly hasTools: boolean;
}

const context: Context = {
	systemPrompt: "Answer accurately.",
	messages: [{ role: "user", content: "Solve this.", timestamp: 0 }],
};

const moaModel: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-moa",
	name: "GPT-5.6 MoA",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	thinkingLevelMap: { xhigh: "xhigh", max: "xhigh", ultra: "xhigh" },
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 372000,
	maxTokens: 128000,
};

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function parseRequest(init: RequestInit | undefined): RequestCapture {
	const parsed: unknown = JSON.parse(String(init?.body));
	if (typeof parsed !== "object" || parsed === null || !("model" in parsed) || typeof parsed.model !== "string") {
		throw new Error("Expected a Codex request body with a model");
	}
	const reasoning = "reasoning" in parsed ? parsed.reasoning : undefined;
	const reasoningEffort =
		typeof reasoning === "object" &&
		reasoning !== null &&
		"effort" in reasoning &&
		typeof reasoning.effort === "string"
			? reasoning.effort
			: undefined;
	return { model: parsed.model, reasoningEffort, hasTools: "tools" in parsed };
}

function sseResponse(text: string, usage: { readonly input: number; readonly output: number }): Response {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: usage.input,
					output_tokens: usage.output,
					total_tokens: usage.input + usage.output,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("GPT-5.6 MoA", () => {
	it("registers the MoA virtual model", () => {
		const model = getModels("openai-codex").find((candidate) => candidate.id === "gpt-5.6-moa");

		expect(model?.thinkingLevelMap?.ultra).toBe("xhigh");
	});
	it("runs Sol and Terra advisers before streaming a Sol synthesis", async () => {
		const requests: RequestCapture[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				const request = parseRequest(init);
				requests.push(request);
				const text = requests.length === 3 ? "synthesized" : `${request.model} analysis`;
				return sseResponse(text, { input: requests.length, output: 1 });
			}),
		);

		const stream = streamOpenAICodexResponses(
			moaModel,
			{
				...context,
				tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
			},
			{
				apiKey: mockToken(),
				reasoningEffort: "ultra",
				transport: "sse",
			},
		);
		const publicTextDeltas: string[] = [];
		for await (const event of stream) {
			if (event.type === "text_delta") publicTextDeltas.push(event.delta);
		}
		const result = await stream.result();

		expect(requests.map((request) => request.model)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-sol"]);
		expect(requests.every((request) => request.reasoningEffort === "xhigh")).toBe(true);
		expect(requests.map((request) => request.hasTools)).toEqual([false, false, true]);
		expect(publicTextDeltas).toEqual(["synthesized"]);
		expect(result.model).toBe("gpt-5.6-moa");
		expect(result.responseModel).toBe("gpt-5.6-sol");
		expect(result.content.some((content) => content.type === "text" && content.text === "synthesized")).toBe(true);
		expect(result.usage.input).toBe(6);
		expect(result.usage.output).toBe(3);
		expect(result.usage.totalTokens).toBe(9);
		expect(result.usage.totalTokens).toBe(
			result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite,
		);
	});

	it("starts both advisers before either response completes", async () => {
		const requests: RequestCapture[] = [];
		const pendingResponses: Array<(response: Response) => void> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				const request = parseRequest(init);
				requests.push(request);
				if (requests.length === 3) return sseResponse("synthesized", { input: 1, output: 1 });
				return new Promise<Response>((resolve) => pendingResponses.push(resolve));
			}),
		);

		const resultPromise = streamOpenAICodexResponses(moaModel, context, {
			apiKey: mockToken(),
			reasoningEffort: "ultra",
			transport: "sse",
		}).result();
		await Promise.resolve();
		await Promise.resolve();

		expect(requests.map((request) => request.model)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
		pendingResponses[0]?.(sseResponse("sol analysis", { input: 1, output: 1 }));
		pendingResponses[1]?.(sseResponse("terra analysis", { input: 1, output: 1 }));
		await resultPromise;
		expect(requests).toHaveLength(3);
	});

	it("does not virtual-dispatch a custom provider that reuses the model ID", async () => {
		const requests: RequestCapture[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				requests.push(parseRequest(init));
				return sseResponse("custom", { input: 1, output: 1 });
			}),
		);

		const result = await streamOpenAICodexResponses({ ...moaModel, provider: "custom-codex" }, context, {
			apiKey: mockToken(),
			transport: "sse",
		}).result();

		expect(requests.map((request) => request.model)).toEqual(["gpt-5.6-moa"]);
		expect(result.model).toBe("gpt-5.6-moa");
	});

	it("aborts the sibling adviser after the first adviser failure", async () => {
		let solAborted = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				const request = parseRequest(init);
				if (request.model === "gpt-5.6-terra") {
					return new Response(JSON.stringify({ error: { message: "terra failed" } }), {
						status: 400,
						headers: { "content-type": "application/json" },
					});
				}
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						solAborted = true;
						reject(new Error("sol aborted"));
					});
				});
			}),
		);

		const result = await streamOpenAICodexResponses(moaModel, context, {
			apiKey: mockToken(),
			reasoningEffort: "ultra",
			transport: "sse",
		}).result();

		expect(solAborted).toBe(true);
		expect(result.stopReason).toBe("error");
	});

	it("stops before synthesis when an adviser fails", async () => {
		const requests: RequestCapture[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				const request = parseRequest(init);
				requests.push(request);
				if (request.model === "gpt-5.6-terra") {
					await new Promise((resolve) => setTimeout(resolve, 10));
					return new Response(JSON.stringify({ error: { message: "terra failed" } }), {
						status: 400,
						headers: { "content-type": "application/json" },
					});
				}
				return sseResponse("sol analysis", { input: 2, output: 1 });
			}),
		);

		const stream = streamOpenAICodexResponses(moaModel, context, {
			apiKey: mockToken(),
			reasoningEffort: "ultra",
			transport: "sse",
		});
		let terminalEvents = 0;
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") terminalEvents++;
		}
		const result = await stream.result();

		expect(requests).toHaveLength(2);
		expect(terminalEvents).toBe(1);
		expect(result.model).toBe("gpt-5.6-moa");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("MoA adviser failed");
		expect(result.usage).toMatchObject({ input: 2, output: 1, totalTokens: 3 });
	});
});

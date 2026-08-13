import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModels } from "../src/models.ts";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
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

function getMoaModel(): Model<"openai-codex-responses"> {
	const model = getModels("openai-codex").find((candidate) => candidate.id === "gpt-5.6-moa");
	if (!model) throw new Error("Missing openai-codex model: gpt-5.6-moa");
	return model;
}

function requestHasToolFields(init: RequestInit | undefined): boolean {
	const parsed: unknown = JSON.parse(String(init?.body));
	return (
		typeof parsed === "object" &&
		parsed !== null &&
		["tools", "tool_choice", "parallel_tool_calls"].some((field) => field in parsed)
	);
}

function collectStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(collectStrings);
	if (typeof value === "object" && value !== null) return Object.values(value).flatMap(collectStrings);
	return [];
}

function synthesisAdvisers(body: string): { readonly sol: string; readonly terra: string } {
	const synthesisText = collectStrings(JSON.parse(body)).find((value) => value.includes('{"sol":'));
	if (!synthesisText) throw new Error("Expected synthesis adviser JSON");
	const advisers: unknown = JSON.parse(synthesisText.slice(synthesisText.indexOf('{"sol":')));
	if (
		typeof advisers !== "object" ||
		advisers === null ||
		!("sol" in advisers) ||
		typeof advisers.sol !== "string" ||
		!("terra" in advisers) ||
		typeof advisers.terra !== "string"
	) {
		throw new Error("Expected string adviser fields");
	}
	return { sol: advisers.sol, terra: advisers.terra };
}

function requestModel(init: RequestInit | undefined): string {
	const parsed: unknown = JSON.parse(String(init?.body));
	if (typeof parsed !== "object" || parsed === null || !("model" in parsed) || typeof parsed.model !== "string") {
		throw new Error("Expected request model");
	}
	return parsed.model;
}

function sseResponse(text: string): Response {
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
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
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

describe("GPT-5.6 MoA safety boundaries", () => {
	it("terminates as aborted when the caller aborts both advisers", async () => {
		const controller = new AbortController();
		let requests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				requests++;
				return new Promise<Response>((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
				);
			}),
		);

		const resultPromise = streamOpenAICodexResponses(getMoaModel(), context, {
			apiKey: mockToken(),
			signal: controller.signal,
			transport: "sse",
		}).result();
		await Promise.resolve();
		controller.abort();
		const result = await resultPromise;

		expect(requests).toBe(2);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
	});

	it("keeps advisers tool-free while synthesis receives only declared tools", async () => {
		const toolFlags: boolean[] = [];
		const onPayload = vi.fn((payload: unknown) =>
			typeof payload === "object" && payload !== null ? { ...payload, tools: [{ type: "function" }] } : payload,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				toolFlags.push(requestHasToolFields(init));
				return sseResponse(toolFlags.length === 3 ? "synthesis" : "analysis");
			}),
		);

		await streamOpenAICodexResponses(
			getMoaModel(),
			{
				...context,
				tools: [{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) }],
			},
			{ apiKey: mockToken(), onPayload, transport: "sse" },
		).result();

		expect(toolFlags).toEqual([false, false, true]);
		expect(onPayload).not.toHaveBeenCalled();
	});

	it("preserves the active model endpoint and headers", async () => {
		const urls: string[] = [];
		const headers: Array<string | null> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				urls.push(input.toString());
				headers.push(new Headers(init?.headers).get("x-moa-test"));
				return sseResponse(urls.length === 3 ? "synthesis" : "analysis");
			}),
		);

		await streamOpenAICodexResponses(
			{
				...getMoaModel(),
				baseUrl: "https://proxy.example/codex",
				headers: { "x-moa-test": "preserved" },
			},
			context,
			{ apiKey: mockToken(), transport: "sse" },
		).result();

		expect(urls).toEqual(Array.from({ length: 3 }, () => "https://proxy.example/codex/responses"));
		expect(headers).toEqual(["preserved", "preserved", "preserved"]);
	});

	it("returns one generic terminal error when synthesis fails", async () => {
		let requests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requests++;
				if (requests === 3) {
					return new Response(JSON.stringify({ error: { message: "sensitive upstream detail" } }), {
						status: 400,
						headers: { "content-type": "application/json" },
					});
				}
				return sseResponse("analysis");
			}),
		);

		const stream = streamOpenAICodexResponses(getMoaModel(), context, {
			apiKey: mockToken(),
			transport: "sse",
		});
		let terminalEvents = 0;
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") terminalEvents++;
		}
		const result = await stream.result();

		expect(terminalEvents).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("MoA synthesis failed");
		expect(result.diagnostics).toBeUndefined();
	});

	it("aborts oversized adviser streams and bounds synthesis input", async () => {
		const bodies: string[] = [];
		let adviserAborts = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(String(init?.body));
				if (bodies.length <= 2) init?.signal?.addEventListener("abort", () => adviserAborts++);
				return sseResponse(bodies.length === 3 ? "synthesis" : "A".repeat(70000));
			}),
		);

		const result = await streamOpenAICodexResponses(getMoaModel(), context, {
			apiKey: mockToken(),
			transport: "sse",
		}).result();

		expect(bodies.map((body) => requestModel({ body }))).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-sol"]);
		expect(adviserAborts).toBe(2);
		const advisers = synthesisAdvisers(bodies[2] ?? "");
		expect(advisers.sol).toHaveLength(24000);
		expect(advisers.terra).toHaveLength(24000);
		expect(advisers.sol.endsWith("\n[truncated]")).toBe(true);
		expect(advisers.terra.endsWith("\n[truncated]")).toBe(true);
		expect(result.usage.totalTokens).toBe(6);
	});

	it("aborts an oversized synthesis as a length-limited success", async () => {
		let requests = 0;
		let synthesisAborted = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				requests++;
				if (requests === 3) {
					init?.signal?.addEventListener("abort", () => {
						synthesisAborted = true;
					});
				}
				return sseResponse(requests === 3 ? "S".repeat(130000) : "analysis");
			}),
		);

		const result = await streamOpenAICodexResponses(getMoaModel(), context, {
			apiKey: mockToken(),
			transport: "sse",
		}).result();

		expect(synthesisAborted).toBe(true);
		expect(result.stopReason).toBe("length");
		const text = result.content.find((content) => content.type === "text");
		expect(text?.text).toHaveLength(128000);
		expect(result.usage.totalTokens).toBe(6);
	});
});

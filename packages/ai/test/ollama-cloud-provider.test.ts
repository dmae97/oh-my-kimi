import { afterEach, describe, expect, test, vi } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { ollamaCloudModelManagerOptions } from "../src/provider-models/ollama";
import { completeSimple, getEnvApiKey, stream, streamSimple } from "../src/stream";
import type { Context, Model, Tool } from "../src/types";
import { getOAuthProviders } from "../src/utils/oauth";

const originalApiKey = Bun.env.OLLAMA_CLOUD_API_KEY;
const originalFetch = global.fetch;

const cloudModel: Model<"ollama-chat"> = {
	id: "gpt-oss:120b",
	name: "GPT OSS 120B",
	api: "ollama-chat",
	provider: "ollama-cloud",
	baseUrl: "https://ollama.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262_144,
	maxTokens: 8_192,
};

const readFileTool = {
	name: "read_file",
	description: "Read a file from disk",
	parameters: {
		type: "object",
		required: ["path"],
		properties: {
			path: { type: "string" },
		},
	} as never,
} satisfies Tool;

function createNdjsonResponse(lines: unknown[]): Response {
	const body = `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(body));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "application/x-ndjson" },
	});
}

afterEach(() => {
	if (originalApiKey === undefined) {
		delete Bun.env.OLLAMA_CLOUD_API_KEY;
	} else {
		Bun.env.OLLAMA_CLOUD_API_KEY = originalApiKey;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("ollama-cloud provider support", () => {
	test("resolves OLLAMA_CLOUD_API_KEY from environment", () => {
		Bun.env.OLLAMA_CLOUD_API_KEY = "ollama-cloud-test-key";
		expect(getEnvApiKey("ollama-cloud")).toBe("ollama-cloud-test-key");
	});

	test("registers built-in descriptor, default model, and oauth selector entry", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "ollama-cloud");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("gpt-oss:120b");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("OLLAMA_CLOUD_API_KEY");
		expect(descriptor?.catalogDiscovery?.allowUnauthenticated).toBeUndefined();
		expect(DEFAULT_MODEL_PER_PROVIDER["ollama-cloud"]).toBe("gpt-oss:120b");

		const provider = getOAuthProviders().find(item => item.id === "ollama-cloud");
		expect(provider?.name).toBe("Ollama Cloud");
	});

	test("discovers ollama-cloud models from native cloud endpoints", async () => {
		global.fetch = vi.fn(async (input, init) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			expect(headers.get("Authorization")).toBe("Bearer cloud-test-key");
			if (url === "https://ollama.com/api/tags") {
				return new Response(
					JSON.stringify({
						models: [{ name: "gpt-oss:120b" }, { model: "qwen3:32b", name: "Qwen 3 32B" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://ollama.com/api/show") {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
				if (body.model === "gpt-oss:120b") {
					return new Response(
						JSON.stringify({
							capabilities: ["completion", "thinking", "vision"],
							model_info: { "gpt-oss.context_length": 262144 },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(JSON.stringify({ capabilities: ["completion", "vision"] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as unknown as typeof fetch;

		const options = ollamaCloudModelManagerOptions({ apiKey: "cloud-test-key" });
		const models = await options.fetchDynamicModels?.();
		const gpt = models?.find(model => model.id === "gpt-oss:120b");
		const qwen = models?.find(model => model.id === "qwen3:32b");

		expect(options.providerId).toBe("ollama-cloud");
		expect(gpt?.provider).toBe("ollama-cloud");
		expect(gpt?.api).toBe("ollama-chat");
		expect(gpt?.baseUrl).toBe("https://ollama.com");
		expect(gpt?.reasoning).toBe(true);
		expect(gpt?.contextWindow).toBe(262144);
		expect(gpt?.input).toEqual(["text", "image"]);
		expect(qwen?.name).toBe("Qwen 3 32B");
		expect(qwen?.input).toEqual(["text", "image"]);
		expect(global.fetch).toHaveBeenCalledWith(
			"https://ollama.com/api/tags",
			expect.objectContaining({ method: "GET" }),
		);
	});

	test("tolerates individual /api/show failures during model discovery", async () => {
		global.fetch = vi.fn(async (input, init) => {
			const url = String(input);
			if (url === "https://ollama.com/api/tags") {
				return new Response(
					JSON.stringify({
						models: [{ name: "model-a" }, { name: "model-b" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://ollama.com/api/show") {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
				if (body.model === "model-b") {
					throw new Error("network error");
				}
				return new Response(JSON.stringify({ capabilities: ["completion"] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as unknown as typeof fetch;

		const options = ollamaCloudModelManagerOptions({ apiKey: "cloud-test-key" });
		const models = await options.fetchDynamicModels?.();

		const ids = models?.map(m => m.id).sort();
		expect(ids).toEqual(["model-a", "model-b"]);
		const modelB = models?.find(m => m.id === "model-b");
		expect(modelB?.input).toEqual(["text"]);
	});

	test("falls back to bundled metadata when /api/show metadata is unavailable", async () => {
		global.fetch = vi.fn(async (input, _init) => {
			const url = String(input);
			if (url === "https://ollama.com/api/tags") {
				return new Response(
					JSON.stringify({
						models: [{ name: "gpt-oss:120b" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://ollama.com/api/show") {
				return new Response(null, { status: 500 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as unknown as typeof fetch;

		const options = ollamaCloudModelManagerOptions({ apiKey: "cloud-test-key" });
		const models = await options.fetchDynamicModels?.();
		const model = models?.find(candidate => candidate.id === "gpt-oss:120b");

		expect(model).toBeDefined();
		expect(model?.name).toBe("GPT OSS (120B)");
		expect(model?.reasoning).toBe(true);
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.contextWindow).toBe(131072);
		expect(model?.maxTokens).toBe(16384);
	});

	test("streams native chat responses with thinking, text, and usage mapping", async () => {
		global.fetch = vi.fn(async (input, init) => {
			expect(String(input)).toBe("https://ollama.com/api/chat");
			const headers = new Headers(init?.headers);
			expect(headers.get("Authorization")).toBe("Bearer cloud-test-key");
			return createNdjsonResponse([
				{
					model: "gpt-oss:120b",
					message: { role: "assistant", thinking: "Need to think." },
					done: false,
				},
				{
					model: "gpt-oss:120b",
					message: { role: "assistant", content: "Hello" },
					done: false,
				},
				{
					model: "gpt-oss:120b",
					message: { role: "assistant", content: " world" },
					done: false,
				},
				{
					model: "gpt-oss:120b",
					done: true,
					done_reason: "stop",
					prompt_eval_count: 11,
					eval_count: 4,
				},
			]);
		}) as unknown as typeof fetch;

		const response = stream(
			cloudModel,
			{
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			{ apiKey: "cloud-test-key" },
		);

		const eventTypes: string[] = [];
		for await (const event of response) {
			eventTypes.push(event.type);
		}
		const result = await response.result();

		expect(eventTypes).toContain("thinking_start");
		expect(eventTypes).toContain("thinking_delta");
		expect(eventTypes).toContain("text_start");
		expect(eventTypes).toContain("text_delta");
		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(11);
		expect(result.usage.output).toBe(4);
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "Need to think." },
			{ type: "text", text: "Hello world" },
		]);
	});

	test("supports ollama-cloud through streamSimple option mapping", async () => {
		global.fetch = vi.fn(async () =>
			createNdjsonResponse([
				{
					model: "gpt-oss:120b",
					message: { role: "assistant", content: "Mapped through streamSimple" },
					done: false,
				},
				{ model: "gpt-oss:120b", done: true, done_reason: "stop", prompt_eval_count: 2, eval_count: 4 },
			]),
		) as unknown as typeof fetch;

		const response = await streamSimple(
			cloudModel,
			{ messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }] },
			{ apiKey: "cloud-test-key", toolChoice: "auto" },
		).result();

		expect(response.stopReason).toBe("stop");
		expect(response.content).toEqual([{ type: "text", text: "Mapped through streamSimple" }]);
		expect(response.usage.input).toBe(2);
		expect(response.usage.output).toBe(4);
	});

	test("supports ollama-cloud through completeSimple top-level contract", async () => {
		global.fetch = vi.fn(async () =>
			createNdjsonResponse([
				{
					model: "gpt-oss:120b",
					message: { role: "assistant", content: "Completed through completeSimple" },
					done: false,
				},
				{ model: "gpt-oss:120b", done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 5 },
			]),
		) as unknown as typeof fetch;

		const response = await completeSimple(
			cloudModel,
			{ messages: [{ role: "user", content: "Finish this", timestamp: Date.now() }] },
			{ apiKey: "cloud-test-key" },
		);

		expect(response.stopReason).toBe("stop");
		expect(response.content).toEqual([{ type: "text", text: "Completed through completeSimple" }]);
		expect(response.usage.input).toBe(3);
		expect(response.usage.output).toBe(5);
	});
	test("streams tool calls and maps native tool stop reasons", async () => {
		global.fetch = vi.fn(async () =>
			createNdjsonResponse([
				{
					model: "gpt-oss:120b",
					message: {
						role: "assistant",
						tool_calls: [
							{
								type: "function",
								function: {
									index: 0,
									name: "read_file",
									arguments: { path: "README.md" },
								},
							},
						],
					},
					done: false,
				},
				{
					model: "gpt-oss:120b",
					done: true,
					done_reason: "tool_calls",
					prompt_eval_count: 5,
					eval_count: 2,
				},
			]),
		) as unknown as typeof fetch;

		const response = stream(
			cloudModel,
			{
				messages: [{ role: "user", content: "Read README", timestamp: Date.now() }],
				tools: [readFileTool],
			},
			{ apiKey: "cloud-test-key" },
		);
		const eventTypes: string[] = [];
		for await (const event of response) {
			eventTypes.push(event.type);
		}
		const result = await response.result();
		const toolCall = result.content.find(block => block.type === "toolCall");

		expect(eventTypes).toContain("toolcall_start");
		expect(eventTypes).toContain("toolcall_end");
		expect(result.stopReason).toBe("toolUse");
		expect(toolCall && toolCall.type === "toolCall" ? toolCall.name : undefined).toBe("read_file");
		expect(
			toolCall && toolCall.type === "toolCall" ? (toolCall.arguments as { path?: string }).path : undefined,
		).toBe("README.md");
	});

	test("converts replay history, tools, and images into native ollama chat payloads", async () => {
		let requestBody: Record<string, unknown> | undefined;
		global.fetch = vi.fn(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return createNdjsonResponse([
				{
					model: "gpt-oss:120b",
					message: { role: "assistant", content: "done" },
					done: false,
				},
				{ model: "gpt-oss:120b", done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 1 },
			]);
		}) as unknown as typeof fetch;

		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Inspect this image" },
						{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
					],
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tool-1", name: "read_file", arguments: { path: "README.md" } }],
					api: "ollama-chat",
					provider: "ollama-cloud",
					model: "gpt-oss:120b",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "read_file",
					content: [{ type: "text", text: "README contents" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
			tools: [readFileTool],
		};

		await stream(cloudModel, context, { apiKey: "cloud-test-key" }).result();

		const messages = requestBody?.messages as Array<Record<string, unknown>> | undefined;
		expect(requestBody?.model).toBe("gpt-oss:120b");
		expect(requestBody?.stream).toBe(true);
		expect(Array.isArray(requestBody?.tools)).toBe(true);
		expect(messages?.[0]).toMatchObject({
			role: "user",
			content: "Inspect this image",
			images: ["aW1hZ2U="],
		});
		expect(messages?.[1]).toMatchObject({
			role: "assistant",
			tool_calls: [
				{
					type: "function",
					function: { name: "read_file", arguments: { path: "README.md" } },
				},
			],
		});
		expect(messages?.[2]).toMatchObject({
			role: "tool",
			tool_name: "read_file",
			content: "README contents",
		});
	});

	describe("mapToolChoice", () => {
		test("omits tool_choice when undefined or auto", async () => {
			let requestBody: Record<string, unknown> | undefined;
			global.fetch = vi.fn(async (_input, init) => {
				requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return createNdjsonResponse([
					{ model: "gpt-oss:120b", message: { role: "assistant", content: "ok" }, done: false },
					{ model: "gpt-oss:120b", done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
				]);
			}) as unknown as typeof fetch;

			await stream(
				cloudModel,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [readFileTool] },
				{ apiKey: "cloud-test-key", toolChoice: "auto" },
			).result();
			expect(requestBody?.tool_choice).toBeUndefined();
		});

		test("passes tool_choice: none when ToolChoice is none", async () => {
			let requestBody: Record<string, unknown> | undefined;
			global.fetch = vi.fn(async (_input, init) => {
				requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return createNdjsonResponse([
					{ model: "gpt-oss:120b", message: { role: "assistant", content: "ok" }, done: false },
					{ model: "gpt-oss:120b", done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
				]);
			}) as unknown as typeof fetch;

			await stream(
				cloudModel,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [readFileTool] },
				{ apiKey: "cloud-test-key", toolChoice: "none" },
			).result();
			expect(requestBody?.tool_choice).toBe("none");
		});

		test("passes tool_choice: required when ToolChoice is required or any", async () => {
			let requestBody: Record<string, unknown> | undefined;
			global.fetch = vi.fn(async (_input, init) => {
				requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return createNdjsonResponse([
					{ model: "gpt-oss:120b", message: { role: "assistant", content: "ok" }, done: false },
					{ model: "gpt-oss:120b", done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 },
				]);
			}) as unknown as typeof fetch;

			await stream(
				cloudModel,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [readFileTool] },
				{ apiKey: "cloud-test-key", toolChoice: "required" },
			).result();
			expect(requestBody?.tool_choice).toBe("required");
		});
	});
});

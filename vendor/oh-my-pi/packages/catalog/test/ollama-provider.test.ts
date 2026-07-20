import { describe, expect, test, vi } from "bun:test";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import type { Context, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { ollamaModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

interface OllamaRequestBody {
	tools?: Array<{ function: { name: string } }>;
	tool_choice?: string;
}

describe("ollama local provider discovery", () => {
	test("applies /api/show context and thinking capabilities to OpenAI-compatible local models", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			const url = String(input);
			if (url === "http://127.0.0.1:11434/v1/models") {
				return new Response(
					JSON.stringify({
						object: "list",
						data: [{ id: "deepseek-v4:latest", object: "model" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:11434/api/show") {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
				expect(body.model).toBe("deepseek-v4:latest");
				return new Response(
					JSON.stringify({
						capabilities: ["completion", "tools", "thinking", "vision"],
						model_info: { "deepseek4.context_length": 1048576 },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const options = ollamaModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const model = models?.find(candidate => candidate.id === "deepseek-v4:latest");

		expect(model?.api).toBe("openai-responses");
		expect(model?.contextWindow).toBe(1048576);
		expect(model?.reasoning).toBe(true);
		expect(model?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		});
		expect(model?.input).toEqual(["text", "image"]);
	});

	test("remaps Ollama's unsupported reasoning levels and skips non-reasoning models", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			const url = String(input);
			if (url === "http://127.0.0.1:11434/v1/models") {
				return new Response(
					JSON.stringify({
						object: "list",
						data: [
							{ id: "gemma4:e4b", object: "model" },
							{ id: "llama-plain:latest", object: "model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:11434/api/show") {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
				const thinking = body.model === "gemma4:e4b";
				return new Response(
					JSON.stringify({
						capabilities: thinking ? ["completion", "tools", "thinking"] : ["completion", "tools"],
						model_info: {},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const models = await ollamaModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();
		const reasoningModel = models?.find(candidate => candidate.id === "gemma4:e4b");
		const plainModel = models?.find(candidate => candidate.id === "llama-plain:latest");
		const builtReasoningModel = reasoningModel ? buildModel(reasoningModel) : undefined;
		const builtPlainModel = plainModel ? buildModel(plainModel) : undefined;

		// Ollama's OpenAI-compatible endpoint accepts low/medium/high/max;
		// reasoning models carry that wire-exact ladder with no remapping
		// (minimal/xhigh never reach the wire because they are not offered).
		expect(reasoningModel?.reasoning).toBe(true);
		expect(builtReasoningModel?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max],
		});
		// Non-reasoning models never send an effort, so they carry no thinking metadata.
		expect(plainModel?.reasoning).toBe(false);
		expect(builtPlainModel?.thinking).toBeUndefined();
	});
});

describe("ollama tool forcing", () => {
	test("limits named forced tool requests to the selected tool", async () => {
		let requestBody: OllamaRequestBody | undefined;
		const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body ?? "{}")) as OllamaRequestBody;
			return new Response(`${JSON.stringify({ done: true })}\n`, {
				status: 200,
				headers: { "Content-Type": "application/x-ndjson" },
			});
		});

		const model = buildModel({
			id: "ggml-org/gemma-3-1b-it/GGUF",
			name: "Gemma 3 1B",
			api: "ollama-chat",
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 8_192,
		} satisfies ModelSpec<"ollama-chat">);
		const readTool = {
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		} satisfies Tool;
		const writeTool = {
			name: "write",
			description: "Write a file",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		} satisfies Tool;
		const context = {
			messages: [{ role: "user", content: "Create README.md", timestamp: Date.now() }],
			tools: [readTool, writeTool],
		} satisfies Context;

		const eventTypes: string[] = [];
		for await (const event of streamOllama(model, context, {
			apiKey: "test-key",
			toolChoice: { type: "function", name: "write" },
			fetch: fetchMock,
		})) {
			eventTypes.push(event.type);
		}

		expect(eventTypes).toContain("done");
		expect(requestBody?.tool_choice).toBe("required");
		expect(requestBody?.tools?.map(tool => tool.function.name)).toEqual(["write"]);
	});
});

describe("ollama reasoning effort normalization (buildModel)", () => {
	const staleOllamaSpec = <TApi extends "openai-responses" | "openai-completions">(
		api: TApi,
		compat?: ModelSpec<TApi>["compat"],
	): ModelSpec<TApi> =>
		({
			id: "gemma4:e4b",
			name: "gemma4:e4b",
			api,
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
			thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
			compat,
		}) as ModelSpec<TApi>;

	test("normalizes a stale ollama responses spec to the wire-exact ladder", () => {
		// A cache row or hand-written config from the remap era: reasoning-capable
		// with `minimal` offered. The builder must normalize the ladder so the
		// wire never sends raw `minimal`/`xhigh`.
		const model = buildModel(staleOllamaSpec("openai-responses"));
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
		expect(model.thinking?.effortMap).toBeUndefined();
		// Retired tiers clamp instead of erroring.
		expect(clampThinkingLevelForModel(model, Effort.Minimal)).toBe(Effort.Low);
		expect(clampThinkingLevelForModel(model, Effort.XHigh)).toBe(Effort.High);
	});

	test("normalizes openai-completions ollama specs too", () => {
		const model = buildModel(staleOllamaSpec("openai-completions"));
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
	});

	test("explicit compat overrides survive for live tiers", () => {
		const model = buildModel(staleOllamaSpec("openai-responses", { reasoningEffortMap: { high: "medium" } }));
		expect(model.compat.reasoningEffortMap).toEqual({ high: "medium" });
		expect(model.thinking?.effortMap).toEqual({ high: "medium" });
	});

	test("leaves non-ollama providers untouched", () => {
		const model = buildModel({ ...staleOllamaSpec("openai-responses"), provider: "custom" });
		expect(model.compat.reasoningEffortMap).toEqual({});
		expect(model.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
	});
});

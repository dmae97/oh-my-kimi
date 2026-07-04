import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, Tool, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import { NON_VISION_IMAGE_PLACEHOLDER } from "@oh-my-pi/pi-ai/providers/vision-guard";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

interface OllamaChatMessagePayload {
	role?: unknown;
	content?: unknown;
	images?: unknown;
}

interface OllamaToolPayload {
	function?: {
		parameters?: Record<string, unknown>;
	};
}

interface OllamaChatRequestPayload {
	think?: unknown;
	messages?: OllamaChatMessagePayload[];
	tools?: OllamaToolPayload[];
}

function isOllamaChatRequestPayload(value: unknown): value is OllamaChatRequestPayload {
	if (value === null || typeof value !== "object") return false;
	const payload = value as { messages?: unknown; tools?: unknown };
	return (
		(payload.messages === undefined || Array.isArray(payload.messages)) &&
		(payload.tools === undefined || Array.isArray(payload.tools))
	);
}

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createReasoningOllamaModel(input: Array<"text" | "image"> = ["text"]) {
	return buildModel({
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "ollama-chat",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com",
		reasoning: true,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	});
}

describe("Ollama chat thinking controls", () => {
	it("sends think false when reasoning is explicitly disabled", async () => {
		let payload: OllamaChatRequestPayload | undefined;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const parsed: unknown = JSON.parse(String(init?.body));
			if (!isOllamaChatRequestPayload(parsed)) {
				throw new Error("Expected Ollama payload object");
			}
			payload = parsed;
			return new Response('{"message":{"content":"391"},"done":true,"prompt_eval_count":1,"eval_count":1}\n', {
				status: 200,
			});
		};
		const context: Context = {
			messages: [{ role: "user", content: "What is 17*23?", timestamp: 0 }],
		};

		await streamOllama(createReasoningOllamaModel(), context, {
			apiKey: "test-key",
			disableReasoning: true,
			fetch: fetchMock,
		}).result();

		expect(payload?.think).toBe(false);
	});

	it("normalizes tool schemas for Ollama's Go parser", async () => {
		let payload: OllamaChatRequestPayload | undefined;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const parsed: unknown = JSON.parse(String(init?.body));
			if (!isOllamaChatRequestPayload(parsed)) {
				throw new Error("Expected Ollama payload object");
			}
			payload = parsed;
			return new Response('{"message":{"content":"ok"},"done":true,"prompt_eval_count":1,"eval_count":1}\n', {
				status: 200,
			});
		};
		const tool: Tool = {
			name: "schema_probe",
			description: "probe schema normalization",
			parameters: {
				type: "object",
				properties: {
					anything: {},
					nullableName: { type: ["string", "null"] },
					stringOrNumber: { type: ["string", "number"] },
					objectOrArray: { type: ["object", "array"] },
					list: { type: "array", items: {} },
					union: { anyOf: [{}, { type: "string" }] },
					nested: {
						type: "object",
						properties: { value: { type: "string" } },
						additionalProperties: false,
					},
				},
				required: ["anything", "nullableName", "stringOrNumber", "objectOrArray", "list", "union", "nested"],
				additionalProperties: false,
			},
		};
		const context: Context = {
			messages: [{ role: "user", content: "hola", timestamp: 0 }],
			tools: [tool],
		};

		await streamOllama(createReasoningOllamaModel(), context, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		const parameters = payload?.tools?.[0]?.function?.parameters;
		if (!parameters || typeof parameters.properties !== "object" || parameters.properties === null) {
			throw new Error("Expected Ollama tool parameters with properties");
		}
		const properties = parameters.properties as Record<string, Record<string, unknown>>;

		const widenedOpen = {
			anyOf: [
				{ type: "string" },
				{ type: "number" },
				{ type: "boolean" },
				{ type: "object" },
				{ type: "array" },
				{ type: "null" },
			],
		};

		expect(Object.hasOwn(parameters, "additionalProperties")).toBe(false);
		expect(properties.anything).toEqual(widenedOpen);
		expect(properties.nullableName?.type).toBe("string");
		expect(properties.stringOrNumber?.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
		expect(Object.hasOwn(properties.stringOrNumber, "type")).toBe(false);
		expect(properties.objectOrArray?.anyOf).toEqual([{ type: "object" }, { type: "array" }]);
		expect(Object.hasOwn(properties.objectOrArray, "type")).toBe(false);
		expect(properties.list?.items).toEqual(widenedOpen);
		expect(properties.union?.anyOf).toEqual([widenedOpen, { type: "string" }]);
		expect(Object.hasOwn(properties.nested, "additionalProperties")).toBe(false);
	});
	it("sends mid-conversation developer messages as user turns for llama.cpp cache reuse", async () => {
		let payload: OllamaChatRequestPayload | undefined;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const parsed: unknown = JSON.parse(String(init?.body));
			if (!isOllamaChatRequestPayload(parsed)) {
				throw new Error("Expected Ollama payload object");
			}
			payload = parsed;
			return new Response('{"message":{"content":"captured"},"done":true,"prompt_eval_count":1,"eval_count":1}\n', {
				status: 200,
			});
		};
		const now = Date.now();
		const context: Context = {
			systemPrompt: ["static system"],
			messages: [
				{ role: "user", content: "Do work", timestamp: now - 2 },
				{
					role: "assistant",
					content: [{ type: "text", text: "Done" }],
					api: "ollama-chat",
					provider: "ollama",
					model: "llama",
					usage: emptyUsage,
					stopReason: "stop",
					timestamp: now - 1,
				},
				{
					role: "developer",
					content: [{ type: "text", text: "Capture reusable lessons." }],
					attribution: "user",
					timestamp: now,
				},
			],
		};

		await streamOllama(createReasoningOllamaModel(), context, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(payload?.messages?.map(message => message.role)).toEqual(["system", "user", "assistant", "user"]);
		expect(payload?.messages?.at(-1)?.content).toBe("Capture reusable lessons.");
	});

	it("keeps agent-attributed developer reminders on the system role", async () => {
		let payload: OllamaChatRequestPayload | undefined;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const parsed: unknown = JSON.parse(String(init?.body));
			if (!isOllamaChatRequestPayload(parsed)) {
				throw new Error("Expected Ollama payload object");
			}
			payload = parsed;
			return new Response('{"message":{"content":"resumed"},"done":true,"prompt_eval_count":1,"eval_count":1}\n', {
				status: 200,
			});
		};
		const now = Date.now();
		const context: Context = {
			systemPrompt: ["static system"],
			messages: [
				{ role: "user", content: "Do work", timestamp: now - 2 },
				{
					role: "assistant",
					content: [{ type: "text", text: "Done" }],
					api: "ollama-chat",
					provider: "ollama",
					model: "llama",
					usage: emptyUsage,
					stopReason: "stop",
					timestamp: now - 1,
				},
				{
					role: "developer",
					content: [{ type: "text", text: "<system-warning>complete the checkpoint</system-warning>" }],
					attribution: "agent",
					timestamp: now,
				},
			],
		};

		await streamOllama(createReasoningOllamaModel(), context, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(payload?.messages?.map(message => message.role)).toEqual(["system", "user", "assistant", "system"]);
		expect(payload?.messages?.at(-1)?.content).toContain("complete the checkpoint");
	});

	it("omits tool-result images for text-only Ollama chat models", async () => {
		let payload: OllamaChatRequestPayload | undefined;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const parsed: unknown = JSON.parse(String(init?.body));
			if (!isOllamaChatRequestPayload(parsed)) {
				throw new Error("Expected Ollama payload object");
			}
			payload = parsed;
			return new Response('{"message":{"content":"ok"},"done":true,"prompt_eval_count":1,"eval_count":1}\n', {
				status: 200,
			});
		};
		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "browser", arguments: { action: "screenshot" } }],
			api: "ollama-chat",
			provider: "ollama-cloud",
			model: "deepseek-v4-flash",
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "browser",
			content: [
				{ type: "text", text: "Screenshot captured" },
				{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
			],
			isError: false,
			timestamp: now + 1,
		};
		const context: Context = {
			messages: [{ role: "user", content: "Inspect the page", timestamp: now - 1 }, assistantMessage, toolResult],
		};

		await streamOllama(createReasoningOllamaModel(), context, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		const toolMessage = payload?.messages?.find(message => message.role === "tool");
		if (!toolMessage) {
			throw new Error("Expected converted Ollama tool message");
		}
		expect("images" in toolMessage).toBe(false);
		expect(toolMessage.content).toContain("Screenshot captured");
		expect(toolMessage.content).toContain(NON_VISION_IMAGE_PLACEHOLDER);
	});

	it("keeps tool-result images for vision-capable Ollama chat models", async () => {
		let payload: OllamaChatRequestPayload | undefined;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const parsed: unknown = JSON.parse(String(init?.body));
			if (!isOllamaChatRequestPayload(parsed)) {
				throw new Error("Expected Ollama payload object");
			}
			payload = parsed;
			return new Response('{"message":{"content":"ok"},"done":true,"prompt_eval_count":1,"eval_count":1}\n', {
				status: 200,
			});
		};
		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "browser", arguments: { action: "screenshot" } }],
			api: "ollama-chat",
			provider: "ollama-cloud",
			model: "deepseek-v4-flash",
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "browser",
			content: [
				{ type: "text", text: "Screenshot captured" },
				{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
			],
			isError: false,
			timestamp: now + 1,
		};
		const context: Context = {
			messages: [{ role: "user", content: "Inspect the page", timestamp: now - 1 }, assistantMessage, toolResult],
		};

		await streamOllama(createReasoningOllamaModel(["text", "image"]), context, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		const toolMessage = payload?.messages?.find(message => message.role === "tool");
		if (!toolMessage) {
			throw new Error("Expected converted Ollama tool message");
		}
		expect(toolMessage.images).toEqual(["ZmFrZQ=="]);
		expect(toolMessage.content).toContain("Screenshot captured");
		expect(toolMessage.content).not.toContain(NON_VISION_IMAGE_PLACEHOLDER);
	});
});

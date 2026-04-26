import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { imageGenTool, setPreferredImageProvider } from "@oh-my-pi/pi-coding-agent/tools/image-gen";

const originalFetch = global.fetch;
const originalOpenRouterKey = Bun.env.OPENROUTER_API_KEY;
const generatedImagePaths: string[] = [];

afterEach(async () => {
	await Promise.all(generatedImagePaths.splice(0).map(imagePath => fs.rm(imagePath, { force: true })));
	global.fetch = originalFetch;
	if (originalOpenRouterKey === undefined) {
		delete Bun.env.OPENROUTER_API_KEY;
	} else {
		Bun.env.OPENROUTER_API_KEY = originalOpenRouterKey;
	}
	setPreferredImageProvider("auto");
});

function getHeaderValue(headers: RequestInit["headers"] | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	if (headers instanceof Headers) {
		return headers.get(name) ?? headers.get(name.toLowerCase()) ?? headers.get(name.toUpperCase()) ?? undefined;
	}
	if (Array.isArray(headers)) {
		for (const [key, value] of headers) {
			if (key.toLowerCase() === name.toLowerCase()) {
				return value;
			}
		}
		return undefined;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name.toLowerCase()) {
			if (typeof value === "string") {
				return value;
			}
			return value.join(",");
		}
	}
	return undefined;
}

describe("imageGenTool", () => {
	it("sets X-Title when routing image generation through OpenRouter", async () => {
		let requestHeaders: RequestInit["headers"] | undefined;
		Bun.env.OPENROUTER_API_KEY = "test-openrouter-key";

		const fetchMock: typeof fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			requestHeaders = init?.headers;
			return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const ctx: CustomToolContext = {
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKeyForProvider: async () => undefined,
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-1", { subject: "a cat" }, undefined, ctx);
		expect(result.content[0].type).toBe("text");
		expect(getHeaderValue(requestHeaders, "X-Title")).toBe("Oh-My-Pi");
	});

	it("e2e writes OpenAI Responses image_generation WebP output to a temp file", async () => {
		let requestUrl: string | undefined;
		let requestBody: unknown;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "image_generation_call",
							result: Buffer.from("fake-webp").toString("base64"),
							revised_prompt: "A crisp tabby cat portrait.",
							status: "completed",
						},
					],
					usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const model = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT 5.5",
			baseUrl: "https://api.openai.com/v1",
		} as Model;
		const ctx: CustomToolContext = {
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async () => undefined,
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-1", { subject: "a cat", aspect_ratio: "16:9" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://api.openai.com/v1/responses");
		expect(requestBody).toMatchObject({
			model: "gpt-5.5",
			tools: [{ type: "image_generation", output_format: "webp", size: "1536x1024", action: "generate" }],
			tool_choice: { type: "image_generation" },
			store: false,
		});
		expect(result.details?.provider).toBe("openai");
		expect(result.details?.imageCount).toBe(1);
		expect(result.details?.images[0]?.mimeType).toBe("image/webp");
		expect(result.details?.revisedPrompt).toBe("A crisp tabby cat portrait.");
		expect(result.details?.imagePaths).toHaveLength(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(savedPath.endsWith(".webp")).toBe(true);
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("fake-webp"));
	});
});

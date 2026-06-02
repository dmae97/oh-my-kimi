import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createModelManager } from "../src/model-manager";
import { Effort } from "../src/model-thinking";
import { getBundledModel } from "../src/models";
import { githubCopilotModelManagerOptions } from "../src/provider-models/openai-compat";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function getHeaderValue(headers: unknown, key: string): string | undefined {
	if (!headers) return undefined;
	if (headers instanceof Headers) {
		return headers.get(key) ?? undefined;
	}
	if (Array.isArray(headers)) {
		for (const item of headers) {
			if (!Array.isArray(item) || item.length < 2) continue;
			const [name, value] = item;
			if (typeof name === "string" && name.toLowerCase() === key.toLowerCase() && typeof value === "string") {
				return value;
			}
		}
		return undefined;
	}
	if (typeof headers === "object") {
		for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
			if (name.toLowerCase() === key.toLowerCase() && typeof value === "string") {
				return value;
			}
		}
	}
	return undefined;
}

async function discoverCopilotModels(
	payload: unknown,
	apiKey = "copilot-test-key",
	expectedBaseUrl = "https://api.githubcopilot.com",
	expectedAuthorizationToken = apiKey,
) {
	const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toBe(`${expectedBaseUrl}/models`);
		expect(init?.method).toBe("GET");
		expect(getHeaderValue(init?.headers, "Authorization")).toBe(`Bearer ${expectedAuthorizationToken}`);
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	global.fetch = fetchMock as unknown as typeof fetch;

	const options = githubCopilotModelManagerOptions({ apiKey });
	expect(options.fetchDynamicModels).toBeDefined();
	const models = await options.fetchDynamicModels?.();
	expect(models).not.toBeNull();
	return { models: models ?? [], fetchMock };
}

describe("github copilot model limits mapping", () => {
	it("uses configured base URL for discovery", async () => {
		const { fetchMock } = await discoverCopilotModels(
			{ data: [] },
			"copilot-test-key",
			"https://api.githubcopilot.com",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("unwraps structured OAuth keys for discovery and routes enterprise discovery to the enterprise host", async () => {
		const structuredApiKey = JSON.stringify({
			token: "ghu_test_copilot_token",
			enterpriseUrl: "ghe.example.com",
		});
		const { fetchMock } = await discoverCopilotModels(
			{ data: [] },
			structuredApiKey,
			"https://copilot-api.ghe.example.com",
			"ghu_test_copilot_token",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("uses max_context_window_tokens as context window when Copilot reports a prompt budget", async () => {
		const { models, fetchMock } = await discoverCopilotModels({
			data: [
				{
					id: "gemini-2.5-pro",
					name: "Gemini 2.5 Pro",
					capabilities: {
						limits: {
							max_context_window_tokens: 1_048_576,
							max_prompt_tokens: 128_000,
							max_output_tokens: 64_000,
						},
					},
				},
			],
		});

		const model = models.find(candidate => candidate.id === "gemini-2.5-pro");
		expect(model).toBeDefined();
		expect(model?.contextWindow).toBe(1_048_576);
		expect(model?.maxTokens).toBe(64_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("falls back to explicit context_length and derives max tokens from max_output_tokens", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				{
					id: "gpt-5.2-codex",
					name: "GPT-5.2 Codex",
					context_length: 250_000,
					max_completion_tokens: 120_000,
					capabilities: {
						limits: {
							max_prompt_tokens: 128_000,
							max_output_tokens: 128_000,
						},
					},
				},
			],
		});

		const model = models.find(candidate => candidate.id === "gpt-5.2-codex");
		expect(model).toBeDefined();
		expect(model?.api).toBe("openai-responses");
		expect(model?.contextWindow).toBe(250_000);
		expect(model?.maxTokens).toBe(128_000);
	});

	it("falls back to max_prompt_tokens when total-window fields are absent", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				{
					id: "claude-opus-4.6",
					name: "Claude Opus 4.6",
					capabilities: {
						limits: {
							max_prompt_tokens: 128_000,
							max_non_streaming_output_tokens: 16_000,
						},
					},
				},
			],
		});

		const model = models.find(candidate => candidate.id === "claude-opus-4.6");
		expect(model).toBeDefined();
		expect(model?.contextWindow).toBe(128_000);
		expect(model?.maxTokens).toBe(16_000);
	});

	it("keeps bundled Copilot fallback limits truthful offline", () => {
		expect(getBundledModel("github-copilot", "claude-opus-4.6")).toMatchObject({
			contextWindow: 168_000,
			maxTokens: 32_000,
		});
		expect(getBundledModel("github-copilot", "gpt-5.2")).toMatchObject({
			contextWindow: 272_000,
			maxTokens: 128_000,
		});
		expect(getBundledModel("github-copilot", "gpt-5.4-mini")).toMatchObject({
			contextWindow: 272_000,
			maxTokens: 128_000,
		});
		expect(getBundledModel("github-copilot", "grok-code-fast-1")).toMatchObject({
			contextWindow: 192_000,
			maxTokens: 64_000,
		});
	});
	it("inherits bundled GPT-5.4 mini reasoning metadata during discovery", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				{
					id: "gpt-5.4-mini",
					name: "GPT-5.4 mini",
					context_length: 400_000,
					max_completion_tokens: 128_000,
					capabilities: {
						limits: {
							max_context_window_tokens: 400_000,
							max_prompt_tokens: 272_000,
							max_output_tokens: 128_000,
						},
					},
				},
			],
		});

		const model = models.find(candidate => candidate.id === "gpt-5.4-mini");
		expect(model).toBeDefined();
		expect(model?.api).toBe("openai-responses");
		expect(model?.reasoning).toBe(true);
		// max_context_window_tokens is the model window; max_prompt_tokens is only
		// Copilot's prompt/summarization budget.
		expect(model?.contextWindow).toBe(400_000);
		expect(model?.maxTokens).toBe(128_000);
		expect(model?.premiumMultiplier).toBe(0.33);
		expect(model?.thinking).toEqual({
			mode: "effort",
			minLevel: Effort.Low,
			maxLevel: Effort.XHigh,
		});
	});

	it("uses max_context_window_tokens before the bundled reference", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				{
					id: "gpt-5.4",
					name: "GPT-5.4",
					capabilities: {
						limits: {
							max_context_window_tokens: 400_000,
							max_output_tokens: 128_000,
						},
					},
				},
			],
		});

		const model = models.find(candidate => candidate.id === "gpt-5.4");
		expect(model).toBeDefined();
		expect(model?.contextWindow).toBe(400_000);
		expect(model?.maxTokens).toBe(128_000);
	});

	it("keeps discovered context window through full model resolution for bundled models", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-copilot-models-"));
		try {
			global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				expect(url).toBe("https://api.githubcopilot.com/models");
				expect(init?.method).toBe("GET");
				expect(getHeaderValue(init?.headers, "Authorization")).toBe("Bearer copilot-test-key");
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "gpt-5.4",
								name: "GPT-5.4",
								capabilities: {
									limits: {
										max_context_window_tokens: 400_000,
										max_prompt_tokens: 128_000,
										max_output_tokens: 128_000,
									},
								},
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}) as unknown as typeof fetch;

			const options = githubCopilotModelManagerOptions({ apiKey: "copilot-test-key" });
			const manager = createModelManager({
				...options,
				cacheDbPath: path.join(tempDir, "models.db"),
			});
			const { models } = await manager.refresh("online");
			const model = models.find(candidate => candidate.id === "gpt-5.4");

			expect(getBundledModel("github-copilot", "gpt-5.4")?.contextWindow).toBe(272_000);
			expect(model).toBeDefined();
			expect(model?.contextWindow).toBe(400_000);
			expect(model?.maxTokens).toBe(128_000);
			expect(model?.reasoning).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	it("prefers Copilot-specific bundled reference over global reference", async () => {
		// When the API returns no limits at all, the model should use the Copilot-specific
		// bundled reference, not a global reference from another provider (e.g. OpenAI at 1050k).
		const { models } = await discoverCopilotModels({
			data: [
				{
					id: "gpt-5.4",
					name: "GPT-5.4",
				},
			],
		});

		const model = models.find(candidate => candidate.id === "gpt-5.4");
		expect(model).toBeDefined();
		// Should use the Copilot-specific bundled reference (272k after models.json fix),
		// not the OpenAI global reference (1050k).
		expect(model?.contextWindow).toBe(272_000);
	});
});

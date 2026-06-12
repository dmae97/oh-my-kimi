import { describe, expect, it } from "bun:test";

import { buildOpenAIResponsesCompat } from "@oh-my-pi/pi-catalog/compat/openai";

describe("resolveOpenAIResponsesCompat supportsDeveloperRole", () => {
	it("returns true for openai provider with official API base URL", () => {
		const model = { provider: "openai", name: "Test Model", baseUrl: "https://api.openai.com/v1" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns false for openai provider with custom proxy base URL", () => {
		const model = { provider: "openai", name: "Test Model", baseUrl: "https://my-proxy.example.com/v1" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(false);
	});

	it("returns true for github-copilot provider", () => {
		const model = { provider: "github-copilot", name: "Test Model", baseUrl: "https://api.githubcopilot.com" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns false for github-copilot provider with custom proxy base URL", () => {
		const model = { provider: "github-copilot", name: "Test Model", baseUrl: "https://proxy.example.com/v1" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(false);
	});

	it("returns true for Azure OpenAI base URL", () => {
		const model = {
			provider: "azure-openai",
			name: "Test Model",
			baseUrl: "https://my-resource.openai.azure.com/openai",
		};
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns true for Azure AI Inference base URL", () => {
		const model = {
			provider: "azure-openai",
			name: "Test Model",
			baseUrl: "https://models.inference.ai.azure.com/v1/chat/completions",
		};
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns true for api.openai.com base URL", () => {
		const model = { provider: "custom", name: "Test Model", baseUrl: "https://api.openai.com/v1/chat/completions" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns false for generic third-party provider", () => {
		const model = { provider: "custom", name: "Test Model", baseUrl: "https://api.example.com/v1" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(false);
	});

	it("returns false for local/localhost endpoints", () => {
		const model = { provider: "custom", name: "Test Model", baseUrl: "http://localhost:8080/v1" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(false);
	});

	it("is case-insensitive for base URL matching", () => {
		const model = { provider: "custom", name: "Test Model", baseUrl: "https://API.OPENAI.COM/v1" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns true for azure.com/openai base URL", () => {
		const model = {
			provider: "custom",
			name: "Test Model",
			baseUrl: "https://azure.com/openai/deployments/my-model",
		};
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns true for github-copilot provider with api.githubcopilot.com", () => {
		const model = { provider: "github-copilot", name: "Test Model", baseUrl: "https://api.githubcopilot.com" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns true for github-copilot provider with api.enterprise.githubcopilot.com", () => {
		const model = {
			provider: "github-copilot",
			name: "Test Model",
			baseUrl: "https://api.enterprise.githubcopilot.com",
		};
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns true for github-copilot provider with copilot-api enterprise domain", () => {
		const model = { provider: "github-copilot", name: "Test Model", baseUrl: "https://copilot-api.mycompany.com" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});
});

describe("buildOpenAIResponsesCompat requiresJuiceZeroHack", () => {
	it("auto-detects GPT-5-family model names case-insensitively", () => {
		const model = { provider: "openai", name: "GPT-5 Mini", baseUrl: "https://api.openai.com/v1" };
		expect(buildOpenAIResponsesCompat(model).requiresJuiceZeroHack).toBe(true);
	});

	it("stays off for non-GPT-5 model names", () => {
		const model = { provider: "openai", name: "o4-mini", baseUrl: "https://api.openai.com/v1" };
		expect(buildOpenAIResponsesCompat(model).requiresJuiceZeroHack).toBe(false);
	});

	it("honors an explicit compat override on a GPT-5 model", () => {
		const model = {
			provider: "openai",
			name: "GPT-5 Mini",
			baseUrl: "https://api.openai.com/v1",
			compat: { requiresJuiceZeroHack: false },
		};
		expect(buildOpenAIResponsesCompat(model).requiresJuiceZeroHack).toBe(false);
	});
});

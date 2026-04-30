import { describe, expect, it } from "bun:test";
import { supportsDeveloperRole } from "../src/providers/openai-responses";
import type { Model } from "../src/types";

describe("supportsDeveloperRole", () => {
	it("returns true for openai provider with official API base URL", () => {
		const model = { provider: "openai", baseUrl: "https://api.openai.com/v1" } as Model;
		expect(supportsDeveloperRole(model)).toBe(true);
	});

	it("returns false for openai provider with custom proxy base URL", () => {
		const model = { provider: "openai", baseUrl: "https://my-proxy.example.com/v1" } as Model;
		expect(supportsDeveloperRole(model)).toBe(false);
	});

	it("returns true for github-copilot provider", () => {
		const model = { provider: "github-copilot", baseUrl: "https://api.githubcopilot.com" } as Model;
		expect(supportsDeveloperRole(model)).toBe(true);
	});

	it("returns false for github-copilot provider with custom proxy base URL", () => {
		const model = { provider: "github-copilot", baseUrl: "https://proxy.example.com/v1" } as Model;
		expect(supportsDeveloperRole(model)).toBe(false);
	});

	it("returns true for Azure OpenAI base URL", () => {
		const model = { provider: "azure-openai", baseUrl: "https://my-resource.openai.azure.com/openai" } as Model;
		expect(supportsDeveloperRole(model)).toBe(true);
	});

	it("returns true for Azure AI Inference base URL", () => {
		const model = {
			provider: "azure-openai",
			baseUrl: "https://models.inference.ai.azure.com/v1/chat/completions",
		} as Model;
		expect(supportsDeveloperRole(model)).toBe(true);
	});

	it("returns true for api.openai.com base URL", () => {
		const model = { provider: "custom", baseUrl: "https://api.openai.com/v1/chat/completions" } as Model;
		expect(supportsDeveloperRole(model)).toBe(true);
	});

	it("returns false for generic third-party provider", () => {
		const model = { provider: "custom", baseUrl: "https://api.example.com/v1" } as Model;
		expect(supportsDeveloperRole(model)).toBe(false);
	});

	it("returns false for local/localhost endpoints", () => {
		const model = { provider: "custom", baseUrl: "http://localhost:8080/v1" } as Model;
		expect(supportsDeveloperRole(model)).toBe(false);
	});

	it("is case-insensitive for base URL matching", () => {
		const model = { provider: "custom", baseUrl: "https://API.OPENAI.COM/v1" } as Model;
		expect(supportsDeveloperRole(model)).toBe(true);
	});

	it("returns true for azure.com/openai base URL", () => {
		const model = { provider: "custom", baseUrl: "https://azure.com/openai/deployments/my-model" } as Model;
		expect(supportsDeveloperRole(model)).toBe(true);
	});

	it("returns true for github-copilot provider with api.githubcopilot.com", () => {
		const model = { provider: "github-copilot", baseUrl: "https://api.githubcopilot.com" } as Model;
		expect(supportsDeveloperRole(model)).toBe(true);
	});

	it("returns true for github-copilot provider with api.enterprise.githubcopilot.com", () => {
		const model = { provider: "github-copilot", baseUrl: "https://api.enterprise.githubcopilot.com" } as Model;
		expect(supportsDeveloperRole(model)).toBe(true);
	});

	it("returns true for github-copilot provider with copilot-api enterprise domain", () => {
		const model = { provider: "github-copilot", baseUrl: "https://copilot-api.mycompany.com" } as Model;
		expect(supportsDeveloperRole(model)).toBe(true);
	});
});

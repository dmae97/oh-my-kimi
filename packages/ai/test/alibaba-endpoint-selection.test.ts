import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { OAuthController } from "../src/registry/oauth/types";
import * as apiKeyValidation from "../src/registry/api-key-validation";

describe("alibaba-coding-plan endpoint selection", () => {
	let validateSpy: ReturnType<typeof spyOn>;
	let alibabaModule: typeof import("../src/registry/alibaba-coding-plan");

	beforeEach(async () => {
		// Import the module
		alibabaModule = await import("../src/registry/alibaba-coding-plan");
		
		// Spy on the validate function from the namespace
		validateSpy = spyOn(apiKeyValidation, "validateOpenAICompatibleApiKey").mockResolvedValue(undefined);
	});

	afterEach(() => {
		validateSpy.mockRestore();
	});

	it("option 1 uses international endpoint and auth URL", async () => {
		let capturedAuth: { url: string; instructions?: string } | undefined;
		const options: OAuthController = {
			onAuth: (info) => { capturedAuth = info; },
			onProgress: () => {},
			onPrompt: async (prompt) => {
				if (prompt.message.includes("Select Alibaba")) return "1";
				if (prompt.message.includes("Paste your")) return "sk-test-key";
				return "";
			},
		};

		const result = await alibabaModule.loginAlibabaCodingPlan(options);

		expect(result.access).toBe("sk-test-key");
		expect(result.refresh).toBe("sk-test-key");
		expect(result.enterpriseUrl).toBe("https://coding-intl.dashscope.aliyuncs.com/v1");
		expect(capturedAuth?.url).toBe("https://modelstudio.console.alibabacloud.com/");
		expect(capturedAuth?.instructions).toContain("International");

		expect(validateSpy).toHaveBeenCalledWith({
			provider: "Alibaba Coding Plan",
			apiKey: "sk-test-key",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
			model: "qwen3.5-plus",
			signal: undefined,
		});
	});

	it("option 2 uses China endpoint and auth URL", async () => {
		let capturedAuth: { url: string; instructions?: string } | undefined;
		const options: OAuthController = {
			onAuth: (info) => { capturedAuth = info; },
			onProgress: () => {},
			onPrompt: async (prompt) => {
				if (prompt.message.includes("Select Alibaba")) return "2";
				if (prompt.message.includes("Paste your")) return "sk-cn-key";
				return "";
			},
		};

		const result = await alibabaModule.loginAlibabaCodingPlan(options);

		expect(result.access).toBe("sk-cn-key");
		expect(result.refresh).toBe("sk-cn-key");
		expect(result.enterpriseUrl).toBe("https://coding.dashscope.aliyuncs.com/v1");
		expect(capturedAuth?.url).toBe("https://dashscope.console.aliyun.com/");
		expect(capturedAuth?.instructions).toContain("China mainland");

		expect(validateSpy).toHaveBeenCalledWith({
			provider: "Alibaba Coding Plan",
			apiKey: "sk-cn-key",
			baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
			model: "qwen3.5-plus",
			signal: undefined,
		});
	});

	it("option 3 prompts for custom URL and uses it", async () => {
		let capturedAuth: { url: string; instructions?: string } | undefined;
		const options: OAuthController = {
			onAuth: (info) => { capturedAuth = info; },
			onProgress: () => {},
			onPrompt: async (prompt) => {
				if (prompt.message.includes("Select Alibaba")) return "3";
				if (prompt.message.includes("custom base URL")) return "https://my-proxy.com/v1";
				if (prompt.message.includes("Paste your")) return "sk-custom-key";
				return "";
			},
		};

		const result = await alibabaModule.loginAlibabaCodingPlan(options);

		expect(result.access).toBe("sk-custom-key");
		expect(result.refresh).toBe("sk-custom-key");
		expect(result.enterpriseUrl).toBe("https://my-proxy.com/v1");
		expect(capturedAuth?.url).toBe("https://modelstudio.console.alibabacloud.com/");

		expect(validateSpy).toHaveBeenCalledWith({
			provider: "Alibaba Coding Plan",
			apiKey: "sk-custom-key",
			baseUrl: "https://my-proxy.com/v1",
			model: "qwen3.5-plus",
			signal: undefined,
		});
	});

	it("empty input defaults to international endpoint and auth URL", async () => {
		const options: OAuthController = {
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async (prompt) => {
				if (prompt.message.includes("Select Alibaba")) return "";
				if (prompt.message.includes("Paste your")) return "sk-test-key";
				return "";
			},
		};

		const result = await alibabaModule.loginAlibabaCodingPlan(options);

		expect(result.enterpriseUrl).toBe("https://coding-intl.dashscope.aliyuncs.com/v1");
	});

	it("strips trailing slashes from custom URL", async () => {
		const options: OAuthController = {
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async (prompt) => {
				if (prompt.message.includes("Select Alibaba")) return "3";
				if (prompt.message.includes("custom base URL")) return "https://my-proxy.com/v1///";
				if (prompt.message.includes("Paste your")) return "sk-test-key";
				return "";
			},
		};

		const result = await alibabaModule.loginAlibabaCodingPlan(options);

		expect(result.enterpriseUrl).toBe("https://my-proxy.com/v1");
	});

	it("throws error when custom URL is empty", async () => {
		const options: OAuthController = {
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async (prompt) => {
				if (prompt.message.includes("Select Alibaba")) return "3";
				if (prompt.message.includes("custom base URL")) return "";
				return "";
			},
		};

		await expect(alibabaModule.loginAlibabaCodingPlan(options)).rejects.toThrow(
			"Custom URL is required for option 3"
		);
	});

	it("throws error when API key is empty", async () => {
		const options: OAuthController = {
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async (prompt) => {
				if (prompt.message.includes("Select Alibaba")) return "1";
				if (prompt.message.includes("Paste your")) return "";
				return "";
			},
		};

		await expect(alibabaModule.loginAlibabaCodingPlan(options)).rejects.toThrow(
			"API key is required"
		);
	});

	it("checks abort signal after endpoint selection", async () => {
		const controller = new AbortController();
		const options: OAuthController = {
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async (prompt) => {
				if (prompt.message.includes("Select Alibaba")) {
					controller.abort();
					return "";
				}
				return "";
			},
			signal: controller.signal,
		};

		await expect(alibabaModule.loginAlibabaCodingPlan(options)).rejects.toThrow(
			"Login cancelled"
		);
	});
});

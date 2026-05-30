import { afterEach, describe, expect, it } from "bun:test";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { CallableLlmBackend, resetHostLlmBackendForTests, setHostLlmBackend } from "../src/core/llm-backends";
import {
	buildHostPrompt,
	callLocalLlm,
	callRemoteLlm,
	chunkMemoriesByBudget,
	complete,
	llmAvailable,
	localGgufAvailable,
	summarizeMemories,
} from "../src/core/local-llm";
import { Mnemosyne } from "../src/core/memory";
import { withMnemosyneRuntimeOptions } from "../src/core/runtime-options";

const OLD_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function restoreEnv(): void {
	for (const key in process.env) {
		if (!(key in OLD_ENV)) delete process.env[key];
	}
	for (const key in OLD_ENV) {
		const value = OLD_ENV[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	restoreEnv();
	globalThis.fetch = ORIGINAL_FETCH;
	resetHostLlmBackendForTests();
});

registerMockApi();

describe("local LLM TypeScript port", () => {
	it("reports remote availability and calls OpenAI-compatible HTTP", async () => {
		process.env.MNEMOSYNE_LLM_BASE_URL = "http://local-llm/v1";
		process.env.MNEMOSYNE_LLM_API_KEY = "sk-test";
		process.env.MNEMOSYNE_LLM_MODEL = "test-model";
		let auth = "";
		let model = "";
		globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			auth = new Headers(init?.headers).get("authorization") ?? "";
			model = (JSON.parse(String(init?.body)) as { model: string }).model;
			return new Response(JSON.stringify({ choices: [{ message: { content: "Remote summary." } }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		expect(llmAvailable()).toBe(true);
		expect(await callRemoteLlm("Test prompt", 0.2)).toBe("Remote summary.");
		expect(auth).toBe("Bearer sk-test");
		expect(model).toBe("test-model");
	});

	it("keeps local GGUF unavailable and returns null for local completion", async () => {
		expect(localGgufAvailable()).toBe(false);
		expect(await callLocalLlm("prompt")).toBeNull();
	});

	it("uses host backend before remote and skips remote on host miss", async () => {
		process.env.MNEMOSYNE_LLM_ENABLED = "true";
		process.env.MNEMOSYNE_HOST_LLM_ENABLED = "true";
		process.env.MNEMOSYNE_LLM_BASE_URL = "http://remote/v1";
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return new Response(JSON.stringify({ choices: [{ message: { content: "Remote summary." } }] }), {
				status: 200,
			});
		}) as unknown as typeof fetch;

		setHostLlmBackend(new CallableLlmBackend("host", () => "Host summary."));
		expect(await summarizeMemories(["Memory one"])).toBe("Host summary.");
		expect(calls).toBe(0);

		setHostLlmBackend(new CallableLlmBackend("host", () => null));
		expect(await summarizeMemories(["Memory one"])).toBeNull();
		expect(calls).toBe(0);
	});

	it("renders host sleep prompt override without chat-template tokens", () => {
		process.env.MNEMOSYNE_SLEEP_PROMPT = "Write in German. Source={source}. Memories:\n{memories}";
		expect(buildHostPrompt(["User prefers tea"], "profile")).toBe(
			"Write in German. Source=profile. Memories:\n- User prefers tea",
		);
	});

	it("expands chunk budget when host backend will handle calls", () => {
		process.env.MNEMOSYNE_LLM_ENABLED = "true";
		process.env.MNEMOSYNE_HOST_LLM_ENABLED = "true";
		process.env.MNEMOSYNE_HOST_LLM_N_CTX = "32000";
		process.env.MNEMOSYNE_LLM_N_CTX = "2048";
		setHostLlmBackend(new CallableLlmBackend("host", () => "x"));
		const hostChunks = chunkMemoriesByBudget(["x".repeat(10_000)]);
		resetHostLlmBackendForTests();
		const localChunks = chunkMemoriesByBudget(["x".repeat(10_000)]);
		expect(hostChunks).toHaveLength(1);
		expect(localChunks).toHaveLength(0);
	});

	it("uses a constructor-scoped completion function instead of remote URL settings", async () => {
		process.env.MNEMOSYNE_LLM_ENABLED = "true";
		process.env.MNEMOSYNE_LLM_BASE_URL = "http://remote.example/v1";
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			throw new Error("remote should not be called");
		}) as unknown as typeof fetch;
		const memory = new Mnemosyne({
			llm: async (prompt, opts) => `fn:${prompt}:${opts?.maxTokens ?? 0}`,
		});
		try {
			const text = await withMnemosyneRuntimeOptions(memory.runtimeOptions, () => complete("hello"));
			expect(text).toBe("fn:hello:2048");
			expect(fetchCalls).toBe(0);
		} finally {
			memory.close();
		}
	});

	it("uses a constructor-scoped pi-ai Model instance", async () => {
		const model = createMockModel({
			handler: () => ({ content: ["model summary"] }),
		});
		const memory = new Mnemosyne({ llm: model });
		try {
			const text = await withMnemosyneRuntimeOptions(memory.runtimeOptions, () => complete("hello"));
			expect(text).toBe("model summary");
		} finally {
			memory.close();
		}
	});

	it("lets llm:false override remote environment defaults", async () => {
		process.env.MNEMOSYNE_LLM_ENABLED = "true";
		process.env.MNEMOSYNE_LLM_BASE_URL = "http://remote.example/v1";
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			throw new Error("remote should not be called");
		}) as unknown as typeof fetch;
		const memory = new Mnemosyne({ llm: false });
		try {
			const text = await withMnemosyneRuntimeOptions(memory.runtimeOptions, () => complete("hello"));
			expect(text).toBeNull();
			expect(fetchCalls).toBe(0);
		} finally {
			memory.close();
		}
	});
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@oh-my-pi/pi-utils";
import { AgentStorage } from "../../src/session/agent-storage";
import { searchGemini } from "../../src/web/search/providers/gemini";

type CapturedRequest = {
	body: Record<string, unknown> | null;
};

const SSE_RESPONSE =
	'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Gemini answer"}]}}],"modelVersion":"gemini-2.5-flash"}}\n\n';

describe("searchGemini tools serialization", () => {
	let capturedRequest: CapturedRequest | null = null;

	const fakeStorage = {
		listAuthCredentials: () => [
			{
				id: 1,
				credential: {
					type: "oauth",
					access: "test-access-token",
					expires: Date.now() + 600_000,
					projectId: "test-project",
				},
			},
		],
		updateAuthCredential: () => undefined,
		authStore: null as never,
	} as unknown as AgentStorage;

	function mockGeminiFetch() {
		capturedRequest = null;
		vi.spyOn(AgentStorage, "open").mockResolvedValue(fakeStorage);
		return hookFetch((_url, init) => {
			capturedRequest = {
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};
			return new Response(SSE_RESPONSE, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		});
	}

	afterEach(() => {
		vi.restoreAllMocks();
		capturedRequest = null;
	});

	it("sends default googleSearch tool when no passthrough payloads are provided", async () => {
		using _hook = mockGeminiFetch();
		await searchGemini({ query: "default tools" }, fakeStorage);

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: {} }],
		});
	});

	it("passes through google_search payload into googleSearch tool", async () => {
		using _hook = mockGeminiFetch();
		await searchGemini(
			{
				query: "google payload",
				google_search: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } },
			},
			fakeStorage,
		);

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } } }],
		});
	});

	it("includes codeExecution and urlContext tools when provided", async () => {
		using _hook = mockGeminiFetch();
		await searchGemini(
			{
				query: "extended tools",
				code_execution: {},
				url_context: { allowedDomains: ["example.com"] },
			},
			fakeStorage,
		);

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: {} }, { codeExecution: {} }, { urlContext: { allowedDomains: ["example.com"] } }],
		});
	});
});

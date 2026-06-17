import { describe, expect, it } from "bun:test";
import * as geminiCliProvider from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import {
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	buildRequest,
	parseGeminiCliCredentials,
	shouldRefreshGeminiCliCredentials,
	streamGoogleGeminiCli,
} from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { getOAuthApiKey } from "@oh-my-pi/pi-ai/registry/oauth";
import type { AssistantMessageEvent, Context, FetchImpl, Model, TJsonSchema } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function createModel(provider: "google-gemini-cli" | "google-antigravity"): Model<"google-gemini-cli"> {
	return buildModel({
		id: provider === "google-antigravity" ? "gemini-3-flash" : "gemini-2.5-flash",
		name: provider,
		api: "google-gemini-cli",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

function createContext(): Context {
	return {
		messages: [{ role: "user", content: "implement token refresh", timestamp: Date.now() }],
	};
}

const VALIDATION_URL = "https://accounts.google.com/signin/continue?sarp=1&scc=1&plt=AKgnsbtTOKEN";

const validationRequiredBody = JSON.stringify({
	error: {
		code: 403,
		status: "PERMISSION_DENIED",
		details: [
			{
				"@type": "type.googleapis.com/google.rpc.ErrorInfo",
				reason: "VALIDATION_REQUIRED",
				metadata: { validation_url: VALIDATION_URL, validation_url_link_text: "Verify your account" },
			},
		],
	},
});

describe("Google Gemini CLI alignment", () => {
	it("encodes enriched OAuth JSON while preserving token + projectId", async () => {
		const expiresAt = Date.now() + 60 * 60 * 1000;
		const result = await getOAuthApiKey("google-gemini-cli", {
			"google-gemini-cli": {
				access: "access-token",
				refresh: "refresh-token",
				expires: expiresAt,
				projectId: "proj-123",
				email: "dev@example.com",
				accountId: "acct-1",
			},
		});

		expect(result).not.toBeNull();
		const payload = JSON.parse(result!.apiKey) as {
			token?: string;
			projectId?: string;
			refreshToken?: string;
			expiresAt?: number;
			email?: string;
			accountId?: string;
		};
		expect(payload.token).toBe("access-token");
		expect(payload.projectId).toBe("proj-123");
		expect(payload.refreshToken).toBe("refresh-token");
		expect(payload.expiresAt).toBe(expiresAt);
		expect(payload.email).toBe("dev@example.com");
		expect(payload.accountId).toBe("acct-1");
	});

	it("accepts legacy, alias, and enriched OAuth JSON payloads", () => {
		const legacy = parseGeminiCliCredentials(JSON.stringify({ token: "legacy-token", projectId: "proj-legacy" }));
		expect(legacy).toEqual({
			accessToken: "legacy-token",
			projectId: "proj-legacy",
			refreshToken: undefined,
			expiresAt: undefined,
			email: undefined,
		});

		const aliasPayload = parseGeminiCliCredentials(
			JSON.stringify({
				token: "alias-token",
				project_id: "proj-alias",
				refresh: "refresh-alias",
				expires: 1_737_000_000,
			}),
		);
		expect(aliasPayload).toEqual({
			accessToken: "alias-token",
			projectId: "proj-alias",
			refreshToken: "refresh-alias",
			expiresAt: 1_737_000_000_000,
			email: undefined,
		});

		const enriched = parseGeminiCliCredentials(
			JSON.stringify({
				token: "enriched-token",
				projectId: "proj-enriched",
				refreshToken: "refresh-token",
				expiresAt: 1_737_000_000_000,
				email: "dev@example.com",
			}),
		);
		expect(enriched).toEqual({
			accessToken: "enriched-token",
			projectId: "proj-enriched",
			refreshToken: "refresh-token",
			expiresAt: 1_737_000_000_000,
			email: "dev@example.com",
		});
	});

	it("avoids excessive antigravity refresh churn with pre-buffered OAuth expiry", () => {
		const issuedAt = 1_700_000_000_000;
		const preBufferedExpiry = issuedAt + 55 * 60 * 1000;

		expect(shouldRefreshGeminiCliCredentials(preBufferedExpiry, true, issuedAt + 10 * 60 * 1000)).toBe(false);
		expect(shouldRefreshGeminiCliCredentials(preBufferedExpiry, true, issuedAt + 54 * 60 * 1000)).toBe(true);
		expect(shouldRefreshGeminiCliCredentials(preBufferedExpiry, false, issuedAt + 54 * 60 * 1000)).toBe(true);
	});

	it("does not export provider-direct refresh helper", () => {
		expect(shouldRefreshGeminiCliCredentials).toBe(geminiCliProvider.shouldRefreshGeminiCliCredentials);
		expect(Object.hasOwn(geminiCliProvider, "refreshGeminiCliCredentialsIfNeeded")).toBe(false);
	});
	it("omits antigravity-only metadata in non-antigravity request payloads", () => {
		const model = createModel("google-gemini-cli");
		const payload = buildRequest(model, createContext(), "proj-123", {}, false) as {
			request: { sessionId?: string };
			requestType?: string;
			userAgent?: string;
			requestId?: string;
		};

		expect(payload.request.sessionId).toBeUndefined();
		expect(payload.requestType).toBeUndefined();
		expect(payload.userAgent).toBeUndefined();
		expect(payload.requestId).toBeUndefined();
	});
	it("keeps every system prompt block in systemInstruction instead of conversation contents", () => {
		const model = createModel("google-gemini-cli");
		const context: Context = {
			systemPrompt: ["primary instruction", "", "supplemental \uD800instruction"],
			messages: [{ role: "user", content: "implement token refresh", timestamp: Date.now() }],
		};
		const payload = buildRequest(model, context, "proj-123", {}, false) as {
			request: {
				contents: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
				systemInstruction?: { role?: string; parts: Array<{ text: string }> };
			};
		};

		expect(payload.request.systemInstruction).toEqual({
			parts: [{ text: "primary instruction" }, { text: "supplemental �instruction" }],
		});
		expect(payload.request.systemInstruction?.role).toBeUndefined();
		expect(payload.request.contents).toEqual([{ role: "user", parts: [{ text: "implement token refresh" }] }]);
	});

	it("keeps antigravity metadata in antigravity request payloads", () => {
		const model = createModel("google-antigravity");
		const payload = buildRequest(model, createContext(), "proj-123", {}, true) as {
			request: {
				sessionId?: string;
				labels?: Record<string, string>;
				systemInstruction?: { role?: string };
			};
			requestType?: string;
			userAgent?: string;
			requestId?: string;
		};

		expect(payload.request.sessionId).toMatch(/^-[0-9]+$/);
		expect(payload.requestType).toBe("agent");
		expect(payload.userAgent).toBe("antigravity");
		// Structured requestId: agent/<agentId>/<ts>/<trajectoryId>/<step>.
		expect(payload.requestId).toMatch(/^agent\/[0-9a-f-]+\/\d+\/[0-9a-f-]+\/\d+$/);
		// Antigravity tags its system instruction with role "user".
		expect(payload.request.systemInstruction?.role).toBe("user");
		const labels = payload.request.labels;
		expect(labels?.trajectory_id).toMatch(/^[0-9a-f-]+$/);
		expect(labels?.last_step_index).toBe("1");
		expect(labels?.used_claude).toBe("false");
		expect(labels?.used_claude_conservative).toBe("false");
	});

	it("stamps the antigravity wire profile (maxOutputTokens + model_enum) by routed wire id", () => {
		const model = createModel("google-antigravity");
		const payload = buildRequest(
			model,
			createContext(),
			"proj-123",
			{ requestModelId: "gemini-3.5-flash-low" },
			true,
		) as {
			model?: string;
			request: { generationConfig?: { maxOutputTokens?: number }; labels?: Record<string, string> };
		};

		expect(payload.model).toBe("gemini-3.5-flash-low");
		expect(payload.request.generationConfig?.maxOutputTokens).toBe(65536);
		expect(payload.request.labels?.model_enum).toBe("MODEL_PLACEHOLDER_M20");
	});

	it("defaults antigravity tools to VALIDATED but omits AUTO toolConfig for plain gemini-cli", () => {
		const context: Context = {
			messages: [{ role: "user", content: "inspect repo", timestamp: Date.now() }],
			tools: [
				{
					name: "read_file",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					} as TJsonSchema,
				},
			],
		};

		const cli = buildRequest(
			createModel("google-gemini-cli"),
			context,
			"proj-123",
			{ toolChoice: "auto" },
			false,
		) as {
			request: { tools?: unknown; toolConfig?: unknown };
		};
		expect(cli.request.tools).toBeDefined();
		expect(cli.request.toolConfig).toBeUndefined();

		const antigravity = buildRequest(
			createModel("google-antigravity"),
			context,
			"proj-123",
			{ toolChoice: "auto" },
			true,
		) as {
			request: { tools?: unknown; toolConfig?: { functionCallingConfig: { mode: string } } };
		};
		expect(antigravity.request.tools).toBeDefined();
		expect(antigravity.request.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
	});

	it("strips patternProperties when antigravity rewrites tools to legacy parameters", () => {
		const model = createModel("google-antigravity");
		const toolContext: Context = {
			messages: [{ role: "user", content: "rewrite files", timestamp: Date.now() }],
			tools: [
				{
					name: "rewrite_rules",
					description: "Map rewrite regex to replacement",
					parameters: {
						type: "object",
						properties: {
							rules: {
								type: "object",
								patternProperties: {
									"^(.*)$": { type: "string" },
								},
							},
						},
						required: ["rules"],
					} as TJsonSchema,
				},
			],
		};
		const payload = buildRequest(model, toolContext, "proj-123", {}, true) as {
			request: { tools?: Array<{ functionDeclarations: Array<{ parameters?: unknown }> }> };
		};

		const parameters = payload.request.tools?.[0]?.functionDeclarations[0]?.parameters;
		expect(parameters).toBeDefined();
		expect(JSON.stringify(parameters)).not.toContain('"patternProperties"');
	});
	it("injects ANTIGRAVITY_SYSTEM_INSTRUCTION for gemini-3.1-pro-high and gemini-3.1-pro-low", () => {
		// Regression test for #1274: shouldInjectAntigravitySystemInstruction checked
		// "gemini-3-pro-high" (hyphen) but the deployed model IDs use "gemini-3.1-pro-high" (dot),
		// so the injection was silently skipped and the Cloud Code Assist API returned HTTP 400.
		for (const modelId of ["gemini-3.1-pro-high", "gemini-3.1-pro-low"] as const) {
			const model: Model<"google-gemini-cli"> = buildModel({
				...createModel("google-antigravity"),
				id: modelId,
			} as ModelSpec<"google-gemini-cli">);
			const context: Context = {
				systemPrompt: ["my instructions"],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const payload = buildRequest(model, context, "proj-123", {}, true) as {
				request: { systemInstruction?: { role?: string; parts: Array<{ text: string }> } };
			};

			const parts = payload.request.systemInstruction?.parts ?? [];
			// The antigravity identity header must be injected as the first part.
			expect(parts[0]?.text).toBe(ANTIGRAVITY_SYSTEM_INSTRUCTION);
			// The user-supplied system prompt must appear after the single injected part.
			expect(parts.slice(1).some(p => p.text === "my instructions")).toBe(true);
		}
	});
	it("adds anthropic-beta for Antigravity Claude reasoning models without relying on id suffix", async () => {
		let requestHeaders: Headers | undefined;
		const fetchMock: FetchImpl = async (_url, init) => {
			requestHeaders = new Headers(init?.headers);
			return new Response('{"error":{"message":"bad request"}}', { status: 400 });
		};

		const model: Model<"google-gemini-cli"> = buildModel({
			...createModel("google-antigravity"),
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			reasoning: true,
		} as ModelSpec<"google-gemini-cli">);

		const result = await streamGoogleGeminiCli(model, createContext(), {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(requestHeaders).toBeDefined();
		expect(requestHeaders!.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
		expect(requestHeaders!.get("X-Goog-Api-Client")).toBeNull();
		expect(requestHeaders!.get("Client-Metadata")).toBeNull();
	});

	it("sends the antigravity/hub User-Agent header on the Antigravity transport", async () => {
		let requestHeaders: Headers | undefined;
		const fetchMock: FetchImpl = async (_url, init) => {
			requestHeaders = new Headers(init?.headers);
			return new Response('{"error":{"message":"bad request"}}', { status: 400 });
		};

		const model = createModel("google-antigravity");
		await streamGoogleGeminiCli(model, createContext(), {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		}).result();

		expect(requestHeaders).toBeDefined();
		expect(requestHeaders!.get("User-Agent")).toMatch(/^antigravity\/hub\/[0-9.]+ /);
	});

	it("filters out empty text parts at stream end but preserves terminal thought signatures", async () => {
		const sseChunks = [
			'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]}}]}}\n\n',
			'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"","thoughtSignature":"terminal-sig"}]},"finishReason":"STOP"}]}}\n\n',
		];

		const fetchMock: FetchImpl = async () => {
			const stream = new ReadableStream({
				async start(controller) {
					const encoder = new TextEncoder();
					for (const chunk of sseChunks) {
						controller.enqueue(encoder.encode(chunk));
						await Bun.sleep(5);
					}
					controller.close();
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		};

		const model: Model<"google-gemini-cli"> = buildModel({
			...createModel("google-antigravity"),
			id: "gemini-3.5-flash",
			name: "Gemini 3.5 Flash",
			reasoning: true,
		} as ModelSpec<"google-gemini-cli">);

		const events: AssistantMessageEvent[] = [];
		const stream = streamGoogleGeminiCli(model, createContext(), {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Hello",
			textSignature: "terminal-sig",
		});

		const textStartEvents = events.filter(e => e.type === "text_start");
		expect(textStartEvents).toHaveLength(1);
		expect(textStartEvents[0].contentIndex).toBe(0);

		const textDeltaEvents = events.filter(e => e.type === "text_delta");
		expect(textDeltaEvents).toHaveLength(1);
		expect(textDeltaEvents[0].delta).toBe("Hello");

		const textEndEvents = events.filter(e => e.type === "text_end");
		expect(textEndEvents).toHaveLength(1);
		expect(textEndEvents[0].content).toBe("Hello");
	});

	it("keeps a text block's own thoughtSignature when a following function call carries its own", async () => {
		// A functionCall part with `text: undefined` must NOT pollute the preceding text/thinking
		// block via the terminal-signature branch; its signature belongs on the tool call alone.
		const sseChunks = [
			'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Hello","thoughtSignature":"text-sig"}]}}]}}\n\n',
			'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"SF"}},"thoughtSignature":"toolcall-sig"}]},"finishReason":"STOP"}]}}\n\n',
		];

		const fetchMock: FetchImpl = async () => {
			const stream = new ReadableStream({
				async start(controller) {
					const encoder = new TextEncoder();
					for (const chunk of sseChunks) {
						controller.enqueue(encoder.encode(chunk));
						await Bun.sleep(5);
					}
					controller.close();
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		};

		const model: Model<"google-gemini-cli"> = buildModel({
			...createModel("google-antigravity"),
			id: "gemini-3.5-flash",
			name: "Gemini 3.5 Flash",
			reasoning: true,
		} as ModelSpec<"google-gemini-cli">);

		const events: AssistantMessageEvent[] = [];
		const stream = streamGoogleGeminiCli(model, createContext(), {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(2);

		// The text block keeps its OWN signature — the function call's signature must NOT migrate onto it.
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Hello",
			textSignature: "text-sig",
		});

		// The function call's signature is captured on the tool call itself, by the functionCall branch.
		const toolCall = result.content[1];
		expect(toolCall.type).toBe("toolCall");
		if (toolCall.type === "toolCall") {
			expect(toolCall.name).toBe("get_weather");
			expect(toolCall.thoughtSignature).toBe("toolcall-sig");
		}

		expect(events.filter(e => e.type === "toolcall_start")).toHaveLength(1);
	});

	it("surfaces account verification failures from model requests", async () => {
		const fetchMock: FetchImpl = async () => new Response(validationRequiredBody, { status: 403 });
		const model = createModel("google-antigravity");

		const stream = streamGoogleGeminiCli(model, createContext(), {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123", email: "dev@example.com" }),
			fetch: fetchMock,
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(403);
		expect(result.errorMessage).toBe(
			`Cloud Code Assist API error (403): Account verification required for dev@example.com. Visit ${VALIDATION_URL} to continue, then retry your request.`,
		);
	});

	describe("retry guardrails", () => {
		it("does not treat explicit HTTP failures as network retry errors", async () => {
			let fetchCalls = 0;
			const fetchMock: FetchImpl = async () => {
				fetchCalls += 1;
				return new Response('{"error":{"message":"busy"}}', {
					status: 503,
					headers: { "retry-after": "120" },
				});
			};

			const model = createModel("google-gemini-cli");
			const stream = streamGoogleGeminiCli(model, createContext(), {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				maxRetryDelayMs: 1000,
				fetch: fetchMock,
			});

			const result = await stream.result();
			expect(fetchCalls).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("Cloud Code Assist API error (503)");
		});
	});
});

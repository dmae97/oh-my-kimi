import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { Effort } from "@oh-my-pi/pi-ai";
import {
	applyClaudeToolPrefix,
	buildAnthropicClientOptions,
	buildAnthropicHeaders,
	buildAnthropicSystemBlocks,
	claudeCodeHeaders,
	claudeCodeSystemInstruction,
	claudeCodeVersion,
	generateClaudeCloakingUserId,
	isClaudeCloakingUserId,
	mapStainlessArch,
	mapStainlessOs,
	streamAnthropic,
	stripClaudeToolPrefix,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { withEnv } from "./helpers";

const ANTHROPIC_MODEL: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type CaptureAnthropicOptions = {
	isOAuth?: boolean;
	metadata?: { user_id?: string };
	thinkingEnabled?: boolean;
	reasoning?: Effort;
	temperature?: number;
	topP?: number;
	topK?: number;
};

function captureAnthropicPayload(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: CaptureAnthropicOptions,
): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamAnthropic(model, context, {
		apiKey: "sk-ant-oat-test",
		isOAuth: options?.isOAuth ?? true,
		signal: createAbortedSignal(),
		metadata: options?.metadata,
		thinkingEnabled: options?.thinkingEnabled,
		reasoning: options?.reasoning,
		temperature: options?.temperature,
		topP: options?.topP,
		topK: options?.topK,
		onPayload: payload => resolve(payload),
	});
	return promise;
}

describe("Anthropic request fingerprint alignment", () => {
	it("uses updated Claude Code header defaults", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
		});

		expect(headers["Anthropic-Beta"]).toContain("context-management-2025-06-27");
		expect(headers["Anthropic-Beta"]).toContain("prompt-caching-scope-2026-01-05");
		expect(headers["Anthropic-Beta"]).not.toContain("fine-grained-tool-streaming-2025-05-14");
		expect(headers["User-Agent"]).toBe(`claude-cli/${claudeCodeVersion} (external, cli)`);
		expect(claudeCodeHeaders["X-Stainless-Package-Version"]).toBe("0.74.0");
		expect("X-Stainless-Helper-Method" in claudeCodeHeaders).toBe(false);
	});

	it("maps Stainless OS and arch values from explicit inputs", () => {
		expect(mapStainlessOs("darwin")).toBe("MacOS");
		expect(mapStainlessOs("windows")).toBe("Windows");
		expect(mapStainlessOs("linux")).toBe("Linux");
		expect(mapStainlessOs("freebsd")).toBe("FreeBSD");
		expect(mapStainlessOs("solaris")).toBe("Other::solaris");

		expect(mapStainlessArch("x64")).toBe("x64");
		expect(mapStainlessArch("amd64")).toBe("x64");
		expect(mapStainlessArch("arm64")).toBe("arm64");
		expect(mapStainlessArch("386")).toBe("x86");
		expect(mapStainlessArch("x86")).toBe("x86");
		expect(mapStainlessArch("sparc64")).toBe("other::sparc64");
	});

	it("uses runtime Stainless OS and arch mappings in Anthropic headers", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
		});

		expect(headers["X-Stainless-Os"]).toBe(mapStainlessOs(process.platform));
		expect(headers["X-Stainless-Arch"]).toBe(mapStainlessArch(process.arch));
	});

	it("injects billing header and Claude Agent SDK identity block", () => {
		const blocks = buildAnthropicSystemBlocks("Stay concise.", {
			includeClaudeCodeInstruction: true,
			extraInstructions: ["Use citations when possible"],
		});

		expect(blocks).toBeDefined();
		expect(blocks?.[0]?.text.startsWith(`x-anthropic-billing-header: cc_version=${claudeCodeVersion}.`)).toBe(true);
		expect(blocks?.[0]?.text).toMatch(/cc_entrypoint=cli; cch=[0-9a-f]{5};$/);
		expect(blocks?.[1]).toEqual({
			type: "text",
			text: claudeCodeSystemInstruction,
		});
		expect(blocks?.[2]).toEqual({
			type: "text",
			text: "Use citations when possible",
		});
		expect(blocks?.[3]).toEqual({
			type: "text",
			text: "Stay concise.",
		});
	});

	it("applies cache_control to system blocks when cacheControl option is set", () => {
		const blocks = buildAnthropicSystemBlocks("Stay concise.", {
			includeClaudeCodeInstruction: true,
			extraInstructions: ["Use citations when possible"],
			cacheControl: { type: "ephemeral" },
		});

		expect(blocks).toBeDefined();
		expect(blocks?.[2]).toEqual({
			type: "text",
			text: "Use citations when possible",
			cache_control: { type: "ephemeral" },
		});
		expect(blocks?.[3]).toEqual({
			type: "text",
			text: "Stay concise.",
			cache_control: { type: "ephemeral" },
		});
	});

	it("uses Bearer auth for non-Anthropic API bases with api-key credentials", () => {
		const headers = buildAnthropicHeaders({
			apiKey: "sk-ant-api-test",
			baseUrl: "https://proxy.example.com",
			stream: true,
		});

		expect(headers.Authorization).toBe("Bearer sk-ant-api-test");
		expect(headers["X-Api-Key"]).toBeUndefined();
	});

	it("forwards only prefix-matching Claude Code User-Agent values", () => {
		const forwardedHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "claude-cli/2.1.63 (external, cli)" },
		});
		expect(forwardedHeaders["User-Agent"]).toBe("claude-cli/2.1.63 (external, cli)");

		// Test variant without slash
		const forwardedNoSlashHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "claude-cli-dev" },
		});
		expect(forwardedNoSlashHeaders["User-Agent"]).toBe("claude-cli-dev");

		const normalizedHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "curl/8.7.1" },
		});
		expect(normalizedHeaders["User-Agent"]).toBe(`claude-cli/${claudeCodeVersion} (external, cli)`);

		const embeddedClaudeCliHeaders = buildAnthropicHeaders({
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			stream: true,
			modelHeaders: { "User-Agent": "my-client claude-cli/2.1.63" },
		});
		expect(embeddedClaudeCliHeaders["User-Agent"]).toBe(`claude-cli/${claudeCodeVersion} (external, cli)`);
	});

	it("skips Claude Code instruction injection for claude-3-5-haiku models", async () => {
		const payload = (await captureAnthropicPayload(
			{ ...ANTHROPIC_MODEL, id: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
			{
				systemPrompt: "Stay concise.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
		)) as { system?: Array<{ type: string; text?: string }> };

		expect(Array.isArray(payload.system)).toBe(true);
		const systemBlocks = payload.system ?? [];
		expect(systemBlocks.some(block => block.text?.startsWith("x-anthropic-billing-header:"))).toBe(false);
		expect(systemBlocks[0]?.text).toBe("Stay concise.");
	});

	it("accepts uppercase hex in the user hash segment", () => {
		const userId =
			"user_ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD_account_12345678-1234-1234-1234-1234567890ab_session_abcdefab-cdef-abcd-efab-cdefabcdef12";
		expect(isClaudeCloakingUserId(userId)).toBe(true);
	});

	it("generates cloaking-compatible user IDs", () => {
		const userId = generateClaudeCloakingUserId();
		expect(isClaudeCloakingUserId(userId)).toBe(true);
	});

	it("injects generated metadata.user_id for OAuth requests when missing", async () => {
		const payload = (await captureAnthropicPayload(ANTHROPIC_MODEL, {
			systemPrompt: "Stay concise.",
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		})) as { metadata?: { user_id?: string } };
		const userId = payload.metadata?.user_id;
		expect(typeof userId).toBe("string");
		expect(isClaudeCloakingUserId(userId ?? "")).toBe(true);
	});

	it("does not inject metadata.user_id for non-OAuth requests without caller metadata", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: "Stay concise.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ isOAuth: false },
		)) as { metadata?: { user_id?: string } };
		expect(payload.metadata).toBeUndefined();
	});

	it("preserves valid caller metadata.user_id for OAuth requests", async () => {
		const userId = generateClaudeCloakingUserId();
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: "Stay concise.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: userId } },
		)) as { metadata?: { user_id?: string } };

		expect(payload.metadata?.user_id).toBe(userId);
	});

	it("replaces invalid caller metadata.user_id for OAuth requests", async () => {
		const payload = (await captureAnthropicPayload(
			ANTHROPIC_MODEL,
			{
				systemPrompt: "Stay concise.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{ metadata: { user_id: "invalid-user-id" } },
		)) as { metadata?: { user_id?: string } };

		expect(payload.metadata?.user_id).not.toBe("invalid-user-id");
		expect(isClaudeCloakingUserId(payload.metadata?.user_id ?? "")).toBe(true);
	});
	it("drops fine-grained tool-streaming beta from default Anthropic client options", () => {
		const options = buildAnthropicClientOptions({
			model: ANTHROPIC_MODEL,
			apiKey: "sk-ant-oat-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			dynamicHeaders: {},
		});

		const beta = options.defaultHeaders["Anthropic-Beta"];
		expect(beta).toContain("context-management-2025-06-27");
		expect(beta).not.toContain("fine-grained-tool-streaming-2025-05-14");
	});

	it("applies Claude Code TLS profile for direct Anthropic transport", () => {
		const options = buildAnthropicClientOptions({
			model: ANTHROPIC_MODEL,
			apiKey: "sk-ant-oat-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			dynamicHeaders: {},
		});

		const tlsOptions = (
			options.fetchOptions as
				| {
						tls?: {
							rejectUnauthorized?: boolean;
							serverName?: string;
							ciphers?: string;
						};
				  }
				| undefined
		)?.tls;
		expect(tlsOptions).toBeDefined();
		expect(tlsOptions?.rejectUnauthorized).toBe(true);
		expect(tlsOptions?.serverName).toBe("api.anthropic.com");
		expect(tlsOptions?.ciphers).toBe(tls.DEFAULT_CIPHERS);
	});

	it("uses Foundry base URL, Bearer auth, and custom headers when enabled", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com/anthropic/",
				ANTHROPIC_CUSTOM_HEADERS: "user-id: alice, x-route: engineering",
			},
			() => {
				const options = buildAnthropicClientOptions({
					model: ANTHROPIC_MODEL,
					apiKey: "foundry-token",
					extraBetas: [],
					stream: true,
					interleavedThinking: false,
					dynamicHeaders: {},
				});

				expect(options.baseURL).toBe("https://foundry.example.com/anthropic");
				expect(options.defaultHeaders.Authorization).toBe("Bearer foundry-token");
				expect(options.defaultHeaders["X-Api-Key"]).toBeUndefined();
				expect(options.defaultHeaders["user-id"]).toBe("alice");
				expect(options.defaultHeaders["x-route"]).toBe("engineering");
			},
		);
	});

	it("loads Foundry mTLS and CA material from file paths", async () => {
		const tmpDir = path.join(os.tmpdir(), `pi-ai-foundry-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		fs.mkdirSync(tmpDir, { recursive: true });
		const caPath = path.join(tmpDir, "ca.pem");
		const certPath = path.join(tmpDir, "client-cert.pem");
		const keyPath = path.join(tmpDir, "client-key.pem");
		fs.writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n", "utf8");
		fs.writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n", "utf8");
		fs.writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n", "utf8");

		try {
			await withEnv(
				{
					CLAUDE_CODE_USE_FOUNDRY: "1",
					FOUNDRY_BASE_URL: "https://foundry.example.com",
					NODE_EXTRA_CA_CERTS: caPath,
					CLAUDE_CODE_CLIENT_CERT: certPath,
					CLAUDE_CODE_CLIENT_KEY: keyPath,
				},
				() => {
					const options = buildAnthropicClientOptions({
						model: ANTHROPIC_MODEL,
						apiKey: "foundry-token",
						extraBetas: [],
						stream: true,
						interleavedThinking: false,
						dynamicHeaders: {},
					});

					const tlsOptions = (
						options.fetchOptions as
							| {
									tls?: {
										serverName?: string;
										ca?: string | string[];
										cert?: string;
										key?: string;
									};
							  }
							| undefined
					)?.tls;
					expect(tlsOptions?.serverName).toBe("foundry.example.com");
					expect(Array.isArray(tlsOptions?.ca)).toBe(true);
					const caValues = (tlsOptions?.ca ?? []) as string[];
					expect(caValues.length).toBeGreaterThanOrEqual(tls.rootCertificates.length + 1);
					expect(caValues.slice(0, tls.rootCertificates.length)).toEqual([...tls.rootCertificates]);
					expect(caValues.at(-1)).toContain("BEGIN CERTIFICATE");
					expect(tlsOptions?.cert).toContain("BEGIN CERTIFICATE");
					expect(tlsOptions?.key).toContain("BEGIN PRIVATE KEY");
				},
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("throws when Foundry mTLS cert/key pair is incomplete", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com",
				CLAUDE_CODE_CLIENT_CERT: "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n",
				CLAUDE_CODE_CLIENT_KEY: undefined,
			},
			() => {
				expect(() =>
					buildAnthropicClientOptions({
						model: ANTHROPIC_MODEL,
						apiKey: "foundry-token",
						extraBetas: [],
						stream: true,
						interleavedThinking: false,
						dynamicHeaders: {},
					}),
				).toThrow("Both CLAUDE_CODE_CLIENT_CERT and CLAUDE_CODE_CLIENT_KEY must be set for mTLS.");
			},
		);
	});

	it("resolves Anthropic Foundry API key when Foundry mode is enabled", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				ANTHROPIC_FOUNDRY_API_KEY: "foundry-env-token",
				ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-should-not-win",
				ANTHROPIC_API_KEY: "sk-ant-api-should-not-win",
			},
			() => {
				expect(getEnvApiKey("anthropic")).toBe("foundry-env-token");
			},
		);
	});

	it("drops sampling params and requests summarized adaptive thinking for Opus 4.7", async () => {
		const payload = (await captureAnthropicPayload(
			{
				...ANTHROPIC_MODEL,
				id: "claude-opus-4-7",
				name: "Claude Opus 4.7",
				thinking: {
					mode: "anthropic-adaptive",
					minLevel: Effort.Minimal,
					maxLevel: Effort.XHigh,
				},
			},
			{
				systemPrompt: "Stay concise.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				thinkingEnabled: true,
				reasoning: Effort.High,
				temperature: 0.2,
				topP: 0.3,
				topK: 4,
			},
		)) as {
			temperature?: number;
			top_p?: number;
			top_k?: number;
			thinking?: { type?: string; display?: string };
			output_config?: { effort?: string };
		};

		expect(payload.temperature).toBeUndefined();
		expect(payload.top_p).toBeUndefined();
		expect(payload.top_k).toBeUndefined();
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "high" });
	});

	it("treats tool prefix helpers as no-ops when prefix is empty", () => {
		expect(applyClaudeToolPrefix("Read", "")).toBe("Read");
		expect(stripClaudeToolPrefix("proxy_Read", "")).toBe("proxy_Read");
	});

	it("does not prefix built-in Anthropic tool names when prefix is configured", () => {
		expect(applyClaudeToolPrefix("web_search", "proxy_")).toBe("web_search");
		expect(applyClaudeToolPrefix("CODE_EXECUTION", "proxy_")).toBe("CODE_EXECUTION");
		expect(applyClaudeToolPrefix("Text_Editor", "proxy_")).toBe("Text_Editor");
		expect(applyClaudeToolPrefix("computer", "proxy_")).toBe("computer");
	});

	it("prefixes custom tool names when prefix is configured", () => {
		expect(applyClaudeToolPrefix("Read", "proxy_")).toBe("proxy_Read");
		expect(applyClaudeToolPrefix("proxy_Read", "proxy_")).toBe("proxy_Read");
		expect(stripClaudeToolPrefix("proxy_Read", "proxy_")).toBe("Read");
	});
});

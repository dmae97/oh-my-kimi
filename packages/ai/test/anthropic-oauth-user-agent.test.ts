import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.ts";
import type { Context, Model } from "../src/types.ts";
import { CLAUDE_CODE_CLI_USER_AGENT } from "../src/utils/claude-code-identity.ts";

/**
 * Locks the header that actually reaches Anthropic on the OAuth (Pro/Max) path.
 * The model gate is evaluated against the version in this user-agent, so a
 * stale value fails every turn with HTTP 400 `claude_code_version_too_old` —
 * and nothing else in the suite exercises the outbound header.
 */
function oauthModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

function context(): Context {
	return { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
}

async function captureRequestHeaders(apiKey: string): Promise<Headers> {
	let captured: Headers | undefined;
	vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit): Promise<Response> => {
		captured = input instanceof Request ? input.headers : new Headers(init?.headers);
		return new Response("stream unavailable", { status: 500 });
	});

	await streamSimple(oauthModel(), context(), { apiKey, maxRetries: 0 }).result();

	if (!captured) throw new Error("no request was issued");
	return captured;
}

describe("anthropic OAuth user-agent", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends the shared Claude Code version on the OAuth path", async () => {
		const headers = await captureRequestHeaders("sk-ant-oat01-test-token");

		expect(headers.get("user-agent")).toBe(CLAUDE_CODE_CLI_USER_AGENT);
		expect(headers.get("x-app")).toBe("cli");
	});

	it("does not spoof the CLI identity for plain API keys", async () => {
		const headers = await captureRequestHeaders("sk-ant-api03-test-key");

		expect(headers.get("user-agent")).not.toBe(CLAUDE_CODE_CLI_USER_AGENT);
		expect(headers.get("x-app")).toBeNull();
	});
});

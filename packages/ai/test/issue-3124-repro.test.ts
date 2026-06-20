import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const originalSkipAuth = process.env.AWS_BEDROCK_SKIP_AUTH;

beforeAll(() => {
	process.env.AWS_BEDROCK_SKIP_AUTH = "1";
});

afterAll(() => {
	if (originalSkipAuth === undefined) delete process.env.AWS_BEDROCK_SKIP_AUTH;
	else process.env.AWS_BEDROCK_SKIP_AUTH = originalSkipAuth;
});

interface BedrockToolConfigPayload {
	toolConfig?: {
		tools?: Array<{ toolSpec?: { name?: string } }>;
		toolChoice?: { auto?: Record<string, never> };
	};
}

function isBedrockToolConfigPayload(payload: unknown): payload is BedrockToolConfigPayload {
	return typeof payload === "object" && payload !== null;
}

function model(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
		name: "Claude 3.5 Sonnet",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

function toolHistoryContext(): Context {
	return {
		messages: [
			{ role: "user", content: "Read the file", timestamp: 0 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 0,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "contents" }],
				isError: false,
				timestamp: 0,
			},
			{ role: "user", content: "Side-channel question", timestamp: 1 },
		],
		tools: [],
	};
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function captureBedrockPayload(context: Context): Promise<BedrockToolConfigPayload> {
	const { promise, resolve } = Promise.withResolvers<BedrockToolConfigPayload>();
	void streamBedrock(model(), context, {
		signal: abortedSignal(),
		toolChoice: "none",
		onPayload: payload => {
			resolve(isBedrockToolConfigPayload(payload) ? payload : {});
			return undefined;
		},
	});
	return promise;
}

describe("issue #3124 — Bedrock /btw with tool history", () => {
	it("keeps toolConfig when a no-tool ephemeral turn replays toolUse/toolResult history", async () => {
		const payload = await captureBedrockPayload(toolHistoryContext());

		expect(payload.toolConfig?.tools?.[0]?.toolSpec?.name).toBe("__no_tools__");
		expect(payload.toolConfig?.toolChoice?.auto).toEqual({});
	});
});

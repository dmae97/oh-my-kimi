import { describe, expect, it } from "bun:test";
import { Effort, type FetchImpl } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

interface CapturedRequestBody {
	model?: string;
	request?: {
		generationConfig?: {
			thinkingConfig?: {
				includeThoughts?: boolean;
				thinkingLevel?: string;
				thinkingBudget?: number;
			};
		};
	};
}

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function collapsedFlashModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-3.5-flash",
		requestModelId: "gemini-3.5-flash-extra-low",
		name: "Gemini 3.5 Flash",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		thinking: {
			mode: "google-level",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortRouting: {
				off: "gemini-3.5-flash-extra-low",
				[Effort.Minimal]: "gemini-3-flash-agent",
				[Effort.Low]: "gemini-3.5-flash-extra-low",
				[Effort.Medium]: "gemini-3.5-flash-extra-low",
				[Effort.High]: "gemini-3.5-flash-low",
			},
			suppressWhenOff: true,
		},
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
	} satisfies ModelSpec<"google-gemini-cli">);
}

function collapsedClaudeModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "claude-sonnet-4-6",
		requestModelId: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortRouting: {
				off: "claude-sonnet-4-6",
				[Effort.Minimal]: "claude-sonnet-4-6-thinking",
				[Effort.Low]: "claude-sonnet-4-6-thinking",
				[Effort.Medium]: "claude-sonnet-4-6-thinking",
				[Effort.High]: "claude-sonnet-4-6-thinking",
			},
		},
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	} satisfies ModelSpec<"google-gemini-cli">);
}

function unroutedModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	} satisfies ModelSpec<"google-gemini-cli">);
}

async function captureRequest(
	model: Model<"google-gemini-cli">,
	reasoning: Effort | undefined,
): Promise<{ body: CapturedRequestBody; attributedModel: string }> {
	let requestBody: string | undefined;
	const fetchMock: FetchImpl = (_input, init) => {
		requestBody = typeof init?.body === "string" ? init.body : undefined;
		return Promise.resolve(new Response('{"error":{"message":"bad request"}}', { status: 400 }));
	};
	const stream = streamSimple(model, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		reasoning,
		fetch: fetchMock,
	});
	const result = await stream.result();
	if (!requestBody) throw new Error("request body was not captured");
	return { body: JSON.parse(requestBody) as CapturedRequestBody, attributedModel: result.model };
}

describe("google-gemini-cli effort-tier variant routing", () => {
	it("routes each effort to its backing wire id and attributes usage to the logical id", async () => {
		const high = await captureRequest(collapsedFlashModel(), Effort.High);
		expect(high.body.model).toBe("gemini-3.5-flash-low");
		expect(high.body.request?.generationConfig?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: "HIGH",
		});
		expect(high.attributedModel).toBe("gemini-3.5-flash");

		const minimal = await captureRequest(collapsedFlashModel(), Effort.Minimal);
		expect(minimal.body.model).toBe("gemini-3-flash-agent");
		expect(minimal.body.request?.generationConfig?.thinkingConfig?.thinkingLevel).toBe("MINIMAL");
	});

	it("suppresses thinking explicitly on the wire when off and suppressWhenOff is set", async () => {
		const off = await captureRequest(collapsedFlashModel(), undefined);
		expect(off.body.model).toBe("gemini-3.5-flash-extra-low");
		expect(off.body.request?.generationConfig?.thinkingConfig).toEqual({
			includeThoughts: false,
			thinkingLevel: "MINIMAL",
		});
	});

	it("routes claude pairs to the bare id when off without wire suppression", async () => {
		const off = await captureRequest(collapsedClaudeModel(), undefined);
		expect(off.body.model).toBe("claude-sonnet-4-6");
		// Omitting thinkingConfig is correct on the non-thinking backing id.
		expect(off.body.request?.generationConfig?.thinkingConfig).toBeUndefined();
	});

	it("routes claude pairs to the -thinking id with a budget when reasoning", async () => {
		const high = await captureRequest(collapsedClaudeModel(), Effort.High);
		expect(high.body.model).toBe("claude-sonnet-4-6-thinking");
		expect(high.body.request?.generationConfig?.thinkingConfig?.includeThoughts).toBe(true);
		expect(high.body.request?.generationConfig?.thinkingConfig?.thinkingBudget).toBeGreaterThan(0);
	});

	it("keeps the status quo for un-routed models", async () => {
		const off = await captureRequest(unroutedModel(), undefined);
		expect(off.body.model).toBe("gemini-2.5-flash");
		expect(off.body.request?.generationConfig?.thinkingConfig).toBeUndefined();

		const high = await captureRequest(unroutedModel(), Effort.High);
		expect(high.body.model).toBe("gemini-2.5-flash");
		expect(high.body.request?.generationConfig?.thinkingConfig?.thinkingBudget).toBeGreaterThan(0);
	});
});

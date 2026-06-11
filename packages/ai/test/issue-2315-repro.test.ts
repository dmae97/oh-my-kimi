import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

interface CaptureOptions {
	disableReasoning?: boolean;
	reasoning?: Effort;
}

async function capturePayload(
	model: Model<"openai-completions">,
	options: CaptureOptions,
): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return createSseResponse([
				{
					id: "x",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: { content: "ok" } }],
				},
				{
					id: "x",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
				"[DONE]",
			]);
		},
		{ preconnect: fetch.preconnect },
	);
	await streamOpenAICompletions(model, testContext, {
		apiKey: "test-key",
		fetch: fetchMock,
		disableReasoning: options.disableReasoning,
		reasoning: options.reasoning,
	}).result();
	if (!payload) throw new Error("Expected request payload");
	return payload;
}

describe("issue #2315 — MiniMax M2 / GPT-OSS reject Fireworks' `none`/`minimal`/`xhigh` reasoning_effort", () => {
	it("disableReasoning on fireworks/minimax-m2.7 clamps to the lowest server-accepted effort", async () => {
		const model = getBundledModel("fireworks", "minimax-m2.7") as Model<"openai-completions">;
		const body = await capturePayload(model, { disableReasoning: true });
		// Pre-fix the wire body carried "none", which MiniMax M2 400'd on every
		// auto-thinking turn. The lowest accepted effort is "low".
		expect(body.reasoning_effort).toBe("low");
	});

	it("disableReasoning on fireworks/gpt-oss-120b clamps to the lowest server-accepted effort", async () => {
		const model = getBundledModel("fireworks", "gpt-oss-120b") as Model<"openai-completions">;
		const body = await capturePayload(model, { disableReasoning: true });
		expect(body.reasoning_effort).toBe("low");
	});

	it("clamps user-requested xhigh on fireworks/minimax-m2.7 to the highest server-accepted effort", async () => {
		const model = getBundledModel("fireworks", "minimax-m2.7") as Model<"openai-completions">;
		const body = await capturePayload(model, { reasoning: Effort.XHigh });
		// xhigh is unsupported upstream; the map clamps to "high" (the ceiling
		// of the {low, medium, high} set MiniMax M2 actually accepts).
		expect(body.reasoning_effort).toBe("high");
	});

	it("preserves low/medium/high passthrough on fireworks/minimax-m2.7", async () => {
		const model = getBundledModel("fireworks", "minimax-m2.7") as Model<"openai-completions">;
		const lowBody = await capturePayload(model, { reasoning: Effort.Low });
		expect(lowBody.reasoning_effort).toBe("low");
		const medBody = await capturePayload(model, { reasoning: Effort.Medium });
		expect(medBody.reasoning_effort).toBe("medium");
		const highBody = await capturePayload(model, { reasoning: Effort.High });
		expect(highBody.reasoning_effort).toBe("high");
	});

	it("keeps the Fireworks-wide minimal→none mapping for non-restricted models (glm-5.1)", async () => {
		const model = getBundledModel("fireworks", "glm-5.1") as Model<"openai-completions">;
		const body = await capturePayload(model, { disableReasoning: true });
		expect(body.reasoning_effort).toBe("none");
	});
});

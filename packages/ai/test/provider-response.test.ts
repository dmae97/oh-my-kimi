import { describe, expect, it } from "bun:test";
import type { Model, ProviderResponseMetadata } from "../src/types";
import { normalizeProviderResponse, notifyProviderResponse } from "../src/utils/provider-response";

describe("provider response metadata", () => {
	it("normalizes response status, headers, and request id", () => {
		const response = new Response(null, {
			status: 202,
			headers: {
				"X-Request-ID": "req_123",
				"X-RateLimit-Remaining": "42",
			},
		});

		expect(normalizeProviderResponse(response, "req_123")).toEqual({
			status: 202,
			headers: {
				"x-request-id": "req_123",
				"x-ratelimit-remaining": "42",
			},
			requestId: "req_123",
		});
	});

	it("invokes the response callback with normalized metadata", async () => {
		const seen: Array<{ response: ProviderResponseMetadata; model: Model | undefined }> = [];
		const model = { provider: "openai", api: "openai-responses", id: "gpt-test" } as Model;

		await notifyProviderResponse(
			{
				onResponse: (response, responseModel) => {
					seen.push({ response, model: responseModel });
				},
			},
			new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }),
			model,
			null,
			{ attempt: 1 },
		);

		expect(seen).toEqual([
			{
				response: {
					status: 204,
					headers: { "cache-control": "no-store" },
					requestId: null,
					metadata: { attempt: 1 },
				},
				model,
			},
		]);
	});
});

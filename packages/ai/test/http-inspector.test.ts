import { describe, expect, it } from "bun:test";
import { buildHttp400DumpPayload, type RawHttpRequestDump } from "@oh-my-pi/pi-ai/utils/http-inspector";

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const dump: RawHttpRequestDump = {
	provider: "anthropic",
	api: "anthropic-messages",
	model: "claude-opus-4-8",
	method: "POST",
	url: "https://api.anthropic.com/v1/messages",
	headers: { "x-api-key": "secret-key", "content-type": "application/json" },
	body: { messages: [{ role: "user", content: "hi" }] },
};

describe("buildHttp400DumpPayload", () => {
	it("keeps request fields top-level and records the provider error response", () => {
		const message = "400 image exceeds 5 MB limit";
		const payload = buildHttp400DumpPayload(dump, new HttpError(400, message), message);

		expect(payload.provider).toBe("anthropic");
		expect(payload.url).toBe("https://api.anthropic.com/v1/messages");
		expect(payload.body).toEqual({ messages: [{ role: "user", content: "hi" }] });
		expect(payload.errorResponse).toEqual({ status: 400, message });
	});

	it("redacts sensitive request headers while keeping the rest", () => {
		const payload = buildHttp400DumpPayload(dump, new HttpError(400, "x"), "x");

		expect(payload.headers?.["x-api-key"]).toBe("[redacted]");
		expect(payload.headers?.["content-type"]).toBe("application/json");
	});
});

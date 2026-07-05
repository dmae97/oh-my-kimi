import { describe, expect, it } from "bun:test";
import {
	buildHttp400DumpPayload,
	type RawHttpRequestDump,
	shouldDumpRejectedRequest,
} from "@oh-my-pi/pi-ai/utils/http-inspector";

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

describe("shouldDumpRejectedRequest", () => {
	it("captures request-content rejections (400 bad request, 413 payload too large)", () => {
		expect(shouldDumpRejectedRequest(new HttpError(400, "bad request"))).toBe(true);
		expect(shouldDumpRejectedRequest(new HttpError(413, "payload too large"))).toBe(true);
	});

	it("skips auth, not-found, rate-limit, and retried 5xx errors that would spam dumps", () => {
		for (const status of [401, 403, 404, 429, 500, 502, 503, 504]) {
			expect(shouldDumpRejectedRequest(new HttpError(status, "x"))).toBe(false);
		}
	});

	it("skips errors without an HTTP status", () => {
		expect(shouldDumpRejectedRequest(new Error("network reset"))).toBe(false);
	});
});

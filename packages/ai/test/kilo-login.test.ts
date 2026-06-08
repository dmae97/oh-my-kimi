import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginKilo } from "../src/registry/kilo";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("kilo oauth login", () => {
	it("returns OAuth credentials when device authorization is approved", async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.kilo.ai/api/device-auth/codes") {
				expect(init?.method).toBe("POST");
				return new Response(
					JSON.stringify({
						code: "ABC123",
						verificationUrl: "https://kilo.ai/verify",
						expiresIn: 300,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://api.kilo.ai/api/device-auth/codes/ABC123") {
				return new Response(JSON.stringify({ status: "approved", token: "kilo-access-token" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const onAuth = vi.fn();
		const credentials = await loginKilo({ onAuth });

		expect(onAuth).toHaveBeenCalledWith({
			url: "https://kilo.ai/verify",
			instructions: "Enter code: ABC123",
		});
		expect(credentials.access).toBe("kilo-access-token");
		expect(credentials.refresh).toBe("");
		expect(credentials.expires).toBeGreaterThan(Date.now());
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("surfaces rate-limit errors from device authorization start", async () => {
		global.fetch = vi.fn(async () => new Response(null, { status: 429 })) as unknown as typeof fetch;

		await expect(loginKilo({})).rejects.toThrow("Too many pending authorization requests. Please try again later.");
	});

	it("surfaces denied device authorization state", async () => {
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.kilo.ai/api/device-auth/codes") {
				return new Response(
					JSON.stringify({
						code: "DENY1",
						verificationUrl: "https://kilo.ai/verify",
						expiresIn: 300,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://api.kilo.ai/api/device-auth/codes/DENY1") {
				return new Response(null, { status: 403 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(loginKilo({})).rejects.toThrow("Authorization was denied");
	});
});

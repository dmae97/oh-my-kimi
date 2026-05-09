import { afterEach, describe, expect, it, vi } from "bun:test";
import { getOAuthApiKey } from "../src/utils/oauth";
import * as kimiOauth from "../src/utils/oauth/kimi";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("issue #957 - Kimi OAuth refresh", () => {
	it("refreshes before the old token reaches its real server expiry", async () => {
		const issuedAt = 1_700_000_000_000;
		let now = issuedAt;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue({});

		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const params = new URLSearchParams(String(init?.body));
			expect(params.get("grant_type")).toBe("refresh_token");
			const refreshToken = params.get("refresh_token");
			if (refreshToken === "refresh-0") {
				return new Response(
					JSON.stringify({
						access_token: "access-1",
						refresh_token: "refresh-1",
						expires_in: 60 * 60,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (refreshToken === "refresh-1") {
				return new Response(
					JSON.stringify({
						access_token: "access-2",
						refresh_token: "refresh-2",
						expires_in: 60 * 60,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected refresh token: ${refreshToken}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const initial = await kimiOauth.refreshKimiToken("refresh-0");
		expect(initial.expires).toBe(issuedAt + 55 * 60 * 1000);

		now = issuedAt + 54 * 60 * 1000;
		const stillValid = await getOAuthApiKey("kimi-code", { "kimi-code": initial });
		expect(stillValid).not.toBeNull();
		expect(stillValid!.apiKey).toBe("access-1");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		now = issuedAt + 59 * 60 * 1000;
		const refreshed = await getOAuthApiKey("kimi-code", { "kimi-code": stillValid!.newCredentials });
		expect(refreshed).not.toBeNull();
		expect(refreshed!.apiKey).toBe("access-2");
		expect(refreshed!.newCredentials.refresh).toBe("refresh-2");
		expect(refreshed!.newCredentials.expires).toBe(now + 55 * 60 * 1000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

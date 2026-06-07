import { describe, expect, it, mock } from "bun:test";
import { getVertexAccessToken, __resetVertexTokenCache } from "../google-auth";

describe("getVertexAccessToken", () => {
	it("should exchange impersonated ADC correctly", async () => {
		__resetVertexTokenCache();
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/mock-impersonated-adc.json";
		
		await Bun.write("/tmp/mock-impersonated-adc.json", JSON.stringify({
			type: "impersonated_service_account",
			service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/target@project.iam.gserviceaccount.com:generateAccessToken",
			source_credentials: {
				type: "authorized_user",
				client_id: "client-id",
				client_secret: "client-secret",
				refresh_token: "refresh-token"
			},
			delegates: ["delegate1"]
		}));

		let fetchCalls: any[] = [];
		const mockFetch = mock(async (url: string, opts: any) => {
			fetchCalls.push({ url, opts });
			if (url.includes("oauth2.googleapis.com/token")) {
				return { ok: true, json: async () => ({ access_token: "source-token", expires_in: 3600 }) };
			}
			if (url.includes("iamcredentials.googleapis.com")) {
				return { ok: true, json: async () => ({ accessToken: "impersonated-token", expireTime: new Date(Date.now() + 3600000).toISOString() }) };
			}
			return { ok: false };
		}) as any;

		const token = await getVertexAccessToken({ fetch: mockFetch });
		expect(token).toBe("impersonated-token");
		expect(fetchCalls.length).toBe(2);
		expect(fetchCalls[0].url).toContain("oauth2.googleapis.com");
		expect(fetchCalls[1].url).toBe("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/target@project.iam.gserviceaccount.com:generateAccessToken");
		expect(fetchCalls[1].opts.headers.Authorization).toBe("Bearer source-token");
		expect(JSON.parse(fetchCalls[1].opts.body).delegates).toEqual(["delegate1"]);
	});
});

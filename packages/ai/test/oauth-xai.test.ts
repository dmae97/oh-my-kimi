import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthLoginCallbacks } from "../src/utils/oauth/types.ts";
import { loginXAI } from "../src/utils/oauth/xai.ts";

const XAI_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
const XAI_VERIFICATION_URI = "https://accounts.x.ai/oauth2/device";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("native xAI OAuth", () => {
	it("uses the official Grok Build device authorization contract", async () => {
		// Given: xAI discovery and device-code endpoints accept the request.
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ token_endpoint: XAI_TOKEN_ENDPOINT }))
			.mockResolvedValueOnce(
				jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: XAI_VERIFICATION_URI,
					verification_uri_complete: `${XAI_VERIFICATION_URI}?user_code=ABCD-EFGH`,
					expires_in: 1800,
					interval: 5,
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const controller = new AbortController();
		const callbacks: OAuthLoginCallbacks = {
			onAuth: () => controller.abort(),
			onDeviceCode: vi.fn(),
			onPrompt: vi.fn(),
			onSelect: vi.fn(),
			signal: controller.signal,
		};

		// When: native xAI login requests a device code.
		await expect(loginXAI(callbacks)).rejects.toThrow("Login cancelled");

		// Then: the request matches Grok Build's accepted device-flow metadata.
		const deviceRequest = fetchMock.mock.calls[1];
		expect(deviceRequest).toBeDefined();
		const request = new Request(deviceRequest?.[0] ?? XAI_VERIFICATION_URI, deviceRequest?.[1]);
		expect(request.headers.get("x-grok-client-surface")).toBe("ui");
		const form = new URLSearchParams(await request.text());
		expect(form.get("referrer")).toBe("grok-build");
		expect(form.get("scope")?.split(" ")).toEqual([
			"openid",
			"profile",
			"email",
			"offline_access",
			"grok-cli:access",
			"api:access",
			"conversations:read",
			"conversations:write",
			"workspaces:read",
			"workspaces:write",
		]);
	});
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import { isXAIAccessTokenExpiring, loginXAIOAuth, refreshXAIOAuthToken, validateXAIEndpoint } from "../xai-oauth";

afterEach(() => {
	vi.restoreAllMocks();
});

function jwtWithExp(exp: number): string {
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
	return `${header}.${payload}.sig`;
}

const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";

const DEVICE_AUTHORIZATION = {
	device_code: "device-code-123",
	user_code: "ABCD-EFGH",
	verification_uri: "https://auth.x.ai/activate",
	verification_uri_complete: "https://auth.x.ai/activate?user_code=ABCD-EFGH",
	expires_in: 600,
	interval: 1,
};

type RecordedRequest = {
	url: string;
	init: RequestInit | undefined;
};

type TokenResponse = {
	body: unknown;
	status?: number;
};

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function createDeviceFlowFetch(tokenResponses: readonly TokenResponse[]) {
	const requests: RecordedRequest[] = [];
	let tokenResponseIndex = 0;
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
		requests.push({ url, init });

		if (url === DISCOVERY_URL) {
			return jsonResponse({ token_endpoint: TOKEN_ENDPOINT });
		}
		if (url === DEVICE_CODE_URL) {
			return jsonResponse(DEVICE_AUTHORIZATION);
		}
		if (url === TOKEN_ENDPOINT) {
			const tokenResponse = tokenResponses[tokenResponseIndex];
			tokenResponseIndex += 1;
			if (!tokenResponse) {
				throw new Error(`Unexpected xAI token poll ${tokenResponseIndex}`);
			}
			return jsonResponse(tokenResponse.body, tokenResponse.status);
		}
		throw new Error(`Unexpected xAI OAuth request: ${url}`);
	});

	return {
		fetchMock: fetchMock as unknown as typeof fetch,
		requests,
	};
}

function requestForm(request: RecordedRequest | undefined): URLSearchParams {
	const body = request?.init?.body;
	if (!(body instanceof URLSearchParams)) {
		throw new Error("Expected an application/x-www-form-urlencoded request body");
	}
	return body;
}

describe("isXAIAccessTokenExpiring", () => {
	it("returns false for an empty string", () => {
		expect(isXAIAccessTokenExpiring("")).toBe(false);
	});

	it("returns false for a non-JWT", () => {
		expect(isXAIAccessTokenExpiring("not.a.jwt")).toBe(false);
	});

	it("returns true when exp is already in the past", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(isXAIAccessTokenExpiring(jwtWithExp(now - 60))).toBe(true);
	});

	it("returns false when exp is well in the future", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(isXAIAccessTokenExpiring(jwtWithExp(now + 3600))).toBe(false);
	});
});

describe("validateXAIEndpoint", () => {
	it("rejects non-HTTPS URLs", () => {
		expect(() => validateXAIEndpoint("http://x.ai/token", "token_endpoint")).toThrow(/Invalid xAI token_endpoint/);
	});

	it("rejects non-xAI hosts", () => {
		expect(() => validateXAIEndpoint("https://evil.com/token", "token_endpoint")).toThrow(
			/Invalid xAI token_endpoint/,
		);
	});

	it("accepts the x.ai apex and *.x.ai subdomains", () => {
		expect(validateXAIEndpoint("https://x.ai/token", "token_endpoint")).toBe("https://x.ai/token");
		expect(validateXAIEndpoint("https://auth.x.ai/oauth/token", "token_endpoint")).toBe(
			"https://auth.x.ai/oauth/token",
		);
	});
});

describe("refreshXAIOAuthToken", () => {
	it("rejects an empty refresh_token without making a network call", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("fetch should not be called when refresh_token is empty");
		});

		await expect(refreshXAIOAuthToken("", fetchMock as unknown as typeof fetch)).rejects.toThrow(
			/missing refresh_token/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("loginXAIOAuth", () => {
	it("performs the RFC 8628 device flow and returns the issued credentials", async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const { fetchMock, requests } = createDeviceFlowFetch([
			{
				body: {
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				},
			},
		]);
		const authEvents: Array<{ url: string; instructions?: string }> = [];
		const progress: string[] = [];
		const onAuth = vi.fn((info: { url: string; instructions?: string }) => {
			authEvents.push(info);
		});
		const onProgress = vi.fn((message: string) => {
			progress.push(message);
		});
		const onManualCodeInput = vi.fn(async () => {
			throw new Error("device authorization must not request a pasted code");
		});

		const credentials = await loginXAIOAuth({
			fetch: fetchMock,
			onAuth,
			onProgress,
			onManualCodeInput,
		});

		expect(requests.map(request => request.url)).toEqual([DISCOVERY_URL, DEVICE_CODE_URL, TOKEN_ENDPOINT]);

		const discoveryRequest = requests[0];
		expect(discoveryRequest?.init?.method).toBe("GET");
		expect(new Headers(discoveryRequest?.init?.headers).get("Accept")).toBe("application/json");

		const deviceRequest = requests[1];
		expect(deviceRequest?.init?.method).toBe("POST");
		const deviceHeaders = new Headers(deviceRequest?.init?.headers);
		expect(deviceHeaders.get("Content-Type")).toBe("application/x-www-form-urlencoded");
		expect(deviceHeaders.get("Accept")).toBe("application/json");
		const deviceForm = requestForm(deviceRequest);
		expect([...deviceForm.keys()].sort()).toEqual(["client_id", "scope"]);
		expect(Object.fromEntries(deviceForm)).toEqual({
			client_id: CLIENT_ID,
			scope: SCOPE,
		});

		const tokenRequest = requests[2];
		expect(tokenRequest?.init?.method).toBe("POST");
		const tokenHeaders = new Headers(tokenRequest?.init?.headers);
		expect(tokenHeaders.get("Content-Type")).toBe("application/x-www-form-urlencoded");
		expect(tokenHeaders.get("Accept")).toBe("application/json");
		const tokenForm = requestForm(tokenRequest);
		expect([...tokenForm.keys()].sort()).toEqual(["client_id", "device_code", "grant_type"]);
		expect(Object.fromEntries(tokenForm)).toEqual({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			client_id: CLIENT_ID,
			device_code: DEVICE_AUTHORIZATION.device_code,
		});

		expect(authEvents).toEqual([
			{
				url: DEVICE_AUTHORIZATION.verification_uri_complete,
				instructions: `Enter code: ${DEVICE_AUTHORIZATION.user_code}`,
			},
		]);
		expect(authEvents[0]?.instructions).not.toMatch(/hermes/i);
		expect(onManualCodeInput).not.toHaveBeenCalled();
		expect(progress).toEqual(["Waiting for xAI device authorization..."]);
		expect(credentials).toEqual({
			access: "access-token",
			refresh: "refresh-token",
			expires: now + 3_300_000,
		});
	});

	it("continues through authorization_pending and slow_down responses", async () => {
		const sleepSpy = vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		const { fetchMock, requests } = createDeviceFlowFetch([
			{ status: 400, body: { error: "authorization_pending" } },
			{ status: 400, body: { error: "slow_down" } },
			{
				body: {
					access_token: "eventual-access-token",
					refresh_token: "eventual-refresh-token",
					expires_in: 3600,
				},
			},
		]);

		const credentials = await loginXAIOAuth({ fetch: fetchMock });

		const tokenRequests = requests.filter(request => request.url === TOKEN_ENDPOINT);
		expect(tokenRequests).toHaveLength(3);
		expect(tokenRequests.map(request => Object.fromEntries(requestForm(request)))).toEqual([
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: CLIENT_ID,
				device_code: DEVICE_AUTHORIZATION.device_code,
			},
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: CLIENT_ID,
				device_code: DEVICE_AUTHORIZATION.device_code,
			},
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: CLIENT_ID,
				device_code: DEVICE_AUTHORIZATION.device_code,
			},
		]);
		expect(sleepSpy.mock.calls).toEqual([[1000], [6000]]);
		expect(credentials.access).toBe("eventual-access-token");
		expect(credentials.refresh).toBe("eventual-refresh-token");
	});

	it("rejects a token response that omits access_token", async () => {
		const { fetchMock, requests } = createDeviceFlowFetch([
			{
				body: {
					refresh_token: "refresh-token",
					expires_in: 3600,
				},
			},
		]);

		await expect(loginXAIOAuth({ fetch: fetchMock })).rejects.toThrow(
			/xAI device-code token response missing access_token/,
		);
		expect(requests.filter(request => request.url === TOKEN_ENDPOINT)).toHaveLength(1);
	});
});

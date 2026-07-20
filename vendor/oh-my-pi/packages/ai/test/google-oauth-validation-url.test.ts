import { afterEach, describe, expect, it, vi } from "bun:test";
import { GoogleOAuthFlow, type GoogleOAuthFlowConfig } from "@oh-my-pi/pi-ai/oauth/google-oauth-shared";
import type { OAuthController } from "@oh-my-pi/pi-ai/oauth/types";
import { extractGoogleValidationUrl } from "@oh-my-pi/pi-ai/utils/google-validation";

const VALIDATION_URL = "https://accounts.google.com/signin/continue?sarp=1&scc=1&plt=AKgnsbtTOKEN";

const validationBody = JSON.stringify({
	error: {
		code: 403,
		status: "PERMISSION_DENIED",
		details: [
			{
				"@type": "type.googleapis.com/google.rpc.ErrorInfo",
				reason: "VALIDATION_REQUIRED",
				metadata: { validation_url: VALIDATION_URL, validation_url_link_text: "Verify your account" },
			},
		],
	},
});

describe("extractGoogleValidationUrl", () => {
	it("extracts the validation url from a raw 403 VALIDATION_REQUIRED body", () => {
		expect(extractGoogleValidationUrl(validationBody)).toBe(VALIDATION_URL);
	});

	it("extracts the url when the body is wrapped in the discovery error prefix", () => {
		// exchangeToken receives discoverProject's thrown message, which embeds the raw body.
		const wrapped = `Could not discover or provision an Antigravity project. loadCodeAssist failed: 403 Forbidden: ${validationBody}`;
		expect(extractGoogleValidationUrl(wrapped)).toBe(VALIDATION_URL);
	});

	it("returns undefined for a 403 that is not VALIDATION_REQUIRED", () => {
		const body = JSON.stringify({
			error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] },
		});
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});

	it("returns undefined when VALIDATION_REQUIRED carries no validation_url", () => {
		const body = JSON.stringify({
			error: { code: 403, details: [{ reason: "VALIDATION_REQUIRED", metadata: {} }] },
		});
		expect(extractGoogleValidationUrl(body)).toBeUndefined();
	});

	it("returns undefined for non-JSON error text", () => {
		expect(extractGoogleValidationUrl("loadCodeAssist failed: 500 Internal Server Error")).toBeUndefined();
	});

	it("returns undefined for empty input", () => {
		expect(extractGoogleValidationUrl("")).toBeUndefined();
	});
});

const TOKEN_URL = "https://oauth2.example.com/token";

function urlOf(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function makeConfig(discoverProject: GoogleOAuthFlowConfig["discoverProject"]): GoogleOAuthFlowConfig {
	return {
		clientId: "client-id",
		clientSecret: "client-secret",
		authUrl: "https://accounts.example.com/o/oauth2/auth",
		tokenUrl: TOKEN_URL,
		scopes: ["scope-a"],
		callbackPort: 0,
		callbackPath: "/callback",
		discoverProject,
	};
}

/** Stub the token-exchange POST and the optional userinfo GET that exchangeToken issues. */
function stubTokenAndUserInfo(email?: string): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | URL | Request) => {
				if (urlOf(input).includes("userinfo")) {
					if (!email) return new Response("{}", { status: 401 });
					return new Response(JSON.stringify({ email }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
			{ preconnect: fetch.preconnect },
		),
	);
}

describe("GoogleOAuthFlow account verification", () => {
	const ctrl: OAuthController = {};

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rewrites a VALIDATION_REQUIRED discovery failure into an actionable message naming the account", async () => {
		stubTokenAndUserInfo("user@example.com");
		const flow = new GoogleOAuthFlow(
			ctrl,
			makeConfig(async () => {
				throw new Error(
					`Could not discover or provision an Antigravity project. loadCodeAssist failed: 403 Forbidden: ${validationBody}`,
				);
			}),
		);

		await expect(flow.exchangeToken("auth-code", "state", "https://localhost/callback")).rejects.toThrow(
			`Account verification required for user@example.com. Visit ${VALIDATION_URL} to continue, then sign in again.`,
		);
	});

	it("omits the account clause when the userinfo lookup yields no email", async () => {
		stubTokenAndUserInfo();
		const flow = new GoogleOAuthFlow(
			ctrl,
			makeConfig(async () => {
				throw new Error(`loadCodeAssist failed: 403 Forbidden: ${validationBody}`);
			}),
		);

		await expect(flow.exchangeToken("auth-code", "state", "https://localhost/callback")).rejects.toThrow(
			`Account verification required. Visit ${VALIDATION_URL} to continue, then sign in again.`,
		);
	});

	it("propagates the original discovery error untouched when it is not VALIDATION_REQUIRED", async () => {
		stubTokenAndUserInfo("user@example.com");
		const original = "Could not discover or provision a Google Cloud project. Set GOOGLE_CLOUD_PROJECT.";
		const flow = new GoogleOAuthFlow(
			ctrl,
			makeConfig(async () => {
				throw new Error(original);
			}),
		);

		await expect(flow.exchangeToken("auth-code", "state", "https://localhost/callback")).rejects.toThrow(original);
	});
});

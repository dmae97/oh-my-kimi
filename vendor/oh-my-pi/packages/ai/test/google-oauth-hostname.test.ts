import { describe, expect, it } from "bun:test";
import { GoogleOAuthFlow } from "../src/registry/oauth/google-oauth-shared";
import type { OAuthController } from "../src/registry/oauth/types";

describe("GoogleOAuthFlow callback hostname", () => {
	it("uses 127.0.0.1 as the callback hostname to avoid IPv6 and proxy delays", () => {
		const ctrl: OAuthController = {
			onAuth: () => {},
		};
		const flow = new GoogleOAuthFlow(ctrl, {
			clientId: "test-client",
			clientSecret: "test-secret",
			authUrl: "https://example.com/auth",
			tokenUrl: "https://example.com/token",
			scopes: ["scope1"],
			callbackPort: 51121,
			callbackPath: "/callback",
			discoverProject: async () => "test-project",
		});

		expect(flow.callbackHostname).toBe("127.0.0.1");
	});
});

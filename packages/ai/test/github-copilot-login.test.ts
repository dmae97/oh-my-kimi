import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginGitHubCopilot } from "../src/utils/oauth/github-copilot";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function mockOnPrompt(value: string) {
	return vi.fn(async () => value);
}

function deviceCodeResponse(overrides: Record<string, unknown> = {}) {
	return {
		device_code: "dc_test",
		user_code: "ABCD-1234",
		verification_uri: "https://github.com/login/device",
		interval: 0,
		expires_in: 300,
		...overrides,
	};
}

function accessTokenResponse(token = "ghu_test") {
	return { access_token: token, token_type: "bearer", scope: "read:user" };
}

function modelPolicyOk() {
	return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("loginGitHubCopilot", () => {
	it("happy path (github.com)", async () => {
		let pollCount = 0;
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://github.com/login/device/code") {
				expect(init?.method).toBe("POST");
				return new Response(JSON.stringify(deviceCodeResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "https://github.com/login/oauth/access_token") {
				pollCount++;
				return new Response(JSON.stringify(accessTokenResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/models/") && url.includes("/policy")) {
				return modelPolicyOk();
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const onAuth = vi.fn();
		const credentials = await loginGitHubCopilot({
			onAuth,
			onPrompt: mockOnPrompt(""),
		});

		expect(onAuth).toHaveBeenCalled();
		expect(credentials.access).toBe("ghu_test");
		expect(credentials.refresh).toBe("ghu_test");
		expect(credentials.expires).toBeGreaterThan(Date.now());
		expect(credentials.enterpriseUrl).toBeUndefined();
		expect(pollCount).toBeGreaterThanOrEqual(1);
	});

	it("enterprise domain", async () => {
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://ghe.example.com/login/device/code") {
				return new Response(JSON.stringify(deviceCodeResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "https://ghe.example.com/login/oauth/access_token") {
				return new Response(JSON.stringify(accessTokenResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("copilot-api.ghe.example.com") && url.includes("/policy")) {
				return modelPolicyOk();
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const credentials = await loginGitHubCopilot({
			onAuth: vi.fn(),
			onPrompt: mockOnPrompt("ghe.example.com"),
		});

		expect(credentials.access).toBe("ghu_test");
		expect(credentials.enterpriseUrl).toBe("ghe.example.com");
	});

	it("blank domain uses github.com", async () => {
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://github.com/login/device/code") {
				return new Response(JSON.stringify(deviceCodeResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "https://github.com/login/oauth/access_token") {
				return new Response(JSON.stringify(accessTokenResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/models/") && url.includes("/policy")) {
				return modelPolicyOk();
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const credentials = await loginGitHubCopilot({
			onAuth: vi.fn(),
			onPrompt: mockOnPrompt("   "),
		});

		expect(credentials.access).toBe("ghu_test");
		expect(credentials.enterpriseUrl).toBeUndefined();
	});

	it("invalid domain rejects", async () => {
		await expect(
			loginGitHubCopilot({
				onAuth: vi.fn(),
				onPrompt: mockOnPrompt("not a valid domain!!!://"),
			}),
		).rejects.toThrow("Invalid GitHub Enterprise URL/domain");
	});

	it("abort cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			loginGitHubCopilot({
				onAuth: vi.fn(),
				onPrompt: mockOnPrompt(""),
				signal: controller.signal,
			}),
		).rejects.toThrow("Login cancelled");
	});

	it("poll handles slow_down then succeeds", async () => {
		let pollCount = 0;
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://github.com/login/device/code") {
				return new Response(JSON.stringify(deviceCodeResponse({ interval: 0 })), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "https://github.com/login/oauth/access_token") {
				pollCount++;
				if (pollCount === 1) {
					return new Response(JSON.stringify({ error: "authorization_pending" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (pollCount === 2) {
					return new Response(JSON.stringify({ error: "slow_down", interval: 1 }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response(JSON.stringify(accessTokenResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/models/") && url.includes("/policy")) {
				return modelPolicyOk();
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const credentials = await loginGitHubCopilot({
			onAuth: vi.fn(),
			onPrompt: mockOnPrompt(""),
		});

		expect(credentials.access).toBe("ghu_test");
		expect(pollCount).toBeGreaterThanOrEqual(3);
	}, 15000);

	it("poll timeout", async () => {
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://github.com/login/device/code") {
				return new Response(JSON.stringify(deviceCodeResponse({ expires_in: 0 })), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "https://github.com/login/oauth/access_token") {
				return new Response(JSON.stringify({ error: "authorization_pending" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(
			loginGitHubCopilot({
				onAuth: vi.fn(),
				onPrompt: mockOnPrompt(""),
			}),
		).rejects.toThrow("Device flow timed out");
	});

	it("device flow error", async () => {
		let _pollCount = 0;
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://github.com/login/device/code") {
				return new Response(JSON.stringify(deviceCodeResponse({ interval: 0 })), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "https://github.com/login/oauth/access_token") {
				_pollCount++;
				return new Response(JSON.stringify({ error: "access_denied", error_description: "User denied" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(
			loginGitHubCopilot({
				onAuth: vi.fn(),
				onPrompt: mockOnPrompt(""),
			}),
		).rejects.toThrow("Device flow failed: access_denied: User denied");
	});

	it("model enablement failure is silent", async () => {
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://github.com/login/device/code") {
				return new Response(JSON.stringify(deviceCodeResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "https://github.com/login/oauth/access_token") {
				return new Response(JSON.stringify(accessTokenResponse()), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/models/") && url.includes("/policy")) {
				return new Response("Internal Server Error", { status: 500 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const credentials = await loginGitHubCopilot({
			onAuth: vi.fn(),
			onPrompt: mockOnPrompt(""),
		});

		// Login succeeds even though all model enablements failed
		expect(credentials.access).toBe("ghu_test");
		expect(credentials.refresh).toBe("ghu_test");
	});
});

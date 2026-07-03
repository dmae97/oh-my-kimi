import { afterEach, describe, expect, it, vi } from "bun:test";
import { OAuthCallbackFlow } from "@oh-my-pi/pi-ai/registry/oauth/callback-server";
import type { OAuthAuthInfo, OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";

/**
 * Regression harness for #4418 — the `/launch` route the callback server hosts
 * so UIs can advertise a short (~30-char) copy target that survives TUI viewport
 * truncation. Without it, the full authorize URL (~260+ chars on Linear/GitHub/…)
 * gets silently truncated mid-parameter and downgrades the flow to plain PKCE.
 */
class LaunchProbeFlow extends OAuthCallbackFlow {
	authUrls: string[] = [];
	// Long enough that a 270-col TUI would clip `code_challenge_method=S256`.
	static readonly PADDING = "x".repeat(200);

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		const url =
			"https://mcp.example.com/authorize?" +
			new URLSearchParams({
				response_type: "code",
				client_id: "test-client",
				redirect_uri: redirectUri,
				state,
				scope: LaunchProbeFlow.PADDING,
				code_challenge: "test-challenge",
				code_challenge_method: "S256",
			}).toString();
		this.authUrls.push(url);
		return { url };
	}

	async exchangeToken(): Promise<OAuthCredentials> {
		return { access: "unused", refresh: "unused", expires: Date.now() + 60_000 };
	}
}

/**
 * Start a flow and resolve once `onAuth` fires — that's the exact instant
 * `/launch` becomes live, so tests can hit it without a wall-clock sleep.
 * Returns the captured auth info, the abort controller (so tests can shut the
 * flow down), and the pending `login` promise (so tests can await teardown).
 */
async function startFlowAndWaitForAuth(): Promise<{
	info: OAuthAuthInfo;
	abort: AbortController;
	login: Promise<void>;
}> {
	const abort = new AbortController();
	const authFired = Promise.withResolvers<OAuthAuthInfo>();
	const flow = new LaunchProbeFlow(
		{
			onAuth: info => {
				authFired.resolve(info);
			},
			signal: abort.signal,
		},
		{ preferredPort: 0, allowPortFallback: true },
	);
	// Kick off login in the background; tests own its lifetime via `abort`.
	const login = flow.login().catch(() => undefined) as Promise<void>;
	const info = await authFired.promise;
	return { info, abort, login };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OAuthCallbackFlow /launch route", () => {
	it("advertises a short launch URL and 302s it to the pending authorization URL", async () => {
		const { info, abort, login } = await startFlowAndWaitForAuth();

		// Contract 1 — launch URL is short and shaped like a loopback URL. A
		// terminal that truncates below ~40 columns is degenerate; anything above
		// that keeps the launch URL intact regardless of the full URL length.
		expect(info.launchUrl).toBeDefined();
		expect(info.launchUrl!.length).toBeLessThan(40);
		expect(info.launchUrl).toMatch(/^http:\/\/localhost:\d+\/launch$/);

		// Contract 2 — GET /launch returns 302 pointing at the pending authorize URL,
		// byte-for-byte (the whole point: no truncation surface between UI and provider).
		const response = await fetch(info.launchUrl!, { redirect: "manual" });
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(info.url);

		abort.abort("test done");
		await login;
	});

	it("stops answering /launch once the flow completes so no stale URL is redirected", async () => {
		const { info, abort, login } = await startFlowAndWaitForAuth();
		expect(info.launchUrl).toBeDefined();

		abort.abort("test done");
		await login;

		// Server has stopped and `#pendingAuthUrl` was cleared — the launch URL
		// no longer connects. The correct end-state is that the redirect NEVER
		// points at a stale URL; the loopback socket is gone so `fetch` rejects.
		await expect(fetch(info.launchUrl!)).rejects.toThrow();
	});

	it("routes `/callback` and `/launch` on the same server without interfering", async () => {
		const { info, abort, login } = await startFlowAndWaitForAuth();
		expect(info.launchUrl).toBeDefined();

		// A GET at an unrelated path still 404s — `/launch` is additive, not a
		// blanket catch-all.
		const origin = new URL(info.launchUrl!).origin;
		const stray = await fetch(`${origin}/nope`);
		expect(stray.status).toBe(404);

		abort.abort("test done");
		await login;
	});
});

/**
 * Contract tests for per-profile MCP OAuth bindings (url-keyed credentials).
 *
 * A server *definition* may live in a shared project `mcp.json` while each
 * profile holds its own credential row in agent.db under the deterministic
 * `mcp_oauth:<url>` id. Before this scheme, the random `auth.credentialId`
 * written into the shared file pointed at exactly one profile's row, so two
 * profiles reauthorizing the same project server clobbered each other.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import * as oauthFlow from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

const SERVER_URL = "https://mcp.example.com/mcp";
const URL_KEY_ID = mcpOAuthCredentialId(SERVER_URL);

function authorizationHeader(config: MCPServerConfig): string | undefined {
	if (config.type !== "http" && config.type !== "sse") return undefined;
	return config.headers?.Authorization;
}

describe("per-profile MCP OAuth binding", () => {
	let manager: MCPManager;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		authStorage = new AuthStorage(store);
		await authStorage.reload();
		manager = new MCPManager(process.cwd());
		manager.setAuthStorage(authStorage);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("resolves the url-keyed credential when the file's credentialId belongs to another profile", async () => {
		// This profile authed the server (url-keyed row exists), but the shared
		// project file still carries a credentialId minted by a different profile.
		await authStorage.set(URL_KEY_ID, {
			type: "oauth",
			access: "this-profile-token",
			refresh: "r",
			expires: Date.now() + 3_600_000,
		});

		const prepared = await manager.prepareConfig({
			type: "http",
			url: SERVER_URL,
			auth: { type: "oauth", credentialId: "mcp_oauth_1234_other_profile" },
		});

		expect(authorizationHeader(prepared)).toBe("Bearer this-profile-token");
	});

	test("resolves the url-keyed credential for a definition-only config (no auth block)", async () => {
		await authStorage.set(URL_KEY_ID, {
			type: "oauth",
			access: "bound-token",
			refresh: "r",
			expires: Date.now() + 3_600_000,
		});

		const prepared = await manager.prepareConfig({ type: "http", url: SERVER_URL });

		expect(authorizationHeader(prepared)).toBe("Bearer bound-token");
	});

	test("prepareConfig({ oauth: false }) skips injection so the reauth probe sees the bare server", async () => {
		await authStorage.set(URL_KEY_ID, {
			type: "oauth",
			access: "bound-token",
			refresh: "r",
			expires: Date.now() + 3_600_000,
		});

		const prepared = await manager.prepareConfig({ type: "http", url: SERVER_URL }, { oauth: false });

		expect(authorizationHeader(prepared)).toBeUndefined();
	});

	test("never clobbers an explicitly configured Authorization header", async () => {
		await authStorage.set(URL_KEY_ID, {
			type: "oauth",
			access: "bound-token",
			refresh: "r",
			expires: Date.now() + 3_600_000,
		});

		const prepared = await manager.prepareConfig({
			type: "http",
			url: SERVER_URL,
			headers: { authorization: "Bearer user-pinned" },
		});

		expect(prepared.type === "http" ? prepared.headers?.authorization : undefined).toBe("Bearer user-pinned");
		expect(authorizationHeader(prepared)).toBeUndefined();
	});

	test("refreshes with embedded material and preserves it across rotation", async () => {
		await authStorage.set(URL_KEY_ID, {
			type: "oauth",
			access: "expired-token",
			refresh: "old-refresh",
			expires: Date.now() - 60_000,
			tokenUrl: "https://mcp.example.com/token",
			clientId: "embedded-client",
			clientSecret: "embedded-secret",
		} as oauthFlow.MCPStoredOAuthCredential);

		const refreshSpy = vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockResolvedValue({
			access: "fresh-token",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});

		// Definition-only config: refresh material must come from the credential.
		const prepared = await manager.prepareConfig({ type: "http", url: SERVER_URL });

		expect(refreshSpy).toHaveBeenCalledWith(
			"https://mcp.example.com/token",
			"old-refresh",
			"embedded-client",
			"embedded-secret",
			SERVER_URL,
		);
		expect(authorizationHeader(prepared)).toBe("Bearer fresh-token");
		// Embedded refresh material must survive rotation, or the *next* refresh
		// of this definition-only binding would be impossible.
		expect(authStorage.get(URL_KEY_ID)).toMatchObject({
			type: "oauth",
			access: "fresh-token",
			refresh: "fresh-refresh",
			tokenUrl: "https://mcp.example.com/token",
			clientId: "embedded-client",
			resource: SERVER_URL,
		});
	});

	test("does not inject oauth for configs with explicit apikey auth", async () => {
		await authStorage.set(URL_KEY_ID, {
			type: "oauth",
			access: "bound-token",
			refresh: "r",
			expires: Date.now() + 3_600_000,
		});

		const prepared = await manager.prepareConfig({
			type: "http",
			url: SERVER_URL,
			auth: { type: "apikey" },
		});

		expect(authorizationHeader(prepared)).toBeUndefined();
	});

	test("an explicit credentialId that resolves wins over the url-keyed row", async () => {
		await authStorage.set("mcp_oauth_1234_pinned", {
			type: "oauth",
			access: "pinned-token",
			refresh: "r",
			expires: Date.now() + 3_600_000,
		});
		await authStorage.set(URL_KEY_ID, {
			type: "oauth",
			access: "url-token",
			refresh: "r",
			expires: Date.now() + 3_600_000,
		});

		const prepared = await manager.prepareConfig({
			type: "http",
			url: SERVER_URL,
			auth: { type: "oauth", credentialId: "mcp_oauth_1234_pinned" },
		});

		expect(authorizationHeader(prepared)).toBe("Bearer pinned-token");
	});

	test("url-keyed fallback never overrides a pinned Authorization header, even past a stale auth block", async () => {
		await authStorage.set(URL_KEY_ID, {
			type: "oauth",
			access: "bound-token",
			refresh: "r",
			expires: Date.now() + 3_600_000,
		});

		const prepared = await manager.prepareConfig({
			type: "http",
			url: SERVER_URL,
			headers: { Authorization: "Bearer user-pinned" },
			auth: { type: "oauth", credentialId: "mcp_oauth_1234_other_profile" },
		});

		expect(authorizationHeader(prepared)).toBe("Bearer user-pinned");
	});

	test("refresh uses the credential's embedded client, not another profile's auth block", async () => {
		// Shared file carries profile A's refresh material; this profile's
		// url-keyed row embeds its own DCR client. Refresh tokens are bound to
		// the client that minted them, so the embedded material must win or the
		// refresh dies with invalid_grant and the row gets purged.
		await authStorage.set(URL_KEY_ID, {
			type: "oauth",
			access: "expired-token",
			refresh: "my-refresh",
			expires: Date.now() - 60_000,
			tokenUrl: "https://mcp.example.com/token",
			clientId: "my-dcr-client",
		} as oauthFlow.MCPStoredOAuthCredential);

		const refreshSpy = vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockResolvedValue({
			access: "fresh-token",
			refresh: "my-refresh",
			expires: Date.now() + 3_600_000,
		});

		const prepared = await manager.prepareConfig({
			type: "http",
			url: SERVER_URL,
			auth: {
				type: "oauth",
				credentialId: "mcp_oauth_1234_other_profile",
				tokenUrl: "https://mcp.example.com/token",
				clientId: "other-profiles-client",
				clientSecret: "other-profiles-secret",
			},
		});

		expect(refreshSpy).toHaveBeenCalledWith(
			"https://mcp.example.com/token",
			"my-refresh",
			"my-dcr-client",
			undefined,
			SERVER_URL,
		);
		expect(authorizationHeader(prepared)).toBe("Bearer fresh-token");
	});
});

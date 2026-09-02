import { describe, expect, it } from "vitest";
import { isRejectedOAuthTokenMessage, summarizeWithOAuthRecovery } from "../src/core/compaction/oauth-recovery.ts";

/**
 * Compaction summarization runs on a model the session may not otherwise use
 * (settings `compaction.model`), so its OAuth token can be dead while every
 * turn on the session model succeeds. A provider that rejects the token as
 * expired days before the stored expiry must trigger exactly one forced refresh
 * and one retry; everything else keeps its original failure.
 */

const CODEX_401 =
	'Summarization failed: 401 {"error":{"message":"Provided authentication token is expired.","code":"token_expired"}}';

describe("isRejectedOAuthTokenMessage", () => {
	it("recognizes provider wording for a rejected bearer token", () => {
		expect(isRejectedOAuthTokenMessage(CODEX_401)).toBe(true);
		expect(isRejectedOAuthTokenMessage("Summarization failed: Provided authentication token is expired.")).toBe(true);
		expect(isRejectedOAuthTokenMessage("401 Unauthorized")).toBe(true);
		expect(isRejectedOAuthTokenMessage("token_revoked")).toBe(true);
	});

	it("leaves quota, overload, and transcript errors alone", () => {
		expect(isRejectedOAuthTokenMessage("403 usage limit for this billing cycle")).toBe(false);
		expect(isRejectedOAuthTokenMessage("Our servers are currently overloaded (server_is_overloaded)")).toBe(false);
		expect(isRejectedOAuthTokenMessage("prompt is too long: 1401 tokens")).toBe(false);
		expect(isRejectedOAuthTokenMessage(undefined)).toBe(false);
	});
});

describe("summarizeWithOAuthRecovery", () => {
	it("returns the first result without touching auth", async () => {
		const refreshes: string[] = [];
		const result = await summarizeWithOAuthRecovery({
			apiKey: "live",
			run: async () => "summary",
			refreshRejectedToken: async (rejected) => {
				refreshes.push(rejected);
				return "unused";
			},
		});
		expect(result).toBe("summary");
		expect(refreshes).toEqual([]);
	});

	it("refreshes the rejected token once and retries with the new one", async () => {
		const attempts: Array<string | undefined> = [];
		const result = await summarizeWithOAuthRecovery({
			apiKey: "dead",
			run: async (apiKey) => {
				attempts.push(apiKey);
				if (apiKey === "dead") throw new Error(CODEX_401);
				return "summary";
			},
			refreshRejectedToken: async (rejected) => (rejected === "dead" ? "rotated" : undefined),
		});
		expect(result).toBe("summary");
		expect(attempts).toEqual(["dead", "rotated"]);
	});

	it("rethrows the original error when the provider has no OAuth credential to refresh", async () => {
		let runs = 0;
		await expect(
			summarizeWithOAuthRecovery({
				apiKey: "sk-api-key",
				run: async () => {
					runs += 1;
					throw new Error(CODEX_401);
				},
				refreshRejectedToken: async () => undefined,
			}),
		).rejects.toThrow(CODEX_401);
		expect(runs).toBe(1);
	});

	it("names the provider login step when the forced refresh itself fails", async () => {
		await expect(
			summarizeWithOAuthRecovery({
				apiKey: "dead",
				provider: "openai-codex",
				run: async () => {
					throw new Error(CODEX_401);
				},
				refreshRejectedToken: async () => {
					throw new Error("refresh_token_reused");
				},
			}),
		).rejects.toThrow(/token is expired.*refresh.*openai-codex.*refresh_token_reused.*\/login openai-codex/s);
	});

	it("does not refresh for errors that are not a rejected token", async () => {
		let refreshes = 0;
		await expect(
			summarizeWithOAuthRecovery({
				apiKey: "live",
				run: async () => {
					throw new Error("Summarization failed: server_is_overloaded");
				},
				refreshRejectedToken: async () => {
					refreshes += 1;
					return "rotated";
				},
			}),
		).rejects.toThrow("server_is_overloaded");
		expect(refreshes).toBe(0);
	});

	it("retries at most once so a still-rejected token cannot loop", async () => {
		let runs = 0;
		let refreshes = 0;
		await expect(
			summarizeWithOAuthRecovery({
				apiKey: "dead",
				run: async () => {
					runs += 1;
					throw new Error(CODEX_401);
				},
				refreshRejectedToken: async () => {
					refreshes += 1;
					return "rotated";
				},
			}),
		).rejects.toThrow("token is expired");
		expect(runs).toBe(2);
		expect(refreshes).toBe(1);
	});

	it("skips recovery when no api key was sent at all", async () => {
		let refreshes = 0;
		await expect(
			summarizeWithOAuthRecovery({
				apiKey: undefined,
				run: async () => {
					throw new Error(CODEX_401);
				},
				refreshRejectedToken: async () => {
					refreshes += 1;
					return "rotated";
				},
			}),
		).rejects.toThrow("token is expired");
		expect(refreshes).toBe(0);
	});
});

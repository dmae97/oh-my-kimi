import { describe, expect, it } from "bun:test";
import type { ApiKeyResolveContext, OAuthAccess, OAuthAccessSource } from "@oh-my-pi/pi-ai";
import { isApiKeyResolver, isAuthRetryableError, resolveApiKeyOnce, withAuth, withOAuthAccess } from "@oh-my-pi/pi-ai";

function authError(status = 401): Error & { status: number } {
	return Object.assign(new Error(`${status} authentication_error`), { status });
}

function usageLimitError(): Error & { status: number } {
	return Object.assign(new Error("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min."), {
		status: 429,
	});
}

describe("isApiKeyResolver / resolveApiKeyOnce", () => {
	it("narrows resolver vs static key and resolves the initial value", async () => {
		expect(isApiKeyResolver("static")).toBe(false);
		expect(isApiKeyResolver(undefined)).toBe(false);
		expect(isApiKeyResolver(() => "k")).toBe(true);

		expect(await resolveApiKeyOnce("static")).toBe("static");
		expect(await resolveApiKeyOnce(undefined)).toBeUndefined();

		let seen: ApiKeyResolveContext | undefined;
		const resolved = await resolveApiKeyOnce(ctx => {
			seen = ctx;
			return "minted";
		});
		expect(resolved).toBe("minted");
		// Initial resolve must look like an initial resolve, not a retry.
		expect(seen).toEqual({ lastChance: false, error: undefined, signal: undefined });
	});
});

describe("isAuthRetryableError", () => {
	it("treats 401 and usage-limit phrasing as retryable, everything else as not", () => {
		expect(isAuthRetryableError(authError(401))).toBe(true);
		expect(isAuthRetryableError(usageLimitError())).toBe(true);
		// A 429 whose body names the *account's* rate limit is rotatable (switch
		// account), even though it isn't a 401 and isn't phrased "usage limit".
		expect(
			isAuthRetryableError(
				Object.assign(
					new Error(
						'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after-ms=9779000',
					),
					{ status: 429 },
				),
			),
		).toBe(true);
		// A generic (non-account) 429 rate limit is NOT rotatable — switching
		// credentials won't help an org/global limit.
		expect(isAuthRetryableError(Object.assign(new Error("429 too many requests"), { status: 429 }))).toBe(false);
		expect(isAuthRetryableError("Error: 401 unauthorized")).toBe(true);
		// xAI SuperGrok surfaces account exhaustion as 403 + "run out of credits" /
		// spending-limit, not 429. Must rotate so multi-account xai-oauth pools work.
		expect(
			isAuthRetryableError(
				Object.assign(
					new Error(
						"403 You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok. (type=personal-team-blocked:spending-limit)",
					),
					{ status: 403 },
				),
			),
		).toBe(true);
		expect(isAuthRetryableError(authError(403))).toBe(false);
		expect(isAuthRetryableError(authError(500))).toBe(false);
		expect(isAuthRetryableError(new Error("network blip"))).toBe(false);
		expect(isAuthRetryableError(undefined)).toBe(false);
	});
});

describe("withAuth", () => {
	it("runs a single attempt for a static string key (no retry)", async () => {
		const keys: Array<string | undefined> = [];
		const result = await withAuth("static-key", async key => {
			keys.push(key);
			return `ok:${key}`;
		});
		expect(result).toBe("ok:static-key");
		expect(keys).toEqual(["static-key"]);
	});

	it("throws when a static key is missing", async () => {
		await expect(withAuth(undefined, async () => "never", { missingKeyMessage: "no key for foo" })).rejects.toThrow(
			"no key for foo",
		);
	});

	it("refreshes the same account, then switches, in order", async () => {
		const keys: string[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const result = await withAuth(
			ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? "k0" : ctx.lastChance ? "k2" : "k1";
			},
			async key => {
				keys.push(key);
				if (key === "k2") return "success";
				throw authError();
			},
		);
		expect(result).toBe("success");
		expect(keys).toEqual(["k0", "k1", "k2"]);
		expect(contexts.map(ctx => ({ lastChance: ctx.lastChance, hasError: ctx.error !== undefined }))).toEqual([
			{ lastChance: false, hasError: false },
			{ lastChance: false, hasError: true },
			{ lastChance: true, hasError: true },
		]);
	});

	it("switches accounts before refreshing the same account on usage limits", async () => {
		const keys: string[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const result = await withAuth(
			ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? "k0" : ctx.lastChance ? "k2" : "k1";
			},
			async key => {
				keys.push(key);
				if (key === "k2") return "success";
				throw usageLimitError();
			},
		);
		expect(result).toBe("success");
		expect(keys).toEqual(["k0", "k2"]);
		expect(contexts.map(ctx => ({ lastChance: ctx.lastChance, hasError: ctx.error !== undefined }))).toEqual([
			{ lastChance: false, hasError: false },
			{ lastChance: true, hasError: true },
		]);
	});

	it("stops retrying when the resolver returns undefined", async () => {
		const keys: string[] = [];
		const original = authError();
		await expect(
			withAuth(
				ctx => (ctx.error === undefined ? "k0" : undefined),
				async key => {
					keys.push(key);
					throw original;
				},
			),
		).rejects.toBe(original);
		expect(keys).toEqual(["k0"]);
	});

	it("does not re-attempt when the re-resolved key is unchanged", async () => {
		const keys: string[] = [];
		const original = authError();
		// refresh-same returns the same key (skip), switch returns the same key (skip).
		await expect(
			withAuth(
				() => "same",
				async key => {
					keys.push(key);
					throw original;
				},
			),
		).rejects.toBe(original);
		expect(keys).toEqual(["same"]);
	});

	it("propagates non-auth errors without retrying", async () => {
		const keys: string[] = [];
		const boom = new Error("network blip");
		await expect(
			withAuth(
				ctx => (ctx.error === undefined ? "k0" : "k1"),
				async key => {
					keys.push(key);
					throw boom;
				},
			),
		).rejects.toBe(boom);
		expect(keys).toEqual(["k0"]);
	});

	it("honors a custom isAuthError classifier", async () => {
		const keys: string[] = [];
		const result = await withAuth(
			ctx => (ctx.error === undefined ? "k0" : "k1"),
			async key => {
				keys.push(key);
				if (key === "k0") throw new Error("CUSTOM_RETRY");
				return "ok";
			},
			{ isAuthError: error => error instanceof Error && error.message === "CUSTOM_RETRY" },
		);
		expect(result).toBe("ok");
		expect(keys).toEqual(["k0", "k1"]);
	});
});

describe("withOAuthAccess", () => {
	type FakeStorage = OAuthAccessSource & {
		calls: Array<{ forceRefresh: boolean | undefined } | "rotate">;
	};

	function fakeStorage(tokens: { initial?: OAuthAccess; forced?: OAuthAccess; rotated?: OAuthAccess }): FakeStorage {
		const storage: FakeStorage = {
			calls: [],
			async getOAuthAccess(_provider, _sessionId, options) {
				storage.calls.push({ forceRefresh: options?.forceRefresh });
				if (options?.forceRefresh) return tokens.forced;
				// After a rotate, the next plain resolve yields the sibling.
				if (storage.calls.includes("rotate")) return tokens.rotated;
				return tokens.initial;
			},
			async rotateSessionCredential() {
				storage.calls.push("rotate");
				return tokens.rotated !== undefined;
			},
		};
		return storage;
	}

	const access = (token: string, extra?: Partial<OAuthAccess>): OAuthAccess => ({
		accessToken: token,
		...extra,
	});

	it("returns the first attempt without extra resolves", async () => {
		const storage = fakeStorage({ initial: access("t1") });
		const result = await withOAuthAccess(storage, "prov", async a => `ok:${a.accessToken}`);
		expect(result).toBe("ok:t1");
		expect(storage.calls).toEqual([{ forceRefresh: undefined }]);
	});

	it("uses the seed for the initial attempt and skips the initial resolve", async () => {
		const storage = fakeStorage({ initial: access("t1") });
		const result = await withOAuthAccess(storage, "prov", async a => a.accessToken, {
			seed: access("seeded"),
		});
		expect(result).toBe("seeded");
		expect(storage.calls).toEqual([]);
	});

	it("force-refreshes the same account on 401, carrying identity metadata", async () => {
		const storage = fakeStorage({
			initial: access("stale"),
			forced: access("fresh", { accountId: "acc-2", projectId: "proj-2" }),
		});
		const attempts: OAuthAccess[] = [];
		const result = await withOAuthAccess(storage, "prov", async a => {
			attempts.push(a);
			if (a.accessToken === "stale") throw authError();
			return a.projectId;
		});
		expect(result).toBe("proj-2");
		expect(attempts.map(a => a.accessToken)).toEqual(["stale", "fresh"]);
		expect(storage.calls).toEqual([{ forceRefresh: undefined }, { forceRefresh: true }]);
	});

	it("skips an unchanged force-refresh token and rotates to a sibling", async () => {
		const storage = fakeStorage({
			initial: access("dead"),
			forced: access("dead"),
			rotated: access("sibling"),
		});
		const attempts: string[] = [];
		const result = await withOAuthAccess(storage, "prov", async a => {
			attempts.push(a.accessToken);
			if (a.accessToken === "dead") throw usageLimitError();
			return "ok";
		});
		expect(result).toBe("ok");
		// "dead" must not be re-attempted after the no-op force refresh.
		expect(attempts).toEqual(["dead", "sibling"]);
		expect(storage.calls).toEqual([
			{ forceRefresh: undefined },
			{ forceRefresh: true },
			"rotate",
			{ forceRefresh: undefined },
		]);
	});

	it("propagates non-auth errors immediately and surfaces the last auth error when exhausted", async () => {
		const boom = new Error("syntax error");
		await expect(
			withOAuthAccess(fakeStorage({ initial: access("t1") }), "prov", async () => {
				throw boom;
			}),
		).rejects.toBe(boom);

		const dead = authError();
		await expect(
			withOAuthAccess(fakeStorage({ initial: access("t1") }), "prov", async () => {
				throw dead;
			}),
		).rejects.toBe(dead);
	});

	it("throws the missing-access message when no credential resolves", async () => {
		await expect(
			withOAuthAccess(fakeStorage({}), "prov", async () => "never", {
				missingAccessMessage: "no codex account",
			}),
		).rejects.toThrow("no codex account");
	});
});

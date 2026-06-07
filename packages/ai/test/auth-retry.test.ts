import { describe, expect, it } from "bun:test";
import type { ApiKeyResolveContext } from "@oh-my-pi/pi-ai";
import { isApiKeyResolver, isAuthRetryableError, resolveApiKeyOnce, withAuth } from "@oh-my-pi/pi-ai";

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

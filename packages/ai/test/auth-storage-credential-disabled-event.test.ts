import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthCredentialStore, AuthStorage, type CredentialDisabledEvent } from "../src/auth-storage";
import * as oauthUtils from "../src/utils/oauth";
// Env vars short-circuit AuthStorage.getApiKey before the OAuth refresh path runs; suppress
// them for every test in this file so the credential-disable code path can be exercised.
const SUPPRESS_ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof SUPPRESS_ANTHROPIC_ENV)[number], string | undefined>> = {};

const expiredOAuth = () =>
	({
		type: "oauth" as const,
		access: "expired-access",
		refresh: "stale-refresh",
		expires: Date.now() - 60_000,
	}) as const;

const failOAuthRefresh = (message = 'HTTP 400 invalid_grant {"error":"invalid_grant"}'): void => {
	vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
		throw new Error(message);
	});
};

describe("AuthStorage credential_disabled subscriptions", () => {
	let tempDir = "";
	const stores: AuthCredentialStore[] = [];

	const openStorage = async (options?: ConstructorParameters<typeof AuthStorage>[1]): Promise<AuthStorage> => {
		const store = await AuthCredentialStore.open(path.join(tempDir, `agent-${stores.length}.db`));
		stores.push(store);
		return new AuthStorage(store, options);
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-credential-disabled-subs-"));
		for (const key of SUPPRESS_ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const store of stores.splice(0)) {
			store.close();
		}
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
		for (const key of SUPPRESS_ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
			delete savedEnv[key];
		}
	});

	describe("constructor `onCredentialDisabled` option", () => {
		test("fires when an OAuth credential is disabled by a definitive refresh failure", async () => {
			const events: CredentialDisabledEvent[] = [];
			const authStorage = await openStorage({
				onCredentialDisabled: event => {
					events.push(event);
				},
			});
			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh();

			const apiKey = await authStorage.getApiKey("anthropic", "session-disabled-event");

			expect(apiKey).toBeUndefined();
			expect(events).toHaveLength(1);
			expect(events[0]?.provider).toBe("anthropic");
			expect(events[0]?.disabledCause).toContain("invalid_grant");
		});

		test("does not fire for transient (non-definitive) refresh failures", async () => {
			const events: CredentialDisabledEvent[] = [];
			const authStorage = await openStorage({
				onCredentialDisabled: event => {
					events.push(event);
				},
			});
			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh("fetch failed: ECONNRESET");

			await authStorage.getApiKey("anthropic", "session-transient-failure");
			expect(events).toHaveLength(0);
		});

		test("swallows synchronous handler exceptions so the disable still completes", async () => {
			const authStorage = await openStorage({
				onCredentialDisabled: () => {
					throw new Error("subscriber exploded");
				},
			});
			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh("invalid_grant");

			await expect(authStorage.getApiKey("anthropic", "session-handler-throws")).resolves.toBeUndefined();
			expect(authStorage.list()).not.toContain("anthropic");
		});

		test("swallows async handler rejections so the disable path still completes", async () => {
			const settled = Promise.withResolvers<void>();
			const authStorage = await openStorage({
				onCredentialDisabled: async () => {
					// Yield so the rejection lands on the microtask queue, not synchronously.
					await Promise.resolve();
					settled.resolve();
					throw new Error("async subscriber exploded");
				},
			});
			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh("invalid_grant");

			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown): void => {
				unhandled.push(reason);
			};
			process.on("unhandledRejection", onUnhandled);
			try {
				await expect(authStorage.getApiKey("anthropic", "session-async-handler-throws")).resolves.toBeUndefined();
				await settled.promise;
				await Bun.sleep(0);
				expect(authStorage.list()).not.toContain("anthropic");
				expect(unhandled).toHaveLength(0);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});
	});

	describe("`onCredentialDisabled(listener)` runtime subscription", () => {
		test("registers an additional subscriber alongside the constructor handler — both fire", async () => {
			const constructorEvents: CredentialDisabledEvent[] = [];
			const runtimeEvents: CredentialDisabledEvent[] = [];
			const authStorage = await openStorage({
				onCredentialDisabled: event => {
					constructorEvents.push(event);
				},
			});
			authStorage.onCredentialDisabled(event => {
				runtimeEvents.push(event);
			});

			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh("invalid_grant");

			await authStorage.getApiKey("anthropic", "session-both-fire");
			expect(constructorEvents).toHaveLength(1);
			expect(runtimeEvents).toHaveLength(1);
			expect(constructorEvents[0]?.provider).toBe("anthropic");
			expect(runtimeEvents[0]?.provider).toBe("anthropic");
		});

		test("fans out every event to every subscriber", async () => {
			const aEvents: CredentialDisabledEvent[] = [];
			const bEvents: CredentialDisabledEvent[] = [];
			const authStorage = await openStorage();
			authStorage.onCredentialDisabled(event => {
				aEvents.push(event);
			});
			authStorage.onCredentialDisabled(event => {
				bEvents.push(event);
			});
			await authStorage.set("anthropic", [expiredOAuth()]);
			await authStorage.set("openai", [expiredOAuth()]);
			failOAuthRefresh("invalid_grant");

			await authStorage.getApiKey("anthropic", "session-fanout-anthropic");
			await authStorage.getApiKey("openai", "session-fanout-openai");

			expect(aEvents.map(event => event.provider)).toEqual(["anthropic", "openai"]);
			expect(bEvents.map(event => event.provider)).toEqual(["anthropic", "openai"]);
		});

		test("unsubscribe removes only that listener; others continue to fire", async () => {
			const authStorage = await openStorage();
			const aEvents: CredentialDisabledEvent[] = [];
			const bEvents: CredentialDisabledEvent[] = [];
			const unsubscribeA = authStorage.onCredentialDisabled(event => {
				aEvents.push(event);
			});
			authStorage.onCredentialDisabled(event => {
				bEvents.push(event);
			});

			await authStorage.set("anthropic", [expiredOAuth()]);
			await authStorage.set("openai", [expiredOAuth()]);
			failOAuthRefresh("invalid_grant");

			await authStorage.getApiKey("anthropic", "session-pre-unsubscribe");
			expect(aEvents).toHaveLength(1);
			expect(bEvents).toHaveLength(1);

			unsubscribeA();

			await authStorage.getApiKey("openai", "session-post-unsubscribe");
			expect(aEvents).toHaveLength(1);
			expect(bEvents).toHaveLength(2);
		});

		test("unsubscribe is idempotent: a second call is a no-op and does not affect other listeners", async () => {
			const authStorage = await openStorage();
			const aEvents: CredentialDisabledEvent[] = [];
			const bEvents: CredentialDisabledEvent[] = [];
			const unsubscribeA = authStorage.onCredentialDisabled(event => {
				aEvents.push(event);
			});
			authStorage.onCredentialDisabled(event => {
				bEvents.push(event);
			});

			unsubscribeA();
			unsubscribeA();

			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh("invalid_grant");
			await authStorage.getApiKey("anthropic", "session-idempotent-unsub");

			expect(aEvents).toHaveLength(0);
			expect(bEvents).toHaveLength(1);
		});

		test("a throwing subscriber does not block other subscribers from receiving the event", async () => {
			const authStorage = await openStorage();
			const tailEvents: CredentialDisabledEvent[] = [];
			authStorage.onCredentialDisabled(() => {
				throw new Error("first subscriber exploded");
			});
			authStorage.onCredentialDisabled(event => {
				tailEvents.push(event);
			});

			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh("invalid_grant");

			await expect(authStorage.getApiKey("anthropic", "session-throw-isolation")).resolves.toBeUndefined();
			expect(tailEvents).toHaveLength(1);
		});

		test("an async-rejecting subscriber does not trip unhandledRejection and does not block others", async () => {
			const authStorage = await openStorage();
			const tailEvents: CredentialDisabledEvent[] = [];
			const settled = Promise.withResolvers<void>();
			authStorage.onCredentialDisabled(async () => {
				await Promise.resolve();
				settled.resolve();
				throw new Error("async subscriber exploded");
			});
			authStorage.onCredentialDisabled(event => {
				tailEvents.push(event);
			});

			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh("invalid_grant");

			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown): void => {
				unhandled.push(reason);
			};
			process.on("unhandledRejection", onUnhandled);
			try {
				await authStorage.getApiKey("anthropic", "session-async-throw-isolation");
				await settled.promise;
				await Bun.sleep(0);
				expect(tailEvents).toHaveLength(1);
				expect(unhandled).toHaveLength(0);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});
	});

	describe("buffer-and-replay for events fired with no subscribers", () => {
		test("replays buffered events to the first subscriber that triggers the empty→non-empty transition", async () => {
			const authStorage = await openStorage();

			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh("invalid_grant");
			await authStorage.getApiKey("anthropic", "session-pre-subscribe");

			const replayed: CredentialDisabledEvent[] = [];
			authStorage.onCredentialDisabled(event => {
				replayed.push(event);
			});
			// Drain may schedule async invocations.
			await Promise.resolve();

			expect(replayed).toHaveLength(1);
			expect(replayed[0]?.provider).toBe("anthropic");
			expect(replayed[0]?.disabledCause).toContain("invalid_grant");
		});

		test("drains once: a later subscriber attached after the first does not re-receive past events", async () => {
			const authStorage = await openStorage();

			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh("invalid_grant");
			await authStorage.getApiKey("anthropic", "session-pre-first-listener");

			const firstEvents: CredentialDisabledEvent[] = [];
			authStorage.onCredentialDisabled(event => {
				firstEvents.push(event);
			});
			await Promise.resolve();
			expect(firstEvents).toHaveLength(1);

			const secondEvents: CredentialDisabledEvent[] = [];
			authStorage.onCredentialDisabled(event => {
				secondEvents.push(event);
			});
			await Promise.resolve();

			expect(secondEvents).toHaveLength(0);
		});

		test("after every subscriber unsubscribes, subsequent events buffer until the next subscribe", async () => {
			const authStorage = await openStorage();
			const events: CredentialDisabledEvent[] = [];
			const unsubscribe = authStorage.onCredentialDisabled(event => {
				events.push(event);
			});

			await authStorage.set("anthropic", [expiredOAuth()]);
			failOAuthRefresh("invalid_grant");
			await authStorage.getApiKey("anthropic", "session-pre-unsubscribe");
			expect(events).toHaveLength(1);

			unsubscribe();
			// No subscribers; the next disable goes to the buffer.
			await authStorage.set("openai", [expiredOAuth()]);
			await authStorage.getApiKey("openai", "session-during-gap");
			expect(events).toHaveLength(1);

			const replayed: CredentialDisabledEvent[] = [];
			authStorage.onCredentialDisabled(event => {
				replayed.push(event);
			});
			await Promise.resolve();
			expect(replayed).toHaveLength(1);
			expect(replayed[0]?.provider).toBe("openai");
		});
	});
});

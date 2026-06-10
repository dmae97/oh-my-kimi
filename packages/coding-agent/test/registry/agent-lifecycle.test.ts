import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface SessionStub {
	session: AgentSession;
	disposeCalls: () => number;
}

/** Minimal session: the lifecycle manager only ever calls dispose() on it. */
function makeSessionStub(dispose?: () => Promise<void>): SessionStub {
	let calls = 0;
	const stub = {
		dispose: async () => {
			calls++;
			await dispose?.();
		},
	};
	return { session: stub as unknown as AgentSession, disposeCalls: () => calls };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(r => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Settle the async park chain (timer callback → park() → dispose → setStatus). */
async function flushAsync(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

const TTL = 20;

describe("AgentLifecycleManager", () => {
	let registry: AgentRegistry;
	let lifecycle: AgentLifecycleManager;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		registry = AgentRegistry.global();
		lifecycle = AgentLifecycleManager.global();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function registerIdleSub(id: string, session: AgentSession | null, sessionFile: string | null = `/tmp/${id}.jsonl`) {
		return registry.register({ id, displayName: "task", kind: "sub", session, sessionFile, status: "idle" });
	}

	it("adopt arms the TTL: an idle agent is parked — session disposed, ref + sessionFile retained", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registerIdleSub("1-Sub", stub.session, "/tmp/1-Sub.jsonl");
		lifecycle.adopt("1-Sub", { idleTtlMs: TTL });

		vi.advanceTimersByTime(TTL);
		await flushAsync();

		const ref = registry.get("1-Sub");
		expect(stub.disposeCalls()).toBe(1);
		expect(ref?.status).toBe("parked");
		expect(ref?.session).toBeNull();
		expect(ref?.sessionFile).toBe("/tmp/1-Sub.jsonl");
		expect(lifecycle.has("1-Sub")).toBe(true);
	});

	it("running disarms the timer; returning to idle re-arms a fresh TTL", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registerIdleSub("2-Sub", stub.session);
		lifecycle.adopt("2-Sub", { idleTtlMs: TTL });
		registry.setStatus("2-Sub", "running");

		vi.advanceTimersByTime(TTL * 10);
		await flushAsync();
		expect(registry.get("2-Sub")?.status).toBe("running");
		expect(registry.get("2-Sub")?.session).toBe(stub.session);
		expect(stub.disposeCalls()).toBe(0);

		registry.setStatus("2-Sub", "idle");
		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("2-Sub")?.status).toBe("parked");
		expect(stub.disposeCalls()).toBe(1);
	});

	it("ensureLive revives a parked agent through its reviver and flips it back to idle", async () => {
		const revived = makeSessionStub();
		registry.register({
			id: "3-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/3-Sub.jsonl",
			status: "parked",
		});
		lifecycle.adopt("3-Sub", { idleTtlMs: 0, revive: async () => revived.session });

		const session = await lifecycle.ensureLive("3-Sub");

		expect(session).toBe(revived.session);
		const ref = registry.get("3-Sub");
		expect(ref?.status).toBe("idle");
		expect(ref?.session).toBe(revived.session);
		expect(ref?.sessionFile).toBe("/tmp/3-Sub.jsonl");
	});

	it("concurrent ensureLive calls during a slow revive coalesce into one reviver run", async () => {
		const gate = deferred();
		const revived = makeSessionStub();
		let reviverRuns = 0;
		registry.register({
			id: "4-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/4-Sub.jsonl",
			status: "parked",
		});
		lifecycle.adopt("4-Sub", {
			idleTtlMs: 0,
			revive: async () => {
				reviverRuns++;
				await gate.promise;
				return revived.session;
			},
		});

		const first = lifecycle.ensureLive("4-Sub");
		const second = lifecycle.ensureLive("4-Sub");
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);

		expect(reviverRuns).toBe(1);
		expect(a).toBe(revived.session);
		expect(b).toBe(revived.session);
	});

	it("ensureLive on an unknown id throws and points at history://", async () => {
		await expect(lifecycle.ensureLive("9-Ghost")).rejects.toThrow(/history:\/\/9-Ghost/);
	});

	it("ensureLive on a parked agent without a reviver throws as not revivable", async () => {
		registry.register({ id: "5-Sub", displayName: "task", kind: "sub", session: null, status: "parked" });
		lifecycle.adopt("5-Sub", { idleTtlMs: 0 });

		await expect(lifecycle.ensureLive("5-Sub")).rejects.toThrow(/cannot be revived.*no reviver registered/);
	});

	it("release disposes a live adopted agent, unregisters it, and leaves no pending park", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registerIdleSub("6-Sub", stub.session);
		lifecycle.adopt("6-Sub", { idleTtlMs: TTL });

		await lifecycle.release("6-Sub");

		expect(stub.disposeCalls()).toBe(1);
		expect(registry.get("6-Sub")).toBeUndefined();
		expect(lifecycle.has("6-Sub")).toBe(false);

		// The disarmed timer must not fire a late park (which would double-dispose).
		vi.advanceTimersByTime(TTL * 10);
		await flushAsync();
		expect(stub.disposeCalls()).toBe(1);
		expect(registry.get("6-Sub")).toBeUndefined();
	});

	it("adopt(Main) is a no-op: Main is never adopted or parked", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: stub.session,
			status: "idle",
		});
		lifecycle.adopt(MAIN_AGENT_ID, { idleTtlMs: TTL });

		expect(lifecycle.has(MAIN_AGENT_ID)).toBe(false);
		vi.advanceTimersByTime(TTL * 10);
		await flushAsync();
		expect(registry.get(MAIN_AGENT_ID)?.status).toBe("idle");
		expect(registry.get(MAIN_AGENT_ID)?.session).toBe(stub.session);
		expect(stub.disposeCalls()).toBe(0);
	});

	it("isParking is true exactly while park's dispose is in flight; parked only after it completes", async () => {
		const gate = deferred();
		const stub = makeSessionStub(() => gate.promise);
		registerIdleSub("7-Sub", stub.session);
		lifecycle.adopt("7-Sub", { idleTtlMs: 0 });

		// park() runs synchronously up to `await session.dispose()`, which we hold open.
		const parking = lifecycle.park("7-Sub");

		expect(stub.disposeCalls()).toBe(1);
		expect(lifecycle.isParking("7-Sub")).toBe(true);
		expect(registry.get("7-Sub")).toBeDefined();
		expect(registry.get("7-Sub")?.status).toBe("idle"); // not yet flipped

		gate.resolve();
		await parking;

		expect(lifecycle.isParking("7-Sub")).toBe(false);
		expect(registry.get("7-Sub")?.status).toBe("parked");
		expect(registry.get("7-Sub")?.session).toBeNull();
	});

	it("idleTtlMs <= 0 adopts without a timer: the agent never parks", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registerIdleSub("8-Sub", stub.session);
		lifecycle.adopt("8-Sub", { idleTtlMs: 0 });

		vi.advanceTimersByTime(60_000);
		await flushAsync();
		const ref = registry.get("8-Sub");
		expect(ref?.status).toBe("idle");
		expect(ref?.session).toBe(stub.session);
		expect(stub.disposeCalls()).toBe(0);
		expect(lifecycle.has("8-Sub")).toBe(true);
	});
});

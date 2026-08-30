import { type FauxProviderRegistration, fauxAssistantMessage, getModel, registerFauxProvider } from "omk-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";

const registrations: FauxProviderRegistration[] = [];

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function createHarness(session = new Session(new InMemorySessionStorage())): AgentHarness {
	return new AgentHarness({
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		session,
		model: getModel("anthropic", "claude-sonnet-4-5"),
	});
}

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

describe("HarnessSession facade", () => {
	it("queues a busy write outside persisted reads, then flushes it after the agent message", async () => {
		// Given: a turn is active and its provider response is held open.
		const registration = registerFauxProvider();
		registrations.push(registration);
		const started = deferred();
		const release = deferred();
		registration.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("assistant");
			},
		]);
		const storageSession = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: storageSession,
			model: registration.getModel(),
		});
		const session = harness.getSession();
		const turn = harness.prompt("user");
		await started.promise;

		// When: an extension writes through the facade during that turn.
		await session.appendCustomEntry("note", { value: 1 });

		// Then: persisted reads omit it while diagnostics disclose one detached pending write.
		expect((await session.getEntries()).some((entry) => entry.type === "custom")).toBe(false);
		const pending = session.getPendingWrites();
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ type: "custom", customType: "note", data: { value: 1 } });

		release.resolve();
		await turn;
		const persisted = await session.getEntries();
		const assistantIndex = persisted.findIndex(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		const customIndex = persisted.findIndex((entry) => entry.type === "custom");
		expect(assistantIndex).toBeGreaterThanOrEqual(0);
		expect(customIndex).toBeGreaterThan(assistantIndex);
		expect(session.getPendingWrites()).toEqual([]);
	});

	it("persists an idle write immediately", async () => {
		const harness = createHarness();
		const session = harness.getSession();

		await session.appendCustomEntry("note", { value: 1 });

		expect((await session.getEntries()).some((entry) => entry.type === "custom")).toBe(true);
		expect(session.getPendingWrites()).toEqual([]);
	});

	it("delegates persisted reads through detached snapshots", async () => {
		const storageSession = new Session(new InMemorySessionStorage());
		const messageId = await storageSession.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
		});
		await storageSession.appendLabel(messageId, "start");
		await storageSession.appendSessionName("named");
		const session = createHarness(storageSession).getSession();

		const metadata = await session.getMetadata();
		expect(metadata.id.length).toBeGreaterThan(0);
		expect(await session.getLeafId()).toBe(await storageSession.getLeafId());
		expect(await session.getEntry(messageId)).toMatchObject({ id: messageId, type: "message" });
		expect((await session.getBranch()).length).toBeGreaterThan(0);
		expect((await session.buildContext()).messages).toHaveLength(1);
		expect(await session.getLabel(messageId)).toBe("start");
		expect(await session.getSessionName()).toBe("named");
		expect(Object.isFrozen(metadata)).toBe(true);
	});

	it("queues extension write shapes in call order and flushes them on settlement", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const started = deferred();
		const release = deferred();
		registration.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("done");
			},
		]);
		const storageSession = new Session(new InMemorySessionStorage());
		const targetId = await storageSession.appendMessage({
			role: "user",
			content: [{ type: "text", text: "target" }],
			timestamp: Date.now(),
		});
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: storageSession,
			model: registration.getModel(),
		});
		const session = harness.getSession();
		const turn = harness.prompt("user");
		await started.promise;

		await session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "injected" }],
			timestamp: Date.now(),
		});
		await session.appendCustomMessage({
			customType: "notice",
			content: "visible",
			display: true,
			details: { source: "hook" },
		});
		await session.appendLabel(targetId, "target-label");
		await session.appendSessionName("busy-name");
		await session.setLeafId(targetId);
		expect(session.getPendingWrites().map((write) => write.type)).toEqual([
			"message",
			"custom_message",
			"label",
			"session_info",
			"leaf",
		]);

		release.resolve();
		await turn;
		expect(session.getPendingWrites()).toEqual([]);
		expect(await session.getLabel(targetId)).toBe("target-label");
		expect(await session.getSessionName()).toBe("busy-name");
		expect(await session.getLeafId()).toBe(targetId);
	});

	it("rejects writes during structural operations instead of leaving them pending past settlement", async () => {
		const storageSession = new Session(new InMemorySessionStorage());
		const targetId = await storageSession.appendMessage({
			role: "user",
			content: [{ type: "text", text: "target" }],
			timestamp: Date.now(),
		});
		await storageSession.appendMessage({
			role: "user",
			content: [{ type: "text", text: "current" }],
			timestamp: Date.now(),
		});
		const harness = createHarness(storageSession);
		const entered = deferred();
		const release = deferred();
		harness.on("session_before_tree", async () => {
			entered.resolve();
			await release.promise;
			return undefined;
		});
		const navigation = harness.navigateTree(targetId);
		await entered.promise;

		try {
			await expect(harness.getSession().appendCustomEntry("late", {})).rejects.toMatchObject({
				code: "invalid_state",
			});
			expect(harness.getSession().getPendingWrites()).toEqual([]);
		} finally {
			release.resolve();
			await navigation;
		}
	});

	it("rejects an unknown leaf before it can enter the pending queue", async () => {
		const session = createHarness().getSession();

		await expect(session.setLeafId("missing")).rejects.toMatchObject({ code: "invalid_argument" });
		expect(session.getPendingWrites()).toEqual([]);
	});

	it("rejects non-plain write data before it can enter the pending queue", async () => {
		const harness = createHarness();
		const session = harness.getSession();

		await expect(session.appendCustomEntry("bad", { when: new Date() })).rejects.toMatchObject({
			code: "invalid_argument",
		});
		expect(session.getPendingWrites()).toEqual([]);
	});

	it("returns detached pending-write snapshots and hides raw storage", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const started = deferred();
		const release = deferred();
		registration.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("done");
			},
		]);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		const session = harness.getSession();
		const turn = harness.prompt("user");
		await started.promise;
		await session.appendCustomEntry("note", { value: 1 });

		const first = session.getPendingWrites();
		expect(Object.isFrozen(first[0])).toBe(true);
		expect(session).not.toHaveProperty("getStorage");
		expect(session.getPendingWrites()).not.toBe(first);

		release.resolve();
		await turn;
	});
});

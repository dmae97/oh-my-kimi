import fc from "fast-check";
import { fauxAssistantMessage, getModel, registerFauxProvider } from "omk-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { AgentHarnessError, SessionError } from "../../src/harness/errors.ts";
import { HarnessSessionFacade } from "../../src/harness/harness-session.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import { type QueuedSessionWrite, SessionWriteCoordinator } from "../../src/harness/session-write-coordinator.ts";
import type { SessionTreeEntry } from "../../src/harness/types.ts";
import { calculateTool } from "../utils/calculate.ts";

const registrations: Array<{ unregister(): void }> = [];

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

class SwitchableCustomEntryStorage extends InMemorySessionStorage {
	private acceptsCustomEntries = false;

	allowCustomEntries(): void {
		this.acceptsCustomEntries = true;
	}

	override async appendEntry(entry: SessionTreeEntry): Promise<void> {
		if (entry.type === "custom" && !this.acceptsCustomEntries) {
			throw new SessionError("storage", "custom entry persistence is unavailable");
		}
		await super.appendEntry(entry);
	}
}

class InvalidStateSessionWriteCoordinator<TMessage> extends SessionWriteCoordinator<TMessage> {
	override async persistAfterPending(_write: QueuedSessionWrite<TMessage>): Promise<void> {
		throw new AgentHarnessError("invalid_state", "reentrant persistence");
	}
}

class TrackingMoveSession extends Session {
	moveToCalls = 0;

	override async moveTo(entryId: string | null): Promise<string | undefined> {
		this.moveToCalls += 1;
		return await super.moveTo(entryId);
	}
}

class BlockingSessionInfoStorage extends InMemorySessionStorage {
	readonly firstSessionInfoStarted = deferred();
	private readonly releaseFirstSessionInfo = deferred();
	private sessionInfoAttempts = 0;

	getSessionInfoAttempts(): number {
		return this.sessionInfoAttempts;
	}

	allowFirstSessionInfo(): void {
		this.releaseFirstSessionInfo.resolve();
	}

	override async appendEntry(entry: SessionTreeEntry): Promise<void> {
		if (entry.type === "session_info") {
			this.sessionInfoAttempts += 1;
			if (this.sessionInfoAttempts === 1) {
				this.firstSessionInfoStarted.resolve();
				await this.releaseFirstSessionInfo.promise;
			}
		}
		await super.appendEntry(entry);
	}
}

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

describe("AgentHarness session-write ordering properties", () => {
	it("preserves a classified coordinator error through the public facade", async () => {
		// Given: a coordinator that rejects with a classified harness state error.
		const storageSession = new Session(new InMemorySessionStorage());
		const session = new HarnessSessionFacade(
			storageSession,
			() => "idle",
			new InvalidStateSessionWriteCoordinator(storageSession),
		);

		// When/Then: the facade preserves the existing classification.
		await expect(session.appendSessionName("name")).rejects.toMatchObject({ code: "invalid_state" });
	});

	it("preserves distinct idle and queued leaf persistence paths", async () => {
		// Given: a session whose public move operation is observable.
		const storageSession = new TrackingMoveSession(new InMemorySessionStorage());
		const targetId = await storageSession.appendMessage({
			role: "user",
			content: [{ type: "text", text: "target" }],
			timestamp: Date.now(),
		});
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: storageSession,
			model: getModel("anthropic", "claude-sonnet-4-5"),
		});

		// When: an idle facade write and then a queued coordinator write select the leaf.
		await harness.getSession().setLeafId(targetId);
		const coordinator = new SessionWriteCoordinator(storageSession);
		coordinator.enqueue({ type: "leaf", targetId });
		await coordinator.flush();

		// Then: only the idle path uses Session.moveTo; queued persistence keeps its storage path.
		expect(storageSession.moveToCalls).toBe(1);
		expect(await storageSession.getLeafId()).toBe(targetId);
	});

	it("snapshots a write when the coordinator accepts it", async () => {
		// Given: mutable plain data passed directly to the coordinator boundary.
		const storageSession = new Session(new InMemorySessionStorage());
		const coordinator = new SessionWriteCoordinator(storageSession);
		const data = { value: 1 };

		// When: the caller mutates its object after enqueue acceptance.
		coordinator.enqueue({ type: "custom", customType: "note", data });
		data.value = 2;
		await coordinator.flush();

		// Then: persistence uses the accepted immutable snapshot.
		const customEntry = (await storageSession.getEntries()).find((entry) => entry.type === "custom");
		expect(customEntry).toMatchObject({ type: "custom", data: { value: 1 } });
	});

	it("starts an idle persistence boundary before a synchronous later enqueue", async () => {
		// Given: an idle persistence operation scheduled against an empty queue.
		const storageSession = new Session(new InMemorySessionStorage());
		const coordinator = new SessionWriteCoordinator(storageSession);

		// When: another write is enqueued synchronously after the idle invocation.
		const idleWrite = coordinator.persistAfterPending({ type: "session_info", name: "idle" });
		coordinator.enqueue({ type: "custom", customType: "later" });
		await idleWrite;
		await coordinator.flush();

		// Then: invocation order owns the empty persistence boundary.
		const order = (await storageSession.getEntries()).flatMap((entry) =>
			entry.type === "session_info" || entry.type === "custom" ? [entry.type] : [],
		);
		expect(order).toEqual(["session_info", "custom"]);
	});

	it("reserves an empty persistence boundary before a later enqueue", async () => {
		// Given: an idle persistence operation scheduled against an empty queue.
		const storageSession = new Session(new InMemorySessionStorage());
		const coordinator = new SessionWriteCoordinator(storageSession);

		// When: another write is enqueued in the next microtask.
		const idleWrite = coordinator.persistAfterPending({ type: "session_info", name: "idle" });
		queueMicrotask(() => coordinator.enqueue({ type: "custom", customType: "later" }));
		await idleWrite;
		await coordinator.flush();

		// Then: the serialized idle operation starts before the later enqueue is accepted.
		const order = (await storageSession.getEntries()).flatMap((entry) =>
			entry.type === "session_info" || entry.type === "custom" ? [entry.type] : [],
		);
		expect(order).toEqual(["session_info", "custom"]);
	});

	it("serializes concurrent idle writes in invocation order", async () => {
		// Given: the first idle session write is held inside storage persistence.
		const storage = new BlockingSessionInfoStorage();
		const session = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(storage),
			model: getModel("anthropic", "claude-sonnet-4-5"),
		}).getSession();
		const firstWrite = session.appendSessionName("first");
		await storage.firstSessionInfoStarted.promise;

		// When: a second idle write is invoked before the first settles.
		const secondWrite = session.appendSessionName("second");
		await Promise.resolve();

		// Then: it cannot enter storage or overtake the first write.
		expect(storage.getSessionInfoAttempts()).toBe(1);
		storage.allowFirstSessionInfo();
		await Promise.all([firstWrite, secondWrite]);
		const names = (await session.getEntries()).flatMap((entry) =>
			entry.type === "session_info" ? [entry.name] : [],
		);
		expect(names).toEqual(["first", "second"]);
	});

	it("snapshots model identity before deferred idle persistence", async () => {
		// Given: a mutable caller-owned model descriptor.
		const storageSession = new Session(new InMemorySessionStorage());
		const initialModel = getModel("anthropic", "claude-sonnet-4-5");
		const nextModel = { ...initialModel };
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: storageSession,
			model: initialModel,
		});
		const expectedModelId = nextModel.id;

		// When: the caller mutates its descriptor immediately after invoking the update.
		const update = harness.setModel(nextModel);
		Reflect.set(nextModel, "id", "mutated-after-call");
		await update;

		// Then: durable session state records the invocation snapshot.
		expect((await storageSession.buildContext()).model).toEqual({
			provider: nextModel.provider,
			modelId: expectedModelId,
		});
	});

	it("snapshots active tool names before deferred idle persistence", async () => {
		// Given: a valid caller-owned active-tool array.
		const storageSession = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: storageSession,
			model: getModel("anthropic", "claude-sonnet-4-5"),
			tools: [calculateTool],
		});
		const activeToolNames = [calculateTool.name];

		// When: the caller mutates its array immediately after invoking the update.
		const update = harness.setActiveTools(activeToolNames);
		activeToolNames[0] = "missing";
		await update;

		// Then: persistence and live state use the validated invocation snapshot.
		expect((await storageSession.buildContext()).activeToolNames).toEqual([calculateTool.name]);
		expect(harness.getActiveTools().map((tool) => tool.name)).toEqual([calculateTool.name]);
	});

	it("does not retain an idle write whose persistence rejects", async () => {
		// Given: idle custom-entry persistence is unavailable.
		const storage = new SwitchableCustomEntryStorage();
		const session = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(storage),
			model: getModel("anthropic", "claude-sonnet-4-5"),
		}).getSession();

		// When: an idle write rejects before it is accepted as durable state.
		await expect(session.appendCustomEntry("rejected", { value: 1 })).rejects.toMatchObject({ code: "session" });

		// Then: later persistence cannot replay that rejected write.
		expect(session.getPendingWrites()).toEqual([]);
		storage.allowCustomEntries();
		await session.appendSessionName("tail");
		expect((await session.getEntries()).some((entry) => entry.type === "custom")).toBe(false);
	});

	it("does not let a later enqueue overtake an already reserved idle boundary", async () => {
		// Given: storage that blocks the first idle write until released.
		const persisted: string[] = [];
		const releaseFirst = deferred();
		let blocking = true;
		const port = {
			getStorage: () => ({ setLeafId: async () => undefined }),
			appendMessage: async () => undefined,
			appendThinkingLevelChange: async () => undefined,
			appendModelChange: async () => undefined,
			appendActiveToolsChange: async () => undefined,
			appendCustomEntry: async (customType: string) => {
				if (blocking) {
					blocking = false;
					await releaseFirst.promise;
				}
				persisted.push(customType);
				return undefined;
			},
			appendCustomMessageEntry: async () => undefined,
			appendLabel: async () => undefined,
			appendSessionName: async () => undefined,
			moveTo: async () => undefined,
		};
		const coordinator = new SessionWriteCoordinator<string>(port);

		// When: B reserves its boundary while A is blocked, and only then is C enqueued.
		const a = coordinator.persistAfterPending({ type: "custom", customType: "A" });
		await Promise.resolve();
		const b = coordinator.persistAfterPending({ type: "custom", customType: "B" });
		coordinator.enqueue({ type: "custom", customType: "C" });
		releaseFirst.resolve();
		await a;
		await b;

		// Then: C was accepted after B's boundary, so it cannot precede B.
		expect(persisted).toEqual(["A", "B"]);
		expect(coordinator.hasPending()).toBe(true);

		await coordinator.flush();
		expect(persisted).toEqual(["A", "B", "C"]);
		expect(coordinator.hasPending()).toBe(false);
	});

	it("keeps accepted pending writes ahead of a later idle write after persistence recovers", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);

		await fc.assert(
			fc.asyncProperty(
				fc.uniqueArray(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 6 }),
				async (values) => {
					// Given: writes accepted during a turn cannot be persisted until the turn has failed.
					registration.setResponses([() => fauxAssistantMessage("done")]);
					const storage = new SwitchableCustomEntryStorage();
					const harness = new AgentHarness({
						env: new NodeExecutionEnv({ cwd: process.cwd() }),
						session: new Session(storage),
						model: registration.getModel(),
					});
					const session = harness.getSession();
					let queued = false;
					harness.subscribe(async (event) => {
						if (event.type !== "message_end" || event.message.role !== "assistant" || queued) return;
						queued = true;
						for (const value of values) await session.appendCustomEntry("pending", { value });
					});
					await expect(harness.prompt("start")).rejects.toMatchObject({ code: "session" });
					expect(session.getPendingWrites()).toHaveLength(values.length);

					// When: persistence recovers and an idle caller submits a later write.
					storage.allowCustomEntries();
					await session.appendSessionName("tail");

					// Then: the accepted queue is durable in FIFO order before the later write.
					type OrderedWrite =
						| { readonly type: "custom"; readonly data: unknown }
						| { readonly type: "session_info"; readonly name: string | undefined };
					const orderedWrites: OrderedWrite[] = [];
					for (const entry of await session.getEntries()) {
						if (entry.type === "custom") orderedWrites.push({ type: entry.type, data: entry.data });
						if (entry.type === "session_info") orderedWrites.push({ type: entry.type, name: entry.name });
					}
					expect(orderedWrites).toEqual([
						...values.map((value) => ({ type: "custom", data: { value } })),
						{ type: "session_info", name: "tail" },
					]);
					expect(session.getPendingWrites()).toEqual([]);
				},
			),
			{ numRuns: 60, seed: 0x53102026 },
		);
	});
});

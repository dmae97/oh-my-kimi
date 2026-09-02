import { type Context, type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "omk-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentHarnessEvent, AgentHarnessResources, SessionTreeEntry } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";

/**
 * Failure-boundary regressions for the operation lifecycle.
 *
 * Every test here pins an invariant that must survive a *failing* observer,
 * flush, or hook: a `begin()`-ed operation always settles exactly once and
 * returns the harness to idle, a started attempt is always closed, outcome
 * classification never reports success for a failed operation, and an awaited
 * callback can never deadlock by waiting on its own operation.
 */

const registrations: FauxProviderRegistration[] = [];

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function makeHarness(
	registration: FauxProviderRegistration,
	session?: Session,
	options?: Partial<ConstructorParameters<typeof AgentHarness>[0]>,
): { harness: AgentHarness; events: AgentHarnessEvent[] } {
	const harness = new AgentHarness({
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		session: session ?? new Session(new InMemorySessionStorage()),
		model: registration.getModel(),
		...options,
	});
	const events: AgentHarnessEvent[] = [];
	harness.subscribe((event) => {
		events.push(event);
	});
	return { harness, events };
}

function settledEvents(events: AgentHarnessEvent[]) {
	return events.flatMap((event) => (event.type === "settled" ? [event] : []));
}

function attemptFinishes(events: AgentHarnessEvent[]) {
	return events.flatMap((event) => (event.type === "attempt_finished" ? [event.summary] : []));
}

/**
 * White-box read of the private lifecycle stage. Deliberately not a public
 * accessor: the commit point is an internal staging invariant, and widening the
 * harness API just to observe it would be a worse trade than this reach-in.
 */
function readStage(harness: AgentHarness): string {
	const { lifecycle } = harness as unknown as {
		lifecycle: { getSnapshot(): { tag: string; stage?: string } };
	};
	const snapshot = lifecycle.getSnapshot();
	return snapshot.tag === "active" ? (snapshot.stage ?? "unknown") : snapshot.tag;
}

/** Custom-entry persistence can be toggled to fail after the provider succeeded. */
class SwitchableCustomEntryStorage extends InMemorySessionStorage {
	private acceptsCustomEntries = false;

	allowCustomEntries(): void {
		this.acceptsCustomEntries = true;
	}

	override async appendEntry(entry: SessionTreeEntry): Promise<void> {
		if (entry.type === "custom" && !this.acceptsCustomEntries) {
			throw new Error("custom entry persistence is unavailable");
		}
		await super.appendEntry(entry);
	}
}

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

describe("operation settlement is failure-safe", () => {
	it("settles and returns to idle when an operation_started listener throws", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("first"), () => fauxAssistantMessage("second")]);
		const { harness, events } = makeHarness(registration);
		let thrown = false;
		harness.subscribe((event) => {
			if (event.type === "operation_started" && !thrown) {
				thrown = true;
				throw new Error("observer failed");
			}
		});

		await expect(harness.prompt("first")).rejects.toMatchObject({ code: "hook" });

		// The failing observer must not strand the lifecycle: settlement still runs
		// exactly once, records a failure, and releases the harness.
		const settleds = settledEvents(events);
		expect(settleds).toHaveLength(1);
		expect(settleds[0]!.outcome.status).toBe("failed");
		expect(settleds[0]!.attemptCount).toBe(0);
		await expect(harness.waitForIdle()).resolves.toBeUndefined();
		// The observer threw before the provider ran, so the canned response queue is
		// untouched; only "the harness accepts a new operation" matters here.
		await expect(harness.prompt("second")).resolves.toBeDefined();
	});

	it("closes the attempt when an attempt_started listener throws", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("first"), () => fauxAssistantMessage("second")]);
		const { harness, events } = makeHarness(registration);
		let thrown = false;
		harness.subscribe((event) => {
			if (event.type === "attempt_started" && !thrown) {
				thrown = true;
				throw new Error("attempt observer failed");
			}
		});

		await expect(harness.prompt("first")).rejects.toMatchObject({ code: "hook" });

		const starts = events.flatMap((event) => (event.type === "attempt_started" ? [event.attempt] : []));
		const finishes = attemptFinishes(events);
		// count(attempt_started) == count(attempt_finished), by attempt id.
		expect(finishes.map((summary) => summary.attemptId)).toEqual(starts.map((attempt) => attempt.attemptId));
		expect(finishes).toHaveLength(1);
		expect(finishes[0]!.outcome).toBe("failed");
		const settleds = settledEvents(events);
		expect(settleds).toHaveLength(1);
		expect(settleds[0]!.outcome.status).toBe("failed");
		await expect(harness.waitForIdle()).resolves.toBeUndefined();
		await expect(harness.prompt("second")).resolves.toBeDefined();
	});

	it("keeps the attempt closed when an attempt_finished listener throws", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("first"), () => fauxAssistantMessage("second")]);
		const { harness, events } = makeHarness(registration);
		let thrown = false;
		harness.subscribe((event) => {
			if (event.type === "attempt_finished" && !thrown) {
				thrown = true;
				throw new Error("attempt_finished observer failed");
			}
		});

		await expect(harness.prompt("first")).rejects.toMatchObject({ code: "hook" });

		const finishes = attemptFinishes(events);
		expect(finishes).toHaveLength(1);
		// The attempt keeps its real provider outcome; the observer failure is an
		// operation-level failure, not a rewrite of already-committed attempt state.
		expect(finishes[0]!.outcome).toBe("completed");
		const settleds = settledEvents(events);
		expect(settleds).toHaveLength(1);
		expect(settleds[0]!.outcome.status).toBe("failed");
		await expect(harness.waitForIdle()).resolves.toBeUndefined();
		const second = await harness.prompt("second");
		expect(second.content).toContainEqual({ type: "text", text: "second" });
	});
});

describe("prompt-family outcome classification parity", () => {
	const templateResources: AgentHarnessResources = {
		promptTemplates: [{ name: "greet", content: "Say hello to $1" }],
		skills: [{ name: "helper", description: "d", content: "c", filePath: "/tmp/helper.md" }],
	};

	it("records an assistant error as failed for every prompt-family API", async () => {
		for (const invoke of [
			(harness: AgentHarness) => harness.prompt("hi"),
			(harness: AgentHarness) => harness.skill("helper"),
			(harness: AgentHarness) => harness.promptFromTemplate("greet", ["world"]),
		]) {
			const registration = registerFauxProvider();
			registrations.push(registration);
			registration.setResponses([() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
			const { harness, events } = makeHarness(registration, undefined, { resources: templateResources });

			const message = await invoke(harness);

			expect(message.stopReason).toBe("error");
			const settleds = settledEvents(events);
			expect(settleds).toHaveLength(1);
			expect(settleds[0]!.attemptCount).toBe(1);
			expect(settleds[0]!.outcome).toMatchObject({ status: "failed", code: "provider" });
		}
	});

	it("records an assistant abort as aborted for every prompt-family API", async () => {
		for (const invoke of [
			(harness: AgentHarness) => harness.prompt("hi"),
			(harness: AgentHarness) => harness.skill("helper"),
			(harness: AgentHarness) => harness.promptFromTemplate("greet", ["world"]),
		]) {
			const registration = registerFauxProvider();
			registrations.push(registration);
			registration.setResponses([() => fauxAssistantMessage("partial", { stopReason: "aborted" })]);
			const { harness, events } = makeHarness(registration, undefined, { resources: templateResources });

			const message = await invoke(harness);

			expect(message.stopReason).toBe("aborted");
			const settleds = settledEvents(events);
			expect(settleds).toHaveLength(1);
			expect(settleds[0]!.attemptCount).toBe(1);
			expect(settleds[0]!.outcome).toMatchObject({ status: "aborted" });
		}
	});
});

describe("outcome precedence", () => {
	it("reports a session flush failure even when the operation was aborted", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		registration.setResponses([
			async (_context, options) => {
				options?.signal?.addEventListener("abort", () => release(), { once: true });
				await gate;
				return fauxAssistantMessage("late", { stopReason: "aborted" });
			},
		]);
		const storage = new SwitchableCustomEntryStorage();
		const { harness, events } = makeHarness(registration, new Session(storage));
		harness.subscribe((event) => {
			if (event.type === "attempt_started") {
				void harness.getSession().appendCustomEntry("queued", { value: 1 });
			}
		});

		const prompt = harness.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.abort().catch(() => undefined);
		await expect(prompt).rejects.toMatchObject({ code: "session" });

		// An aborted signal must not mask a real persistence failure.
		const settleds = settledEvents(events);
		expect(settleds).toHaveLength(1);
		expect(settleds[0]!.outcome).toMatchObject({ status: "failed", code: "session" });
	});

	it("preserves the listener and provider causes when a boundary flush fails after them", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("done")]);
		const storage = new SwitchableCustomEntryStorage();
		const { harness, events } = makeHarness(registration, new Session(storage));
		let listenerThrown = false;
		harness.subscribe((event) => {
			if (event.type === "attempt_started") {
				void harness.getSession().appendCustomEntry("queued", { value: 1 });
			}
			if (event.type === "turn_end" && !listenerThrown) {
				listenerThrown = true;
				throw new Error("turn_end listener failed");
			}
		});

		const failure = await harness.prompt("hello").then(
			() => undefined,
			(error: unknown) => error,
		);

		// The flush failure still wins the classification, but a failing flush at
		// the turn or attempt boundary must not erase what failed before it: the
		// audit trail has to show the listener error and the storage error together.
		expect(failure).toMatchObject({ code: "session" });
		const causes = causeMessages(failure);
		expect(causes).toContain("turn_end listener failed");
		expect(causes).toContain("custom entry persistence is unavailable");
		const settleds = settledEvents(events);
		expect(settleds).toHaveLength(1);
		expect(settleds[0]!.outcome).toMatchObject({ status: "failed", code: "session" });
		expect(attemptFinishes(events)).toHaveLength(1);
		await expect(harness.waitForIdle()).resolves.toBeUndefined();
	});
});

/** Every message reachable through `cause` and `AggregateError.errors`, depth-first. */
function causeMessages(error: unknown): string[] {
	const messages: string[] = [];
	const visit = (candidate: unknown): void => {
		if (!(candidate instanceof Error)) return;
		messages.push(candidate.message);
		if (candidate instanceof AggregateError) for (const inner of candidate.errors) visit(inner);
		visit(candidate.cause);
	};
	visit(error);
	return messages;
}

describe("structural cancellation and commit staging", () => {
	async function branchedSession(): Promise<{ session: Session; targetId: string }> {
		const session = new Session(new InMemorySessionStorage());
		const firstId = await session.appendMessage(userMessage("first"));
		await session.appendMessage(fauxAssistantMessage("first reply"));
		await session.appendMessage(userMessage("second"));
		await session.appendMessage(fauxAssistantMessage("second reply"));
		return { session, targetId: firstId };
	}

	it("settles navigateTree as cancelled when the tree hook cancels", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const { session, targetId } = await branchedSession();
		const leafBefore = await session.getLeafId();
		const { harness, events } = makeHarness(registration, session);
		harness.on("session_before_tree", () => ({ cancel: true }));

		const result = await harness.navigateTree(targetId);

		expect(result.cancelled).toBe(true);
		const settleds = settledEvents(events);
		expect(settleds).toHaveLength(1);
		expect(settleds[0]!.outcome.status).toBe("cancelled");
		expect(await session.getLeafId()).toBe(leafBefore);
	});

	it("passes through the committing stage before mutating the session", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const { session, targetId } = await branchedSession();
		const { harness } = makeHarness(registration, session);
		const stages: string[] = [];
		const trackedSession = session as Session & { moveTo: Session["moveTo"] };
		const originalMoveTo = trackedSession.moveTo.bind(trackedSession);
		trackedSession.moveTo = async (entryId, summary) => {
			stages.push(readStage(harness));
			return await originalMoveTo(entryId, summary);
		};

		await harness.navigateTree(targetId);

		expect(stages).toContain("committing");
	});

	it("never reaches committing when the tree hook cancels before the commit point", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const { session, targetId } = await branchedSession();
		const { harness } = makeHarness(registration, session);
		const stages: string[] = [];
		harness.subscribe(() => {
			stages.push(readStage(harness));
		});
		harness.on("session_before_tree", () => ({ cancel: true }));

		await harness.navigateTree(targetId);

		expect(stages).not.toContain("committing");
	});
});

describe("queued input requires a consuming attempt", () => {
	async function branchedSession(): Promise<{ session: Session; targetId: string }> {
		const session = new Session(new InMemorySessionStorage());
		const firstId = await session.appendMessage(userMessage("first"));
		await session.appendMessage(fauxAssistantMessage("first reply"));
		return { session, targetId: firstId };
	}

	function contextTexts(context: Context): string[] {
		return context.messages.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		);
	}

	it("rejects steer and followUp during a structural operation instead of leaking into the next prompt", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const seenContexts: Context[] = [];
		registration.setResponses([
			(context) => {
				seenContexts.push(context);
				return fauxAssistantMessage("next reply");
			},
		]);
		const { session, targetId } = await branchedSession();
		const { harness } = makeHarness(registration, session);
		const rejections: unknown[] = [];
		harness.on("session_before_tree", async () => {
			// A tree navigation runs no agent attempt, so nothing could ever consume
			// these; accepting them would silently inject them into a later prompt.
			rejections.push(await harness.steer("leaked steer").catch((error) => error));
			rejections.push(await harness.followUp("leaked follow-up").catch((error) => error));
			return { cancel: true };
		});

		await harness.navigateTree(targetId);
		expect(rejections).toHaveLength(2);
		for (const rejection of rejections) expect(rejection).toMatchObject({ code: "invalid_state" });

		await harness.prompt("next");
		expect(seenContexts).toHaveLength(1);
		const texts = contextTexts(seenContexts[0]!);
		expect(texts).toContain("next");
		expect(texts).not.toContain("leaked steer");
		expect(texts).not.toContain("leaked follow-up");
	});
});

describe("awaited callbacks cannot wait on their own operation", () => {
	it("rejects waitForIdle from a settled listener instead of deadlocking", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("done"), () => fauxAssistantMessage("second")]);
		const { harness } = makeHarness(registration);
		let selfWait: unknown;
		harness.subscribe(async (event) => {
			if (event.type === "settled" && selfWait === undefined) {
				selfWait = await harness
					.waitForIdle()
					.then(() => "resolved")
					.catch((error) => error);
			}
		});

		// The listener swallows the guard error, so the operation itself succeeds;
		// what matters is that the wait failed fast instead of hanging forever.
		await expect(harness.prompt("first")).resolves.toBeDefined();

		expect(selfWait).toMatchObject({ code: "invalid_state" });
		await expect(harness.waitForIdle()).resolves.toBeUndefined();
		const second = await harness.prompt("second");
		expect(second.content).toContainEqual({ type: "text", text: "second" });
	});

	it("rejects abort from an attempt_started listener instead of deadlocking", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("done"), () => fauxAssistantMessage("second")]);
		const { harness } = makeHarness(registration);
		let selfAbort: unknown;
		harness.subscribe(async (event) => {
			if (event.type === "attempt_started" && selfAbort === undefined) {
				selfAbort = await harness
					.abort()
					.then(() => "resolved")
					.catch((error) => error);
			}
		});

		await expect(harness.prompt("first")).resolves.toBeDefined();

		expect(selfAbort).toMatchObject({ code: "invalid_state" });
		await expect(harness.waitForIdle()).resolves.toBeUndefined();
		const second = await harness.prompt("second");
		expect(second.content).toContainEqual({ type: "text", text: "second" });
	});

	it("still allows an external waitForIdle to observe settlement", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("done")]);
		const { harness } = makeHarness(registration);

		const prompt = harness.prompt("hello");
		const idle = harness.waitForIdle();
		await prompt;

		await expect(idle).resolves.toBeUndefined();
	});
});

describe("lifecycle payloads are detached from internal state", () => {
	it("ignores external mutation of an operation_started payload", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("done")]);
		const { harness, events } = makeHarness(registration);
		harness.subscribe((event) => {
			if (event.type === "operation_started") {
				Reflect.set(event.operation, "operationId", "mutated");
			}
		});

		await harness.prompt("hello");

		const attemptStarted = events.find((event) => event.type === "attempt_started");
		const settled = settledEvents(events)[0];
		if (attemptStarted?.type !== "attempt_started" || settled === undefined) throw new Error("missing events");
		expect(attemptStarted.attempt.operationId).not.toBe("mutated");
		expect(settled.operationId).not.toBe("mutated");
		expect(attemptStarted.attempt.attemptId).toBe(`${settled.operationId}:a0`);
	});
});

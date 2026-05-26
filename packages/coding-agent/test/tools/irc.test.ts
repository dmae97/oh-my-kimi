import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type FileEntry, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { IrcTool } from "@oh-my-pi/pi-coding-agent/tools/irc";

interface FakeSession {
	session: AgentSession;
	calls: Array<{ from: string; message: string; awaitReply: boolean }>;
	/** Override the reply this fake session generates. */
	setReply: (text: string) => void;
	/** Cause the next respondAsBackground call to throw. */
	setError: (error: Error) => void;
	/** Resolve the next respondAsBackground call only when allowed. */
	gateNextCall: () => { release: () => void };
	/** Keep the next respondAsBackground call pending until aborted. */
	hangNextCall: () => void;
}
function makeFakeSession(): FakeSession {
	let nextReply = "auto-reply";
	let nextError: Error | null = null;
	let gate: { promise: Promise<void>; release: () => void } | null = null;
	let hangNext = false;
	const calls: Array<{ from: string; message: string; awaitReply: boolean }> = [];
	const session = {
		respondAsBackground: async (args: {
			from: string;
			message: string;
			awaitReply?: boolean;
			signal?: AbortSignal;
		}) => {
			const awaitReply = args.awaitReply !== false;
			calls.push({ from: args.from, message: args.message, awaitReply });
			if (gate) {
				const g = gate;
				gate = null;
				await g.promise;
			}
			if (hangNext) {
				hangNext = false;
				const deferred = Promise.withResolvers<never>();
				if (args.signal?.aborted) {
					deferred.reject(args.signal.reason instanceof Error ? args.signal.reason : new Error("aborted"));
				} else {
					args.signal?.addEventListener(
						"abort",
						() =>
							deferred.reject(args.signal?.reason instanceof Error ? args.signal.reason : new Error("aborted")),
						{ once: true },
					);
				}
				return await deferred.promise;
			}
			if (nextError) {
				const err = nextError;
				nextError = null;
				throw err;
			}
			return { replyText: awaitReply ? nextReply : null };
		},
	};
	return {
		session: session as unknown as AgentSession,
		calls,
		setReply: text => {
			nextReply = text;
		},
		setError: error => {
			nextError = error;
		},
		gateNextCall: () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			gate = { promise, release: resolve };
			return { release: resolve };
		},
		hangNextCall: () => {
			hangNext = true;
		},
	};
}

function makeToolSession(registry: AgentRegistry, agentId: string): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => agentId,
	};
}
function createRealBackgroundSession(): { session: AgentSession; sessionManager: SessionManager } {
	const sessionManager = SessionManager.inMemory("/tmp");
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				systemPrompt: ["system prompt"],
				messages: [],
				tools: [],
			},
		}),
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {} as never,
	});
	return { session, sessionManager };
}

describe("IrcTool", () => {
	let registry: AgentRegistry;

	const sessions: AgentSession[] = [];
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		registry = AgentRegistry.global();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("createIf returns null when irc is disabled", () => {
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			agentRegistry: registry,
			getAgentId: () => "0-Main",
		};
		session.settings.set("irc.enabled", false);
		expect(IrcTool.createIf(session)).toBeNull();
	});

	it("createIf returns null without registry/agentId", () => {
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		expect(IrcTool.createIf(session)).toBeNull();
	});

	it("op=list returns peers visible to the caller", async () => {
		const main = makeFakeSession();
		const sub = makeFakeSession();
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		registry.register({
			id: "0-AuthLoader",
			displayName: "task",
			kind: "sub",
			parentId: "0-Main",
			session: sub.session,
		});

		const tool = new IrcTool(makeToolSession(registry, "0-Main"));
		const result = await tool.execute("call-1", { op: "list" });
		expect(result.details?.op).toBe("list");
		expect(result.details?.peers).toEqual([
			{
				id: "0-AuthLoader",
				displayName: "task",
				kind: "sub",
				status: "running",
				parentId: "0-Main",
			},
		]);
		expect(result.details?.channels).toEqual(["all", "0-AuthLoader"]);
	});

	it("op=send DM returns the recipient's prose reply", async () => {
		const main = makeFakeSession();
		const sub = makeFakeSession();
		sub.setReply("pong");
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		registry.register({
			id: "0-AuthLoader",
			displayName: "task",
			kind: "sub",
			parentId: "0-Main",
			session: sub.session,
		});

		const tool = new IrcTool(makeToolSession(registry, "0-Main"));
		const result = await tool.execute("call-2", {
			op: "send",
			to: "0-AuthLoader",
			message: "ping",
		});
		expect(result.details?.delivered).toEqual(["0-AuthLoader"]);
		expect(result.details?.replies).toEqual([{ from: "0-AuthLoader", text: "pong" }]);
		expect(sub.calls).toEqual([{ from: "0-Main", message: "ping", awaitReply: true }]);
	});

	it("op=send returns immediately even when the recipient is mid-tool-call", async () => {
		// Simulate "blocked recipient": gateNextCall holds respondAsBackground
		// pending until we release it. From the sender's perspective the call
		// must still complete because the side-channel does not block on the
		// recipient's main loop in a real session.
		const main = makeFakeSession();
		const sub = makeFakeSession();
		sub.setReply("ok");
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		registry.register({ id: "0-Busy", displayName: "task", kind: "sub", parentId: "0-Main", session: sub.session });

		const gate = sub.gateNextCall();
		const tool = new IrcTool(makeToolSession(registry, "0-Main"));
		const pending = tool.execute("call-3", { op: "send", to: "0-Busy", message: "are you there?" });
		// Release the gate after a microtask: the dispatch was already issued
		// even though the recipient was holding.
		setTimeout(() => gate.release(), 5);
		const result = await pending;
		expect(result.details?.delivered).toEqual(["0-Busy"]);
		expect(result.details?.replies).toEqual([{ from: "0-Busy", text: "ok" }]);
	});

	it("op=send to=all broadcasts (default no reply, only injection on each peer)", async () => {
		const main = makeFakeSession();
		const subA = makeFakeSession();
		const subB = makeFakeSession();
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		registry.register({ id: "0-A", displayName: "task", kind: "sub", parentId: "0-Main", session: subA.session });
		registry.register({ id: "0-B", displayName: "task", kind: "sub", parentId: "0-Main", session: subB.session });

		const tool = new IrcTool(makeToolSession(registry, "0-Main"));
		const result = await tool.execute("call-4", { op: "send", to: "all", message: "anyone there?" });
		expect(new Set(result.details?.delivered)).toEqual(new Set(["0-A", "0-B"]));
		expect(result.details?.replies ?? []).toEqual([]);
		expect(subA.calls).toEqual([{ from: "0-Main", message: "anyone there?", awaitReply: false }]);
		expect(subB.calls).toEqual([{ from: "0-Main", message: "anyone there?", awaitReply: false }]);
	});

	it("op=send returns notFound when target is unknown", async () => {
		const main = makeFakeSession();
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });

		const tool = new IrcTool(makeToolSession(registry, "0-Main"));
		const result = await tool.execute("call-5", { op: "send", to: "0-Ghost", message: "hi" });
		expect(result.details?.delivered ?? []).toEqual([]);
		expect(result.details?.notFound).toEqual(["0-Ghost"]);
	});

	it("op=send fails a hung recipient after the configured timeout", async () => {
		const main = makeFakeSession();
		const sub = makeFakeSession();
		sub.hangNextCall();
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		registry.register({ id: "0-Hung", displayName: "task", kind: "sub", parentId: "0-Main", session: sub.session });

		const toolSession = makeToolSession(registry, "0-Main");
		toolSession.settings.set("irc.timeoutMs", 5);
		const tool = new IrcTool(toolSession);
		const result = await tool.execute("call-timeout", { op: "send", to: "0-Hung", message: "ping" });

		expect(result.details?.delivered ?? []).toEqual([]);
		expect(result.details?.failed).toEqual([{ id: "0-Hung", error: "IRC timed out waiting for 0-Hung after 5 ms" }]);
		expect(sub.calls).toEqual([{ from: "0-Main", message: "ping", awaitReply: true }]);
	});
	it("op=send preserves the recipient's incoming DM when the auto-reply times out", async () => {
		const main = makeFakeSession();
		const { session: recipient, sessionManager } = createRealBackgroundSession();
		sessions.push(recipient);
		vi.spyOn(recipient, "runEphemeralTurn").mockImplementation(async ({ signal }) => {
			if (!signal) {
				throw new Error("Missing abort signal");
			}
			const deferred = Promise.withResolvers<never>();
			const rejectOnAbort = () => {
				deferred.reject(signal.reason instanceof Error ? signal.reason : new Error("IRC aborted"));
			};
			if (signal.aborted) {
				rejectOnAbort();
			} else {
				signal.addEventListener("abort", rejectOnAbort, { once: true });
			}
			return await deferred.promise;
		});
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		registry.register({
			id: "0-Hung",
			displayName: "task",
			kind: "sub",
			parentId: "0-Main",
			session: recipient,
		});

		const toolSession = makeToolSession(registry, "0-Main");
		toolSession.settings.set("irc.timeoutMs", 5);
		const tool = new IrcTool(toolSession);
		const result = await tool.execute("call-timeout-persist", { op: "send", to: "0-Hung", message: "ping" });

		expect(result.details?.delivered ?? []).toEqual([]);
		expect(result.details?.failed).toEqual([{ id: "0-Hung", error: "IRC timed out waiting for 0-Hung after 5 ms" }]);
		expect(recipient.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "custom",
					customType: "irc:incoming",
					content: "[IRC `0-Main` → you]\n\nping",
				}),
			]),
		);
		expect(recipient.messages).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ role: "custom", customType: "irc:autoreply" })]),
		);
		const persistedEntries = sessionManager
			.captureState()
			.fileEntries.filter(
				(entry): entry is Extract<FileEntry, { type: "custom_message" }> =>
					entry.type === "custom_message" && typeof entry.content === "string",
			);
		expect(persistedEntries).toEqual([
			expect.objectContaining({
				customType: "irc:incoming",
				content: "[IRC `0-Main` → you]\n\nping",
			}),
		]);
	});

	it("op=send surfaces recipient errors as failed", async () => {
		const main = makeFakeSession();
		const sub = makeFakeSession();
		sub.setError(new Error("model unavailable"));
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		registry.register({ id: "0-Down", displayName: "task", kind: "sub", parentId: "0-Main", session: sub.session });

		const tool = new IrcTool(makeToolSession(registry, "0-Main"));
		const result = await tool.execute("call-6", { op: "send", to: "0-Down", message: "ping" });
		expect(result.details?.delivered ?? []).toEqual([]);
		expect(result.details?.failed).toEqual([{ id: "0-Down", error: "model unavailable" }]);
	});
});

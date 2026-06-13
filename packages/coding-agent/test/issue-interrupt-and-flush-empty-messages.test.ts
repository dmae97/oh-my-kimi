/**
 * Regression test for the empty-messages interrupt-and-flush bug.
 *
 * Scenario the user hit:
 *   1. The agent is already streaming (a hidden turn: context promotion,
 *      auto-retry, auto-compaction, an extension-emitted turn, etc.).
 *   2. The user types "hi" and presses Enter. Because isStreaming is true,
 *      the input controller routes the message to `session.steer("hi")`
 *      (see the streamingBehavior branch in `AgentSession.prompt`).
 *      Critically, the user message is NEVER appended to `#state.messages`
 *      in the agent — it lives only in the steering queue.
 *   3. The user presses Enter again on an empty editor to inject the steer
 *      immediately. The input controller calls
 *      `session.interruptAndFlushQueuedMessages()`.
 *   4. `interruptAndFlushQueuedMessages` aborts the streaming turn, then
 *      calls `agent.continue()` to drain the queued steer. `continue()` is:
 *
 *          if (messages.length === 0) throw "No messages to continue from";
 *          if (last role === "assistant") { drainSteering(); runLoop(drained); }
 *          else runLoop(undefined);
 *
 *      When `#state.messages` is empty, step 4 throws and:
 *        - `agent.continue()` propagates the throw out of
 *          `interruptAndFlushQueuedMessages`.
 *        - The input controller catches it and surfaces the error string
 *          ("Error: No messages to continue from") — the visible
 *          "Error:" line in the user's first screenshot.
 *        - The steering queue is never drained, so the session's
 *          `#steeringMessages` mirror is never cleared by the
 *          message_start handler. The "Steer: hi" chip stays visible
 *          forever (the second screenshot) until the user manually
 *          dequeues with Alt+Up or starts a new session.
 *
 * Contract this test defends:
 *   - `interruptAndFlushQueuedMessages` MUST deliver a queued steer even
 *     when the agent has no prior messages in `#state.messages`.
 *   - The flush MUST NOT reject with any error.
 *   - It MUST clear both the agent queue and the session mirror in a
 *     single atomic step, so the visible chip disappears the moment the
 *     user presses Enter, not after a downstream message_start event
 *     fires.
 *   - The delivered messages must contain the original steer text.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("interrupt-and-flush must not strand a queued steer when the agent has no prior messages", () => {
	let session: AgentSession;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-flush-empty-messages-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	it("delivers a steer queued on a session whose #state.messages is empty", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const callMessages: Message[][] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn(_model, context, _options) {
				callMessages.push([...context.messages]);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ack") });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		// Reproduce the user flow: a hidden turn is already streaming, so
		// the input controller routed the user's "hi" to session.steer
		// instead of session.prompt. The session mirror and agent queue
		// are populated; #state.messages stays empty.
		await session.steer("hi");
		expect(session.agent.hasQueuedMessages()).toBe(true);
		expect(session.getQueuedMessages().steering).toEqual(["hi"]);

		// Empty-Enter → interruptAndFlushQueuedMessages. Must NOT throw.
		// Awaiting the flush is enough: it resolves only after the resumed
		// turn's prompt() has run and the assistant message has been
		// emitted. The call to callMessages.push() happens synchronously
		// inside streamFn, so by the time the flush resolves the model
		// call has been recorded.
		await expect(
			session.interruptAndFlushQueuedMessages({ reason: "Interrupted by user" }),
		).resolves.toBeUndefined();

		// The steer must be delivered as a fresh turn.
		expect(callMessages.length).toBeGreaterThanOrEqual(1);
		const delivered = callMessages[0]?.some((message: Message) => {
			if (typeof message.content === "string") return message.content.includes("hi");
			return message.content.some(c => c.type === "text" && c.text.includes("hi"));
		});
		expect(delivered).toBe(true);

		// Both queues must clear atomically — no stranded chip.
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression: a steer can land on an idle session — the submit path checks
 * `isStreaming` before `#queueSteer`'s (potentially slow) image normalization,
 * so the turn may end in between. Unlike `#queueFollowUp`, `#queueSteer` had no
 * idle drain: the message stranded in the queue (visible chip, never delivered)
 * until the next manual prompt.
 *
 * Contract: steering an idle, resumable (assistant-ended) session schedules an
 * immediate `agent.continue()`; a non-resumable state leaves the message queued
 * without starting a turn.
 */

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("AgentSession steer idle drain", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;

	async function createSession(messages: Parameters<typeof Agent.prototype.appendMessage>[0][]): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({}),
			modelRegistry: new ModelRegistry(authStorage),
		});
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-steer-idle-drain-");
		vi.useFakeTimers();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("delivers a steer queued on an idle resumable session via continue()", async () => {
		await createSession([{ role: "user", content: "hello", timestamp: Date.now() }, createAssistantMessage()]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		await session.steer("steer me please");

		// Queued and visible immediately...
		expect(session.getQueuedMessages().steering).toContain("steer me please");
		expect(session.agent.hasQueuedMessages()).toBe(true);

		// ...and drained without waiting for the next manual prompt.
		vi.advanceTimersByTime(200);
		await session.waitForIdle();
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("leaves the steer queued when the session is not resumable", async () => {
		// Last message is a user message: continue() from this state would run an
		// extra model call on the stale prompt, so the drain must not fire.
		await createSession([{ role: "user", content: "hello", timestamp: Date.now() }]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		await session.steer("wait for the run");

		vi.advanceTimersByTime(200);
		await session.waitForIdle();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(session.agent.hasQueuedMessages()).toBe(true);
		expect(session.getQueuedMessages().steering).toContain("wait for the run");
	});

	it("round-trips queued images through clearQueue for editor restoration", async () => {
		// Non-resumable state so the idle drain stays out of the way.
		await createSession([{ role: "user", content: "hello", timestamp: Date.now() }]);
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };

		await session.steer("with image", [image]);

		const { steering } = session.clearQueue();
		expect(steering).toEqual([{ text: "with image", images: [image] }]);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});
});

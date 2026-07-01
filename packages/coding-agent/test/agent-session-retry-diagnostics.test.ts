import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function transientErrorStream(model: Model<Api>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage: "socket closed",
			errorId: AIError.create(AIError.Flag.Transient),
			timestamp: Date.now(),
		};
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

function successStream(model: Model<Api>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "recovered" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	throw new Error("Timed out waiting for retry diagnostics");
}

function isRemovalMissDebugCall(call: unknown[]): boolean {
	const payload = call[1];
	return (
		call[0] === "agent active context assistant removal" &&
		typeof payload === "object" &&
		payload !== null &&
		"removed" in payload &&
		payload.removed === false
	);
}

describe("AgentSession retry diagnostics", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-retry-diagnostics-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("logs the active-context state when retry removal misses the assistant tail", async () => {
		const model = createMockModel({ provider: "openrouter", id: "glm-test" }).model;
		const calls: string[] = [];
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: requestedModel => {
				calls.push(`${requestedModel.provider}/${requestedModel.id}`);
				if (calls.length === 1) return transientErrorStream(requestedModel);
				return successStream(requestedModel);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 0,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
			"todo.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		agent.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			if (event.message.stopReason !== "error") return;
			const messages = agent.state.messages;
			const last = messages.at(-1);
			if (last?.role !== "assistant") return;
			agent.replaceMessages([...messages.slice(0, -1), { ...last, timestamp: last.timestamp + 1 }]);
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});

		const promptPromise = session.prompt("trigger transient error").catch(() => undefined);
		await waitFor(() => debugSpy.mock.calls.some(isRemovalMissDebugCall));
		await waitFor(() => debugSpy.mock.calls.some(call => call[0] === "agent.continue failed state after scheduling"));

		expect(debugSpy.mock.calls).toContainEqual([
			"agent active context assistant removal",
			expect.objectContaining({ reason: "auto-retry", removed: false, lastRole: "assistant" }),
		]);
		expect(debugSpy.mock.calls).toContainEqual([
			"agent.continue failed state after scheduling",
			expect.objectContaining({ lastRole: "assistant", messageCount: 2 }),
		]);
		await session.abort();
		await promptPromise;
	});
});

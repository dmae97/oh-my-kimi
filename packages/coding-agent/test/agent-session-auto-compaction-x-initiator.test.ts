import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const TEST_API_KEY = "test-key";

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "github-copilot",
		model: "gpt-4o",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function contextContainsMarker(context: Context, marker: string): boolean {
	return context.messages.some(message => {
		if (typeof message.content === "string") {
			return message.content.includes(marker);
		}
		return message.content.some(block => {
			if (block.type === "text") {
				return block.text.includes(marker);
			}
			if (block.type === "thinking") {
				return block.thinking.includes(marker);
			}
			return false;
		});
	});
}

function captureCompactionCalls(marker: string) {
	const capturedOptions: Array<SimpleStreamOptions | undefined> = [];
	const originalCompleteSimple = ai.completeSimple;
	vi.spyOn(ai, "completeSimple").mockImplementation(async (...args) => {
		const [model, context, options] = args;
		if (model.provider === "github-copilot" && contextContainsMarker(context, marker)) {
			capturedOptions.push(options);
			return createAssistantMessage("Compacted summary") as never;
		}
		return originalCompleteSimple(...args);
	});
	return capturedOptions;
}

describe("AgentSession compaction Copilot initiator attribution", () => {
	let tempDir: TempDir;
	const sessions: Array<{ dispose: () => Promise<void> }> = [];
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-auto-compaction-x-initiator-");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	async function createSession(taskDepth: number, marker: string) {
		const model = ai.getBundledModel("github-copilot", "gpt-4o");
		if (!model) {
			throw new Error("Expected github-copilot/gpt-4o model to exist");
		}

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `testauth-${taskDepth}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("github-copilot", TEST_API_KEY);
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({
			role: "user",
			content: `Initial request with enough text to summarize later. ${marker}`,
			timestamp: Date.now() - 3,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `Initial response with extra context for compaction. ${marker}` }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				// Keep this large so manual compaction remains eligible even if defaults are used.
				input: 120_000,
				output: 2_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 122_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "user",
			content: `Latest request before the oversized assistant turn. ${marker}`,
			timestamp: Date.now(),
		});

		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			model,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": false,
				"compaction.keepRecentTokens": 1,
				"contextPromotion.enabled": false,
			}),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			taskDepth,
		});
		sessions.push(session);
		return { model, session };
	}

	function expectNoForcedCopilotHeader(model: { headers?: Record<string, string> | undefined }) {
		expect(model.headers?.["X-Initiator"]).toBeUndefined();
	}

	function expectInitiatorOverride(
		capturedOptions: Array<SimpleStreamOptions | undefined>,
		expected: "agent" | undefined,
	) {
		expect(capturedOptions.length).toBeGreaterThan(0);
		for (const options of capturedOptions) {
			expect(options?.initiatorOverride).toBe(expected);
		}
	}

	async function triggerAutoCompaction(
		session: Pick<AgentSession, "agent" | "subscribe">,
		model: { api: string; provider: string; id: string; contextWindow: number },
		marker: string,
	) {
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "auto_compaction_end") {
				unsubscribe();
				resolve();
			}
		});

		const assistantMessage = {
			role: "assistant" as const,
			content: [
				{ type: "text" as const, text: `Oversized response that should trigger auto-compaction. ${marker}` },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop" as const,
			usage: {
				input: model.contextWindow,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: model.contextWindow,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });

		await promise;
	}

	it("keeps main-session manual compaction user-attributed", async () => {
		const marker = `main-manual-${Date.now()}`;
		const capturedOptions = captureCompactionCalls(marker);
		const { model, session } = await createSession(0, marker);

		await session.compact();

		expect(model.provider).toBe("github-copilot");
		expect(model.id).toBe("gpt-4o");
		expectNoForcedCopilotHeader(model);
		expectInitiatorOverride(capturedOptions, undefined);
	});

	it("uses agent attribution for main-session auto-compaction", async () => {
		const marker = `main-auto-${Date.now()}`;
		const capturedOptions = captureCompactionCalls(marker);
		const { model, session } = await createSession(0, marker);

		await triggerAutoCompaction(session, model, marker);

		expect(model.provider).toBe("github-copilot");
		expect(model.id).toBe("gpt-4o");
		expectNoForcedCopilotHeader(model);
		expectInitiatorOverride(capturedOptions, "agent");
	});

	it("keeps subagent manual compaction user-attributed", async () => {
		const marker = `subagent-manual-${Date.now()}`;
		const capturedOptions = captureCompactionCalls(marker);
		const { model, session } = await createSession(1, marker);

		await session.compact();

		expect(model.provider).toBe("github-copilot");
		expect(model.id).toBe("gpt-4o");
		expectNoForcedCopilotHeader(model);
		expectInitiatorOverride(capturedOptions, undefined);
	});

	it("uses agent attribution for subagent auto-compaction", async () => {
		const marker = `subagent-auto-${Date.now()}`;
		const capturedOptions = captureCompactionCalls(marker);
		const { model, session } = await createSession(1, marker);

		await triggerAutoCompaction(session, model, marker);

		expect(model.provider).toBe("github-copilot");
		expect(model.id).toBe("gpt-4o");
		expectNoForcedCopilotHeader(model);
		expectInitiatorOverride(capturedOptions, "agent");
	});
});

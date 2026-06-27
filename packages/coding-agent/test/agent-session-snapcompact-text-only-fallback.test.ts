import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession snapcompact text-only fallback", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			vi.restoreAllMocks();
		}
	});

	it("uses context-full auto-compaction when the active model cannot read snapcompact frames", async () => {
		tempDir = TempDir.createSync("@pi-snapcompact-text-only-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("aimlapi", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const activeModel = getBundledModel("aimlapi", "alibaba/qwen3-coder-480b-a35b-instruct");
		if (!activeModel) throw new Error("Expected bundled text-only model to exist");

		const agent = new Agent({
			initialState: {
				model: activeModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		const firstKeptEntryId = sessionManager.getBranch()[0]?.id;
		if (!firstKeptEntryId) throw new Error("Expected seeded branch entry");

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.strategy": "snapcompact",
				modelRoles: { vision: "aimlapi/claude-sonnet-4-5-20250929" },
			}),
			modelRegistry,
		});
		vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "compacted",
			shortSummary: undefined,
			firstKeptEntryId,
			tokensBefore: 123,
			details: {},
		});

		const end = Promise.withResolvers<{ action: string; errorMessage?: string }>();
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "compaction") notices.push(event.message);
			if (event.type === "auto_compaction_end") {
				end.resolve({ action: event.action, errorMessage: event.errorMessage });
			}
		});
		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: activeModel.api,
			provider: activeModel.provider,
			model: activeModel.id,
			stopReason: "stop" as const,
			usage: {
				input: 245000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 246000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		const result = await end.promise;
		expect(result).toEqual({ action: "context-full", errorMessage: undefined });
		expect(compactionModule.compact).toHaveBeenCalled();
		expect(notices).toContain(
			"snapcompact needs a vision-capable active model (alibaba/qwen3-coder-480b-a35b-instruct is text-only); using context-full auto-compaction instead.",
		);
		expect(sessionManager.getBranch().find(entry => entry.type === "compaction")).toMatchObject({
			type: "compaction",
			summary: "compacted",
		});
	});
});

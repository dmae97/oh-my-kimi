import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Message } from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	notices: string[];
	awaitCompactionEnd: () => Promise<{ action: string; errorMessage?: string }>;
	triggerThreshold: () => void;
}

interface HarnessOptions {
	activeModel: { provider: GeneratedProvider; id: string };
	seedMessages?: Message[];
}

async function createHarness(tempDir: TempDir, authStorage: AuthStorage, options: HarnessOptions): Promise<Harness> {
	const activeModel = getBundledModel(options.activeModel.provider, options.activeModel.id);
	if (!activeModel) throw new Error(`Missing bundled model ${options.activeModel.provider}/${options.activeModel.id}`);
	authStorage.setRuntimeApiKey(options.activeModel.provider, "test-key");

	const modelRegistry = new ModelRegistry(authStorage);
	const agent = new Agent({
		initialState: { model: activeModel, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	const seed = options.seedMessages ?? [{ role: "user", content: "hello", timestamp: Date.now() }];
	for (const message of seed) sessionManager.appendMessage(message);
	const firstKeptEntryId = sessionManager.getBranch()[0]?.id;
	if (!firstKeptEntryId) throw new Error("Expected seeded branch entry");

	const session = new AgentSession({
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

	const triggerThreshold = () => {
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
	};

	return { session, sessionManager, notices, awaitCompactionEnd: () => end.promise, triggerThreshold };
}

describe("AgentSession auto-snapcompact local-blocker fallback", () => {
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
			session = undefined;
			authStorage = undefined;
			tempDir = undefined;
		}
	});

	it("downgrades to context-full when the active model cannot read snapcompact frames", async () => {
		tempDir = TempDir.createSync("@pi-snapcompact-text-only-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const harness = await createHarness(tempDir, authStorage, {
			activeModel: { provider: "aimlapi", id: "alibaba/qwen3-coder-480b-a35b-instruct" },
		});
		session = harness.session;
		harness.triggerThreshold();

		const result = await harness.awaitCompactionEnd();
		expect(result).toEqual({ action: "context-full", errorMessage: undefined });
		expect(compactionModule.compact).toHaveBeenCalled();
		expect(harness.notices).toContain(
			"snapcompact needs a vision-capable active model (alibaba/qwen3-coder-480b-a35b-instruct is text-only); using context-full auto-compaction instead.",
		);
		expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toMatchObject({
			type: "compaction",
			summary: "compacted",
		});
	});

	it("downgrades to context-full when the transcript is too non-ASCII for snapcompact to render", async () => {
		tempDir = TempDir.createSync("@pi-snapcompact-non-ascii-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const harness = await createHarness(tempDir, authStorage, {
			activeModel: { provider: "aimlapi", id: "claude-sonnet-4-5-20250929" },
			seedMessages: [
				{
					role: "user",
					content: "你好,请帮我审查这段代码。它的逻辑似乎有问题,我无法理解为何返回空结果。",
					timestamp: Date.now(),
				},
			],
		});
		session = harness.session;
		harness.triggerThreshold();

		const result = await harness.awaitCompactionEnd();
		expect(result.action).toBe("context-full");
		expect(result.errorMessage).toBeUndefined();
		expect(compactionModule.compact).toHaveBeenCalled();
		const cjkNotice = harness.notices.find(message =>
			message.startsWith("snapcompact disabled: high non-ASCII rate detected"),
		);
		expect(cjkNotice).toBeDefined();
		expect(cjkNotice).toContain("using context-full auto-compaction instead.");
		expect(harness.sessionManager.getBranch().find(entry => entry.type === "compaction")).toMatchObject({
			type: "compaction",
			summary: "compacted",
		});
	});
});

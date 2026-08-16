/**
 * Unit tests for vision-route compaction behavior.
 *
 * When a text-only session model (e.g. deepseek-v4-flash) serves a turn whose
 * transcript carries image blocks, the agent loop auto-routes the request to
 * the vision model (openai-codex/gpt-5.6-luna, 400K window). Two failures used
 * to follow:
 *
 * 1. Threshold compaction was computed against the session model's window
 *    (deepseek 1M -> ~700K), so the vision request overflowed (400K) before
 *    compaction could fire.
 * 2. A context_overflow error surfaced from the auto-routed vision model was
 *    ignored by `_checkCompaction` because the message model differs from the
 *    session model, so the raw error reached the user instead of compacting.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "omk-agent-core";
import { getModel } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createCodingTools } from "../src/index.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("AgentSession vision-route compaction", () => {
	let session: AgentSession;
	let tempDir: string;
	let sessionManager: SessionManager;
	let settingsManager: SettingsManager;

	const deepseekModel = getModel("deepseek", "deepseek-v4-flash")!;
	expect(deepseekModel.input).not.toContain("image"); // text-only session model

	function textMessage(text: string) {
		return { type: "text" as const, text };
	}
	function imageMessage() {
		return { type: "image" as const, mimeType: "image/png" as const, data: "AAAA" };
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-vision-compaction-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) session.dispose();
		if (tempDir) rmSync(tempDir, { recursive: true });
	});

	function createSession() {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: deepseekModel,
				systemPrompt: "You are a helpful assistant. Be concise.",
				tools: createCodingTools(process.cwd()),
			},
		});
		sessionManager = SessionManager.inMemory();
		settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({
			compaction: { enabled: true, reserveTokens: 1024, maxUsageRatio: 0.7 },
		});
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage);
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		return session;
	}

	it("uses the vision-route window for image-bearing turns", async () => {
		createSession();
		// @ts-expect-error private method under test
		const effective = session._effectiveTurnContextWindow([{ role: "user", content: [imageMessage()] }], 1_000_000);
		expect(effective).toBe(400_000); // gpt-5.6-luna window, not deepseek 1M
	});

	it("keeps the session-model window for text-only turns", async () => {
		createSession();
		// @ts-expect-error private method under test
		const effective = session._effectiveTurnContextWindow(
			[{ role: "user", content: [textMessage("hi")], timestamp: Date.now() }],
			1_000_000,
		);
		expect(effective).toBe(1_000_000);
	});

	it("keeps the session-model window when the model can see images itself", async () => {
		createSession();
		session.agent.state.model = getModel("anthropic", "claude-sonnet-5");
		// @ts-expect-error private method under test
		const effective = session._effectiveTurnContextWindow([{ role: "user", content: [imageMessage()] }], 1_000_000);
		expect(effective).toBe(1_000_000);
	});

	it("does not treat a vision-route overflow as a foreign-model overflow", async () => {
		createSession();
		// @ts-expect-error private method under test
		session._overflowRecoveryAttempts = 0;
		// @ts-expect-error private method under test
		const overflowMessage = session._checkCompaction({
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			stopReason: "error",
			errorMessage:
				"Codex error: Your input exceeds the context window of this model. Please adjust your input and try again. (context_length_exceeded)",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			timestamp: Date.now(),
			content: [],
		} as never);
		// Compaction path (not `false` from the same-model guard) — overflow is
		// recognized as session-owned and recovery proceeds.
		await expect(overflowMessage).resolves.not.toBeNull();
		// @ts-expect-error private method under test
		expect(session._overflowRecoveryAttempts).toBe(1);
	});
});

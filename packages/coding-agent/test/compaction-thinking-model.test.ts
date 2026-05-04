/**
 * Test for compaction with thinking models.
 *
 * Tests both:
 * - Claude via Antigravity (google-gemini-cli API)
 * - Claude via real Anthropic API (anthropic-messages API)
 *
 * Reproduces issue where compact fails when maxTokens < thinkingBudget.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, getBundledModel, type Model, type Effort as ThinkingLevelType } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "./utilities";

// Check for auth
const HAS_ANTIGRAVITY_AUTH = false; // OAuth not available in test environment
const HAS_ANTHROPIC_AUTH = !!e2eApiKey("ANTHROPIC_API_KEY");

describe.skipIf(!HAS_ANTIGRAVITY_AUTH)("Compaction with thinking models (Antigravity)", () => {
	let session: AgentSession;
	let tempDir: string;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-thinking-compaction-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(
		modelId: "claude-opus-4-5-thinking" | "claude-sonnet-4-5",
		thinkingLevel: ThinkingLevelType = Effort.High,
	) {
		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tools = await createTools(toolSession);

		const model = getBundledModel("google-antigravity", modelId);
		if (!model) {
			throw new Error(`Model not found: google-antigravity/${modelId}`);
		}

		const agent = new Agent({
			getApiKey: () => e2eApiKey("ANTHROPIC_API_KEY"),
			initialState: {
				model,
				systemPrompt: ["You are a helpful assistant. Be concise."],
				tools,
				thinkingLevel,
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		session.subscribe(() => {});

		return session;
	}

	it("should compact successfully with claude-opus-4-5-thinking and thinking level high", async () => {
		await createSession("claude-opus-4-5-thinking", Effort.High);

		// Send a simple prompt
		await session.prompt("Write down the first 10 prime numbers.");
		await session.agent.waitForIdle();

		// Verify we got a response
		const messages = session.messages;
		expect(messages.length).toBeGreaterThan(0);

		const assistantMessages = messages.filter(m => m.role === "assistant");
		expect(assistantMessages.length).toBeGreaterThan(0);

		// Now try to compact - this should not throw
		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.tokensBefore).toBeGreaterThan(0);

		// Verify session is still usable after compaction
		const messagesAfterCompact = session.messages;
		expect(messagesAfterCompact.length).toBeGreaterThan(0);
		expect(messagesAfterCompact[0].role).toBe("compactionSummary");
	}, 180000);

	it("should compact successfully with claude-sonnet-4-5 (non-thinking) for comparison", async () => {
		await createSession("claude-sonnet-4-5");

		await session.prompt("Write down the first 10 prime numbers.");
		await session.agent.waitForIdle();

		const messages = session.messages;
		expect(messages.length).toBeGreaterThan(0);

		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);
	}, 180000);
});

// ============================================================================
// Real Anthropic API tests (for comparison)
// ============================================================================

describe.skipIf(!HAS_ANTHROPIC_AUTH)("Compaction with thinking models (Anthropic)", () => {
	let session: AgentSession;
	let tempDir: string;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-thinking-compaction-anthropic-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(model: Model, thinkingLevel: ThinkingLevelType = Effort.High) {
		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tools = await createTools(toolSession);

		const agent = new Agent({
			getApiKey: () => e2eApiKey("ANTHROPIC_API_KEY"),
			initialState: {
				model,
				systemPrompt: ["You are a helpful assistant. Be concise."],
				tools,
				thinkingLevel,
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		session.subscribe(() => {});

		return session;
	}

	it("should compact successfully with claude-3-7-sonnet and thinking level high", async () => {
		const model = getBundledModel("anthropic", "claude-3-7-sonnet-latest")!;
		await createSession(model, Effort.High);

		// Send a simple prompt
		await session.prompt("Write down the first 10 prime numbers.");
		await session.agent.waitForIdle();

		// Verify we got a response
		const messages = session.messages;
		expect(messages.length).toBeGreaterThan(0);

		const assistantMessages = messages.filter(m => m.role === "assistant");
		expect(assistantMessages.length).toBeGreaterThan(0);

		// Now try to compact - this should not throw
		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.tokensBefore).toBeGreaterThan(0);

		// Verify session is still usable after compaction
		const messagesAfterCompact = session.messages;
		expect(messagesAfterCompact.length).toBeGreaterThan(0);
		expect(messagesAfterCompact[0].role).toBe("compactionSummary");
	}, 180000);
});

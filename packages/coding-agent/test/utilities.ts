/**
 * Shared test utilities for coding-agent tests.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "../../ai/test/oauth";

export { e2eApiKey };

/**
 * Create a minimal user message for testing.
 */
export function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

/**
 * Create a minimal assistant message for testing.
 */
export function assistantMsg(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/**
 * Options for creating a test session.
 */
export interface TestSessionOptions {
	/** Use in-memory session (no file persistence) */
	inMemory?: boolean;
	/** Custom system prompt */
	systemPrompt?: string | string[];
	/** Custom settings overrides */
	settingsOverrides?: Record<string, unknown>;
}

/**
 * Resources returned by createTestSession that need cleanup.
 */
export interface TestSessionContext {
	session: AgentSession;
	sessionManager: SessionManager;
	tempDir: string;
	cleanup: () => Promise<void>;
}

/**
 * Create an AgentSession for testing with proper setup and cleanup.
 * Use this for e2e tests that need real LLM calls.
 */
export async function createTestSession(options: TestSessionOptions = {}): Promise<TestSessionContext> {
	const tempDir = path.join(os.tmpdir(), `omp-test-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });

	const toolSession: ToolSession = {
		cwd: tempDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(options.settingsOverrides),
	};
	const tools = await createTools(toolSession);

	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		getApiKey: () => e2eApiKey("ANTHROPIC_API_KEY"),
		initialState: {
			model,
			systemPrompt: Array.isArray(options.systemPrompt)
				? options.systemPrompt
				: [options.systemPrompt ?? "You are a helpful assistant. Be extremely concise."],
			tools,
		},
	});

	const sessionManager = options.inMemory ? SessionManager.inMemory() : SessionManager.create(tempDir, tempDir);
	const settings = Settings.isolated(options.settingsOverrides);

	const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
	});

	// Must subscribe to enable session persistence
	session.subscribe(() => {});

	const cleanup = async () => {
		await session.dispose();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	};

	return { session, sessionManager, tempDir, cleanup };
}

/**
 * Build a session tree for testing using SessionManager.
 * Returns the IDs of all created entries.
 *
 * Example tree structure:
 * ```
 * u1 -> a1 -> u2 -> a2
 *          -> u3 -> a3  (branch from a1)
 * u4 -> a4              (another root)
 * ```
 */
export function buildTestTree(
	session: SessionManager,
	structure: {
		messages: Array<{ role: "user" | "assistant"; text: string; branchFrom?: string }>;
	},
): Map<string, string> {
	const ids = new Map<string, string>();

	for (const msg of structure.messages) {
		if (msg.branchFrom) {
			const branchFromId = ids.get(msg.branchFrom);
			if (!branchFromId) {
				throw new Error(`Cannot branch from unknown entry: ${msg.branchFrom}`);
			}
			session.branch(branchFromId);
		}

		const id =
			msg.role === "user" ? session.appendMessage(userMsg(msg.text)) : session.appendMessage(assistantMsg(msg.text));

		ids.set(msg.text, id);
	}

	return ids;
}

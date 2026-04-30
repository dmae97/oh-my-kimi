import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TodoWriteTool } from "@oh-my-pi/pi-coding-agent/tools";
import { Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Regression test: /new (AgentSession.newSession) must fully switch to a new session file
 * before the call resolves.
 *
 * If it doesn't, UI code that reloads todos immediately after /new will read the old
 * session artifact dir and keep showing stale todos.
 */
describe("AgentSession newSession clears todo artifacts", () => {
	let tempDir: string;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-new-session-todos-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		sessionManager = SessionManager.create(tempDir, tempDir);
		const settings = Settings.isolated();
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Test model not found in registry");
		}

		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
		};

		const agent = new Agent({
			getApiKey: () => "test",
			initialState: {
				model,
				systemPrompt: "test",
				tools: [new TodoWriteTool(toolSession)],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		// Must subscribe to enable session persistence hooks
		session.subscribe(() => {});
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

	it("should not carry over todo state to the new session branch", async () => {
		const oldSessionFile = session.sessionFile;
		expect(oldSessionFile).toBeDefined();

		session.setTodoPhases([
			{
				name: "Tasks",
				tasks: [{ content: "do the thing", status: "pending" }],
			},
		]);
		expect(session.getTodoPhases()).toHaveLength(1);
		expect(session.getTodoPhases()[0]?.tasks).toHaveLength(1);
		await session.newSession();

		const newSessionFile = session.sessionFile;
		expect(newSessionFile).toBeDefined();
		expect(newSessionFile).not.toBe(oldSessionFile);

		expect(session.getTodoPhases()).toHaveLength(0);
	});

	it("should clear stale todo cache when branching from the first user message", async () => {
		sessionManager.appendMessage({
			role: "user",
			content: "start task",
			timestamp: Date.now(),
		});

		const branchCandidates = session.getUserMessagesForBranching();
		expect(branchCandidates).toHaveLength(1);

		session.setTodoPhases([
			{
				name: "Execution",
				tasks: [{ content: "stale from old branch", status: "in_progress" }],
			},
		]);
		expect(session.getTodoPhases()).toHaveLength(1);

		const result = await session.branch(branchCandidates[0].entryId);
		expect(result.cancelled).toBe(false);
		expect(result.selectedText).toBe("start task");
		expect(session.getTodoPhases()).toHaveLength(0);
	});
});

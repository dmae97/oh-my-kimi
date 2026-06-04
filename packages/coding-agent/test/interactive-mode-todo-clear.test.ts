import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import type { TodoPhase } from "../src/tools/todo";

function renderTodos(mode: InteractiveMode): string {
	return Bun.stripANSI(mode.todoContainer.render(120).join("\n"));
}

describe("InteractiveMode todo auto-clear", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-todo-clear-");
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	async function createMode(todoClearDelay: number): Promise<void> {
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "tasks.todoClearDelay": todoClearDelay },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "tasks.todoClearDelay": todoClearDelay }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	}

	it("clears closed todos from the panel instantly without mutating session history", async () => {
		await createMode(0);
		const phases: TodoPhase[] = [
			{
				name: "Implementation",
				tasks: [
					{ content: "done task", status: "completed" },
					{ content: "abandoned task", status: "abandoned" },
				],
			},
		];
		session.setTodoPhases(phases);

		mode.setTodos(session.getTodoPhases());

		expect(renderTodos(mode)).not.toContain("done task");
		expect(renderTodos(mode)).not.toContain("abandoned task");
		expect(session.getTodoPhases()).toEqual(phases);
	});

	it("leaves closed todos visible when auto-clear is disabled", async () => {
		await createMode(-1);

		mode.setTodos([{ name: "Implementation", tasks: [{ content: "done task", status: "completed" }] }]);

		expect(renderTodos(mode)).toContain("done task");
	});

	it("clears closed todos after the configured delay", async () => {
		await createMode(1);
		vi.useFakeTimers();

		mode.setTodos([{ name: "Implementation", tasks: [{ content: "done task", status: "completed" }] }]);
		expect(renderTodos(mode)).toContain("done task");

		vi.advanceTimersByTime(999);
		expect(renderTodos(mode)).toContain("done task");

		vi.advanceTimersByTime(1);
		expect(renderTodos(mode)).not.toContain("done task");
	});
});

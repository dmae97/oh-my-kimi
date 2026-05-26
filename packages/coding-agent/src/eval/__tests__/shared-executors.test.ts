import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import type { LoadExtensionsResult } from "../../extensibility/extensions/types";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../../sdk";
import * as sdkModule from "../../sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../session/agent-session";
import { TaskTool } from "../../task";
import * as discoveryModule from "../../task/discovery";
import type { AgentDefinition, TaskParams } from "../../task/types";
import type { ToolSession } from "../../tools";
import { EventBus } from "../../utils/event-bus";
import { disposeAllVmContexts } from "../js/context-manager";
import { executeJs } from "../js/executor";
import { disposeAllKernelSessions, executePython } from "../py/executor";

function createToolSession(cwd: string, sessionFile: string | null, evalSessionId?: string): ToolSession {
	const modelRegistry = {
		authStorage: undefined,
		refresh: async () => {},
		getAvailable: () => [],
		getApiKey: async () => null,
	} as unknown as ModelRegistry;
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
		}),
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getEvalSessionId: evalSessionId ? () => evalSessionId : undefined,
		modelRegistry,
	} as unknown as ToolSession;
}

function assistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
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

function createYieldingSubagentSession(onPrompt: () => Promise<void>): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	return {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["eval", "yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			await onPrompt();
			state.messages.push(assistantStopMessage("done"));
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-call",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

const taskAgent: AgentDefinition = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Read eval state and yield.",
	source: "bundled",
	tools: ["eval", "yield"],
};

const taskParams: TaskParams = {
	agent: "task",
	tasks: [{ id: "ReadEval", description: "Read eval state", assignment: "Read parent eval state." }],
};

describe("shared eval executors", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await disposeAllVmContexts();
		await disposeAllKernelSessions();
	});

	it("shares JavaScript state across executeJs calls with one session id", async () => {
		using tempDir = TempDir.createSync("@omp-eval-js-shared-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-shared:${crypto.randomUUID()}`;
		const session = createToolSession(tempDir.path(), sessionFile);

		await executeJs("globalThis.x = 41;", { sessionId, session, sessionFile });
		const result = await executeJs("return globalThis.x + 1;", { sessionId, session, sessionFile });

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("42");
	});

	it("shares Python state across executePython calls with one session id", async () => {
		using tempDir = TempDir.createSync("@omp-eval-py-shared-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `py-shared:${crypto.randomUUID()}`;

		await executePython("x = 41", { cwd: tempDir.path(), sessionId, sessionFile });
		const result = await executePython("print(x + 1)", { cwd: tempDir.path(), sessionId, sessionFile });

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("42");
	});

	it("updates Python cwd when one shared session id runs from multiple directories", async () => {
		using tempDir = TempDir.createSync("@omp-eval-py-cwd-");
		const dirA = path.join(tempDir.path(), "a");
		const dirB = path.join(tempDir.path(), "b");
		await fs.mkdir(dirA);
		await fs.mkdir(dirB);
		const realDirA = await fs.realpath(dirA);
		const realDirB = await fs.realpath(dirB);
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `py-cwd:${crypto.randomUUID()}`;

		const first = await executePython("import os\nprint(os.getcwd())", { cwd: dirA, sessionId, sessionFile });
		const second = await executePython("import os\nprint(os.getcwd())", { cwd: dirB, sessionId, sessionFile });

		expect(first.exitCode).toBe(0);
		expect(first.output.trim()).toBe(realDirA);
		expect(second.exitCode).toBe(0);
		expect(second.output.trim()).toBe(realDirB);
	});

	it("interrupts timed out synchronous Python cells before they mutate shared state", async () => {
		using tempDir = TempDir.createSync("@omp-eval-py-sync-timeout-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `py-sync-timeout:${crypto.randomUUID()}`;

		const timedOut = await executePython("import time\ntime.sleep(0.2)\nleaked_after_timeout = True", {
			cwd: tempDir.path(),
			sessionId,
			sessionFile,
			timeoutMs: 20,
		});
		await Bun.sleep(250);
		const probe = await executePython('print("leaked_after_timeout" in globals())', {
			cwd: tempDir.path(),
			sessionId,
			sessionFile,
		});

		expect(timedOut.cancelled).toBe(true);
		expect(probe.exitCode).toBe(0);
		expect(probe.output.trim()).toBe("False");
	});

	it("settles Python cells that raise SystemExit", async () => {
		using tempDir = TempDir.createSync("@omp-eval-py-system-exit-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `py-system-exit:${crypto.randomUUID()}`;

		const result = await executePython('raise SystemExit("bye")', {
			cwd: tempDir.path(),
			sessionId,
			sessionFile,
			timeoutMs: 500,
		});

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("SystemExit");
		expect(result.output).toContain("bye");
	});

	it("lets a subagent inherit parent JavaScript and Python eval state", async () => {
		using tempDir = TempDir.createSync("@omp-eval-subagent-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const evalSessionId = `session:${sessionFile}:cwd:${tempDir.path()}`;
		const parentSession = createToolSession(tempDir.path(), sessionFile, evalSessionId);
		let seenJs = "";
		let seenPy = "";
		let capturedOptions: CreateAgentSessionOptions | undefined;

		await executeJs('globalThis.parentSecret = "hello-js";', {
			sessionId: `js:${evalSessionId}`,
			session: parentSession,
			sessionFile,
		});
		await executePython('parent_secret = "hello-py"', {
			cwd: tempDir.path(),
			sessionId: `python:${evalSessionId}`,
			sessionFile,
		});

		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			capturedOptions = options;
			const inherited = options.parentEvalSessionId;
			if (!inherited) throw new Error("Missing parent eval session id");
			return {
				session: createYieldingSubagentSession(async () => {
					const jsResult = await executeJs("return globalThis.parentSecret;", {
						sessionId: `js:${inherited}`,
						session: parentSession,
						sessionFile,
					});
					const pyResult = await executePython("print(parent_secret)", {
						cwd: tempDir.path(),
						sessionId: `python:${inherited}`,
						sessionFile,
					});
					seenJs = jsResult.output.trim();
					seenPy = pyResult.output.trim();
				}),
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} satisfies CreateAgentSessionResult;
		});

		const tool = await TaskTool.create(parentSession);
		await tool.execute("tool-call", taskParams);

		expect(capturedOptions?.parentEvalSessionId).toBe(evalSessionId);
		expect(seenJs).toBe("hello-js");
		expect(seenPy).toBe("hello-py");
	});

	it("interleaves async JavaScript runs on one session id", async () => {
		using tempDir = TempDir.createSync("@omp-eval-js-interleave-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-interleave:${crypto.randomUUID()}`;
		const session = createToolSession(tempDir.path(), sessionFile);
		const events: string[] = [];

		const first = executeJs('await Bun.sleep(80); display("A");', {
			sessionId,
			session,
			sessionFile,
			onChunk: chunk => {
				events.push(chunk.trim());
			},
		});
		await Bun.sleep(10);
		const second = executeJs('display("B");', {
			sessionId,
			session,
			sessionFile,
			onChunk: chunk => {
				events.push(chunk.trim());
			},
		});

		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.exitCode).toBe(0);
		expect(secondResult.exitCode).toBe(0);
		expect(events.filter(Boolean)).toEqual(["B", "A"]);
	});

	it("interleaves async Python runs on one session id", async () => {
		using tempDir = TempDir.createSync("@omp-eval-py-interleave-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `py-interleave:${crypto.randomUUID()}`;
		const events: string[] = [];

		const first = executePython('import asyncio\nawait asyncio.sleep(0.08)\nprint("A")', {
			cwd: tempDir.path(),
			sessionId,
			sessionFile,
			onChunk: chunk => {
				events.push(chunk.trim());
			},
		});
		await Bun.sleep(10);
		const second = executePython('print("B")', {
			cwd: tempDir.path(),
			sessionId,
			sessionFile,
			onChunk: chunk => {
				events.push(chunk.trim());
			},
		});

		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.exitCode).toBe(0);
		expect(secondResult.exitCode).toBe(0);
		expect(events.filter(Boolean)).toEqual(["B", "A"]);
	});

	it("preserves module-level singleton state across re-imports of an unchanged file", async () => {
		using tempDir = TempDir.createSync("@omp-eval-js-mtime-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-mtime:${crypto.randomUUID()}`;
		const session = createToolSession(tempDir.path(), sessionFile);
		const modulePath = path.join(tempDir.path(), "singleton.ts");
		const moduleSpec = JSON.stringify(modulePath);
		await Bun.write(
			modulePath,
			"let value = 0;\nexport function set(v) { value = v; }\nexport function get() { return value; }\n",
		);

		const initResult = await executeJs(`const mod = await import(${moduleSpec}); mod.set(42); return mod.get();`, {
			sessionId,
			session,
			sessionFile,
		});
		expect(initResult.exitCode).toBe(0);
		expect(initResult.output.trim()).toBe("42");

		// Unchanged file: re-import must reuse the existing module namespace so the
		// counter is still 42. This is the regression — the previous unconditional
		// `delete require.cache[target]` reset singletons on every dynamic import.
		const reuseResult = await executeJs(`const mod = await import(${moduleSpec}); return mod.get();`, {
			sessionId,
			session,
			sessionFile,
		});
		expect(reuseResult.exitCode).toBe(0);
		expect(reuseResult.output.trim()).toBe("42");

		// Bump mtime by 5s to simulate an edit; the next import must evict the cache
		// and re-evaluate the file, dropping the counter back to its initializer.
		const future = new Date(Date.now() + 5_000);
		await fs.utimes(modulePath, future, future);

		const reloadResult = await executeJs(`const mod = await import(${moduleSpec}); return mod.get();`, {
			sessionId,
			session,
			sessionFile,
		});
		expect(reloadResult.exitCode).toBe(0);
		expect(reloadResult.output.trim()).toBe("0");
	});
});

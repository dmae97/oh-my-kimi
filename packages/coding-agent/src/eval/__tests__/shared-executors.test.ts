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

function createBridgeToolSession(resultText: string, calls: unknown[]): ToolSession {
	const readTool = {
		name: "read",
		label: "read",
		description: "read",
		parameters: { type: "object" },
		async execute(_id: string, args: unknown) {
			calls.push(args);
			return { content: [{ type: "text" as const, text: resultText }] };
		},
	};
	const tools = new Map<string, unknown>([["read", readTool]]);
	return { getToolByName: (name: string) => tools.get(name) } as unknown as ToolSession;
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

	it("treats idleTimeoutMs as an inactivity budget, not a fixed timer", async () => {
		using tempDir = TempDir.createSync("@omp-eval-js-idle-budget-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-idle-budget:${crypto.randomUUID()}`;
		const session = createToolSession(tempDir.path(), sessionFile);

		// With no wall-clock deadlineMs/timeoutMs and no aborting signal, a cell that
		// runs well past idleTimeoutMs must still complete: the backend must never
		// derive a competing fixed timer from the inactivity budget.
		const result = await executeJs("await Bun.sleep(120); return 'done';", {
			sessionId,
			session,
			sessionFile,
			idleTimeoutMs: 30,
		});

		expect(result.cancelled).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("done");
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

	it("deduplicates concurrent first JavaScript session acquisition", async () => {
		using tempDir = TempDir.createSync("@omp-eval-js-cold-start-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-cold-start:${crypto.randomUUID()}`;
		const session = createToolSession(tempDir.path(), sessionFile);

		const [first, second] = await Promise.all([
			executeJs(
				"globalThis.sharedMarker ??= crypto.randomUUID(); await Bun.sleep(50); return globalThis.sharedMarker;",
				{
					sessionId,
					session,
					sessionFile,
				},
			),
			executeJs("globalThis.sharedMarker ??= crypto.randomUUID(); return globalThis.sharedMarker;", {
				sessionId,
				session,
				sessionFile,
			}),
		]);
		const third = await executeJs("return globalThis.sharedMarker;", { sessionId, session, sessionFile });

		expect(first.exitCode).toBe(0);
		expect(second.exitCode).toBe(0);
		expect(third.exitCode).toBe(0);
		expect(first.output.trim()).toBe(second.output.trim());
		expect(third.output.trim()).toBe(first.output.trim());
	});

	it("deduplicates concurrent first Python session acquisition", async () => {
		using tempDir = TempDir.createSync("@omp-eval-py-cold-start-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `py-cold-start:${crypto.randomUUID()}`;

		const [first, second] = await Promise.all([
			executePython(
				`import asyncio, uuid
shared_marker = globals().get("shared_marker") or str(uuid.uuid4())
globals()["shared_marker"] = shared_marker
await asyncio.sleep(0.05)
print(shared_marker)`,
				{ cwd: tempDir.path(), sessionId, sessionFile },
			),
			executePython(
				`import uuid
shared_marker = globals().get("shared_marker") or str(uuid.uuid4())
globals()["shared_marker"] = shared_marker
print(shared_marker)`,
				{ cwd: tempDir.path(), sessionId, sessionFile },
			),
		]);
		const third = await executePython("print(shared_marker)", { cwd: tempDir.path(), sessionId, sessionFile });

		expect(first.exitCode).toBe(0);
		expect(second.exitCode).toBe(0);
		expect(third.exitCode).toBe(0);
		expect(first.output.trim()).toBe(second.output.trim());
		expect(third.output.trim()).toBe(first.output.trim());
	});

	it("splits retained Python kernels by cwd for one shared session id", async () => {
		using tempDir = TempDir.createSync("@omp-eval-py-cwd-");
		const dirA = path.join(tempDir.path(), "a");
		const dirB = path.join(tempDir.path(), "b");
		await fs.mkdir(dirA);
		await fs.mkdir(dirB);
		const realDirA = await fs.realpath(dirA);
		const realDirB = await fs.realpath(dirB);
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `py-cwd:${crypto.randomUUID()}`;

		const first = await executePython(
			`import os
token = "from-a"
print(os.getcwd())`,
			{
				cwd: dirA,
				sessionId,
				sessionFile,
			},
		);
		const second = await executePython(
			`import os
print(os.getcwd())
print("token" in globals())`,
			{
				cwd: dirB,
				sessionId,
				sessionFile,
			},
		);
		const third = await executePython("print(token)", { cwd: dirA, sessionId, sessionFile });

		expect(first.exitCode).toBe(0);
		expect(first.output.trim()).toBe(realDirA);
		expect(second.exitCode).toBe(0);
		expect(second.output.trim().split("\n")).toEqual([realDirB, "False"]);
		expect(third.exitCode).toBe(0);
		expect(third.output.trim()).toBe("from-a");
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

	it("routes interleaved JavaScript display output to the matching run", async () => {
		using tempDir = TempDir.createSync("@omp-eval-js-interleave-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-interleave:${crypto.randomUUID()}`;
		const session = createToolSession(tempDir.path(), sessionFile);

		const first = executeJs('await Bun.sleep(80); display({ label: "A" });', {
			sessionId,
			session,
			sessionFile,
		});
		await Bun.sleep(10);
		const second = executeJs('display({ label: "B" });', {
			sessionId,
			session,
			sessionFile,
		});

		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.exitCode).toBe(0);
		expect(secondResult.exitCode).toBe(0);
		expect(firstResult.displayOutputs).toEqual([{ type: "json", data: { label: "A" } }]);
		expect(secondResult.displayOutputs).toEqual([{ type: "json", data: { label: "B" } }]);
	});

	it("routes interleaved Python display output to the matching run", async () => {
		using tempDir = TempDir.createSync("@omp-eval-py-interleave-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `py-interleave:${crypto.randomUUID()}`;

		const first = executePython(
			`import asyncio
await asyncio.sleep(0.08)
display({"label": "A"})`,
			{
				cwd: tempDir.path(),
				sessionId,
				sessionFile,
			},
		);
		await Bun.sleep(10);
		const second = executePython('display({"label": "B"})', {
			cwd: tempDir.path(),
			sessionId,
			sessionFile,
		});

		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.exitCode).toBe(0);
		expect(secondResult.exitCode).toBe(0);
		expect(firstResult.displayOutputs).toEqual([{ type: "json", data: { label: "A" } }]);
		expect(secondResult.displayOutputs).toEqual([{ type: "json", data: { label: "B" } }]);
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

	it("reloads a local re-export when a transitive dependency changes", async () => {
		using tempDir = TempDir.createSync("@omp-eval-js-transitive-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-transitive:${crypto.randomUUID()}`;
		const session = createToolSession(tempDir.path(), sessionFile);
		const leafPath = path.join(tempDir.path(), "leaf.ts");
		const entryPath = path.join(tempDir.path(), "entry.ts");
		const entrySpec = JSON.stringify(entryPath);
		await Bun.write(leafPath, "export const value = 1;\n");
		await Bun.write(entryPath, 'export { value } from "./leaf.ts";\n');

		const initial = await executeJs(`const mod = await import(${entrySpec}); return mod.value;`, {
			sessionId,
			session,
			sessionFile,
		});
		expect(initial.exitCode).toBe(0);
		expect(initial.output.trim()).toBe("1");

		await Bun.write(leafPath, "export const value = 2;\n");
		const future = new Date(Date.now() + 5_000);
		await fs.utimes(leafPath, future, future);

		const reloaded = await executeJs(`const mod = await import(${entrySpec}); return mod.value;`, {
			sessionId,
			session,
			sessionFile,
		});
		expect(reloaded.exitCode).toBe(0);
		expect(reloaded.output.trim()).toBe("2");
	});

	it("links a cyclic local module graph without crashing", async () => {
		// Regression: the loader used to link()+evaluate() each local module individually
		// inside the recursive linker callback. On any import cycle that re-entered Bun's
		// node:vm linker mid-instantiation and segfaulted the process (SIGTRAP,
		// getImportedModule on a null record) — e.g. `await import("…/edit/streaming.ts")`,
		// whose relative-import subtree is cyclic. The graph must now link in a single pass.
		using tempDir = TempDir.createSync("@omp-eval-js-cycle-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-cycle:${crypto.randomUUID()}`;
		const session = createToolSession(tempDir.path(), sessionFile);
		const alphaPath = path.join(tempDir.path(), "alpha.ts");
		const betaPath = path.join(tempDir.path(), "beta.ts");
		const alphaSpec = JSON.stringify(alphaPath);
		const betaSpec = JSON.stringify(betaPath);
		await Bun.write(
			alphaPath,
			'import { betaName } from "./beta.ts";\nexport const alphaName = "alpha";\nexport function combined() { return alphaName + ":" + betaName; }\n',
		);
		await Bun.write(
			betaPath,
			'import { alphaName } from "./alpha.ts";\nexport const betaName = "beta";\nexport function viaAlpha() { return alphaName; }\n',
		);

		const result = await executeJs(
			`const a = await import(${alphaSpec});\nconst b = await import(${betaSpec});\nreturn [a.combined(), b.viaAlpha()].join("|");`,
			{ sessionId, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("alpha:beta|alpha");
	});

	it("loads TypeScript type-only imports in cells and local modules", async () => {
		using tempDir = TempDir.createSync("@omp-eval-js-type-imports-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-type-imports:${crypto.randomUUID()}`;
		const session = createToolSession(tempDir.path(), sessionFile);
		const typesPath = path.join(tempDir.path(), "types.ts");
		const valuesPath = path.join(tempDir.path(), "values.ts");
		const entryPath = path.join(tempDir.path(), "entry.ts");
		const typesSpec = JSON.stringify(typesPath);
		const entrySpec = JSON.stringify(entryPath);
		await Bun.write(typesPath, "export interface TypeOnly { value: number }\n");
		await Bun.write(valuesPath, "export interface InlineOnly { value: number }\nexport const imported = 41;\n");
		await Bun.write(
			entryPath,
			[
				'import type { TypeOnly } from "./types.ts";',
				'import { type InlineOnly, imported } from "./values.ts";',
				"export const typeOnly = 1;",
				"export const inlineType = imported;",
				"",
			].join("\n"),
		);

		const result = await executeJs(
			`import type { TypeOnly } from ${typesSpec};\nconst mod = await import(${entrySpec});\nreturn mod.typeOnly + mod.inlineType;`,
			{
				sessionId,
				session,
				sessionFile,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("42");
	});

	it("refreshes the Python tool proxy when bridge env appears after kernel warm-up", async () => {
		using tempDir = TempDir.createSync("@omp-eval-py-tool-proxy-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `py-tool-proxy:${crypto.randomUUID()}`;
		const bridgeCalls: unknown[] = [];
		const bridgeSession = createBridgeToolSession("bridge-ok", bridgeCalls);

		const withoutBridge = await executePython(
			'try:\n    print(tool.read({"path": "foo.txt"}))\nexcept Exception as exc:\n    print(type(exc).__name__)\n    print(str(exc))',
			{ cwd: tempDir.path(), sessionId, sessionFile },
		);
		const withBridge = await executePython('print(tool.read({"path": "foo.txt"}))', {
			cwd: tempDir.path(),
			sessionId,
			sessionFile,
			toolSession: bridgeSession,
		});

		expect(withoutBridge.exitCode).toBe(0);
		expect(withoutBridge.output).toContain("RuntimeError");
		expect(withoutBridge.output).toContain("tool bridge is unavailable");
		expect(withBridge.exitCode).toBe(0);
		expect(withBridge.output.trim()).toBe("bridge-ok");
		expect(bridgeCalls).toEqual([{ path: "foo.txt", _i: "py prelude" }]);
	});
});

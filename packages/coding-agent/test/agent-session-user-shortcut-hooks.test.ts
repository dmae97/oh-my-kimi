import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pythonExecutor from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TOOL_TIMEOUTS } from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession user shortcut hooks", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-user-shortcut-hooks-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	function createSession(extensionRunner?: ExtensionRunner): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		return session;
	}

	it("invokes user_bash hook and honors replacement result", async () => {
		const replacement = {
			output: "hooked bash output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 18,
			outputLines: 1,
			outputBytes: 18,
		};
		const emitUserBash = vi.fn().mockResolvedValue({ result: replacement });
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "user_bash"),
			emitUserBash,
		} as unknown as ExtensionRunner;
		const executeBashSpy = vi.spyOn(bashExecutor, "executeBash");

		createSession(extensionRunner);
		const result = await session.executeBash("echo hello", undefined, { excludeFromContext: true });

		expect(emitUserBash).toHaveBeenCalledWith({
			type: "user_bash",
			command: "echo hello",
			excludeFromContext: true,
			cwd: expect.any(String),
		});
		expect(executeBashSpy).not.toHaveBeenCalled();
		expect(result).toEqual(replacement);
		const bashMessage = session.messages.at(-1);
		expect(bashMessage?.role).toBe("bashExecution");
		expect(bashMessage).toMatchObject({
			output: "hooked bash output",
			excludeFromContext: true,
		});
	});

	it("invokes user_python hook and honors replacement result", async () => {
		const replacement = {
			output: "hooked python output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 20,
			outputLines: 1,
			outputBytes: 20,
			displayOutputs: [],
			stdinRequested: false,
		};
		const emitUserPython = vi.fn().mockResolvedValue({ result: replacement });
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "user_python"),
			emitUserPython,
		} as unknown as ExtensionRunner;
		const executePythonSpy = vi.spyOn(pythonExecutor, "executePython");

		createSession(extensionRunner);
		const result = await session.executePython("print('hi')", undefined, { excludeFromContext: true });

		expect(emitUserPython).toHaveBeenCalledWith({
			type: "user_python",
			code: "print('hi')",
			excludeFromContext: true,
			cwd: expect.any(String),
		});
		expect(executePythonSpy).not.toHaveBeenCalled();
		expect(result).toEqual(replacement);
		const pythonMessage = session.messages.at(-1);
		expect(pythonMessage?.role).toBe("pythonExecution");
		expect(pythonMessage).toMatchObject({
			output: "hooked python output",
			excludeFromContext: true,
		});
	});

	it("falls back to normal execution when hook does not return a replacement", async () => {
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "user_bash" || eventType === "user_python"),
			emitUserBash: vi.fn().mockResolvedValue({}),
			emitUserPython: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue({
			output: "bash fallback",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 13,
			outputLines: 1,
			outputBytes: 13,
		});
		vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "python fallback",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 15,
			outputLines: 1,
			outputBytes: 15,
			displayOutputs: [],
			stdinRequested: false,
		});

		createSession(extensionRunner);
		const bashResult = await session.executeBash("pwd", undefined, { excludeFromContext: true });
		const pythonResult = await session.executePython("1+1", undefined, { excludeFromContext: false });

		expect(bashResult.output).toBe("bash fallback");
		expect(pythonResult.output).toBe("python fallback");
		expect(bashExecutor.executeBash).toHaveBeenCalledTimes(1);
		expect(pythonExecutor.executePython).toHaveBeenCalledTimes(1);
		expect(
			session.messages.some(message => message.role === "bashExecution" && message.excludeFromContext === true),
		).toBe(true);
		expect(
			session.messages.some(message => message.role === "pythonExecution" && message.excludeFromContext === false),
		).toBe(true);
	});

	it("passes the default native timeout to fallback bash execution", async () => {
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue({
			output: "bash fallback",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 13,
			outputLines: 1,
			outputBytes: 13,
		});

		createSession();
		await session.executeBash("pwd", undefined, { excludeFromContext: false });

		expect(bashExecutor.executeBash).toHaveBeenCalledWith(
			"pwd",
			expect.objectContaining({
				timeout: TOOL_TIMEOUTS.bash.default * 1000,
				sessionKey: expect.any(String),
				signal: expect.any(AbortSignal),
			}),
		);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pythonExecutor from "@oh-my-pi/pi-coding-agent/ipy/executor";
import * as pythonKernel from "@oh-my-pi/pi-coding-agent/ipy/kernel";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { PythonTool } from "@oh-my-pi/pi-coding-agent/tools/python";
import { Snowflake } from "@oh-my-pi/pi-utils";

function createSession(
	cwd: string,
	sessionFile: string,
	overrides?: Partial<Record<SettingPath, unknown>>,
	kernelOwnerId?: string,
	forcePythonWarmup = false,
): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => null,
		getPythonKernelOwnerId: () => kernelOwnerId ?? null,
		forcePythonWarmup,
		settings: Settings.isolated({ "python.toolMode": "ipy-only", ...overrides }),
	};
}

describe("python tool settings", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `python-tool-settings-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		pythonExecutor.resetPreludeDocsCache();
		vi.restoreAllMocks();
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("exposes python tool when kernel is available", async () => {
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const sessionFile = path.join(testDir, "session.jsonl");
		const tools = await createTools(createSession(testDir, sessionFile), ["python"]);

		expect(tools.map(tool => tool.name).sort()).toEqual(["exit_plan_mode", "python"]);
	});

	it("falls back to bash when python is unavailable", async () => {
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({
			ok: false,
			reason: "missing",
		});
		const sessionFile = path.join(testDir, "session.jsonl");
		const tools = await createTools(createSession(testDir, sessionFile), ["python"]);

		expect(tools.map(tool => tool.name).sort()).toEqual(["bash", "exit_plan_mode"]);
	});

	it("passes kernel owner and kernel mode from settings to executor", async () => {
		vi.spyOn(pythonExecutor, "getPreludeDocs").mockReturnValue([]);
		const warmupSpy = vi.spyOn(pythonExecutor, "warmPythonEnvironment").mockResolvedValue({ ok: true, docs: [] });
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 2,
			outputLines: 1,
			outputBytes: 2,
			displayOutputs: [],
			stdinRequested: false,
		});

		const sessionFile = path.join(testDir, "session.jsonl");
		const kernelOwnerId = "owner-456";
		const session = createSession(testDir, sessionFile, { "python.kernelMode": "per-call" }, kernelOwnerId);
		const pythonTool = new PythonTool(session);

		await pythonTool.execute("tool-call", { cells: [{ title: "print-single-cell", code: "print(1)" }] });

		expect(warmupSpy).toHaveBeenCalledWith(
			testDir,
			`session:${sessionFile}:cwd:${testDir}`,
			true,
			sessionFile,
			kernelOwnerId,
			expect.any(AbortSignal),
		);
		expect(executeSpy).toHaveBeenCalledWith(
			"print(1)",
			expect.objectContaining({
				kernelMode: "per-call",
				sessionId: `session:${sessionFile}:cwd:${testDir}`,
				kernelOwnerId,
			}),
		);
	});

	it("passes kernel owner into createTools warmup without changing session ids", async () => {
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonExecutor, "getPreludeDocs").mockReturnValue([]);
		const warmupSpy = vi.spyOn(pythonExecutor, "warmPythonEnvironment").mockResolvedValue({ ok: true, docs: [] });

		const sessionFile = path.join(testDir, "session-create-tools.jsonl");
		const kernelOwnerId = "owner-create-tools";
		const previousSkipCheck = Bun.env.PI_PYTHON_SKIP_CHECK;

		delete Bun.env.PI_PYTHON_SKIP_CHECK;
		try {
			await createTools(createSession(testDir, sessionFile, undefined, kernelOwnerId, true), ["python"]);

			expect(warmupSpy).toHaveBeenCalledWith(
				testDir,
				`session:${sessionFile}:cwd:${testDir}`,
				true,
				sessionFile,
				kernelOwnerId,
			);
		} finally {
			if (previousSkipCheck === undefined) {
				delete Bun.env.PI_PYTHON_SKIP_CHECK;
			} else {
				Bun.env.PI_PYTHON_SKIP_CHECK = previousSkipCheck;
			}
		}
	});
});

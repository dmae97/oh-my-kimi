import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import {
	disposeAllKernelSessions,
	executePythonWithKernel,
	getPreludeDocs,
	resetPreludeDocsCache,
	warmPythonEnvironment,
} from "@oh-my-pi/pi-coding-agent/ipy/executor";
import { type KernelShutdownResult, type PreludeHelper, PythonKernel } from "@oh-my-pi/pi-coding-agent/ipy/kernel";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import { TempDir } from "@oh-my-pi/pi-utils";
import { FakeKernel } from "./helpers";

describe("executePythonWithKernel", () => {
	it("captures text and display outputs", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			options => {
				options?.onChunk?.("hello\n");
				options?.onDisplay?.({ type: "json", data: { foo: "bar" } });
			},
		);

		const result = await executePythonWithKernel(kernel, "print('hello')");

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("hello");
		expect(result.displayOutputs).toHaveLength(1);
	});

	it("marks stdin request as error", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: true },
			() => {},
		);

		const result = await executePythonWithKernel(kernel, "input('prompt')");

		expect(result.exitCode).toBe(1);
		expect(result.stdinRequested).toBe(true);
		expect(result.output).toContain("Kernel requested stdin; interactive input is not supported.");
	});

	it("maps error status to exit code 1", async () => {
		const kernel = new FakeKernel(
			{ status: "error", cancelled: false, timedOut: false, stdinRequested: false },
			options => {
				options?.onChunk?.("Traceback\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "raise ValueError('nope')");

		expect(result.exitCode).toBe(1);
		expect(result.cancelled).toBe(false);
		expect(result.output).toContain("Traceback");
	});

	it("sanitizes streamed chunks", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			options => {
				options?.onChunk?.("\u001b[31mred\r\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "print('red')");

		expect(result.output).toBe("red\n");
	});

	it("returns cancelled result with timeout annotation", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: true, timedOut: true, stdinRequested: false },
			options => {
				options?.onChunk?.("partial output\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "while True: pass", { timeoutMs: 4100 });

		expect(result.exitCode).toBeUndefined();
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Command timed out after 4 seconds");
	});

	it("returns cancelled result without timeout annotation", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: true, timedOut: false, stdinRequested: false },
			options => {
				options?.onChunk?.("cancelled output\n");
			},
		);

		const result = await executePythonWithKernel(kernel, "while True: pass");

		expect(result.exitCode).toBeUndefined();
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("cancelled output");
		expect(result.output).not.toContain("Command timed out");
	});

	it("truncates large output and stores full output artifact", async () => {
		const lineLength = 100;
		const lineCount = Math.ceil((DEFAULT_MAX_BYTES * 1.5) / lineLength);
		const lines = Array.from(
			{ length: lineCount },
			(_, i) => `line${i.toString().padStart(6, "0")}: ${"x".repeat(lineLength - 15)}`,
		);
		const largeOutput = `${lines.join("\n")}\nTAIL\n`;
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			async options => {
				await options?.onChunk?.(largeOutput);
			},
		);
		using tempDir = TempDir.createSync("@python-executor-artifacts-");
		const artifactPath = path.join(tempDir.path(), "0.python.txt");

		const result = await executePythonWithKernel(kernel, "print('big')", {
			artifactPath,
			artifactId: "0",
		});

		expect(result.truncated).toBe(true);
		expect(result.artifactId).toBe("0");
		expect(result.output).toContain("TAIL");

		const fullText = await Bun.file(artifactPath).text();
		expect(fullText).toBe(largeOutput);
	});
});

afterEach(async () => {
	await disposeAllKernelSessions();
	resetPreludeDocsCache();
	vi.restoreAllMocks();
});

describe("warmPythonEnvironment", () => {
	it("caches prelude docs on warmup", async () => {
		const previousSkip = Bun.env.PI_PYTHON_SKIP_CHECK;
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		using tempDir = TempDir.createSync("@python-executor-");
		const docs: PreludeHelper[] = [
			{
				name: "read",
				signature: "(path)",
				docstring: "Read file contents.",
				category: "File I/O",
			},
		];
		const kernel = {
			introspectPrelude: vi.fn().mockResolvedValue(docs),
			ping: vi.fn().mockResolvedValue(true),
			isAlive: () => true,
			shutdown: vi.fn(async (): Promise<KernelShutdownResult> => ({ confirmed: true })),
		};
		const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernel);

		const result = await warmPythonEnvironment(tempDir.path(), "session-1");

		expect(result.ok).toBe(true);
		expect(result.docs).toEqual(docs);
		expect(getPreludeDocs()).toEqual(docs);
		expect(kernel.introspectPrelude).toHaveBeenCalledTimes(1);

		startSpy.mockRestore();
		if (previousSkip === undefined) {
			delete Bun.env.PI_PYTHON_SKIP_CHECK;
		} else {
			Bun.env.PI_PYTHON_SKIP_CHECK = previousSkip;
		}
	});
});

import { describe, expect, it } from "bun:test";
import { executePythonWithKernel } from "@oh-my-pi/pi-coding-agent/ipy/executor";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import { FakeKernel } from "./helpers";

describe("executePythonWithKernel streaming", () => {
	it("truncates large output and tracks totals", async () => {
		const largeOutput = "a".repeat(DEFAULT_MAX_BYTES + 128);
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			options => options?.onChunk?.(largeOutput),
		);

		const result = await executePythonWithKernel(kernel, "print('hi')");

		expect(result.truncated).toBe(true);
		expect(result.output.length).toBeLessThan(largeOutput.length);
		expect(result.totalBytes).toBeGreaterThan(result.outputBytes);
	});

	it("annotates timed out runs", async () => {
		const kernel = new FakeKernel({ status: "ok", cancelled: true, timedOut: true, stdinRequested: false }, () => {});

		const result = await executePythonWithKernel(kernel, "sleep", { timeoutMs: 2000 });

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("Command timed out after 2 seconds");
	});

	it("sanitizes ANSI and carriage returns", async () => {
		const kernel = new FakeKernel(
			{ status: "ok", cancelled: false, timedOut: false, stdinRequested: false },
			options => options?.onChunk?.("\u001b[31mhello\r\n"),
		);

		const result = await executePythonWithKernel(kernel, "print('hello')");

		expect(result.output).toBe("hello\n");
	});
});

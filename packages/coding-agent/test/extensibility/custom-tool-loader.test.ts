import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { loadCustomTools } from "../../src/extensibility/custom-tools/loader";

let tempRoot: string | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	if (tempRoot) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

async function writeTool(name: string, source: string): Promise<string> {
	tempRoot ??= await fs.mkdtemp(path.join(os.tmpdir(), "omp-custom-tool-loader-"));
	const filePath = path.join(tempRoot, name);
	await Bun.write(filePath, source);
	return filePath;
}

function requireTempRoot(): string {
	if (!tempRoot) throw new Error("Temporary custom tool root was not created.");
	return tempRoot;
}

describe("custom tool loader", () => {
	it("survives a tool that calls process.exit synchronously at import time and still loads later valid tools", async () => {
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		const exitingTool = await writeTool(
			"sync-exit.js",
			[
				"function main() {",
				"\ttry {",
				"\t\tdoWork();",
				"\t} catch {",
				"\t\tprocess.exit(1);",
				"\t}",
				"}",
				"main();",
			].join("\n"),
		);
		const validTool = await writeTool(
			"valid.js",
			[
				"export default api => ({",
				'\tname: "safe_custom_tool",',
				'\tlabel: "Safe Custom Tool",',
				'\tdescription: "Returns a fixed response",',
				"\tparameters: api.zod.object({}),",
				"\tasync execute() {",
				'\t\treturn { content: [{ type: "text", text: "ok" }] };',
				"\t},",
				"});",
			].join("\n"),
		);

		const result = await loadCustomTools([{ path: exitingTool }, { path: validTool }], requireTempRoot(), []);

		expect(result.tools.map(tool => tool.tool.name)).toEqual(["safe_custom_tool"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.path).toBe(exitingTool);

		const loggedExit = errorSpy.mock.calls.find(
			call =>
				typeof call[0] === "string" && call[0].startsWith("Custom tool attempted to exit the process during load"),
		);
		expect(loggedExit).toBeDefined();
		expect(loggedExit?.[1]).toMatchObject({ code: 1 });
	});

	it("survives a tool that schedules a deferred process.exit via void promise.catch and still registers it", async () => {
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		const signalKey = `__omp1704_async_signal_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		const { promise, resolve } = Promise.withResolvers<unknown>();
		(globalThis as Record<string, unknown>)[signalKey] = resolve;

		try {
			const asyncTool = await writeTool(
				"async-exit.js",
				[
					`const signal = globalThis[${JSON.stringify(signalKey)}];`,
					"async function main() { throw new Error('startup failure'); }",
					"void main().catch(() => {",
					"\tprocess.exit(7);",
					"\tsignal('survived');",
					"});",
					"export default api => ({",
					'\tname: "async_exit_tool",',
					'\tlabel: "Async Exit Tool",',
					'\tdescription: "Schedules a deferred exit during import",',
					"\tparameters: api.zod.object({}),",
					"\tasync execute() {",
					'\t\treturn { content: [{ type: "text", text: "ok" }] };',
					"\t},",
					"});",
				].join("\n"),
			);

			const result = await loadCustomTools([{ path: asyncTool }], requireTempRoot(), []);

			// The tool's deferred exit attempt fires after the import promise settles.
			// If the guard did not intercept it, the test process would die before this resolves.
			const outcome = await promise;
			expect(outcome).toBe("survived");
			expect(result.tools.map(tool => tool.tool.name)).toEqual(["async_exit_tool"]);
			expect(result.errors).toEqual([]);

			const loggedExit = errorSpy.mock.calls.find(
				call =>
					typeof call[0] === "string" &&
					call[0].startsWith("Custom tool attempted to exit the process during load"),
			);
			expect(loggedExit).toBeDefined();
			expect(loggedExit?.[1]).toMatchObject({ code: 7 });
		} finally {
			delete (globalThis as Record<string, unknown>)[signalKey];
		}
	});
});

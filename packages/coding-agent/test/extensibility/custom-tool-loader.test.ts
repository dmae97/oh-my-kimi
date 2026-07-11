import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCustomTools, type ToolPathWithSource } from "../../src/extensibility/custom-tools/loader";

let tempRoot: string | undefined;

afterEach(async () => {
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

const VALID_TOOL_SOURCE = [
	"export default api => ({",
	'\tname: "safe_custom_tool",',
	'\tlabel: "Safe Custom Tool",',
	'\tdescription: "Returns a fixed response",',
	"\tparameters: api.zod.object({}),",
	"\tasync execute() {",
	'\t\treturn { content: [{ type: "text", text: "ok" }] };',
	"\t},",
	"});",
].join("\n");

const TEST_SOURCE: NonNullable<ToolPathWithSource["source"]> = {
	provider: "plugin",
	providerName: "Regression Plugin",
	level: "user",
};

const ARRAY_WITH_NULL_SOURCE = ["export default () => [null];"].join("\n");

const MIXED_ARRAY_SOURCE = [
	"export default api => [",
	"\t{",
	'\t\tname: "mixed_valid_tool",',
	'\t\tlabel: "Mixed Valid Tool",',
	'\t\tdescription: "Returns a fixed response from a mixed tool factory result",',
	"\t\tparameters: api.zod.object({}),",
	"\t\tasync execute() {",
	'\t\t\treturn { content: [{ type: "text", text: "ok" }] };',
	"\t\t},",
	"\t},",
	"\tnull,",
	"];",
].join("\n");

const MISSING_NAME_SOURCE = [
	"export default api => ({",
	'\tdescription: "Missing name but otherwise loadable shape",',
	"\tparameters: api.zod.object({}),",
	"\tasync execute() {",
	'\t\treturn { content: [{ type: "text", text: "ok" }] };',
	"\t},",
	"});",
].join("\n");

describe("custom tool loader", () => {
	it("skips a tool that calls process.exit synchronously at import time and still loads later valid tools", async () => {
		// CLI-shaped module: main() at the bottom, exit on failure (issue #1704).
		// Without the exit guard this terminates the test process before the
		// assertions run.
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
		const validTool = await writeTool("valid.js", VALID_TOOL_SOURCE);

		const result = await loadCustomTools([{ path: exitingTool }, { path: validTool }], requireTempRoot(), []);

		expect(result.tools.map(tool => tool.tool.name)).toEqual(["safe_custom_tool"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.path).toBe(exitingTool);
		expect(result.errors[0]?.error).toContain("process.exit(1)");
	});

	it("skips a tool whose factory calls process.exit and still loads later valid tools", async () => {
		const factoryExitTool = await writeTool(
			"factory-exit.js",
			["export default () => {", "\tprocess.exit(3);", "};"].join("\n"),
		);
		const validTool = await writeTool("valid.js", VALID_TOOL_SOURCE);

		const result = await loadCustomTools([{ path: factoryExitTool }, { path: validTool }], requireTempRoot(), []);

		expect(result.tools.map(tool => tool.tool.name)).toEqual(["safe_custom_tool"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.path).toBe(factoryExitTool);
		expect(result.errors[0]?.error).toContain("process.exit(3)");
	});

	it("reports a null array entry instead of throwing", async () => {
		const nullArrayTool = await writeTool("null-array.js", ARRAY_WITH_NULL_SOURCE);

		const result = await loadCustomTools([{ path: nullArrayTool, source: TEST_SOURCE }], requireTempRoot(), []);

		expect(result.tools).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({
			path: nullArrayTool,
			source: TEST_SOURCE,
		});
		expect(result.errors[0]?.error.toLowerCase()).toContain("invalid");
		expect(result.errors[0]?.error).toContain("index 0");
	});

	it("reports a tool entry missing a name instead of throwing", async () => {
		const missingNameTool = await writeTool("missing-name.js", MISSING_NAME_SOURCE);

		const loadResult = loadCustomTools([{ path: missingNameTool, source: TEST_SOURCE }], requireTempRoot(), []);
		await expect(loadResult).resolves.toMatchObject({
			tools: [],
			errors: [
				{
					path: missingNameTool,
					source: TEST_SOURCE,
				},
			],
		});
		const result = await loadResult;

		expect(result.tools).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({
			path: missingNameTool,
			source: TEST_SOURCE,
		});
		expect(result.errors[0]?.error.toLowerCase()).toContain("invalid");
		expect(result.errors[0]?.error).toContain("index 0");
		expect(result.errors[0]?.error).toContain("string name");
	});

	it("keeps valid tools from a mixed array and reports the null entry", async () => {
		const mixedArrayTool = await writeTool("mixed-array.js", MIXED_ARRAY_SOURCE);

		const result = await loadCustomTools([{ path: mixedArrayTool, source: TEST_SOURCE }], requireTempRoot(), []);

		expect(result.tools.map(tool => tool.tool.name)).toEqual(["mixed_valid_tool"]);
		expect(result.tools[0]).toMatchObject({
			path: mixedArrayTool,
			source: TEST_SOURCE,
		});
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({
			path: mixedArrayTool,
			source: TEST_SOURCE,
		});
		expect(result.errors[0]?.error.toLowerCase()).toContain("invalid");
		expect(result.errors[0]?.error).toContain("index 1");
	});
});

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCustomTools } from "../../src/extensibility/custom-tools/loader";

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

describe("custom tool loader", () => {
	it("turns process.exit during module import into a load error without stopping later tools", async () => {
		const originalExit = process.exit;
		const exitingTool = await writeTool(
			"exiting.js",
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

		if (!tempRoot) {
			throw new Error("Temporary custom tool root was not created.");
		}

		const result = await loadCustomTools([{ path: exitingTool }, { path: validTool }], tempRoot, []);

		expect(process.exit).toBe(originalExit);
		expect(result.tools.map(tool => tool.tool.name)).toEqual(["safe_custom_tool"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.path).toBe(exitingTool);
		expect(result.errors[0]?.error).toContain("attempted to exit the process during load with code 1");
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { TempDir } from "@oh-my-pi/pi-utils";

// Tool name registered by the synthetic extension below.
const TOOL_NAME = "schedule_prompt_test";

describe("issue #1215: legacy @mariozechner/pi-ai imports survive getResolvedSpecifier failure", () => {
	let projectDir: TempDir;
	let extensionPath: string;

	beforeEach(() => {
		projectDir = TempDir.createSync("@issue-1215-");
		const pluginDir = path.join(projectDir.path(), "pi-schedule-like-plugin");
		extensionPath = path.join(pluginDir, "index.ts");
		fs.mkdirSync(pluginDir, { recursive: true });

		// Mirrors the import pattern used by pi-schedule-prompt@0.3.0, which was
		// the reporter's failing plugin. z is a runtime value re-exported from
		// @oh-my-pi/pi-ai so using it forces the import to be resolved at load time.
		fs.writeFileSync(
			extensionPath,
			[
				'import { z } from "@mariozechner/pi-ai";',
				"",
				"export default function(pi) {",
				"\tpi.registerTool({",
				`\t\tname: ${JSON.stringify(TOOL_NAME)},`,
				'\t\tdescription: "Issue #1215 regression test",',
				"\t\tparameters: z.object({ text: z.string() }),",
				'\t\texecute: async () => ({ content: [{ type: "text", text: "ok" }] }),',
				"\t});",
				"}",
			].join("\n"),
		);
	});

	afterEach(() => {
		projectDir.removeSync();
	});

	it("loads the extension and registers the tool", async () => {
		const result = await loadExtensions([extensionPath], projectDir.path());

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].tools.has(TOOL_NAME)).toBe(true);
	});
});

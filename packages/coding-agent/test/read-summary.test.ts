import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

let artifactCounter = 0;

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

function createSession(cwd: string, settings = Settings.isolated()): ToolSession {
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionDir = path.join(cwd, "session");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			await fs.mkdir(sessionDir, { recursive: true });
			const id = `artifact-${++artifactCounter}`;
			return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
		},
		settings,
	};
}

describe("read summary", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-summary-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("summarizes parseable TypeScript files without an explicit selector", async () => {
		const fixture = path.join(tmpDir, "fixture.ts");
		await fs.writeFile(
			fixture,
			"export function alpha(value: string): string {\n\tconst clean = value.trim();\n\tconst label = clean || 'alpha';\n\treturn label.toUpperCase();\n}\n\nexport function beta(): number {\n\tconst one = 1;\n\tconst two = 2;\n\treturn one + two;\n}\n",
		);

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-summary-ts", { path: fixture });
		const text = textOutput(result);

		expect(text).toContain("export function alpha(value: string): string {");
		expect(text).toContain("export function beta(): number {");
		expect(text).toContain("...");
		expect(text).not.toContain("const clean = value.trim()");
		expect(result.details?.summary?.elidedSpans).toBe(2);
	});

	it("does not truncate summarized output", async () => {
		const fixture = path.join(tmpDir, "many.ts");
		const source = Array.from(
			{ length: 20 },
			(_, index) =>
				`export function fn${index}(): number {\n\tconst one = ${index};\n\tconst two = ${index + 1};\n\treturn one + two;\n}`,
		).join("\n\n");
		await fs.writeFile(fixture, `${source}\n`);

		const tool = new ReadTool(createSession(tmpDir, Settings.isolated({ "read.defaultLimit": 10 })));
		const result = await tool.execute("read-summary-no-truncate", { path: fixture });
		const text = textOutput(result);

		expect(text).toContain("export function fn19(): number {");
		expect(text).not.toContain("[Showing lines");
		expect(result.details?.truncation).toBeUndefined();
		expect(result.details?.summary?.elidedSpans).toBe(20);
	});

	it("returns verbatim anchored ranges when a selector is explicit", async () => {
		const fixture = path.join(tmpDir, "fixture.ts");
		await fs.writeFile(fixture, "export function alpha(): string {\n\tconst clean = 'alpha';\n\treturn clean;\n}\n");

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-summary-range", { path: `${fixture}:1-9999` });
		const text = textOutput(result);

		expect(text).toContain("const clean = 'alpha';");
		expect(text).not.toContain("...");
		expect(result.details?.summary).toBeUndefined();
	});

	it("returns raw verbatim content without anchors", async () => {
		const fixture = path.join(tmpDir, "fixture.ts");
		await fs.writeFile(fixture, "export const value = 1;\n");

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-summary-raw", { path: `${fixture}:raw` });
		const text = textOutput(result);

		expect(text).toBe("export const value = 1;\n");
		expect(text).not.toMatch(/^1[a-z]{2}\|/);
	});

	it("falls back to normal reads when summaries are disabled or parsing fails", async () => {
		const valid = path.join(tmpDir, "valid.ts");
		const broken = path.join(tmpDir, "broken.ts");
		await fs.writeFile(valid, "export function alpha(): string {\n\tconst clean = 'alpha';\n\treturn clean;\n}\n");
		await fs.writeFile(broken, "export function broken( {\n");

		const disabledTool = new ReadTool(createSession(tmpDir, Settings.isolated({ "read.summarize.enabled": false })));
		const disabled = await disabledTool.execute("read-summary-disabled", { path: valid });
		expect(textOutput(disabled)).toContain("const clean = 'alpha';");
		expect(disabled.details?.summary).toBeUndefined();

		const enabledTool = new ReadTool(createSession(tmpDir));
		const parseFailure = await enabledTool.execute("read-summary-parse-failure", { path: broken });
		expect(textOutput(parseFailure)).toContain("export function broken( {");
		expect(parseFailure.details?.summary).toBeUndefined();
	});

	it("preserves SQLite colon paths while plain-file selectors split only line suffixes", async () => {
		const dbPath = path.join(tmpDir, "data.db");
		const db = new Database(dbPath);
		try {
			db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
			db.run("INSERT INTO users (id, name) VALUES (42, 'Ada')");
		} finally {
			db.close();
		}

		const tool = new ReadTool(createSession(tmpDir));
		const row = await tool.execute("read-summary-sqlite-row", { path: `${dbPath}:users:42` });
		const text = textOutput(row);

		expect(text).toContain("id: 42");
		expect(text).toContain("name: Ada");
	});
});

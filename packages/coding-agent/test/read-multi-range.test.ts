import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string, bridge?: ClientBridge): ToolSession {
	const settings = Settings.isolated();
	// Disable structural summarization so multi-range tests assert raw line content
	// regardless of language heuristics.
	settings.set("read.summarize.enabled", false);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
		getClientBridge: bridge ? () => bridge : undefined,
	};
}

function makeNumberedContent(lines: number): string {
	return Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("read tool multi-range selector", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-multi-range-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("uses only the filename in hashline headers for nested files", async () => {
		const filePath = path.join(tmpDir, "src", "nested", "numbered.txt");
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, "alpha\nbeta\n");

		const tool = new ReadTool(createSession(tmpDir));
		const text = textOutput(await tool.execute("call-filename-header", { path: filePath }));
		const firstLine = text.split("\n")[0];

		expect(firstLine).toMatch(/^\[numbered\.txt#[0-9A-F]{4}\]$/);
		expect(firstLine).not.toContain("src");
	});

	it("returns both ranges separated by an elision marker", async () => {
		const filePath = path.join(tmpDir, "src", "numbered.txt");
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, makeNumberedContent(50));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("call-multi", { path: `${filePath}:3-5,20-22` });
		const text = textOutput(result);
		const firstLine = text.split("\n")[0];
		expect(firstLine).toMatch(/^\[numbered\.txt#[0-9A-F]{4}\]$/);

		expect(text).toContain("line 3");
		expect(text).toContain("line 4");
		expect(text).toContain("line 5");
		expect(text).toContain("line 20");
		expect(text).toContain("line 21");
		expect(text).toContain("line 22");
		expect(text).not.toMatch(/^2:line 2$/m);
		expect(text).not.toMatch(/^6:line 6$/m);
		// Lines between the ranges must be elided
		expect(text).not.toContain("line 10");
		expect(text).not.toContain("line 19");
		// Separator marker is present between blocks
		expect(text).toContain("…");
	});

	it("does not add a closing bracket outside a forward range", async () => {
		const filePath = path.join(tmpDir, "brackets.ts");
		await fs.writeFile(
			filePath,
			[
				"function outer() {",
				"  const one = 1;",
				"  const two = 2;",
				"  const three = 3;",
				"  const four = 4;",
				"  return one + two + three + four;",
				"}",
				"after();",
			].join("\n"),
		);

		const tool = new ReadTool(createSession(tmpDir));
		const text = textOutput(await tool.execute("call-bracket-close", { path: `${filePath}:1-1` }));

		expect(text).toContain("function outer() {");
		expect(text).not.toContain("…");
		expect(text).not.toMatch(/^7:}$/m);
		expect(text).not.toContain("const four");
		expect(text).not.toContain("return one + two");
	});

	it("does not add an opening bracket outside a reverse range", async () => {
		const filePath = path.join(tmpDir, "brackets.ts");
		await fs.writeFile(
			filePath,
			[
				"function outer() {",
				"  const one = 1;",
				"  const two = 2;",
				"  const three = 3;",
				"  const four = 4;",
				"  return one + two + three + four;",
				"}",
				"after();",
			].join("\n"),
		);

		const tool = new ReadTool(createSession(tmpDir));
		const text = textOutput(await tool.execute("call-bracket-open", { path: `${filePath}:7-7` }));

		expect(text).toMatch(/^7:}$/m);
		expect(text).not.toContain("function outer() {");
		expect(text).not.toContain("…");
		expect(text).not.toContain("const one = 1");
		expect(text).not.toContain("const four = 4");
	});

	it("does not add Python syntactic boundaries outside a range", async () => {
		const filePath = path.join(tmpDir, "module.py");
		await fs.writeFile(
			filePath,
			[
				"def greet(name):",
				"    a = 1",
				"    b = 2",
				"    c = 3",
				"    d = 4",
				"    e = 5",
				"    f = 6",
				"    g = 7",
				"    return a + b + c + d + e + f + g + len(name)",
				"trailing = 1",
			].join("\n"),
		);

		const tool = new ReadTool(createSession(tmpDir));
		const text = textOutput(await tool.execute("call-py-def", { path: `${filePath}:1-1` }));

		expect(text).toContain("def greet(name):");
		expect(text).not.toContain("…");
		expect(text).not.toContain("return a + b + c + d + e + f + g + len(name)");
		expect(text).not.toContain("trailing = 1");
	});

	it("merges overlapping ranges into a single contiguous block", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(20));

		const tool = new ReadTool(createSession(tmpDir));
		// 3-7 and 6-9 overlap → merged into 3-9 (collapses to a single-range read).
		const result = await tool.execute("call-merge", { path: `${filePath}:3-7,6-9` });
		const text = textOutput(result);

		// All lines from the merged range present
		for (const i of [3, 4, 5, 6, 7, 8, 9]) {
			expect(text).toMatch(new RegExp(`^${i}:line ${i}$`, "m"));
		}
		// No separator because ranges merged into one contiguous block
		expect(text).not.toContain("…");
	});

	it("sorts ranges in ascending order regardless of user order", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(50));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("call-sort", { path: `${filePath}:30-32,5-7` });
		const text = textOutput(result);

		const indexEarly = text.indexOf("line 5");
		const indexLate = text.indexOf("line 30");
		expect(indexEarly).toBeGreaterThanOrEqual(0);
		expect(indexLate).toBeGreaterThan(indexEarly);
	});

	it("surfaces an inline notice when a range is past EOF", async () => {
		const filePath = path.join(tmpDir, "small.txt");
		await fs.writeFile(filePath, makeNumberedContent(10));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("call-oob", { path: `${filePath}:3-5,999-1000` });
		const text = textOutput(result);

		expect(text).toContain("line 3");
		expect(text).toContain("line 5");
		expect(text).toContain("Range 999-1000 is beyond end of file (10 lines total); skipped");
	});

	it("supports the +count syntax in multi-range", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(30));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("call-plus", { path: `${filePath}:2+2,20+2` });
		const text = textOutput(result);

		expect(text).toContain("line 2");
		expect(text).toContain("line 3");
		expect(text).toContain("line 20");
		expect(text).toContain("line 21");
		expect(text).not.toContain("line 4");
		expect(text).not.toContain("line 19");
	});

	it("accepts `..` as a forgiving alias for `-`, producing identical output", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(30));

		const tool = new ReadTool(createSession(tmpDir));
		const dotdot = textOutput(await tool.execute("call-dotdot", { path: `${filePath}:3..5` }));
		const dash = textOutput(await tool.execute("call-dash", { path: `${filePath}:3-5` }));

		expect(dotdot).toContain("line 3");
		expect(dotdot).toContain("line 5");
		// `..` must be a pure alias: byte-for-byte identical to the `-` form.
		expect(dotdot).toBe(dash);
	});

	it("accepts `..` in multi-range selectors", async () => {
		const filePath = path.join(tmpDir, "numbered.txt");
		await fs.writeFile(filePath, makeNumberedContent(50));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("call-dotdot-multi", { path: `${filePath}:3..5,20..22` });
		const text = textOutput(result);

		expect(text).toContain("line 3");
		expect(text).toContain("line 5");
		expect(text).toContain("line 20");
		expect(text).toContain("line 22");
		expect(text).not.toContain("line 10");
		expect(text).toContain("…");
	});

	it("rejects multi-range selectors on directories", async () => {
		const tool = new ReadTool(createSession(tmpDir));
		await expect(tool.execute("call-dir", { path: `${tmpDir}:1-2,5-6` })).rejects.toThrow(
			/Multi-range line selectors are not supported for directory listings/,
		);
	});

	it("routes multi-range reads through the ACP bridge when available", async () => {
		const filePath = path.join(tmpDir, "disk.txt");
		await fs.writeFile(filePath, "disk one\ndisk two\ndisk three\ndisk four\ndisk five\n");
		const bridgeText = "bridge one\nbridge two\nbridge three\nbridge four\nbridge five\n";
		const bridge: ClientBridge = {
			capabilities: { readTextFile: true },
			readTextFile: async () => bridgeText,
		};

		const tool = new ReadTool(createSession(tmpDir, bridge));
		const result = await tool.execute("call-bridge", { path: `${filePath}:1-2,4-5` });
		const text = textOutput(result);

		expect(text).toContain("bridge one");
		expect(text).toContain("bridge two");
		expect(text).toContain("bridge four");
		expect(text).toContain("bridge five");
		expect(text).not.toContain("bridge three");
		expect(text).not.toContain("disk one");
	});
});

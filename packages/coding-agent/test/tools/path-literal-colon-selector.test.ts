import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { splitPathAndSel, splitPathAndSelPreferringLiteral } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { GrepTool } from "../../src/tools/grep";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

// Regression: filenames whose tail matches the read-tool selector grammar
// (e.g. `test:1-2`, `log:raw`) used to be shredded by `splitPathAndSel` before
// either tool checked the filesystem — see issue #4618. Both `read` and `grep`
// must prefer a real literal file over the selector interpretation.
describe("literal colon filename resolution (issue #4618)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "literal-colon-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
			...overrides,
		};
	}

	describe("splitPathAndSelPreferringLiteral", () => {
		it("keeps the raw path intact when a literal colon file exists on disk", async () => {
			const literal = "test:1-2";
			await Bun.write(path.join(tmpDir, literal), "test\n");

			// Strict splitter still peels — this documents the contract the
			// literal-preferring variant sits on top of.
			expect(splitPathAndSel(literal)).toEqual({ path: "test", sel: "1-2" });

			expect(await splitPathAndSelPreferringLiteral(literal, tmpDir)).toEqual({ path: literal });
		});

		it("falls back to selector interpretation when the literal path does not exist", async () => {
			// No file created — the selector split wins because the raw path
			// cannot be stat'd.
			expect(await splitPathAndSelPreferringLiteral("test:1-2", tmpDir)).toEqual({
				path: "test",
				sel: "1-2",
			});
		});

		it("also protects `:raw`-shaped literal filenames", async () => {
			const literal = "log:raw";
			await Bun.write(path.join(tmpDir, literal), "line one\nline two\n");
			expect(await splitPathAndSelPreferringLiteral(literal, tmpDir)).toEqual({ path: literal });
		});

		it("returns the strict split unchanged when there is no selector tail", async () => {
			expect(await splitPathAndSelPreferringLiteral("plain.txt", tmpDir)).toEqual({
				path: "plain.txt",
			});
		});
	});

	describe("read tool", () => {
		it("reads a literal file whose name ends in a selector-shaped suffix", async () => {
			const literal = "test:1-2";
			const absolute = path.join(tmpDir, literal);
			await Bun.write(absolute, "test\n");

			const tool = new ReadTool(createSession());
			const result = await tool.execute("read-literal", { path: absolute });
			const output = getText(result);

			expect(output).toContain("test");
			// The strict split would have opened `test` (which doesn't exist)
			// and thrown "Path 'test' not found".
			expect(output).not.toMatch(/not found/i);
		});

		it("prefers a real `foo:1-2` file over interpreting `:1-2` as a range on `foo`", async () => {
			await Bun.write(path.join(tmpDir, "foo"), "line 1\nline 2\nline 3\n");
			await Bun.write(path.join(tmpDir, "foo:1-2"), "colon file wins\n");

			const tool = new ReadTool(createSession());
			const result = await tool.execute("read-literal-wins", {
				path: path.join(tmpDir, "foo:1-2"),
			});
			const output = getText(result);

			expect(output).toContain("colon file wins");
			expect(output).not.toContain("line 1");
		});

		it("still honors the `:5-10` selector when only the base file exists on disk", async () => {
			const absolute = path.join(tmpDir, "notes");
			const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
			await Bun.write(absolute, `${lines}\n`);

			const session = createSession();
			session.settings.set("read.summarize.enabled", false);
			const tool = new ReadTool(session);
			const result = await tool.execute("read-selector-preserved", {
				path: `${absolute}:5-10`,
			});
			const output = getText(result);

			expect(output).toContain("line 5");
			expect(output).toContain("line 10");
			// Lines well outside the requested range must not appear — the selector
			// still peels because the raw `notes:5-10` path does not exist literally.
			expect(output).not.toContain("line 30");
			expect(output).not.toContain("line 40");
		});

		it("reads a literal file that looks like an archive selector (`data.zip:1-2`)", async () => {
			// A real POSIX file whose name ends in a selector-shaped tail after an
			// archive extension. The archive resolver would otherwise open `data.zip`
			// alongside it and error on the phantom member.
			const baseArchive = path.join(tmpDir, "data.zip");
			// Empty zip bytes — the file just needs to stat as a real archive so
			// the archive resolver would happily accept it.
			await Bun.write(
				baseArchive,
				new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
			);
			const literal = path.join(tmpDir, "data.zip:1-2");
			await Bun.write(literal, "literal archive-shaped file\n");

			const tool = new ReadTool(createSession());
			const result = await tool.execute("read-literal-zip-selector", { path: literal });
			const output = getText(result);

			expect(output).toContain("literal archive-shaped file");
		});

		it("reads a literal file that looks like a sqlite selector (`notes.db:1-2`)", async () => {
			// A real POSIX file whose base name matches a sqlite-shaped path plus a
			// selector-shaped tail. The sqlite resolver would misroute this to
			// `notes.db` and try to open a table named `1-2`.
			const baseDb = path.join(tmpDir, "notes.db");
			// SQLite database header (16-byte magic string plus zero-padding).
			const header = new Uint8Array(4096);
			header.set(Buffer.from("SQLite format 3\0", "utf-8"), 0);
			await Bun.write(baseDb, header);
			const literal = path.join(tmpDir, "notes.db:1-2");
			await Bun.write(literal, "literal db-shaped file\n");

			const tool = new ReadTool(createSession());
			const result = await tool.execute("read-literal-db-selector", { path: literal });
			const output = getText(result);

			expect(output).toContain("literal db-shaped file");
		});
	});

	describe("grep tool", () => {
		it("searches inside a literal `test:1-2` file", async () => {
			const literal = "test:1-2";
			const absolute = path.join(tmpDir, literal);
			await Bun.write(absolute, "needle\n");

			const tool = new GrepTool(createSession());
			const result = await tool.execute("grep-literal", {
				pattern: "needle",
				path: absolute,
			});
			const output = getText(result);

			expect(output).toContain("needle");
			expect(output).not.toMatch(/not found/i);
		});

		it("preserves `:N-M` line-range filtering when the literal file does not exist", async () => {
			const absolute = path.join(tmpDir, "notes.txt");
			await Bun.write(absolute, "one\ntwo\nthree\nfour\n");

			const tool = new GrepTool(createSession());
			const rangedResult = await tool.execute("grep-range-filter", {
				pattern: ".",
				path: `${absolute}:1-2`,
			});
			const rangedOutput = getText(rangedResult);

			expect(rangedOutput).toContain("one");
			expect(rangedOutput).toContain("two");
			// Lines outside the range are filtered out.
			expect(rangedOutput).not.toContain("three");
			expect(rangedOutput).not.toContain("four");
		});
	});
});

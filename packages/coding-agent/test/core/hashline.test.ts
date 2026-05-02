import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	applyHashlineEdits,
	buildCompactHashlineDiffPreview,
	computeLineHash,
	type ExecuteHashlineSingleOptions,
	executeHashlineSingle,
	generateDiffString,
	HashlineMismatchError,
	hashlineEditParamsSchema,
	parseHashline,
	splitHashlineInput,
	splitHashlineInputs,
} from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Value } from "@sinclair/typebox/value";

beforeAll(async () => {
	_resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

function tag(line: number, content: string): string {
	return `${line}${computeLineHash(line, content)}`;
}

function mistag(line: number, content: string): string {
	const hash = computeLineHash(line, content);
	return `${line}${hash === "zz" ? "yy" : "zz"}`;
}

function applyDiff(content: string, diff: string): string {
	return applyHashlineEdits(content, parseHashline(diff)).lines;
}

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-edit-"));
	try {
		await fn(tempDir);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

function hashlineExecuteOptions(tempDir: string, input: string): ExecuteHashlineSingleOptions {
	return {
		session: { cwd: tempDir } as ToolSession,
		input,
		writethrough: async (targetPath, content) => {
			await Bun.write(targetPath, content);
			return undefined;
		},
		beginDeferredDiagnosticsForPath: () => ({
			onDeferredDiagnostics: () => {},
			signal: new AbortController().signal,
			finalize: () => {},
		}),
	};
}

describe("hashline parser — block op syntax", () => {
	const content = "aaa\nbbb\nccc";

	it("inserts payload before/after a Lid, and at BOF/EOF", () => {
		const diff = [
			`< ${tag(2, "bbb")}`,
			"|before b",
			`+ ${tag(2, "bbb")}`,
			"|after b",
			"+ BOF",
			"|top",
			"+ EOF",
			"|tail",
		].join("\n");
		expect(applyDiff(content, diff)).toBe("top\naaa\nbefore b\nbbb\nafter b\nccc\ntail");
	});

	it("inserts after the final line via `+ ANCHOR` instead of falling off the file", () => {
		const diff = [`+ ${tag(3, "ccc")}`, "|tail"].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nbbb\nccc\ntail");
	});

	it("blanks a line in place when `= ANCHOR` has no payload", () => {
		const diff = `= ${tag(2, "bbb")}`;
		expect(applyDiff(content, diff)).toBe("aaa\n\nccc");
	});

	it("blanks a range to a single empty line when `= A..B` has no payload", () => {
		const diff = `= ${tag(1, "aaa")}..${tag(2, "bbb")}`;
		expect(applyDiff(content, diff)).toBe("\nccc");
	});

	it("deletes one line or an inclusive range", () => {
		expect(applyDiff(content, `- ${tag(2, "bbb")}`)).toBe("aaa\nccc");
		expect(applyDiff(content, `- ${tag(2, "bbb")}..${tag(3, "ccc")}`)).toBe("aaa");
	});

	it("replaces one line or an inclusive range with payload lines", () => {
		const single = [`= ${tag(2, "bbb")}`, "|BBB"].join("\n");
		expect(applyDiff(content, single)).toBe("aaa\nBBB\nccc");

		const range = [`= ${tag(2, "bbb")}..${tag(3, "ccc")}`, "|BBB", "|CCC"].join("\n");
		expect(applyDiff(content, range)).toBe("aaa\nBBB\nCCC");
	});

	it("preserves payload text exactly after the first pipe", () => {
		const diff = [`= ${tag(2, "bbb")}`, "|", "|# not a header", "|+ not an op", "|  spaced"].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\n\n# not a header\n+ not an op\n  spaced\nccc");
	});

	it("rejects missing payloads and orphan payload lines", () => {
		expect(() => parseHashline(`+ ${tag(1, "aaa")}`)).toThrow(/require at least one \|TEXT payload/);
		expect(() => parseHashline("|orphan")).toThrow(/payload line has no preceding/);
	});

	it("rejects old cursor and equals-inline syntax after cutover", () => {
		expect(() => parseHashline(`@${tag(1, "aaa")}\n+old`)).toThrow(/unrecognized op/);
		expect(() => parseHashline(`${tag(1, "aaa")}=AAA`)).toThrow(/unrecognized op/);
	});
});

describe("hashline — stale anchors", () => {
	it("throws HashlineMismatchError when a Lid hash no longer matches", () => {
		const diff = [`= ${mistag(2, "bbb")}`, "|BBB"].join("\n");
		expect(() => applyDiff("aaa\nbbb\nccc", diff)).toThrow(HashlineMismatchError);
	});

	it("rebases a uniquely shifted anchor within the configured window", () => {
		const stale = tag(2, "bbb");
		const diff = [`= ${stale}`, "|BBB"].join("\n");
		const result = applyHashlineEdits("aaa\nINSERTED\nbbb\nccc", parseHashline(diff));
		expect(result.lines).toBe("aaa\nINSERTED\nBBB\nccc");
		expect(result.warnings?.[0]).toContain(`Auto-rebased anchor ${stale}`);
	});

	it("rejects when the line is in bounds but the hash matches no nearby line", () => {
		// Two-char hash, fabricated by guaranteeing it equals neither line 2's nor any other line's hash
		const fakeHash = computeLineHash(2, "bbb") === "zz" ? "yy" : "zz";
		const diff = [`= 2${fakeHash}`, "|BBB"].join("\n");
		expect(() => applyDiff("aaa\nbbb\nccc", diff)).toThrow(HashlineMismatchError);
	});

	it("rejects when multiple lines within the rebase window share the same hash", () => {
		// Significant-content lines hash by content alone; identical content gives
		// identical hashes, so multiple lines in ±5 collide and force a reject.
		const file = ["x = 1", "y = 2", "x = 1", "z = 3", "x = 1", "w = 4"].join("\n");
		const collidingHash = computeLineHash(1, "x = 1");
		// User points at line 4 (`z = 3`) with the colliding hash; the rebase
		// window covers lines 1, 3, and 5, all of which match — ambiguous.
		const diff = [`= 4${collidingHash}`, "|REPLACED"].join("\n");
		expect(() => applyDiff(file, diff)).toThrow(HashlineMismatchError);
	});
});

describe("splitHashlineInput — @ headers", () => {
	it("extracts path and diff body from @path header", () => {
		const input = [`@src/foo.ts`, `= ${tag(2, "bbb")}`, "|BBB"].join("\n");
		expect(splitHashlineInput(input)).toEqual({ path: "src/foo.ts", diff: `= ${tag(2, "bbb")}\n|BBB` });
	});

	it("strips leading blank lines and unquotes matching path quotes", () => {
		expect(splitHashlineInput(`\n@"foo bar.ts"\n+ BOF\n|x`)).toEqual({ path: "foo bar.ts", diff: "+ BOF\n|x" });
	});

	it("normalizes cwd-prefixed absolute paths to cwd-relative paths", () => {
		const cwd = process.cwd();
		const absolute = path.join(cwd, "src", "foo.ts");
		expect(splitHashlineInput(`@${absolute}\n+ BOF\n|x`, { cwd }).path).toBe("src/foo.ts");
	});

	it("uses explicit fallback path only when input has recognizable operations", () => {
		expect(splitHashlineInput("+ BOF\n|x", { path: "a.ts" })).toEqual({ path: "a.ts", diff: "+ BOF\n|x" });
		expect(() => splitHashlineInput("plain text", { path: "a.ts" })).toThrow(/must begin with/);
	});

	it("splits multiple edit sections", () => {
		const input = ["@a.ts", "+ BOF", "|a", "@b.ts", "+ EOF", "|b"].join("\n");
		expect(splitHashlineInputs(input)).toEqual([
			{ path: "a.ts", diff: "+ BOF\n|a" },
			{ path: "b.ts", diff: "+ EOF\n|b" },
		]);
	});
});

describe("hashline executor", () => {
	it("creates a missing file with a file-scoped insert", async () => {
		await withTempDir(async tempDir => {
			const input = "@new.ts\n+ BOF\n|export const x = 1;\n";
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, input));
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("new.ts:");
			expect(await Bun.file(path.join(tempDir, "new.ts")).text()).toBe("export const x = 1;");
		});
	});

	it("preflights every section before writing multi-file edits", async () => {
		await withTempDir(async tempDir => {
			const aPath = path.join(tempDir, "a.ts");
			const bPath = path.join(tempDir, "b.ts");
			await Bun.write(aPath, "aaa\n");
			await Bun.write(bPath, "bbb\n");
			const input = ["@a.ts", `= ${tag(1, "aaa")}`, "|AAA", "@b.ts", `= ${mistag(1, "bbb")}`, "|BBB"].join("\n");

			await expect(executeHashlineSingle(hashlineExecuteOptions(tempDir, input))).rejects.toThrow(
				/changed since the last read/,
			);
			expect(await Bun.file(aPath).text()).toBe("aaa\n");
			expect(await Bun.file(bPath).text()).toBe("bbb\n");
		});
	});
});

describe("hashlineEditParamsSchema — extra-field tolerance", () => {
	it("accepts extra `path` field alongside `input`", () => {
		expect(Value.Check(hashlineEditParamsSchema, { path: "x.ts", input: "@x.ts\n+ BOF\n|x" })).toBe(true);
	});

	it("still requires `input`", () => {
		expect(Value.Check(hashlineEditParamsSchema, { path: "x.ts" })).toBe(false);
	});
});

describe("buildCompactHashlineDiffPreview — anchors track post-edit line numbers", () => {
	it("emits hashes against the new file's line numbers for context after a range expansion", () => {
		const before = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"].join("\n");
		const after = ["a1", "a2", "a3", "X", "Y", "Z", "a5", "a6", "a7"].join("\n");
		const { diff } = generateDiffString(before, after);
		const preview = buildCompactHashlineDiffPreview(diff);

		// Walk the preview and verify every ` LINE+HASH|content` line matches what
		// the file now has at that line number.
		const newFileLines = after.split("\n");
		for (const line of preview.preview.split("\n")) {
			if (!line.startsWith(" ")) continue;
			// Skip context-elision markers ("...") which carry no real file content.
			if (line.endsWith("|...")) continue;
			const match = /^\s(\d+)([a-z]{2})\|(.*)$/.exec(line);
			expect(match).not.toBeNull();
			if (!match) continue;
			const lineNum = Number(match[1]);
			const hash = match[2];
			const content = match[3];
			expect(newFileLines[lineNum - 1]).toBe(content);
			expect(computeLineHash(lineNum, content)).toBe(hash);
		}
	});

	it("emits + lines with hashes against new line numbers and - lines with the placeholder", () => {
		const before = "alpha\nbeta\ngamma\n";
		const after = "alpha\nDELTA\nEPSILON\ngamma\n";
		const { diff } = generateDiffString(before, after);
		const preview = buildCompactHashlineDiffPreview(diff);

		const additions = preview.preview.split("\n").filter(line => line.startsWith("+"));
		expect(additions).toEqual([
			`+2${computeLineHash(2, "DELTA")}|DELTA`,
			`+3${computeLineHash(3, "EPSILON")}|EPSILON`,
		]);

		const removals = preview.preview.split("\n").filter(line => line.startsWith("-"));
		expect(removals).toEqual(["-2--|beta"]);
	});
});

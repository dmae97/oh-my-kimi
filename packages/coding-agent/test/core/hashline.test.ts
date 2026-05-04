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
	HL_BODY_SEP,
	HL_BODY_SEP_RE_RAW,
	HL_EDIT_SEP,
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

// Single source of truth for the payload separator under test. Every literal
// payload line in this file goes through `pl()` so flipping
// `HL_EDIT_SEP` (e.g. to ">" or "\\") flips the test inputs in
// lockstep without any `|`-vs-`>` churn.
const sep = HL_EDIT_SEP;
const pl = (text: string): string => `${sep}${text}`;
const outputSep = HL_BODY_SEP;
const outputSepRe = HL_BODY_SEP_RE_RAW;

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
			pl("before b"),
			`+ ${tag(2, "bbb")}`,
			pl("after b"),
			"+ BOF",
			pl("top"),
			"+ EOF",
			pl("tail"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("top\naaa\nbefore b\nbbb\nafter b\nccc\ntail");
	});

	it("inserts after the final line via `+ ANCHOR` instead of falling off the file", () => {
		const diff = [`+ ${tag(3, "ccc")}`, pl("tail")].join("\n");
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
		const single = [`= ${tag(2, "bbb")}`, pl("BBB")].join("\n");
		expect(applyDiff(content, single)).toBe("aaa\nBBB\nccc");

		const range = [`= ${tag(2, "bbb")}..${tag(3, "ccc")}`, pl("BBB"), pl("CCC")].join("\n");
		expect(applyDiff(content, range)).toBe("aaa\nBBB\nCCC");
	});

	it("auto-absorbs duplicated multiline prefix boundaries during replacement", () => {
		const source = ["// one", "// two", "old();"].join("\n");
		const diff = [`= ${tag(3, "old();")}`, pl("// one"), pl("// two"), pl("new();")].join("\n");

		expect(applyDiff(source, diff)).toBe(["// one", "// two", "new();"].join("\n"));
	});

	it("auto-absorbs duplicated multiline suffix boundaries during replacement", () => {
		const source = ["old();", "// one", "// two"].join("\n");
		const diff = [`= ${tag(1, "old();")}`, pl("new();"), pl("// one"), pl("// two")].join("\n");

		expect(applyDiff(source, diff)).toBe(["new();", "// one", "// two"].join("\n"));
	});

	it("does not auto-absorb a single duplicated boundary line", () => {
		const source = ["keep", "old();"].join("\n");
		const diff = [`= ${tag(2, "old();")}`, pl("keep"), pl("new();")].join("\n");

		expect(applyDiff(source, diff)).toBe(["keep", "keep", "new();"].join("\n"));
	});

	it("does not auto-absorb a duplicate boundary that another op already targets", () => {
		// Lines 3-4 ("X","Y") match the payload's trailing block, but line 4
		// is also the anchor of a separate insert. Absorbing it would silently
		// steal that anchor and turn the insert into a replacement.
		const source = ["A", "B", "X", "Y", "Z"].join("\n");
		const diff = [
			`= ${tag(1, "A")}..${tag(2, "B")}`,
			pl("alpha"),
			pl("X"),
			pl("Y"),
			`< ${tag(4, "Y")}`,
			pl("extra"),
		].join("\n");

		expect(applyDiff(source, diff)).toBe(["alpha", "X", "Y", "X", "extra", "Y", "Z"].join("\n"));
	});

	it("surfaces a warning when boundary duplicates are auto-absorbed", () => {
		const source = ["// one", "// two", "old();"].join("\n");
		const diff = [`= ${tag(3, "old();")}`, pl("// one"), pl("// two"), pl("new();")].join("\n");

		const result = applyHashlineEdits(source, parseHashline(diff));
		expect(result.lines).toBe(["// one", "// two", "new();"].join("\n"));
		expect(result.warnings).toBeDefined();
		expect(result.warnings).toEqual(
			expect.arrayContaining([expect.stringMatching(/Auto-absorbed 2 duplicate line\(s\) above replacement/)]),
		);
	});

	it("auto-absorbs duplicated leading payload of a pure `+ ANCHOR` insert", () => {
		// `+ 2 ~aaa ~bbb ~NEW`: payload echoes the two file lines AT/ABOVE the
		// insertion point (aaa, bbb), then adds NEW. The leading echo is absorbed.
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`+ ${tag(2, "bbb")}`, pl("aaa"), pl("bbb"), pl("NEW")].join("\n");
		expect(applyDiff(source, diff)).toBe("aaa\nbbb\nNEW\nccc");
	});

	it("auto-absorbs context-wrap echo (leading-above + trailing-below) on `+ ANCHOR`", () => {
		// `+ 2 ~aaa ~bbb ~NEW ~ccc ~ddd`: payload wraps NEW with context above
		// (aaa, bbb) AND below (ccc, ddd). Both ends should be absorbed, leaving
		// only NEW inserted after bbb.
		const source = ["aaa", "bbb", "ccc", "ddd"].join("\n");
		const diff = [`+ ${tag(2, "bbb")}`, pl("aaa"), pl("bbb"), pl("NEW"), pl("ccc"), pl("ddd")].join("\n");
		expect(applyDiff(source, diff)).toBe("aaa\nbbb\nNEW\nccc\nddd");
	});

	it("auto-absorbs duplicated trailing payload of a pure `< ANCHOR` insert", () => {
		// Insert before line 3 ("ccc"). Trailing payload echoes the anchor and the
		// line after it. Drop the trailing duplicates.
		const source = ["aaa", "bbb", "ccc", "ddd"].join("\n");
		const diff = [`< ${tag(3, "ccc")}`, pl("NEW"), pl("ccc"), pl("ddd")].join("\n");
		expect(applyDiff(source, diff)).toBe("aaa\nbbb\nNEW\nccc\nddd");
	});

	it("auto-absorbs duplicated leading payload at EOF insert", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		// `+ EOF` payload echoes the last two file lines, then adds NEW.
		const diff = ["+ EOF", pl("bbb"), pl("ccc"), pl("NEW")].join("\n");
		expect(applyDiff(source, diff)).toBe("aaa\nbbb\nccc\nNEW");
	});

	it("auto-absorbs duplicated trailing payload at BOF insert", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		// `< BOF` payload prepends NEW but trails with the first two file lines.
		const diff = ["< BOF", pl("NEW"), pl("aaa"), pl("bbb")].join("\n");
		expect(applyDiff(source, diff)).toBe("NEW\naaa\nbbb\nccc");
	});

	it("does not auto-absorb a single duplicated boundary line in a pure insert", () => {
		// One-line echo should NOT trigger absorb (matches replacement-absorb threshold).
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`+ ${tag(2, "bbb")}`, pl("bbb"), pl("NEW")].join("\n");
		// Only "bbb" matches above; that's a 1-line dup, not absorbed.
		expect(applyDiff(source, diff)).toBe("aaa\nbbb\nbbb\nNEW\nccc");
	});

	it("surfaces a warning when pure-insert duplicates are auto-dropped", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`+ ${tag(2, "bbb")}`, pl("aaa"), pl("bbb"), pl("NEW")].join("\n");
		const result = applyHashlineEdits(source, parseHashline(diff));
		expect(result.lines).toBe("aaa\nbbb\nNEW\nccc");
		expect(result.warnings).toBeDefined();
		expect(result.warnings).toEqual(
			expect.arrayContaining([expect.stringMatching(/Auto-dropped 2 duplicate line\(s\) at the start of insert/)]),
		);
	});

	it("preserves payload text exactly after the first separator", () => {
		const diff = [`= ${tag(2, "bbb")}`, pl(""), pl("# not a header"), pl("+ not an op"), pl("  spaced")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\n\n# not a header\n+ not an op\n  spaced\nccc");
	});

	it("rejects missing payloads and orphan payload lines", () => {
		expect(() => parseHashline(`+ ${tag(1, "aaa")}`)).toThrow(/require at least one/);
		expect(() => parseHashline(pl("orphan"))).toThrow(/payload line has no preceding/);
	});

	it("rejects old cursor and equals-inline syntax after cutover", () => {
		expect(() => parseHashline(`@${tag(1, "aaa")}\n+old`)).toThrow(/unrecognized op/);
		expect(() => parseHashline(`${tag(1, "aaa")}=AAA`)).toThrow(/unrecognized op/);
	});
});

describe("hashline parser — inline modify syntax", () => {
	const content = "alpha\nbeta\ngamma";

	it("prepends text to the anchored line via `< ANCHOR<sep>TEXT`", () => {
		const diff = `< ${tag(2, "beta")}${pl("// ")}`;
		expect(applyDiff(content, diff)).toBe("alpha\n// beta\ngamma");
	});

	it("appends text to the anchored line via `+ ANCHOR<sep>TEXT`", () => {
		const diff = `+ ${tag(2, "beta")}${pl(" // tag")}`;
		expect(applyDiff(content, diff)).toBe("alpha\nbeta // tag\ngamma");
	});

	it("combines a prepend and an append on the same line", () => {
		const diff = [`< ${tag(2, "beta")}${pl("[")}`, `+ ${tag(2, "beta")}${pl("]")}`].join("\n");
		expect(applyDiff(content, diff)).toBe("alpha\n[beta]\ngamma");
	});

	it("stacks multiple prepends with later edits wrapping earlier ones", () => {
		const diff = [`< ${tag(2, "beta")}${pl("A")}`, `< ${tag(2, "beta")}${pl("B")}`].join("\n");
		expect(applyDiff(content, diff)).toBe("alpha\nBAbeta\ngamma");
	});

	it("stacks multiple appends with later edits wrapping earlier ones", () => {
		const diff = [`+ ${tag(2, "beta")}${pl("A")}`, `+ ${tag(2, "beta")}${pl("B")}`].join("\n");
		expect(applyDiff(content, diff)).toBe("alpha\nbetaAB\ngamma");
	});

	it("appends inline AND inserts payload lines after the modified line", () => {
		const diff = [`+ ${tag(2, "beta")}${pl(" // tag")}`, pl("inserted-after-1"), pl("inserted-after-2")].join("\n");
		expect(applyDiff(content, diff)).toBe("alpha\nbeta // tag\ninserted-after-1\ninserted-after-2\ngamma");
	});

	it("prepends inline AND inserts payload lines before the modified line", () => {
		const diff = [`< ${tag(2, "beta")}${pl("// ")}`, pl("inserted-before-1"), pl("inserted-before-2")].join("\n");
		expect(applyDiff(content, diff)).toBe("alpha\ninserted-before-1\ninserted-before-2\n// beta\ngamma");
	});

	it("allows a block insert-before to coexist with an inline modify on the same line", () => {
		const diff = [`< ${tag(2, "beta")}`, pl("// note"), `+ ${tag(2, "beta")}${pl("!")}`].join("\n");
		expect(applyDiff(content, diff)).toBe("alpha\n// note\nbeta!\ngamma");
	});

	it("rejects combining inline modify with a delete on the same line", () => {
		const diff = [`- ${tag(2, "beta")}`, `+ ${tag(2, "beta")}${pl("!")}`].join("\n");
		expect(() => applyDiff(content, diff)).toThrow(/cannot combine inline modify/);
	});

	it("validates the anchor hash for inline modify just like other ops", () => {
		const diff = `+ ${mistag(2, "beta")}${pl("!")}`;
		expect(() => applyDiff(content, diff)).toThrow(HashlineMismatchError);
	});

	it("treats an empty inline payload as a no-op when nothing else follows", () => {
		const diff = `+ ${tag(2, "beta")}${pl("")}`;
		const result = applyHashlineEdits(content, parseHashline(diff));
		expect(result.lines).toBe(content);
	});
});

describe("hashline — stale anchors", () => {
	it("throws HashlineMismatchError when a Lid hash no longer matches", () => {
		const diff = [`= ${mistag(2, "bbb")}`, pl("BBB")].join("\n");
		expect(() => applyDiff("aaa\nbbb\nccc", diff)).toThrow(HashlineMismatchError);
	});

	it("rebases a uniquely shifted anchor within the configured window", () => {
		const stale = tag(2, "bbb");
		const diff = [`= ${stale}`, pl("BBB")].join("\n");
		const result = applyHashlineEdits("aaa\nINSERTED\nbbb\nccc", parseHashline(diff));
		expect(result.lines).toBe("aaa\nINSERTED\nBBB\nccc");
		expect(result.warnings?.[0]).toContain(`Auto-rebased anchor ${stale}`);
	});

	it("rejects when the line is in bounds but the hash matches no nearby line", () => {
		// Two-char hash, fabricated by guaranteeing it equals neither line 2's nor any other line's hash
		const fakeHash = computeLineHash(2, "bbb") === "zz" ? "yy" : "zz";
		const diff = [`= 2${fakeHash}`, pl("BBB")].join("\n");
		expect(() => applyDiff("aaa\nbbb\nccc", diff)).toThrow(HashlineMismatchError);
	});

	it("rejects when multiple lines within the rebase window share the same hash", () => {
		// Significant-content lines hash by content alone; identical content gives
		// identical hashes, so multiple lines in ±5 collide and force a reject.
		const file = ["x = 1", "y = 2", "x = 1", "z = 3", "x = 1", "w = 4"].join("\n");
		const collidingHash = computeLineHash(1, "x = 1");
		// User points at line 4 (`z = 3`) with the colliding hash; the rebase
		// window covers lines 1, 3, and 5, all of which match — ambiguous.
		const diff = [`= 4${collidingHash}`, pl("REPLACED")].join("\n");
		expect(() => applyDiff(file, diff)).toThrow(HashlineMismatchError);
	});
});

describe("splitHashlineInput — @ headers", () => {
	it("extracts path and diff body from @path header", () => {
		const input = [`@src/foo.ts`, `= ${tag(2, "bbb")}`, pl("BBB")].join("\n");
		expect(splitHashlineInput(input)).toEqual({ path: "src/foo.ts", diff: `= ${tag(2, "bbb")}\n${pl("BBB")}` });
	});

	it("strips leading blank lines and unquotes matching path quotes", () => {
		expect(splitHashlineInput(`\n@"foo bar.ts"\n+ BOF\n${pl("x")}`)).toEqual({
			path: "foo bar.ts",
			diff: `+ BOF\n${pl("x")}`,
		});
	});

	it("normalizes cwd-prefixed absolute paths to cwd-relative paths", () => {
		const cwd = process.cwd();
		const absolute = path.join(cwd, "src", "foo.ts");
		expect(splitHashlineInput(`@${absolute}\n+ BOF\n${pl("x")}`, { cwd }).path).toBe("src/foo.ts");
	});

	it("uses explicit fallback path only when input has recognizable operations", () => {
		expect(splitHashlineInput(`+ BOF\n${pl("x")}`, { path: "a.ts" })).toEqual({
			path: "a.ts",
			diff: `+ BOF\n${pl("x")}`,
		});
		expect(() => splitHashlineInput("plain text", { path: "a.ts" })).toThrow(/must begin with/);
	});

	it("splits multiple edit sections", () => {
		const input = ["@a.ts", "+ BOF", pl("a"), "@b.ts", "+ EOF", pl("b")].join("\n");
		expect(splitHashlineInputs(input)).toEqual([
			{ path: "a.ts", diff: `+ BOF\n${pl("a")}` },
			{ path: "b.ts", diff: `+ EOF\n${pl("b")}` },
		]);
	});
});

describe("hashline executor", () => {
	it("creates a missing file with a file-scoped insert", async () => {
		await withTempDir(async tempDir => {
			const input = `@new.ts\n+ BOF\n${pl("export const x = 1;")}\n`;
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
			const input = ["@a.ts", `= ${tag(1, "aaa")}`, pl("AAA"), "@b.ts", `= ${mistag(1, "bbb")}`, pl("BBB")].join(
				"\n",
			);

			await expect(executeHashlineSingle(hashlineExecuteOptions(tempDir, input))).rejects.toThrow(
				/changed since the last read/,
			);
			expect(await Bun.file(aPath).text()).toBe("aaa\n");
			expect(await Bun.file(bPath).text()).toBe("bbb\n");
		});
	});

	it("applies multiple sections targeting the same file against the original snapshot", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const original = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"].join("\n");
			await Bun.write(filePath, `${original}\n`);

			// Two sections, both anchored against the ORIGINAL file. Section 1 expands
			// line 2 into 9 lines (net +8 shift, beyond the ±5 anchor rebase window).
			// Section 2's anchor points at line 8 of the original; after section 1
			// applies, that content moves to line 16. A naive sequential apply reads
			// the modified disk and fails anchor validation because rebase cannot
			// span the 8-line gap.
			const input = [
				"@a.ts",
				`= ${tag(2, "L2")}`,
				pl("L2a"),
				pl("L2b"),
				pl("L2c"),
				pl("L2d"),
				pl("L2e"),
				pl("L2f"),
				pl("L2g"),
				pl("L2h"),
				pl("L2i"),
				"@a.ts",
				`+ ${tag(8, "L8")}`,
				pl("INSERTED"),
			].join("\n");

			await executeHashlineSingle(hashlineExecuteOptions(tempDir, input));

			expect(await Bun.file(filePath).text()).toBe(
				[
					"L1",
					"L2a",
					"L2b",
					"L2c",
					"L2d",
					"L2e",
					"L2f",
					"L2g",
					"L2h",
					"L2i",
					"L3",
					"L4",
					"L5",
					"L6",
					"L7",
					"L8",
					"INSERTED",
					"L9",
					"L10",
					"",
				].join("\n"),
			);
		});
	});
});

describe("hashlineEditParamsSchema — extra-field tolerance", () => {
	it("accepts extra `path` field alongside `input`", () => {
		expect(Value.Check(hashlineEditParamsSchema, { path: "x.ts", input: `@x.ts\n+ BOF\n${pl("x")}` })).toBe(true);
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

		// Walk the preview and verify every ` LINE+HASH${outputSep}content` line matches what
		// the file now has at that line number.
		const newFileLines = after.split("\n");
		for (const line of preview.preview.split("\n")) {
			if (!line.startsWith(" ")) continue;
			// Skip context-elision markers ("...") which carry no real file content.
			if (line.endsWith(`${outputSep}...`)) continue;
			const match = new RegExp(`^\\s(\\d+)([a-z]{2})${outputSepRe}(.*)$`).exec(line);
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
			`+2${computeLineHash(2, "DELTA")}${outputSep}DELTA`,
			`+3${computeLineHash(3, "EPSILON")}${outputSep}EPSILON`,
		]);

		const removals = preview.preview.split("\n").filter(line => line.startsWith("-"));
		expect(removals).toEqual([`-2--${outputSep}beta`]);
	});
});

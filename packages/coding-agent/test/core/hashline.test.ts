import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	applyHashlineEdits,
	buildCompactHashlineDiffPreview,
	computeFileHash,
	type ExecuteHashlineSingleOptions,
	executeHashlineSingle,
	FileReadCache,
	generateDiffString,
	getFileReadCache,
	HashlineMismatchError,
	hashlineEditParamsSchema,
	parseHashline,
	splitHashlineInput,
	splitHashlineInputs,
	tryRecoverHashlineWithCache,
} from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

const pl = (text: string): string => text;
const extra = (text: string): string => `+${text}`;
const outputSep = ":";
const outputSepRe = ":";

function tag(line: number, _content: string): string {
	return `${line}`;
}

function header(filePath: string, content: string): string {
	return `¶${filePath}#${computeFileHash(content)}`;
}

function sameLineRange(anchor: string): string {
	return `${anchor}-${anchor}`;
}

function applyDiff(content: string, diff: string): string {
	return applyHashlineEdits(content, parseHashline(diff).edits).lines;
}

function applyDiffWithPureInsertAutoDrop(content: string, diff: string): string {
	return applyHashlineEdits(content, parseHashline(diff).edits, { autoDropPureInsertDuplicates: true }).lines;
}

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-edit-"));
	try {
		await fn(tempDir);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

function makeHashlineSession(tempDir: string, settings = Settings.isolated()): ToolSession {
	return { cwd: tempDir, settings } as ToolSession;
}

function hashlineExecuteOptions(
	tempDir: string,
	input: string,
	settings = Settings.isolated(),
	session: ToolSession = makeHashlineSession(tempDir, settings),
): ExecuteHashlineSingleOptions {
	return {
		session,
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

describe("hashline parser — suffix-op syntax", () => {
	const content = "aaa\nbbb\nccc";

	it("inserts payload before/after a Lid, and at BOF/EOF", () => {
		const diff = [
			`${tag(2, "bbb")}↑`,
			extra("before b"),
			`${tag(2, "bbb")}↓`,
			extra("after b"),
			"BOF↓",
			extra("top"),
			"EOF↓",
			extra("tail"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("top\naaa\nbefore b\nbbb\nafter b\nccc\ntail");
	});

	it("inserts after the final line via `ANCHOR↓` instead of falling off the file", () => {
		const diff = [`${tag(3, "ccc")}↓`, extra("tail")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nbbb\nccc\ntail");
	});

	it("deletes one line or an inclusive range with `!`", () => {
		expect(applyDiff(content, `${sameLineRange(tag(2, "bbb"))}!`)).toBe("aaa\nccc");
		expect(applyDiff(content, `${tag(2, "bbb")}-${tag(3, "ccc")}!`)).toBe("aaa");
	});

	it("blanks a line in place with `A:` when given an explicit empty payload", () => {
		const explicit = `${sameLineRange(tag(2, "bbb"))}:`;
		expect(applyDiff(content, explicit)).toBe("aaa\n\nccc");
	});

	it("replaces one line or an inclusive range with payload lines", () => {
		const single = [`${tag(2, "bbb")}:`, extra("BBB")].join("\n");
		expect(applyDiff(content, single)).toBe("aaa\nBBB\nccc");

		const range = [`${tag(2, "bbb")}-${tag(3, "ccc")}:`, extra("BBB"), extra("CCC")].join("\n");
		expect(applyDiff(content, range)).toBe("aaa\nBBB\nCCC");
	});

	it("treats single-anchor replace sugar as equivalent to an explicit one-line range", () => {
		const anchor = tag(2, "bbb");
		expect(parseHashline(`${anchor}:\n${extra("BBB")}\n${extra("CCC")}`).edits).toEqual(
			parseHashline(`${anchor}-${anchor}:\n${extra("BBB")}\n${extra("CCC")}`).edits,
		);
		expect(applyDiff(content, `${anchor}:\n${extra("BBB")}\n${extra("CCC")}`)).toBe(
			applyDiff(content, `${anchor}-${anchor}:\n${extra("BBB")}\n${extra("CCC")}`),
		);
	});

	it("warns when inline payload is used on insert and replace ops but still applies the edit", () => {
		const anchor = tag(2, "bbb");
		const warning = /Accepted inline payload on the op line/;
		const cases: Array<[string, string]> = [
			[`${anchor}↓NEW`, "aaa\nbbb\nNEW\nccc"],
			[`${anchor}↑NEW`, "aaa\nNEW\nbbb\nccc"],
			[`${anchor}:NEW`, "aaa\nNEW\nccc"],
		];
		for (const [diff, expected] of cases) {
			const parsed = parseHashline(diff);
			expect(parsed.warnings.some(w => warning.test(w))).toBe(true);
			expect(applyDiff(content, diff)).toBe(expected);
		}
	});

	it("accepts payload lines on insert ops with `+` continuation", () => {
		const anchor = tag(2, "bbb");
		const diff = [`${anchor}↓`, extra("first line"), extra("second line")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nbbb\nfirst line\nsecond line\nccc");
	});

	it("accepts payload lines on the replace op with `+` continuation", () => {
		const anchor = tag(2, "bbb");
		const diff = [`${anchor}:`, extra("FIRST"), extra("SECOND")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nFIRST\nSECOND\nccc");
	});

	it("accepts unprefixed payload continuation lines as implicit continuation with a warning", () => {
		const anchor = tag(2, "bbb");
		const parsed = parseHashline(`${anchor}:\n${extra("FIRST")}\nSECOND`);
		expect(parsed.warnings.some(w => w.includes("without the `+` prefix"))).toBe(true);
		expect(applyDiff(content, `${anchor}:\n${extra("FIRST")}\nSECOND`)).toBe("aaa\nFIRST\nSECOND\nccc");
	});

	it("preserves whitespace-bearing payload exactly", () => {
		const anchor = tag(2, "bbb");
		const payload = "\tconst streamKeepaliveMs = opts.streamKeepaliveMs;";
		expect(applyDiff(content, [`${anchor}↓`, extra(payload)].join("\n"))).toBe(`aaa\nbbb\n${payload}\nccc`);
		expect(applyDiff(content, [`${anchor}↑`, extra(payload)].join("\n"))).toBe(`aaa\n${payload}\nbbb\nccc`);
	});

	it("auto-absorbs duplicated multiline prefix boundaries during replacement", () => {
		const source = ["// one", "// two", "old();"].join("\n");
		const diff = [`${sameLineRange(tag(3, "old();"))}:`, extra("// one"), extra("// two"), extra("new();")].join(
			"\n",
		);

		expect(applyDiff(source, diff)).toBe(["// one", "// two", "new();"].join("\n"));
	});

	it("auto-absorbs duplicated multiline suffix boundaries during replacement", () => {
		const source = ["old();", "// one", "// two"].join("\n");
		const diff = [`${sameLineRange(tag(1, "old();"))}:`, extra("new();"), extra("// one"), extra("// two")].join(
			"\n",
		);

		expect(applyDiff(source, diff)).toBe(["new();", "// one", "// two"].join("\n"));
	});

	it("auto-absorbs a duplicated single structural suffix during replacement", () => {
		const source = ["old();", "};"].join("\n");
		const diff = [`${sameLineRange(tag(1, "old();"))}:`, extra("new();"), extra("};")].join("\n");

		expect(applyDiff(source, diff)).toBe(["new();", "};"].join("\n"));
	});

	it("auto-absorbs a duplicated single structural prefix during replacement", () => {
		const source = ["};", "old();"].join("\n");
		const diff = [`${sameLineRange(tag(2, "old();"))}:`, extra("};"), extra("new();")].join("\n");

		expect(applyDiff(source, diff)).toBe(["};", "new();"].join("\n"));
	});

	it("does not absorb a single structural replacement suffix when it preserves balance", () => {
		// The replacement payload `if ok {` + `}` is itself net-zero, so the trailing
		// `}` is a legitimate part of the new block, not a duplicate of the file's
		// existing `}`. The single-line structural absorb must NOT fire here.
		const source = ["old();", "}"].join("\n");
		const diff = [`${sameLineRange(tag(1, "old();"))}:`, extra("if ok {"), extra("}")].join("\n");

		expect(applyDiff(source, diff)).toBe(["if ok {", "}", "}"].join("\n"));
	});

	it("does not auto-absorb a single duplicated boundary line", () => {
		const source = ["keep", "old();"].join("\n");
		const diff = [`${sameLineRange(tag(2, "old();"))}:`, extra("keep"), extra("new();")].join("\n");

		expect(applyDiff(source, diff)).toBe(["keep", "keep", "new();"].join("\n"));
	});

	it("does not auto-absorb a duplicate boundary that another op already targets", () => {
		// Lines 3-4 ("X","Y") match the payload's trailing block, but line 4
		// is also the anchor of a separate insert. Absorbing it would silently
		// steal that anchor and turn the insert into a replacement.
		const source = ["A", "B", "X", "Y", "Z"].join("\n");
		const diff = [
			`${tag(1, "A")}-${tag(2, "B")}:`,
			extra("alpha"),
			extra("X"),
			extra("Y"),
			`${tag(4, "Y")}↑`,
			extra("extra"),
		].join("\n");

		expect(applyDiff(source, diff)).toBe(["alpha", "X", "Y", "X", "extra", "Y", "Z"].join("\n"));
	});

	it("surfaces a warning when boundary duplicates are auto-absorbed", () => {
		const source = ["// one", "// two", "old();"].join("\n");
		const diff = [`${sameLineRange(tag(3, "old();"))}:`, extra("// one"), extra("// two"), extra("new();")].join(
			"\n",
		);

		const result = applyHashlineEdits(source, parseHashline(diff).edits);
		expect(result.lines).toBe(["// one", "// two", "new();"].join("\n"));
		expect(result.warnings).toBeDefined();
		expect(result.warnings).toEqual(
			expect.arrayContaining([expect.stringMatching(/Auto-absorbed 2 duplicate line\(s\) above replacement/)]),
		);
	});

	it("auto-absorbs a single duplicated non-structural prefix during replacement when opt-in is set", () => {
		// Regression: `103-138:const X = …` over a file whose line 102 already
		// reads `const X = …` produced two consecutive declarations. With the
		// opt-in on, the leading boundary line gets dropped.
		const source = ["const X = …", "", "const LEGACY = {", "  a: 1,", "}"].join("\n");
		const diff = [`${tag(2, "")}-${tag(5, "}")}:`, extra("const X = …")].join("\n");

		const result = applyHashlineEdits(source, parseHashline(diff).edits, { autoDropPureInsertDuplicates: true });
		expect(result.lines).toBe(["const X = …"].join("\n"));
		expect(result.warnings).toEqual(
			expect.arrayContaining([expect.stringMatching(/Auto-absorbed 1 duplicate line\(s\) above replacement/)]),
		);
	});

	it("auto-absorbs a single duplicated non-structural suffix during replacement when opt-in is set", () => {
		// Regression: `93-104:## Subagents` over a file whose line 105 already
		// reads `## Subagents` produced two consecutive headings. With the
		// opt-in on, the trailing boundary line gets dropped.
		const source = ["## Legacy", "", "stale content", "", "## Subagents"].join("\n");
		const diff = [`${tag(1, "## Legacy")}-${tag(4, "")}:`, extra("## Subagents")].join("\n");

		const result = applyHashlineEdits(source, parseHashline(diff).edits, { autoDropPureInsertDuplicates: true });
		expect(result.lines).toBe(["## Subagents"].join("\n"));
		expect(result.warnings).toEqual(
			expect.arrayContaining([expect.stringMatching(/Auto-absorbed 1 duplicate line\(s\) below replacement/)]),
		);
	});

	it("preserves a legitimate single-line replacement that happens to match an adjacent line by default", () => {
		// Without the opt-in, `2:foo` over `[1]foo,[2]bar,[3]baz` must still
		// produce two consecutive `foo` lines. The non-structural single-line
		// absorber stays gated on `autoDropPureInsertDuplicates`.
		const source = ["foo", "bar", "baz"].join("\n");
		const diff = [`${sameLineRange(tag(2, "bar"))}:`, extra("foo")].join("\n");

		expect(applyDiff(source, diff)).toBe(["foo", "foo", "baz"].join("\n"));
	});

	it("does not auto-drop generic (multi-line) pure-insert duplicate boundaries by default", () => {
		// Multi-line context echo (`aaa`, `bbb`) is gated on the
		// `autoDropPureInsertDuplicates` opt-in. Single-line pure-insert
		// duplicates stay literal because they are ambiguous.
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`${tag(2, "bbb")}↓`, extra("aaa"), extra("bbb"), extra("NEW")].join("\n");
		expect(applyDiff(source, diff)).toBe("aaa\nbbb\naaa\nbbb\nNEW\nccc");
	});

	it("preserves a duplicated single structural suffix for pure insert by default", () => {
		const source = ["if ok {", "   keep();", "   }"].join("\n");
		const diff = [`${tag(3, "   }")}↑`, extra("   added();"), extra("   }")].join("\n");

		expect(applyDiff(source, diff)).toBe(["if ok {", "   keep();", "   added();", "   }", "   }"].join("\n"));
	});

	it("preserves a duplicated single structural prefix for pure insert even when duplicate absorption is enabled", () => {
		const source = ["   });", "next();"].join("\n");
		const diff = [`${tag(1, "   });")}↓`, extra("   });"), extra("added();")].join("\n");
		const result = applyHashlineEdits(source, parseHashline(diff).edits, { autoDropPureInsertDuplicates: true });

		expect(result.lines).toBe(["   });", "   });", "added();", "next();"].join("\n"));
		expect(result.warnings).toBeUndefined();
	});

	it("preserves an intentional non-structural anchor duplicate for `ANCHOR↓` by default", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`${tag(2, "bbb")}↓`, extra("bbb"), extra("NEW")].join("\n");

		expect(applyDiff(source, diff)).toBe("aaa\nbbb\nbbb\nNEW\nccc");
	});

	it("preserves an intentional non-structural anchor duplicate for `ANCHOR↑` by default", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`${tag(2, "bbb")}↑`, extra("NEW"), extra("bbb")].join("\n");

		expect(applyDiff(source, diff)).toBe("aaa\nNEW\nbbb\nbbb\nccc");
	});

	it("does not drop a single structural pure-insert suffix when it preserves balance", () => {
		const source = ["if outer {", "}"].join("\n");
		const diff = [`${tag(2, "}")}↑`, extra("if inner {"), extra("}")].join("\n");

		expect(applyDiff(source, diff)).toBe(["if outer {", "if inner {", "}", "}"].join("\n"));
	});

	it("auto-absorbs duplicated leading payload of a pure `ANCHOR↓` insert", () => {
		// Payload echoes the two file lines AT/ABOVE the insertion point
		// (aaa, bbb), then adds NEW. The leading echo is absorbed.
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`${tag(2, "bbb")}↓`, extra("aaa"), extra("bbb"), extra("NEW")].join("\n");
		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("aaa\nbbb\nNEW\nccc");
	});

	it("auto-absorbs context-wrap echo (leading-above + trailing-below) on `ANCHOR↓`", () => {
		// Payload wraps NEW with context above (aaa, bbb) AND below (ccc, ddd).
		// Both ends should be absorbed, leaving only NEW inserted after bbb.
		const source = ["aaa", "bbb", "ccc", "ddd"].join("\n");
		const diff = [`${tag(2, "bbb")}↓`, extra("aaa"), extra("bbb"), extra("NEW"), extra("ccc"), extra("ddd")].join(
			"\n",
		);
		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("aaa\nbbb\nNEW\nccc\nddd");
	});

	it("auto-absorbs duplicated trailing payload of a pure `ANCHOR↑` insert", () => {
		// Insert before line 3 ("ccc"). Trailing payload echoes the anchor and the
		// line after it. Drop the trailing duplicates.
		const source = ["aaa", "bbb", "ccc", "ddd"].join("\n");
		const diff = [`${tag(3, "ccc")}↑`, extra("NEW"), extra("ccc"), extra("ddd")].join("\n");
		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("aaa\nbbb\nNEW\nccc\nddd");
	});

	it("auto-absorbs duplicated leading payload at EOF insert", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		// `EOF↓` payload echoes the last two file lines, then adds NEW.
		const diff = ["EOF↓", extra("bbb"), extra("ccc"), extra("NEW")].join("\n");
		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("aaa\nbbb\nccc\nNEW");
	});

	it("auto-absorbs duplicated trailing payload at BOF insert", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		// `BOF↑` payload prepends NEW but trails with the first two file lines.
		const diff = ["BOF↑", extra("NEW"), extra("aaa"), extra("bbb")].join("\n");
		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("NEW\naaa\nbbb\nccc");
	});

	it("preserves a single duplicated anchor line in a pure insert even when generic duplicate absorption is enabled", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`${tag(2, "bbb")}↓`, extra("bbb"), extra("NEW")].join("\n");

		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("aaa\nbbb\nbbb\nNEW\nccc");
	});

	it("surfaces a warning when pure-insert duplicates are auto-dropped", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`${tag(2, "bbb")}↓`, extra("aaa"), extra("bbb"), extra("NEW")].join("\n");
		const result = applyHashlineEdits(source, parseHashline(diff).edits, { autoDropPureInsertDuplicates: true });
		expect(result.lines).toBe("aaa\nbbb\nNEW\nccc");
		expect(result.warnings).toBeDefined();
		expect(result.warnings).toEqual(
			expect.arrayContaining([expect.stringMatching(/Auto-dropped 2 duplicate line\(s\) at the start of insert/)]),
		);
	});

	it("preserves payload text exactly", () => {
		const diff = [
			`${sameLineRange(tag(2, "bbb"))}:`,
			extra(""),
			extra("# not a header"),
			extra("+ not an op"),
			extra("  spaced"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\n\n# not a header\n+ not an op\n  spaced\nccc");
	});

	it("treats plus-only payload lines as empty payload lines", () => {
		const diff = [`${sameLineRange(tag(2, "bbb"))}:first`, extra(""), extra(""), extra("after")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nfirst\n\n\nafter\nccc");
	});

	it("ignores raw blank separators between ops", () => {
		const diff = [`${sameLineRange(tag(1, "aaa"))}:AAA`, "", "", `${sameLineRange(tag(3, "ccc"))}:CCC`].join("\n");
		expect(applyDiff(content, diff)).toBe("AAA\nbbb\nCCC");
	});

	it("treats a bare insert op as inserting one empty line", () => {
		// `LINE↑` / `LINE↓` with no payload default to one empty line.
		const upAnchor = { line: 1 };
		expect(parseHashline(`${tag(1, "aaa")}↑`).edits).toEqual([
			{ kind: "insert", cursor: { kind: "before_anchor", anchor: upAnchor }, text: "", lineNum: 1, index: 0 },
		]);
		expect(parseHashline(`${tag(1, "aaa")}↓`).edits).toEqual([
			{ kind: "insert", cursor: { kind: "after_anchor", anchor: upAnchor }, text: "", lineNum: 1, index: 0 },
		]);
	});

	it("rejects orphan payload lines with no preceding op", () => {
		expect(() => parseHashline(extra("orphan")).edits).toThrow(/payload line has no preceding/);
	});

	it("rejects op sigils written in prefix position", () => {
		expect(() => parseHashline(`↑${tag(1, "aaa")}\nold`).edits).toThrow(/unrecognized op/);
		expect(() => parseHashline(`↓${tag(1, "aaa")}\nold`).edits).toThrow(/unrecognized op/);
		expect(() => parseHashline(`:${tag(1, "aaa")}\nold`).edits).toThrow(/unrecognized op/);
	});

	it("rejects ranges with `..` separator", () => {
		// `..` is no longer the range separator; the line is treated as orphan
		// payload because `2..3:` does not match the new range pattern.
		expect(() => parseHashline(`${tag(2, "bbb")}..${tag(3, "ccc")}:\n${extra("BBB")}`).edits).toThrow(
			/payload line has no preceding/,
		);
	});

	it("describes the new sigil shape on unknown-op lines", () => {
		expect(() => parseHashline(`-${sameLineRange(tag(2, "bbb"))}`).edits).toThrow(
			/Use LINE↑.*LINE↓.*LINE: \/ A-B:.*LINE! \/ A-B!/,
		);
	});

	it("accepts `LINE:TEXT` copied verbatim from read output with a deprecation warning", () => {
		const anchor = tag(2, "bbb");
		const warning = /Accepted inline payload on the op line/;
		const single = parseHashline(`${anchor}:BBB`);
		expect(single.warnings.some(w => warning.test(w))).toBe(true);
		expect(applyDiff(content, `${anchor}:BBB`)).toBe("aaa\nBBB\nccc");

		const ranged = parseHashline(`${anchor}-${tag(3, "ccc")}:BBB`);
		expect(ranged.warnings.some(w => warning.test(w))).toBe(true);
		expect(applyDiff(content, `${anchor}-${tag(3, "ccc")}:BBB`)).toBe("aaa\nBBB");
	});

	it("leniently strips `*`/`>` line-marker decoration from anchors", () => {
		const anchor = tag(2, "bbb");
		expect(applyDiff(content, `*${anchor}:\n${extra("BBB")}`)).toBe("aaa\nBBB\nccc");
		expect(applyDiff(content, `>${anchor}↑\n${extra("X")}`)).toBe("aaa\nX\nbbb\nccc");
	});

	it("rejects arrow replace syntax as an unrecognized payload line", () => {
		expect(() => parseHashline(`2→\nBBB`).edits).toThrow(/payload line has no preceding/);
		expect(() => parseHashline(`2-3→\nBBB`).edits).toThrow(/payload line has no preceding/);
	});

	it("treats `LINE:TEXT` as replace syntax even when TEXT contains ↑ / ↓", () => {
		const anchor = tag(2, "bbb");
		// Inline payload still warns but applies; the embedded ↑/↓ are literal payload bytes.
		const warning = /Accepted inline payload on the op line/;
		const a = parseHashline(`${anchor}:bbb↓`);
		expect(a.warnings.some(w => warning.test(w))).toBe(true);
		expect(applyDiff(content, `${anchor}:bbb↓`)).toBe("aaa\nbbb↓\nccc");

		const b = parseHashline(`${anchor}:bbb↑\n${extra("X")}`);
		expect(b.warnings.some(w => warning.test(w))).toBe(true);
		expect(applyDiff(content, `${anchor}:bbb↑\n${extra("X")}`)).toBe("aaa\nbbb↑\nX\nccc");
	});

	it("accepts BOF/EOF inserts with inline payload (with warning) or `+` continuation", () => {
		expect(applyDiff(content, `BOF↓\n${extra("HEAD")}`)).toBe("HEAD\naaa\nbbb\nccc");
		expect(applyDiff(content, `EOF↓\n${extra("TAIL")}`)).toBe("aaa\nbbb\nccc\nTAIL");
		const inline = parseHashline(`BOF↓HEAD`);
		expect(inline.warnings.some(w => /Accepted inline payload on the op line/.test(w))).toBe(true);
		expect(applyDiff(content, `BOF↓HEAD`)).toBe("HEAD\naaa\nbbb\nccc");
		expect(() => parseHashline(`2!keep`).edits).toThrow(
			/deletes only\. Payload is forbidden after !; use : to replace/,
		);
	});

	it("coalesces two replace ops targeting the same single line (last wins)", () => {
		const diff = `${tag(2, "bbb")}:\n${extra("BBB")}\n${tag(2, "bbb")}:\n${extra("BBB2")}`;
		const { edits, warnings } = parseHashline(diff);
		expect(applyHashlineEdits("aaa\nbbb\nccc", edits).lines).toBe("aaa\nBBB2\nccc");
		expect(warnings).toEqual([
			"Detected an identical-range before/after replace pair; kept only the second block's payload. Issue ONE op per range — the payload is the final desired content, never both old and new.",
		]);
	});

	it("coalesces two replace ops covering the same range (before/after-block pattern, last wins)", () => {
		const diff = `${tag(2, "bbb")}-${tag(3, "ccc")}:\n${extra("OLD")}\n${extra("OLD2")}\n${tag(2, "bbb")}-${tag(3, "ccc")}:\n${extra("NEW")}\n${extra("NEW2")}`;
		const { edits, warnings } = parseHashline(diff);
		expect(applyHashlineEdits("aaa\nbbb\nccc\nddd", edits).lines).toBe("aaa\nNEW\nNEW2\nddd");
		expect(warnings).toEqual([
			"Detected an identical-range before/after replace pair; kept only the second block's payload. Issue ONE op per range — the payload is the final desired content, never both old and new.",
		]);
	});

	it("still rejects two replace ops whose ranges partially overlap without containment", () => {
		// 3-5 extends past the outer 2-4, so it is neither identical nor contained.
		// The inner anchors still clash with the outer range's deletes and the
		// post-hoc validator catches the overlap.
		const diff = `${tag(2, "bbb")}-${tag(4, "ddd")}:\n${extra("NEW1")}\n${tag(3, "ccc")}-${tag(5, "eee")}:\n${extra("NEW2")}`;
		expect(() => parseHashline(diff).edits).toThrow(/anchor line 3 is already targeted by the .+ op on line 1/);
	});

	it("uses `+` payload lines inside a multi-line replacement", () => {
		const diff = `${tag(2, "bbb")}-${tag(4, "ddd")}:\n${extra("line one")}\n${extra("line two")}\n${extra("line three")}`;
		const { edits, warnings } = parseHashline(diff);
		expect(applyHashlineEdits("aaa\nbbb\nccc\nddd\neee", edits).lines).toBe(
			"aaa\nline one\nline two\nline three\neee",
		);
		expect(warnings).toEqual([]);
	});

	it("demotes read-output `N:TEXT` lines inside a pending `A-B:` as payload continuation with a warning", () => {
		// The demote path is the one place inline payload is tolerated: it
		// strips the `LINE:` prefix and appends `TEXT` to the outer pending
		// payload (with a warning) so the model's mistake doesn't fail loudly.
		const diff = `${tag(2, "bbb")}-${tag(4, "ddd")}:\n${extra("line one")}\n${tag(3, "ccc")}:line two`;
		const { warnings } = parseHashline(diff);
		expect(warnings.some(w => w.includes("LINE:TEXT"))).toBe(true);
		expect(applyDiff("aaa\nbbb\nccc\nddd\neee", diff)).toBe("aaa\nline one\nline two\neee");
	});

	it("treats `N:` outside the pending range as a separate op", () => {
		const diff = `${tag(2, "bbb")}-${tag(3, "ccc")}:\n${extra("line one")}\n${tag(5, "eee")}:\n${extra("line five")}`;
		const { edits, warnings } = parseHashline(diff);
		expect(applyHashlineEdits("aaa\nbbb\nccc\nddd\neee\nfff", edits).lines).toBe(
			"aaa\nline one\nddd\nline five\nfff",
		);
		expect(warnings).toEqual([]);
	});

	it("rejects a replace overlapping a later delete", () => {
		const diff = `${tag(2, "bbb")}-${tag(4, "ddd")}:\n${extra("X")}\n${tag(3, "ccc")}!`;
		expect(() => parseHashline(diff).edits).toThrow(/anchor line 3 is already targeted by the .+ op on line 1/);
	});

	it("rejects two deletes on the same line", () => {
		const diff = `${tag(2, "bbb")}!\n${tag(2, "bbb")}!`;
		expect(() => parseHashline(diff).edits).toThrow(/anchor line 2 is already targeted by the .+ op on line 1/);
	});

	it("accepts multiple inserts at the same anchor (sequential, not duplicates)", () => {
		// Two ↑ at the same line is a legitimate accumulation pattern — both
		// inserts above land in source order. Only deletes/replaces are
		// considered overlapping.
		const diff = `${tag(2, "bbb")}↑\n${extra("X")}\n${tag(2, "bbb")}↑\n${extra("Y")}`;
		expect(() => parseHashline(diff).edits).not.toThrow();
	});

	it("accepts a replace alongside an insert at the same anchor", () => {
		// `N:foo` deletes line N and inserts at before_anchor: N; `N↑bar`
		// adds another insert at the same cursor. No conflicting delete, so
		// this is allowed.
		const diff = `${tag(2, "bbb")}:\n${extra("NEW")}\n${tag(2, "bbb")}↑\n${extra("ABOVE")}`;
		expect(() => parseHashline(diff).edits).not.toThrow();
	});
});

describe("hashline — file hash binding", () => {
	it("rejects line-hash anchors as unrecognized payload lines", () => {
		expect(() => parseHashline(`2ab:\n${extra("BBB")}`).edits).toThrow(/payload line has no preceding/);
	});

	it("applies line-number edits without per-anchor hash validation", () => {
		const diff = `${sameLineRange(tag(2, "bbb"))}:\n${extra("BBB")}`;
		expect(applyDiff("aaa\nbbb\nccc", diff)).toBe("aaa\nBBB\nccc");
	});
});

describe("splitHashlineInput — ¶ headers", () => {
	it("extracts path, file hash, and diff body from ¶path#hash header", () => {
		const input = [`¶src/foo.ts#1a2b`, `${sameLineRange(tag(2, "bbb"))}:`, extra("BBB")].join("\n");
		expect(splitHashlineInput(input)).toEqual({
			path: "src/foo.ts",
			fileHash: "1a2b",
			diff: `${sameLineRange(tag(2, "bbb"))}:\n${extra("BBB")}`,
		});
	});

	it("strips leading blank lines", () => {
		expect(splitHashlineInput(`\n¶foo.ts\nBOF↓\n${extra("x")}`)).toEqual({
			path: "foo.ts",
			diff: `BOF↓\n${extra("x")}`,
		});
	});

	it("normalizes cwd-prefixed absolute paths to cwd-relative paths", () => {
		const cwd = process.cwd();
		const absolute = path.join(cwd, "src", "foo.ts");
		expect(splitHashlineInput(`¶${absolute}\nBOF↓\n${extra("x")}`, { cwd }).path).toBe("src/foo.ts");
	});

	it("uses explicit fallback path only when input has recognizable operations", () => {
		expect(splitHashlineInput(`BOF↓\n${extra("x")}`, { path: "a.ts" })).toEqual({
			path: "a.ts",
			diff: `BOF↓\n${extra("x")}`,
		});
		expect(() => splitHashlineInput("plain text", { path: "a.ts" })).toThrow(/must begin with/);
	});

	it("splits multiple edit sections", () => {
		const input = ["¶a.ts", "BOF↓", extra("a"), "¶b.ts", "EOF↓", extra("b")].join("\n");
		expect(splitHashlineInputs(input)).toEqual([
			{ path: "a.ts", diff: `BOF↓\n${extra("a")}` },
			{ path: "b.ts", diff: `EOF↓\n${extra("b")}` },
		]);
	});

	it("tolerates extra ¶ chars on the section header", () => {
		const input = ["¶¶a.ts", "BOF↓", extra("a"), "¶¶¶b.ts", "EOF↓", extra("b")].join("\n");
		expect(splitHashlineInputs(input)).toEqual([
			{ path: "a.ts", diff: `BOF↓\n${extra("a")}` },
			{ path: "b.ts", diff: `EOF↓\n${extra("b")}` },
		]);
	});

	it("silently drops a duplicate header with no operations between them", () => {
		const input = ["¶¶src/foo.ts", "¶¶src/foo.ts", `BOF↓`, extra("x")].join("\n");
		expect(splitHashlineInputs(input)).toEqual([{ path: "src/foo.ts", diff: `BOF↓\n${extra("x")}` }]);
	});

	it("silently drops a trailing header with no operations", () => {
		const input = ["¶¶a.ts", "BOF↓", extra("a"), "¶¶b.ts"].join("\n");
		expect(splitHashlineInputs(input)).toEqual([{ path: "a.ts", diff: `BOF↓\n${extra("a")}` }]);
	});
});

describe("hashline executor", () => {
	it("creates a missing file with a file-scoped insert", async () => {
		await withTempDir(async tempDir => {
			const input = `¶new.ts\nBOF↓${pl("export const x = 1;")}\n`;
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, input));
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("new.ts:");
			expect(await Bun.file(path.join(tempDir, "new.ts")).text()).toBe("export const x = 1;");
		});
	});

	it("honors the pure-insert duplicate auto-drop setting", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const source = ["aaa", "bbb", "ccc"].join("\n");
			const input = `${header("a.ts", source)}\n${tag(2, "bbb")}↓${pl("aaa")}\n${extra("bbb")}\n${extra("NEW")}\n`;

			await Bun.write(filePath, source);
			await executeHashlineSingle(hashlineExecuteOptions(tempDir, input));
			expect(await Bun.file(filePath).text()).toBe("aaa\nbbb\naaa\nbbb\nNEW\nccc");

			await Bun.write(filePath, source);
			const enabled = Settings.isolated({ "edit.hashlineAutoDropPureInsertDuplicates": true });
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, input, enabled));
			expect(await Bun.file(filePath).text()).toBe("aaa\nbbb\nNEW\nccc");
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("Auto-dropped");
		});
	});

	it("preflights every section before writing multi-file edits", async () => {
		await withTempDir(async tempDir => {
			const aPath = path.join(tempDir, "a.ts");
			const bPath = path.join(tempDir, "b.ts");
			await Bun.write(aPath, "aaa\n");
			await Bun.write(bPath, "bbb\n");
			const bHeader = "¶b.ts#0000";
			const input = [
				header("a.ts", "aaa\n"),
				`${sameLineRange(tag(1, "aaa"))}:`,
				extra("AAA"),
				bHeader,
				`${sameLineRange(tag(1, "bbb"))}:`,
				extra("BBB"),
			].join("\n");

			await expect(executeHashlineSingle(hashlineExecuteOptions(tempDir, input))).rejects.toThrow(
				/file changed between read and edit|file hashes to/,
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
			// line 2 into 9 lines (net +8 shift). Section 2's anchor points at line 8
			// of the original; after section 1 applies, that content moves to line 16.
			// A naive sequential apply reads the modified disk and fails anchor
			// validation outright.
			const input = [
				header("a.ts", `${original}\n`),
				`${sameLineRange(tag(2, "L2"))}:`,
				extra("L2a"),
				extra("L2b"),
				extra("L2c"),
				extra("L2d"),
				extra("L2e"),
				extra("L2f"),
				extra("L2g"),
				extra("L2h"),
				extra("L2i"),
				header("a.ts", `${original}\n`),
				`${tag(8, "L8")}↓`,
				extra("INSERTED"),
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
		expect(hashlineEditParamsSchema.safeParse({ path: "x.ts", input: `¶x.ts\nBOF↓\n${extra("x")}` }).success).toBe(
			true,
		);
	});

	it("still requires `input`", () => {
		expect(hashlineEditParamsSchema.safeParse({ path: "x.ts" }).success).toBe(false);
	});
});

describe("buildCompactHashlineDiffPreview — line numbers track post-edit positions", () => {
	it("emits context lines against the new file's line numbers after a range expansion", () => {
		const before = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"].join("\n");
		const after = ["a1", "a2", "a3", "X", "Y", "Z", "a5", "a6", "a7"].join("\n");
		const { diff } = generateDiffString(before, after);
		const preview = buildCompactHashlineDiffPreview(diff);

		// Walk the preview and verify every ` LINE:content` line matches what
		// the file now has at that line number.
		const newFileLines = after.split("\n");
		for (const line of preview.preview.split("\n")) {
			if (!line.startsWith(" ")) continue;
			// Skip context-elision markers ("...") which carry no real file content.
			if (line.endsWith(`${outputSep}...`)) continue;
			const match = new RegExp(`^\\s(\\d+)${outputSepRe}(.*)$`).exec(line);
			expect(match).not.toBeNull();
			if (!match) continue;
			const lineNum = Number(match[1]);
			const content = match[2];
			expect(newFileLines[lineNum - 1]).toBe(content);
		}
	});

	it("emits + and - lines with bare line numbers", () => {
		const before = "alpha\nbeta\ngamma\n";
		const after = "alpha\nDELTA\nEPSILON\ngamma\n";
		const { diff } = generateDiffString(before, after);
		const preview = buildCompactHashlineDiffPreview(diff);

		const additions = preview.preview.split("\n").filter(line => line.startsWith("+"));
		expect(additions).toEqual([`+2${outputSep}DELTA`, `+3${outputSep}EPSILON`]);

		const removals = preview.preview.split("\n").filter(line => line.startsWith("-"));
		expect(removals).toEqual([`-2${outputSep}beta`]);
	});
});

describe("hashline — anchor-stale recovery via read snapshot cache", () => {
	it("recovers when the file was modified out-of-band after a read", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const v0Lines = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"];
			const v0Text = `${v0Lines.join("\n")}\n`;
			await Bun.write(filePath, v0Text);

			const session = makeHashlineSession(tempDir);
			// Simulate the read tool having shown V0 to the model in this session.
			getFileReadCache(session).recordContiguous(filePath, 1, v0Text.split("\n"), {
				fullText: v0Text,
				fileHash: computeFileHash(v0Text),
			});

			// External actor (linter, subagent, user) prepends 7 lines. Anchors
			// authored against V0 no longer match V1, so the model's edit cannot
			// land without consulting the cached snapshot.
			const headerLines = ["H1", "H2", "H3", "H4", "H5", "H6", "H7"];
			const v1Lines = [...headerLines, ...v0Lines];
			await Bun.write(filePath, `${v1Lines.join("\n")}\n`);

			// Model authors anchor against V0 — line 2 is "L2" in V0.
			const input = `${header("a.ts", v0Text)}\n${sameLineRange(tag(2, "L2"))}:\n${extra(pl("L2-MODEL"))}\n`;
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session));

			const finalLines = (await Bun.file(filePath).text()).replace(/\n$/, "").split("\n");
			// The external prepend AND the model's edit must both be present.
			expect(finalLines.slice(0, 7)).toEqual(["H1", "H2", "H3", "H4", "H5", "H6", "H7"]);
			expect(finalLines).toContain("L2-MODEL");
			expect(finalLines).not.toContain("L2");
			// Other unchanged lines preserved.
			expect(finalLines).toContain("L7");
			expect(finalLines).toContain("L8");

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toMatch(/Recovered from a stale file hash using a previous read snapshot/);
		});
	});

	it("falls back to mismatch error when the cache does not cover the failing anchor", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const v0Lines = Array.from({ length: 10 }, (_, idx) => `L${idx + 1}`);
			const v0Text = `${v0Lines.join("\n")}\n`;
			await Bun.write(filePath, v0Text);

			const session = makeHashlineSession(tempDir);
			// Cache only covers the first three lines — enough to retain the file hash
			// but not enough to synthesize the requested pre-edit snapshot.
			getFileReadCache(session).recordContiguous(filePath, 1, v0Lines.slice(0, 3), {
				fileHash: computeFileHash(v0Text),
			});

			const v1Lines = [...v0Lines];
			v1Lines[5] = "L6-CHANGED";
			await Bun.write(filePath, `${v1Lines.join("\n")}\n`);

			const input = `${header("a.ts", v0Text)}\n${sameLineRange(tag(6, "L6"))}:\n${extra(pl("L6-MODEL"))}\n`;
			await expect(
				executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session)),
			).rejects.toThrow(HashlineMismatchError);
			// Disk content unchanged.
			expect(await Bun.file(filePath).text()).toBe(`${v1Lines.join("\n")}\n`);
		});
	});

	it("returns null from tryRecoverHashlineWithCache when applyPatch cannot land", () => {
		const cache = new FileReadCache();
		const fakePath = "/tmp/__hashline-recovery-applypatch__.ts";
		const snapshotText = "alpha\nbeta\ngamma\ndelta\nepsilon";
		cache.recordContiguous(fakePath, 1, snapshotText.split("\n"), {
			fullText: snapshotText,
			fileHash: computeFileHash(snapshotText),
		});

		// Live file is completely different — patch context cannot match even
		// with fuzz tolerance.
		const currentText = "totally\nunrelated\ncontent\nhere\nnow\n";
		const edits = parseHashline(`${sameLineRange(tag(2, "beta"))}:\n${extra(pl("BETA-MODEL"))}`).edits;

		const recovered = tryRecoverHashlineWithCache({
			cache,
			absolutePath: fakePath,
			currentText,
			edits,
			fileHash: computeFileHash(snapshotText),
			options: {},
		});
		expect(recovered).toBeNull();
	});

	it("isolates caches across sessions", () => {
		const a = new FileReadCache();
		const b = new FileReadCache();
		const fakePath = "/tmp/__hashline-cache-isolation__.ts";
		a.recordContiguous(fakePath, 1, ["x", "y", "z"]);
		expect(a.get(fakePath)).not.toBeNull();
		expect(b.get(fakePath)).toBeNull();
	});

	it("captures the post-edit result so the next edit can recover from anchors against it", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const v0Lines = ["alpha", "beta", "gamma", "delta", "epsilon"];
			const v0Text = `${v0Lines.join("\n")}\n`;
			await Bun.write(filePath, v0Text);

			const session = makeHashlineSession(tempDir);
			// Initial read populates the cache with V0.
			getFileReadCache(session).recordContiguous(filePath, 1, v0Text.split("\n"), {
				fullText: v0Text,
				fileHash: computeFileHash(v0Text),
			});

			// First edit: change line 2 : BETA. After the write, the cache should
			// reflect V1 (post-edit), not V0.
			const firstInput = `${header("a.ts", v0Text)}\n${sameLineRange(tag(2, "beta"))}:\n${extra(pl("BETA"))}\n`;
			await executeHashlineSingle(hashlineExecuteOptions(tempDir, firstInput, undefined, session));
			const v1Lines = ["alpha", "BETA", "gamma", "delta", "epsilon"];
			expect(await Bun.file(filePath).text()).toBe(`${v1Lines.join("\n")}\n`);
			const snap = getFileReadCache(session).get(filePath);
			expect(snap?.lines.get(1)).toBe("alpha");
			expect(snap?.lines.get(2)).toBe("BETA");
			expect(snap?.lines.get(3)).toBe("gamma");

			// External actor prepends 7 lines after the edit. Anchors authored
			// against V1 (the post-edit state the model just observed) no longer
			// match V2 — recovery must consult the cached V1 snapshot to land the
			// second edit.
			const v2Lines = ["H1", "H2", "H3", "H4", "H5", "H6", "H7", ...v1Lines];
			await Bun.write(filePath, `${v2Lines.join("\n")}\n`);

			const secondInput = `${header("a.ts", `${v1Lines.join("\n")}\n`)}\n${sameLineRange(tag(3, "gamma"))}:\n${extra(pl("GAMMA"))}\n`;
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, secondInput, undefined, session));

			const finalLines = (await Bun.file(filePath).text()).replace(/\n$/, "").split("\n");
			expect(finalLines.slice(0, 7)).toEqual(["H1", "H2", "H3", "H4", "H5", "H6", "H7"]);
			expect(finalLines).toContain("BETA");
			expect(finalLines).toContain("GAMMA");
			expect(finalLines).not.toContain("gamma");
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toMatch(/Recovered from a stale file hash using a previous read snapshot/);
		});
	});
	it("recovers from an older in-session snapshot even if the current file advanced again", () => {
		const cache = new FileReadCache();
		const fakePath = "/tmp/__hashline-cache-ring-recovery__.ts";
		const v0Text = "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\n";
		const v1Text = "L1\nL2-EDITED\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\n";
		const currentText = "L1\nL2-EDITED\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\nTRAILER\n";

		cache.recordContiguous(fakePath, 1, v0Text.split("\n"), {
			fullText: v0Text,
			fileHash: computeFileHash(v0Text),
		});
		cache.recordContiguous(fakePath, 1, v1Text.split("\n"), {
			fullText: v1Text,
			fileHash: computeFileHash(v1Text),
		});

		const recovered = tryRecoverHashlineWithCache({
			cache,
			absolutePath: fakePath,
			currentText,
			fileHash: computeFileHash(v0Text),
			edits: parseHashline(`10:\n${extra("L10-EDITED")}`).edits,
			options: {},
		});

		expect(recovered).not.toBeNull();
		expect(recovered?.lines).toContain("L10-EDITED");
	});

	it("retains older file hashes in the per-path snapshot ring", () => {
		const cache = new FileReadCache();
		const fakePath = "/tmp/__hashline-cache-ring__.ts";
		const versions = ["one\n", "two\n", "three\n"];
		for (const version of versions) {
			cache.recordContiguous(fakePath, 1, version.split("\n"), {
				fullText: version,
				fileHash: computeFileHash(version),
			});
		}
		expect(cache.get(fakePath)?.fileHash).toBe(computeFileHash("three\n"));
		expect(cache.getByHash(fakePath, computeFileHash("one\n"))?.fullText).toBe("one\n");
		expect(cache.getByHash(fakePath, computeFileHash("two\n"))?.fullText).toBe("two\n");
	});

	it("drops a cached entry when newly recorded lines disagree on overlap", () => {
		const cache = new FileReadCache();
		const fakePath = "/tmp/__hashline-cache-conflict__.ts";
		cache.recordContiguous(fakePath, 1, ["a", "b", "c", "d", "e"]);
		cache.recordSparse(fakePath, [
			[3, "c"],
			[4, "D-CHANGED"],
			[5, "e"],
			[6, "f"],
			[7, "g"],
		]);

		const snap = cache.get(fakePath);
		expect(snap).not.toBeNull();
		// Old entries dropped; only the divergent record's entries remain.
		expect(snap?.lines.has(1)).toBe(false);
		expect(snap?.lines.has(2)).toBe(false);
		expect(snap?.lines.get(4)).toBe("D-CHANGED");
		expect(snap?.lines.get(7)).toBe("g");
	});

	it("evicts old paths past the per-session LRU cap", () => {
		const cache = new FileReadCache();
		// Cap is 30 paths. Insert 32 distinct paths; the oldest two must evict.
		for (let i = 0; i < 32; i++) {
			cache.recordContiguous(`/tmp/file-${i}.ts`, 1, ["x"]);
		}
		expect(cache.get("/tmp/file-0.ts")).toBeNull();
		expect(cache.get("/tmp/file-1.ts")).toBeNull();
		expect(cache.get("/tmp/file-2.ts")).not.toBeNull();
		expect(cache.get("/tmp/file-31.ts")).not.toBeNull();
	});
});

describe("hashline *** Abort recovery sentinel (harmony-leak mitigation)", () => {
	const sentinel = "*** Abort";

	it("parser breaks at *** Abort and surfaces a warning", () => {
		const diff = [`${tag(1, "alpha")}↓`, extra("HELLO"), sentinel, `${tag(99, "junk")}↓`, extra("never")].join("\n");
		const { edits, warnings } = parseHashline(diff);
		expect(edits).toHaveLength(1);
		expect(edits[0]).toMatchObject({ kind: "insert", text: "HELLO" });
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toMatch(/truncated mid-call/i);
	});

	it("appended sentinel from harmony-leak truncation: ops above are preserved", () => {
		// Mirrors the exact shape harmony-leak emits inside a single section.
		const diff = `${tag(1, "alpha")}↓\n${extra(pl("KEPT"))}\n*** Abort\n`;
		const { edits, warnings } = parseHashline(diff);
		expect(edits).toHaveLength(1);
		expect(edits[0]).toMatchObject({ text: "KEPT" });
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("splitter respects *** Abort like *** End Patch", () => {
		const input = [
			`¶a.ts`,
			`${tag(1, "alpha")}↓`,
			extra("a-payload"),
			sentinel,
			`¶b.ts`,
			`${tag(1, "beta")}↓`,
			extra("never-emitted"),
		].join("\n");
		const sections = splitHashlineInputs(input);
		expect(sections).toHaveLength(1);
		expect(sections[0].path).toBe("a.ts");
		expect(sections[0].diff.includes("never-emitted")).toBe(false);
	});

	it("clean input without sentinel produces no warning", () => {
		const diff = `${tag(1, "alpha")}↓\n${extra(pl("PAYLOAD"))}\n`;
		const { warnings } = parseHashline(diff);
		expect(warnings).toEqual([]);
	});
});

describe("hashline parser — bare ':' replaces with a single blank line", () => {
	it("bare A: replaces the line with a single blank line", () => {
		const text = "line1\nline2\nline3\n";
		const { diff } = splitHashlineInput(`${header("a.ts", text)}\n2:\n`);
		expect(applyDiff(text, diff)).toBe("line1\n\nline3\n");
	});

	it("bare A-B: replaces the range with a single blank line", () => {
		const text = "line1\nline2\nline3\nline4\n";
		const { diff } = splitHashlineInput(`${header("a.ts", text)}\n2-3:\n`);
		expect(applyDiff(text, diff)).toBe("line1\n\nline4\n");
	});

	it("A: with inline body still works", () => {
		const text = "line1\nline2\nline3\n";
		const { diff } = splitHashlineInput(`${header("a.ts", text)}\n2:replacement\n`);
		expect(applyDiff(text, diff)).toBe("line1\nreplacement\nline3\n");
	});

	it("bare A↑ still inserts a blank line above", () => {
		const text = "line1\nline2\nline3\n";
		const { diff } = splitHashlineInput(`${header("a.ts", text)}\n2↑\n`);
		expect(applyDiff(text, diff)).toBe("line1\n\nline2\nline3\n");
	});

	it("bare A↓ still inserts a blank line below", () => {
		const text = "line1\nline2\nline3\n";
		const { diff } = splitHashlineInput(`${header("a.ts", text)}\n2↓\n`);
		expect(applyDiff(text, diff)).toBe("line1\nline2\n\nline3\n");
	});
});

describe("hashline apply — brace-delete soft warning", () => {
	it("deleting a line with unbalanced brace emits a warning", () => {
		const text = "if (x) {\n  doThing();\n} else {\n  doOther();\n}\n";
		const { diff } = splitHashlineInput(`${header("a.ts", text)}\n3!\n`);
		const result = applyHashlineEdits(text, parseHashline(diff).edits);
		expect(result.warnings).toBeDefined();
		expect(result.warnings![0]).toContain("structural bracket/brace boundary");
		expect(result.warnings![0]).toContain("} else {");
	});

	it("deleting a balanced line emits no warning", () => {
		const text = "line1\nline2\nline3\n";
		const { diff } = splitHashlineInput(`${header("a.ts", text)}\n2!\n`);
		const result = applyHashlineEdits(text, parseHashline(diff).edits);
		expect(result.warnings).toBeUndefined();
	});

	it("replace operation that includes a brace line does NOT warn", () => {
		const text = "if (x) {\n  body\n}\n";
		const { diff } = splitHashlineInput(`${header("a.ts", text)}\n3:}\n`);
		const result = applyHashlineEdits(text, parseHashline(diff).edits);
		expect(result.warnings).toBeUndefined();
	});
});

describe("hashline parser — plus-prefixed blank payload lines", () => {
	it("raw blank lines between ops are ignored", () => {
		const text = "a\nb\nc\nd\ne\n";
		const ops = `${header("a.ts", text)}\n1:A\n\n3:C\n`;
		const { diff } = splitHashlineInput(ops);
		expect(applyDiff(text, diff)).toBe("A\nb\nC\nd\ne\n");
	});

	it("plus-only continuation lines are appended as empty payload lines", () => {
		const text = "a\nb\nc\nd\ne\n";
		const ops = `${header("a.ts", text)}\n1:A\n${extra("")}\n${extra("")}\n3:C\n`;
		const { diff } = splitHashlineInput(ops);
		expect(applyDiff(text, diff)).toBe("A\n\n\nb\nC\nd\ne\n");
	});

	it("bare A: followed by two plus-only lines replaces the line with two blanks", () => {
		const text = "a\nb\nc\nd\ne\n";
		const ops = `${header("a.ts", text)}\n2:\n${extra("")}\n${extra("")}\n4:D\n`;
		const { diff } = splitHashlineInput(ops);
		expect(applyDiff(text, diff)).toBe("a\n\n\nc\nD\ne\n");
	});

	it("plus-only line inside payload between two content lines is preserved", () => {
		const text = "a\nb\nc\n";
		const ops = `${header("a.ts", text)}\n2:first\n${extra("")}\n${extra("second")}\n`;
		const { diff } = splitHashlineInput(ops);
		expect(applyDiff(text, diff)).toBe("a\nfirst\n\nsecond\nc\n");
	});
});

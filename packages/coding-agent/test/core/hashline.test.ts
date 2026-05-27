import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ApplyOptions,
	applyEdits,
	buildCompactDiffPreview as buildCompactHashlineDiffPreview,
	computeFileHash,
	detectLineEnding,
	type Edit,
	InMemorySnapshotStore as FileReadCache,
	Filesystem,
	MismatchError as HashlineMismatchError,
	NotFoundError,
	Patch,
	Patcher,
	type PatchSection,
	parsePatch as parseHashline,
	Recovery,
	type SplitOptions,
	type WriteResult,
} from "@oh-my-pi/hashline";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type ExecuteHashlineSingleOptions,
	executeHashlineSingle,
	generateDiffString,
	getFileSnapshotStore as getFileReadCache,
	hashlineEditParamsSchema,
} from "@oh-my-pi/pi-coding-agent/edit";
import * as z from "zod/v4";

/**
 * The test bodies were written against the legacy hashline API surface. The
 * shims below project the new `@oh-my-pi/hashline` shapes onto the legacy
 * names so production code can use the new names directly while we keep the
 * pre-existing behavior assertions intact.
 */
function applyHashlineEdits(
	text: string,
	edits: readonly Edit[],
	options: ApplyOptions = {},
): { text: string; lines: string; firstChangedLine?: number; warnings?: string[] } {
	const r = applyEdits(text, [...edits], options);
	return { ...r, lines: r.text };
}

interface SectionView {
	path: string;
	fileHash?: string;
	diff: string;
}
function toSectionView(section: PatchSection): SectionView {
	return section.fileHash !== undefined
		? { path: section.path, fileHash: section.fileHash, diff: section.diff }
		: { path: section.path, diff: section.diff };
}
function splitHashlineInput(input: string, options: SplitOptions = {}): SectionView {
	return toSectionView(Patch.parseSingle(input, options));
}
function splitHashlineInputs(input: string, options: SplitOptions = {}): SectionView[] {
	return Patch.parse(input, options).sections.map(toSectionView);
}

function tryRecoverHashlineWithCache(args: {
	cache: FileReadCache;
	absolutePath: string;
	currentText: string;
	fileHash: string;
	edits: readonly Edit[];
	options?: ApplyOptions;
}): { text: string; lines: string; firstChangedLine: number | undefined; warnings: string[] } | null {
	const recovered = new Recovery(args.cache).tryRecover({
		path: args.absolutePath,
		currentText: args.currentText,
		fileHash: args.fileHash,
		edits: args.edits,
		options: args.options,
	});
	return recovered ? { ...recovered, lines: recovered.text } : null;
}

import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

const repl = (text: string): string => `|${text}`;
const above = (text: string): string => `↑${text}`;
const below = (text: string): string => `↓${text}`;
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

class PolicyFilesystem extends Filesystem {
	#files = new Map<string, string>();
	#blocked = new Set<string>();

	constructor(initial: Iterable<readonly [string, string]>, blocked: Iterable<string>) {
		super();
		for (const [filePath, content] of initial) this.#files.set(filePath, content);
		for (const filePath of blocked) this.#blocked.add(filePath);
	}

	async readText(filePath: string): Promise<string> {
		const content = this.#files.get(filePath);
		if (content === undefined) throw new NotFoundError(filePath);
		return content;
	}

	async preflightWrite(filePath: string): Promise<void> {
		if (this.#blocked.has(filePath)) throw new Error(`blocked write: ${filePath}`);
	}

	async writeText(filePath: string, content: string): Promise<WriteResult> {
		this.#files.set(filePath, content);
		return { text: content };
	}

	get(filePath: string): string | undefined {
		return this.#files.get(filePath);
	}
}

describe("hashline normalization", () => {
	it("preserves the first newline style when restoring mixed-ending files", () => {
		expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n");
		expect(detectLineEnding("a\nb\r\nc")).toBe("\n");
	});
});

describe("hashline parser — range-anchor syntax", () => {
	it("keeps parsed edits reusable across different target snapshots", () => {
		const section = Patch.parseSingle(["¶a.ts", `${tag(2, "bbb")}:`, below("tail")].join("\n"));

		expect(section.applyTo("aaa\nbbb").text).toBe("aaa\nbbb\ntail");
		expect(section.applyTo("aaa\nbbb\nccc").text).toBe("aaa\nbbb\ntail\nccc");
	});

	const content = "aaa\nbbb\nccc";

	it("inserts payload before/after a Lid, and at BOF/EOF", () => {
		const diff = [
			`${tag(2, "bbb")}:`,
			above("before b"),
			below("after b"),

			"BOF:",
			below("top"),
			"EOF:",
			below("tail"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("top\naaa\nbefore b\nbbb\nafter b\nccc\ntail");
	});

	it("inserts after the final line without falling off the file", () => {
		const diff = [`${tag(3, "ccc")}:`, below("tail")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nbbb\nccc\ntail");
	});

	it("deletes a line or range when the block has no payload rows", () => {
		expect(applyDiff(content, `${sameLineRange(tag(2, "bbb"))}:`)).toBe("aaa\nccc");
		expect(applyDiff(content, `${tag(2, "bbb")}-${tag(3, "ccc")}:`)).toBe("aaa");
	});

	it("replaces a line with one blank when given an explicit empty replace payload", () => {
		const explicit = [`${sameLineRange(tag(2, "bbb"))}:`, repl("")].join("\n");
		expect(applyDiff(content, explicit)).toBe("aaa\n\nccc");
	});

	it("replaces one line or an inclusive range with payload lines", () => {
		const single = [`${tag(2, "bbb")}:`, repl("BBB")].join("\n");
		expect(applyDiff(content, single)).toBe("aaa\nBBB\nccc");

		const range = [`${tag(2, "bbb")}-${tag(3, "ccc")}:`, repl("BBB"), repl("CCC")].join("\n");
		expect(applyDiff(content, range)).toBe("aaa\nBBB\nCCC");
	});

	it("treats single-anchor replace sugar as equivalent to an explicit one-line range", () => {
		const anchor = tag(2, "bbb");
		expect(parseHashline(`${anchor}:\n${repl("BBB")}\n${repl("CCC")}`).edits).toEqual(
			parseHashline(`${anchor}-${anchor}:\n${repl("BBB")}\n${repl("CCC")}`).edits,
		);
		expect(applyDiff(content, `${anchor}:\n${repl("BBB")}\n${repl("CCC")}`)).toBe(
			applyDiff(content, `${anchor}-${anchor}:\n${repl("BBB")}\n${repl("CCC")}`),
		);
	});

	it("rejects inline payload on anchor rows", () => {
		const anchor = tag(2, "bbb");
		for (const diff of [`${anchor}:NEW`, `${anchor}-${tag(3, "ccc")}:NEW`, "BOF:NEW", "EOF:NEW"]) {
			expect(() => parseHashline(diff)).toThrow(/Inline payload on the anchor line is rejected/);
		}
	});

	it("routes interleaved payload rows to stable above, replace, and below buckets", () => {
		const diff = [
			`${tag(2, "bbb")}:`,
			below("below 1"),
			above("above 1"),
			repl("BBB"),
			above("above 2"),
			below("below 2"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nabove 1\nabove 2\nBBB\nbelow 1\nbelow 2\nccc");
	});

	it("preserves the anchor when only above/below payload rows are present", () => {
		const diff = [`${tag(2, "bbb")}:`, above("before"), below("after")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nbefore\nbbb\nafter\nccc");
	});

	it("escapes literal leading payload sigils by doubling them", () => {
		const diff = [`${tag(2, "bbb")}:`, repl("|literal"), above("↑literal"), below("↓literal")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\n↑literal\n|literal\n↓literal\nccc");
	});

	it("rejects replacement payload at virtual BOF/EOF anchors", () => {
		expect(() => parseHashline(["BOF:", repl("HEAD")].join("\n"))).toThrow(/virtual positions/);
		expect(() => parseHashline(["EOF:", repl("TAIL")].join("\n"))).toThrow(/virtual positions/);
	});

	it("rejects unprefixed payload continuation lines", () => {
		const anchor = tag(2, "bbb");
		expect(() => parseHashline(`${anchor}:\n${repl("FIRST")}\nSECOND`)).toThrow(/must start with/);
	});

	it("preserves whitespace-bearing payload exactly", () => {
		const anchor = tag(2, "bbb");
		const payload = "\tconst streamKeepaliveMs = opts.streamKeepaliveMs;";
		expect(applyDiff(content, [`${anchor}:`, below(payload)].join("\n"))).toBe(`aaa\nbbb\n${payload}\nccc`);
		expect(applyDiff(content, [`${anchor}:`, above(payload)].join("\n"))).toBe(`aaa\n${payload}\nbbb\nccc`);
	});

	it("auto-absorbs duplicated multiline prefix boundaries during replacement", () => {
		const source = ["// one", "// two", "old();"].join("\n");
		const diff = [`${sameLineRange(tag(3, "old();"))}:`, repl("// one"), repl("// two"), repl("new();")].join("\n");

		expect(applyDiff(source, diff)).toBe(["// one", "// two", "new();"].join("\n"));
	});

	it("auto-absorbs duplicated multiline suffix boundaries during replacement", () => {
		const source = ["old();", "// one", "// two"].join("\n");
		const diff = [`${sameLineRange(tag(1, "old();"))}:`, repl("new();"), repl("// one"), repl("// two")].join("\n");

		expect(applyDiff(source, diff)).toBe(["new();", "// one", "// two"].join("\n"));
	});

	it("auto-absorbs a duplicated single structural suffix during replacement", () => {
		const source = ["old();", "};"].join("\n");
		const diff = [`${sameLineRange(tag(1, "old();"))}:`, repl("new();"), repl("};")].join("\n");

		expect(applyDiff(source, diff)).toBe(["new();", "};"].join("\n"));
	});

	it("auto-absorbs a duplicated single structural prefix during replacement", () => {
		const source = ["};", "old();"].join("\n");
		const diff = [`${sameLineRange(tag(2, "old();"))}:`, repl("};"), repl("new();")].join("\n");

		expect(applyDiff(source, diff)).toBe(["};", "new();"].join("\n"));
	});

	it("does not absorb a single structural replacement suffix when it preserves balance", () => {
		// The replacement payload `if ok {` + `}` is itself net-zero, so the trailing
		// `}` is a legitimate part of the new block, not a duplicate of the file's
		// existing `}`. The single-line structural absorb must NOT fire here.
		const source = ["old();", "}"].join("\n");
		const diff = [`${sameLineRange(tag(1, "old();"))}:`, repl("if ok {"), repl("}")].join("\n");

		expect(applyDiff(source, diff)).toBe(["if ok {", "}", "}"].join("\n"));
	});

	it("does not auto-absorb a single duplicated boundary line", () => {
		const source = ["keep", "old();"].join("\n");
		const diff = [`${sameLineRange(tag(2, "old();"))}:`, repl("keep"), repl("new();")].join("\n");

		expect(applyDiff(source, diff)).toBe(["keep", "keep", "new();"].join("\n"));
	});

	it("does not auto-absorb a duplicate boundary that another op already targets", () => {
		// Lines 3-4 ("X","Y") match the payload's trailing block, but line 4
		// is also the anchor of a separate insert. Absorbing it would silently
		// steal that anchor and turn the insert into a replacement.
		const source = ["A", "B", "X", "Y", "Z"].join("\n");
		const diff = [
			`${tag(1, "A")}-${tag(2, "B")}:`,
			repl("alpha"),
			repl("X"),
			repl("Y"),
			`${tag(4, "Y")}:`,
			above("extra"),
		].join("\n");

		expect(applyDiff(source, diff)).toBe(["alpha", "X", "Y", "X", "extra", "Y", "Z"].join("\n"));
	});

	it("surfaces a warning when boundary duplicates are auto-absorbed", () => {
		const source = ["// one", "// two", "old();"].join("\n");
		const diff = [`${sameLineRange(tag(3, "old();"))}:`, repl("// one"), repl("// two"), repl("new();")].join("\n");

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
		const diff = [`${tag(2, "")}-${tag(5, "}")}:`, repl("const X = …")].join("\n");

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
		const diff = [`${tag(1, "## Legacy")}-${tag(4, "")}:`, repl("## Subagents")].join("\n");

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
		const diff = [`${sameLineRange(tag(2, "bar"))}:`, repl("foo")].join("\n");

		expect(applyDiff(source, diff)).toBe(["foo", "foo", "baz"].join("\n"));
	});

	it("does not auto-drop generic (multi-line) pure-insert duplicate boundaries by default", () => {
		// Multi-line context echo (`aaa`, `bbb`) is gated on the
		// `autoDropPureInsertDuplicates` opt-in. Single-line pure-insert
		// duplicates stay literal because they are ambiguous.
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`${tag(2, "bbb")}:`, below("aaa"), below("bbb"), below("NEW")].join("\n");
		expect(applyDiff(source, diff)).toBe("aaa\nbbb\naaa\nbbb\nNEW\nccc");
	});

	it("preserves a duplicated single structural suffix for pure insert by default", () => {
		const source = ["if ok {", "   keep();", "   }"].join("\n");
		const diff = [`${tag(3, "   }")}:`, above("   added();"), above("   }")].join("\n");

		expect(applyDiff(source, diff)).toBe(["if ok {", "   keep();", "   added();", "   }", "   }"].join("\n"));
	});

	it("preserves a duplicated single structural prefix for pure insert even when duplicate absorption is enabled", () => {
		const source = ["   });", "next();"].join("\n");
		const diff = [`${tag(1, "   });")}:`, below("   });"), below("added();")].join("\n");
		const result = applyHashlineEdits(source, parseHashline(diff).edits, { autoDropPureInsertDuplicates: true });

		expect(result.lines).toBe(["   });", "   });", "added();", "next();"].join("\n"));
		expect(result.warnings).toBeUndefined();
	});

	it("preserves an intentional non-structural anchor duplicate for below insert by default", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`${tag(2, "bbb")}:`, below("bbb"), below("NEW")].join("\n");

		expect(applyDiff(source, diff)).toBe("aaa\nbbb\nbbb\nNEW\nccc");
	});

	it("preserves an intentional non-structural anchor duplicate for above insert by default", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`${tag(2, "bbb")}:`, above("NEW"), above("bbb")].join("\n");

		expect(applyDiff(source, diff)).toBe("aaa\nNEW\nbbb\nbbb\nccc");
	});

	it("does not drop a single structural pure-insert suffix when it preserves balance", () => {
		const source = ["if outer {", "}"].join("\n");
		const diff = [`${tag(2, "}")}:`, above("if inner {"), above("}")].join("\n");

		expect(applyDiff(source, diff)).toBe(["if outer {", "if inner {", "}", "}"].join("\n"));
	});

	it("auto-absorbs duplicated leading payload of a pure below insert", () => {
		// Payload echoes the two file lines AT/ABOVE the insertion point
		// (aaa, bbb), then adds NEW. The leading echo is absorbed.
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`${tag(2, "bbb")}:`, below("aaa"), below("bbb"), below("NEW")].join("\n");
		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("aaa\nbbb\nNEW\nccc");
	});

	it("auto-absorbs context-wrap echo (leading-above + trailing-below) on below insert", () => {
		// Payload wraps NEW with context above (aaa, bbb) AND below (ccc, ddd).
		// Both ends should be absorbed, leaving only NEW inserted after bbb.
		const source = ["aaa", "bbb", "ccc", "ddd"].join("\n");
		const diff = [`${tag(2, "bbb")}:`, below("aaa"), below("bbb"), below("NEW"), below("ccc"), below("ddd")].join(
			"\n",
		);
		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("aaa\nbbb\nNEW\nccc\nddd");
	});

	it("auto-absorbs duplicated trailing payload of a pure above insert", () => {
		// Insert before line 3 ("ccc"). Trailing payload echoes the anchor and the
		// line after it. Drop the trailing duplicates.
		const source = ["aaa", "bbb", "ccc", "ddd"].join("\n");
		const diff = [`${tag(3, "ccc")}:`, above("NEW"), above("ccc"), above("ddd")].join("\n");
		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("aaa\nbbb\nNEW\nccc\nddd");
	});

	it("auto-absorbs duplicated leading payload at EOF insert", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		// `EOF:` payload echoes the last two file lines, then adds NEW.
		const diff = ["EOF:", below("bbb"), below("ccc"), below("NEW")].join("\n");
		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("aaa\nbbb\nccc\nNEW");
	});

	it("auto-absorbs duplicated trailing payload at BOF insert", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		// `BOF:` payload prepends NEW but trails with the first two file lines.
		const diff = ["BOF:", above("NEW"), above("aaa"), above("bbb")].join("\n");
		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("NEW\naaa\nbbb\nccc");
	});

	it("preserves a single duplicated anchor line in a pure insert even when generic duplicate absorption is enabled", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`${tag(2, "bbb")}:`, below("bbb"), below("NEW")].join("\n");

		expect(applyDiffWithPureInsertAutoDrop(source, diff)).toBe("aaa\nbbb\nbbb\nNEW\nccc");
	});

	it("surfaces a warning when pure-insert duplicates are auto-dropped", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`${tag(2, "bbb")}:`, below("aaa"), below("bbb"), below("NEW")].join("\n");
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
			repl(""),
			repl("# not a header"),
			repl("+ not an op"),
			repl("\\ not an op"),
			repl("  spaced"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\n\n# not a header\n+ not an op\n\\ not an op\n  spaced\nccc");
	});

	it("treats explicit empty replace payload rows as blank lines", () => {
		const diff = [`${sameLineRange(tag(2, "bbb"))}:`, repl("first"), repl(""), repl(""), repl("after")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nfirst\n\n\nafter\nccc");
	});

	it("skips markdown-comment lines immediately before an operation", () => {
		const diff = [
			"# This is a comment line from a model explanation.",
			"## Another comment line.",
			`${tag(2, "bbb")}:`,
			repl("BBB"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nBBB\nccc");
	});

	it("does not skip comment lines when they are not immediately before an operation", () => {
		const diff = ["# This is a stray comment.", "", `${tag(2, "bbb")}:`, repl("BBB")].join("\n");
		expect(() => parseHashline(diff)).toThrow(/payload line has no preceding/);
	});

	it("preserves raw blank separators between ops", () => {
		const diff = [
			`${sameLineRange(tag(1, "aaa"))}:`,
			repl("AAA"),
			"",
			"",
			`${sameLineRange(tag(3, "ccc"))}:`,
			repl("CCC"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("AAA\nbbb\nCCC");
	});

	it("inserts explicit blank lines above and below an anchor", () => {
		const anchor = { line: 1 };
		expect(parseHashline(`${tag(1, "aaa")}:\n${above("")}`).edits).toEqual([
			{ kind: "insert", cursor: { kind: "before_anchor", anchor }, text: "", lineNum: 1, index: 0 },
		]);
		expect(parseHashline(`${tag(1, "aaa")}:\n${below("")}`).edits).toEqual([
			{ kind: "insert", cursor: { kind: "after_anchor", anchor }, text: "", lineNum: 1, index: 0 },
		]);
	});

	it("rejects orphan payload lines with no preceding op", () => {
		expect(() => parseHashline(repl("orphan")).edits).toThrow(/payload line has no preceding/);
	});

	it("rejects ranges with `..` separator", () => {
		expect(() => parseHashline(`${tag(2, "bbb")}..${tag(3, "ccc")}:\n${repl("BBB")}`).edits).toThrow(
			/payload line has no preceding/,
		);
	});

	it("describes the new block shape on unknown-op lines", () => {
		expect(() => parseHashline(`-${sameLineRange(tag(2, "bbb"))}`).edits).toThrow(/Use A-B:, A:, BOF:, or EOF:/);
	});

	it("rejects `LINE:TEXT` copied verbatim from read output", () => {
		const anchor = tag(2, "bbb");
		expect(() => parseHashline(`${anchor}:BBB`)).toThrow(/Inline payload on the anchor line is rejected/);
		expect(() => parseHashline(`${anchor}-${tag(3, "ccc")}:BBB`)).toThrow(
			/Inline payload on the anchor line is rejected/,
		);
	});

	it("leniently strips `*`/`>` line-marker decoration from anchors", () => {
		const anchor = tag(2, "bbb");
		expect(applyDiff(content, `*${anchor}:\n${repl("BBB")}`)).toBe("aaa\nBBB\nccc");
		expect(applyDiff(content, `>${anchor}:\n${above("X")}`)).toBe("aaa\nX\nbbb\nccc");
	});

	it("rejects arrow replace syntax as an unrecognized payload line", () => {
		expect(() => parseHashline(`2→\nBBB`).edits).toThrow(/payload line has no preceding/);
		expect(() => parseHashline(`2-3→\nBBB`).edits).toThrow(/payload line has no preceding/);
	});

	it("preserves payload text containing arrow sigils after the leading payload sigil", () => {
		const anchor = tag(2, "bbb");
		expect(applyDiff(content, `${anchor}:\n${repl("bbb↑")}\n${below("tail↓")}`)).toBe("aaa\nbbb↑\ntail↓\nccc");
	});

	it("accepts BOF/EOF inserts with either arrow payload sigil", () => {
		expect(applyDiff(content, `BOF:\n${below("HEAD")}`)).toBe("HEAD\naaa\nbbb\nccc");
		expect(applyDiff(content, `EOF:\n${above("TAIL")}`)).toBe("aaa\nbbb\nccc\nTAIL");
	});

	it("coalesces two replace ops targeting the same single line (last wins)", () => {
		const diff = `${tag(2, "bbb")}:\n${repl("BBB")}\n${tag(2, "bbb")}:\n${repl("BBB2")}`;
		const { edits, warnings } = parseHashline(diff);
		expect(applyHashlineEdits("aaa\nbbb\nccc", edits).lines).toBe("aaa\nBBB2\nccc");
		expect(warnings).toEqual([
			"Detected two identical-range hashline blocks; kept only the second block. Issue ONE block per range — payload is the final desired content, never both old and new.",
		]);
	});

	it("coalesces two replace ops covering the same range (before/after-block pattern, last wins)", () => {
		const diff = `${tag(2, "bbb")}-${tag(3, "ccc")}:\n${repl("OLD")}\n${repl("OLD2")}\n${tag(2, "bbb")}-${tag(3, "ccc")}:\n${repl("NEW")}\n${repl("NEW2")}`;
		const { edits, warnings } = parseHashline(diff);
		expect(applyHashlineEdits("aaa\nbbb\nccc\nddd", edits).lines).toBe("aaa\nNEW\nNEW2\nddd");
		expect(warnings).toEqual([
			"Detected two identical-range hashline blocks; kept only the second block. Issue ONE block per range — payload is the final desired content, never both old and new.",
		]);
	});

	it("still rejects two replace ops whose ranges partially overlap without containment", () => {
		// 3-5 extends past the outer 2-4, so it is neither identical nor contained.
		// The inner anchors still clash with the outer range's deletes and the
		// post-hoc validator catches the overlap.
		const diff = `${tag(2, "bbb")}-${tag(4, "ddd")}:\n${repl("NEW1")}\n${tag(3, "ccc")}-${tag(5, "eee")}:\n${repl("NEW2")}`;
		expect(() => parseHashline(diff).edits).toThrow(/anchor line 3 is already targeted by the : block on line 1/);
	});

	it("uses `|` payload lines inside a multi-line replacement", () => {
		const diff = `${tag(2, "bbb")}-${tag(4, "ddd")}:\n${repl("line one")}\n${repl("line two")}\n${repl("line three")}`;
		const { edits, warnings } = parseHashline(diff);
		expect(applyHashlineEdits("aaa\nbbb\nccc\nddd\neee", edits).lines).toBe(
			"aaa\nline one\nline two\nline three\neee",
		);
		expect(warnings).toEqual([]);
	});

	it("rejects read-output `N:TEXT` lines inside a pending `A-B:` block", () => {
		const diff = `${tag(2, "bbb")}-${tag(4, "ddd")}:\n${repl("line one")}\n${tag(3, "ccc")}:line two`;
		expect(() => parseHashline(diff)).toThrow(/Inline payload on the anchor line is rejected/);
	});

	it("treats `N:` outside the pending range as a separate op", () => {
		const diff = `${tag(2, "bbb")}-${tag(3, "ccc")}:\n${repl("line one")}\n${tag(5, "eee")}:\n${repl("line five")}`;
		const { edits, warnings } = parseHashline(diff);
		expect(applyHashlineEdits("aaa\nbbb\nccc\nddd\neee\nfff", edits).lines).toBe(
			"aaa\nline one\nddd\nline five\nfff",
		);
		expect(warnings).toEqual([]);
	});

	it("accepts multiple inserts in the same bucket", () => {
		const diff = `${tag(2, "bbb")}:\n${above("X")}\n${above("Y")}`;
		expect(applyDiff(content, diff)).toBe("aaa\nX\nY\nbbb\nccc");
	});

	it("accepts a replace alongside an insert at the same anchor", () => {
		const diff = `${tag(2, "bbb")}:\n${above("ABOVE")}\n${repl("NEW")}`;
		expect(applyDiff(content, diff)).toBe("aaa\nABOVE\nNEW\nccc");
	});
});

describe("hashline — file hash binding", () => {
	it("rejects line-hash anchors as unrecognized payload lines", () => {
		expect(() => parseHashline(`2ab:\n${repl("BBB")}`).edits).toThrow(/payload line has no preceding/);
	});

	it("applies line-number edits without per-anchor hash validation", () => {
		const diff = `${sameLineRange(tag(2, "bbb"))}:\n${repl("BBB")}`;
		expect(applyDiff("aaa\nbbb\nccc", diff)).toBe("aaa\nBBB\nccc");
	});
});

describe("splitHashlineInput — ¶ headers", () => {
	it("extracts path, file hash, and diff body from ¶path#hash header", () => {
		const input = [`¶src/foo.ts#1a2b`, `${sameLineRange(tag(2, "bbb"))}:`, repl("BBB")].join("\n");
		expect(splitHashlineInput(input)).toEqual({
			path: "src/foo.ts",
			fileHash: "1a2b",
			diff: `${sameLineRange(tag(2, "bbb"))}:\n${repl("BBB")}`,
		});
	});

	it("strips leading blank lines", () => {
		expect(splitHashlineInput(`\n¶foo.ts\nBOF:\n${below("x")}`)).toEqual({
			path: "foo.ts",
			diff: `BOF:\n${below("x")}`,
		});
	});

	it("normalizes cwd-prefixed absolute paths to cwd-relative paths", () => {
		const cwd = process.cwd();
		const absolute = path.join(cwd, "src", "foo.ts");
		expect(splitHashlineInput(`¶${absolute}\nBOF:\n${below("x")}`, { cwd }).path).toBe("src/foo.ts");
	});

	it("uses explicit fallback path only when input has recognizable operations", () => {
		expect(splitHashlineInput(`BOF:\n${below("x")}`, { path: "a.ts" })).toEqual({
			path: "a.ts",
			diff: `BOF:\n${below("x")}`,
		});
		expect(() => splitHashlineInput("plain text", { path: "a.ts" })).toThrow(/must begin with/);
	});

	it("splits multiple edit sections", () => {
		const input = ["¶a.ts", "BOF:", below("a"), "¶b.ts", "EOF:", below("b")].join("\n");
		expect(splitHashlineInputs(input)).toEqual([
			{ path: "a.ts", diff: `BOF:\n${below("a")}` },
			{ path: "b.ts", diff: `EOF:\n${below("b")}` },
		]);
	});

	it("tolerates extra ¶ chars on the section header", () => {
		const input = ["¶¶a.ts", "BOF:", below("a"), "¶¶¶b.ts", "EOF:", below("b")].join("\n");
		expect(splitHashlineInputs(input)).toEqual([
			{ path: "a.ts", diff: `BOF:\n${below("a")}` },
			{ path: "b.ts", diff: `EOF:\n${below("b")}` },
		]);
	});

	it("silently drops a duplicate header with no operations between them", () => {
		const input = ["¶¶src/foo.ts", "¶¶src/foo.ts", "BOF:", below("x")].join("\n");
		expect(splitHashlineInputs(input)).toEqual([{ path: "src/foo.ts", diff: `BOF:\n${below("x")}` }]);
	});

	it("silently drops a trailing header with no operations", () => {
		const input = ["¶¶a.ts", "BOF:", below("a"), "¶¶b.ts"].join("\n");
		expect(splitHashlineInputs(input)).toEqual([{ path: "a.ts", diff: `BOF:\n${below("a")}` }]);
	});
});

it("preflights write policy for every section before committing a batch", async () => {
	const fixture = new PolicyFilesystem(
		[
			["a.ts", "aaa\n"],
			["b.ts", "bbb\n"],
		],
		["b.ts"],
	);
	const input = [
		header("a.ts", "aaa\n"),
		`${sameLineRange(tag(1, "aaa"))}:`,
		repl("AAA"),
		header("b.ts", "bbb\n"),
		`${sameLineRange(tag(1, "bbb"))}:`,
		repl("BBB"),
	].join("\n");

	await expect(new Patcher({ fs: fixture }).apply(Patch.parse(input))).rejects.toThrow(/blocked write: b\.ts/);
	expect(fixture.get("a.ts")).toBe("aaa\n");
	expect(fixture.get("b.ts")).toBe("bbb\n");
});

describe("hashline executor", () => {
	it("creates a missing file with a file-scoped insert", async () => {
		await withTempDir(async tempDir => {
			const input = `¶new.ts\nBOF:\n${below("export const x = 1;")}\n`;
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, input));
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("¶new.ts#");
			expect(await Bun.file(path.join(tempDir, "new.ts")).text()).toBe("export const x = 1;");
		});
	});
	it("honors the pure-insert duplicate auto-drop setting", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const source = ["aaa", "bbb", "ccc"].join("\n");
			const input = `${header("a.ts", source)}\n${tag(2, "bbb")}:\n${below("aaa")}\n${below("bbb")}\n${below("NEW")}\n`;

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
				repl("AAA"),
				bHeader,
				`${sameLineRange(tag(1, "bbb"))}:`,
				repl("BBB"),
			].join("\n");

			await expect(executeHashlineSingle(hashlineExecuteOptions(tempDir, input))).rejects.toThrow(
				/file changed between read and edit|file hashes to/,
			);
			expect(await Bun.file(aPath).text()).toBe("aaa\n");
			expect(await Bun.file(bPath).text()).toBe("bbb\n");
		});
	});

	it("rejects duplicate canonical targets before writing stale section results", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const source = "one\ntwo\n";
			await Bun.write(filePath, source);
			const input = [
				header("a.ts", source),
				`${sameLineRange(tag(1, "one"))}:`,
				repl("ONE"),
				header("./a.ts", source),
				`${sameLineRange(tag(2, "two"))}:`,
				repl("TWO"),
			].join("\n");

			await expect(executeHashlineSingle(hashlineExecuteOptions(tempDir, input))).rejects.toThrow(
				/resolve to the same file/,
			);
			expect(await Bun.file(filePath).text()).toBe(source);
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
				repl("L2a"),
				repl("L2b"),
				repl("L2c"),
				repl("L2d"),
				repl("L2e"),
				repl("L2f"),
				repl("L2g"),
				repl("L2h"),
				repl("L2i"),
				header("a.ts", `${original}\n`),
				`${tag(8, "L8")}:`,
				below("INSERTED"),
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

describe("hashlineEditParamsSchema — payload shape", () => {
	it("declares only `input` as the model-facing field", () => {
		const jsonSchema = z.toJSONSchema(hashlineEditParamsSchema) as {
			properties?: Record<string, unknown>;
			required?: string[];
		};

		expect(Object.keys(jsonSchema.properties ?? {})).toEqual(["input"]);
		expect(jsonSchema.required).toEqual(["input"]);
	});

	it("tolerates provider extra fields without declaring `path`", () => {
		expect(hashlineEditParamsSchema.safeParse({ path: "x.ts", input: `¶x.ts\nBOF:\n${below("x")}` }).success).toBe(
			true,
		);
	});

	it("accepts `_input` as a provider-emitted alias for `input`", () => {
		const parsed = hashlineEditParamsSchema.safeParse({ _input: `¶x.ts\nBOF:\n${below("x")}` });
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.input).toBe(`¶x.ts\nBOF:\n${below("x")}`);
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
			const input = `${header("a.ts", v0Text)}\n${sameLineRange(tag(2, "L2"))}:\n${repl("L2-MODEL")}\n`;
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

			const input = `${header("a.ts", v0Text)}\n${sameLineRange(tag(6, "L6"))}:\n${repl("L6-MODEL")}\n`;
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
		const edits = parseHashline(`${sameLineRange(tag(2, "beta"))}:\n${repl("BETA-MODEL")}`).edits;

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
		expect(a.head(fakePath)).not.toBeNull();
		expect(b.head(fakePath)).toBeNull();
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
			const firstInput = `${header("a.ts", v0Text)}\n${sameLineRange(tag(2, "beta"))}:\n${repl("BETA")}\n`;
			await executeHashlineSingle(hashlineExecuteOptions(tempDir, firstInput, undefined, session));
			const v1Lines = ["alpha", "BETA", "gamma", "delta", "epsilon"];
			expect(await Bun.file(filePath).text()).toBe(`${v1Lines.join("\n")}\n`);
			const snap = getFileReadCache(session).head(filePath);
			expect(snap?.lines.get(1)).toBe("alpha");
			expect(snap?.lines.get(2)).toBe("BETA");
			expect(snap?.lines.get(3)).toBe("gamma");

			// External actor prepends 7 lines after the edit. Anchors authored
			// against V1 (the post-edit state the model just observed) no longer
			// match V2 — recovery must consult the cached V1 snapshot to land the
			// second edit.
			const v2Lines = ["H1", "H2", "H3", "H4", "H5", "H6", "H7", ...v1Lines];
			await Bun.write(filePath, `${v2Lines.join("\n")}\n`);

			const secondInput = `${header("a.ts", `${v1Lines.join("\n")}\n`)}\n${sameLineRange(tag(3, "gamma"))}:\n${repl("GAMMA")}\n`;
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

	it("rejects replay when a prior in-session edit rewrote the line the model re-targets", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const v0Lines = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"];
			const v0Text = `${v0Lines.join("\n")}\n`;
			await Bun.write(filePath, v0Text);

			const session = makeHashlineSession(tempDir);
			getFileReadCache(session).recordContiguous(filePath, 1, v0Text.split("\n"), {
				fullText: v0Text,
				fileHash: computeFileHash(v0Text),
			});

			// First edit lands cleanly against v0: line 5 becomes L5-FIRST.
			const firstInput = `${header("a.ts", v0Text)}\n${sameLineRange(tag(5, "L5"))}:\n${extra(pl("L5-FIRST"))}\n`;
			await executeHashlineSingle(hashlineExecuteOptions(tempDir, firstInput, undefined, session));

			const v1Lines = [...v0Lines];
			v1Lines[4] = "L5-FIRST";
			expect(await Bun.file(filePath).text()).toBe(`${v1Lines.join("\n")}\n`);

			// Second edit: model is still anchored against v0 (stale hash) and
			// again targets line 5 — the very line the first edit rewrote.
			// Recovery must refuse so the model re-reads instead of silently
			// overwriting L5-FIRST with payload authored against L5.
			const secondInput = `${header("a.ts", v0Text)}\n${sameLineRange(tag(5, "L5"))}:\n${extra(pl("L5-SECOND"))}\n`;
			await expect(
				executeHashlineSingle(hashlineExecuteOptions(tempDir, secondInput, undefined, session)),
			).rejects.toThrow(HashlineMismatchError);
			expect(await Bun.file(filePath).text()).toBe(`${v1Lines.join("\n")}\n`);
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
			edits: parseHashline(`10:\n${repl("L10-EDITED")}`).edits,
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
		expect(cache.head(fakePath)?.fileHash).toBe(computeFileHash("three\n"));
		expect(cache.byHash(fakePath, computeFileHash("one\n"))?.fullText).toBe("one\n");
		expect(cache.byHash(fakePath, computeFileHash("two\n"))?.fullText).toBe("two\n");
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

		const snap = cache.head(fakePath);
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
		expect(cache.head("/tmp/file-0.ts")).toBeNull();
		expect(cache.head("/tmp/file-1.ts")).toBeNull();
		expect(cache.head("/tmp/file-2.ts")).not.toBeNull();
		expect(cache.head("/tmp/file-31.ts")).not.toBeNull();
	});
});

describe("hashline *** Abort recovery sentinel (harmony-leak mitigation)", () => {
	const sentinel = "*** Abort";

	it("parser breaks at *** Abort and surfaces a warning", () => {
		const diff = [`${tag(1, "alpha")}:`, below("HELLO"), sentinel, `${tag(99, "junk")}:`, below("never")].join("\n");
		const { edits, warnings } = parseHashline(diff);
		expect(edits).toHaveLength(1);
		expect(edits[0]).toMatchObject({ kind: "insert", text: "HELLO" });
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toMatch(/truncated mid-call/i);
	});

	it("appended sentinel from harmony-leak truncation: ops above are preserved", () => {
		// Mirrors the exact shape harmony-leak emits inside a single section.
		const diff = `${tag(1, "alpha")}:\n${below("KEPT")}\n*** Abort\n`;
		const { edits, warnings } = parseHashline(diff);
		expect(edits).toHaveLength(1);
		expect(edits[0]).toMatchObject({ text: "KEPT" });
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("splitter respects *** Abort like *** End Patch", () => {
		const input = [
			`¶a.ts`,
			`${tag(1, "alpha")}:`,
			below("a-payload"),
			sentinel,
			`¶b.ts`,
			`${tag(1, "beta")}:`,
			below("never-emitted"),
		].join("\n");
		const sections = splitHashlineInputs(input);
		expect(sections).toHaveLength(1);
		expect(sections[0].path).toBe("a.ts");
		expect(sections[0].diff.includes("never-emitted")).toBe(false);
	});

	it("clean input without sentinel produces no warning", () => {
		const diff = `${tag(1, "alpha")}:\n${below("PAYLOAD")}\n`;
		const { warnings } = parseHashline(diff);
		expect(warnings).toEqual([]);
	});
});

describe("hashline parser — blank payload rows", () => {
	it("bare A: deletes the line", () => {
		const text = "line1\nline2\nline3\n";
		const { diff } = splitHashlineInput(`${header("a.ts", text)}\n2:\n`);
		expect(applyDiff(text, diff)).toBe("line1\nline3\n");
	});

	it("bare A-B: deletes the range", () => {
		const text = "line1\nline2\nline3\nline4\n";
		const { diff } = splitHashlineInput(`${header("a.ts", text)}\n2-3:\n`);
		expect(applyDiff(text, diff)).toBe("line1\nline4\n");
	});

	it("A: with inline body is rejected", () => {
		const text = "line1\nline2\nline3\n";
		const { diff } = splitHashlineInput(`${header("a.ts", text)}\n2:replacement\n`);
		expect(() => parseHashline(diff)).toThrow(/Inline payload on the anchor line is rejected/);
	});

	it("explicit empty above/below rows insert blank lines", () => {
		const text = "line1\nline2\nline3\n";
		const aboveDiff = splitHashlineInput(`${header("a.ts", text)}\n2:\n${above("")}\n`).diff;
		expect(applyDiff(text, aboveDiff)).toBe("line1\n\nline2\nline3\n");

		const belowDiff = splitHashlineInput(`${header("a.ts", text)}\n2:\n${below("")}\n`).diff;
		expect(applyDiff(text, belowDiff)).toBe("line1\nline2\n\nline3\n");
	});
});

describe("hashline parser — explicit blank payload rows", () => {
	it("raw blank lines between ops are ignored", () => {
		const text = "a\nb\nc\nd\ne\n";
		const ops = `${header("a.ts", text)}\n1:\n${repl("A")}\n\n3:\n${repl("C")}\n`;
		const { diff } = splitHashlineInput(ops);
		expect(applyDiff(text, diff)).toBe("A\nb\nC\nd\ne\n");
	});

	it("empty replace payload rows are appended as blank payload lines", () => {
		const text = "a\nb\nc\nd\ne\n";
		const ops = `${header("a.ts", text)}\n1:\n${repl("A")}\n${repl("")}\n${repl("")}\n3:\n${repl("C")}\n`;
		const { diff } = splitHashlineInput(ops);
		expect(applyDiff(text, diff)).toBe("A\n\n\nb\nC\nd\ne\n");
	});

	it("bare A: followed by two empty replace rows replaces the line with two blanks", () => {
		const text = "a\nb\nc\nd\ne\n";
		const ops = `${header("a.ts", text)}\n2:\n${repl("")}\n${repl("")}\n4:\n${repl("D")}\n`;
		const { diff } = splitHashlineInput(ops);
		expect(applyDiff(text, diff)).toBe("a\n\n\nc\nD\ne\n");
	});

	it("empty replace row inside payload between two content lines is preserved", () => {
		const text = "a\nb\nc\n";
		const ops = `${header("a.ts", text)}\n2:\n${repl("first")}\n${repl("")}\n${repl("second")}\n`;
		const { diff } = splitHashlineInput(ops);
		expect(applyDiff(text, diff)).toBe("a\nfirst\n\nsecond\nc\n");
	});
});

import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyEdits,
	buildCompactDiffPreview as buildCompactHashlineDiffPreview,
	detectLineEnding,
	type Edit,
	InMemorySnapshotStore as FileReadCache,
	Filesystem,
	formatHashlineHeader,
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
 * The test bodies use a small adapter over the package API so production code
 * can use the package names directly while assertions stay compact.
 */
function applyHashlineEdits(
	text: string,
	edits: readonly Edit[],
): {
	text: string;
	lines: string;
	firstChangedLine?: number;
	warnings?: string[];
} {
	const r = applyEdits(text, [...edits]);
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
	tag: string;
	edits: readonly Edit[];
}): { text: string; lines: string; firstChangedLine: number | undefined; warnings: string[] } | null {
	const recovered = new Recovery(args.cache).tryRecover({
		path: args.absolutePath,
		currentText: args.currentText,
		fileHash: args.tag,
		edits: args.edits,
	});
	return recovered ? { ...recovered, lines: recovered.text } : null;
}

import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

const repl = (text: string): string => `+${text}`;
const outputSep = ":";
const outputSepRe = ":";

function tag(line: number, _content: string): string {
	return `${line}`;
}

function recordFullSnapshot(cache: FileReadCache, filePath: string, fullText: string): string {
	return cache.record(filePath, fullText);
}

function header(filePath: string, tag: string): string {
	return formatHashlineHeader(filePath, tag);
}

function sameLineRange(anchor: string): string {
	return `replace ${anchor}..${anchor}:`;
}

function applyDiff(content: string, diff: string): string {
	return applyHashlineEdits(content, parseHashline(diff).edits).lines;
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
		const section = Patch.parseSingle(["¶a.ts", `insert after ${tag(2, "bbb")}:`, repl("tail")].join("\n"));

		expect(section.applyTo("aaa\nbbb").text).toBe("aaa\nbbb\ntail");
		expect(section.applyTo("aaa\nbbb\nccc").text).toBe("aaa\nbbb\ntail\nccc");
	});

	const content = "aaa\nbbb\nccc";

	it("inserts payload before/after a Lid, and at insert head:/insert tail:", () => {
		const diff = [
			`insert before ${tag(2, "bbb")}:`,
			repl("before b"),
			`insert after ${tag(2, "bbb")}:`,
			repl("after b"),
			"insert head:",
			repl("top"),
			"insert tail:",
			repl("tail"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("top\naaa\nbefore b\nbbb\nafter b\nccc\ntail");
	});

	it("inserts after the final line without falling off the file", () => {
		const diff = [`insert after ${tag(3, "ccc")}:`, repl("tail")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nbbb\nccc\ntail");
	});

	it("deletes a line or range via delete hunks", () => {
		expect(applyDiff(content, `delete ${tag(2, "bbb")}`)).toBe("aaa\nccc");
		expect(applyDiff(content, `delete ${tag(2, "bbb")}..${tag(3, "ccc")}`)).toBe("aaa");
	});

	it("replaces a line with one blank when given an explicit empty replace payload", () => {
		const explicit = [`${sameLineRange(tag(2, "bbb"))}`, repl("")].join("\n");
		expect(applyDiff(content, explicit)).toBe("aaa\n\nccc");
	});

	it("replaces one line or an inclusive range with payload lines", () => {
		const single = [`${sameLineRange(tag(2, "bbb"))}`, repl("BBB")].join("\n");
		expect(applyDiff(content, single)).toBe("aaa\nBBB\nccc");

		const range = [`replace ${tag(2, "bbb")}..${tag(3, "ccc")}:`, repl("BBB"), repl("CCC")].join("\n");
		expect(applyDiff(content, range)).toBe("aaa\nBBB\nCCC");
	});

	it("rejects bare single-number hunk headers", () => {
		const anchor = tag(2, "bbb");
		expect(() => parseHashline(`${anchor}\n${repl("BBB")}`)).toThrow(/hunk headers need a verb/);
	});

	it("delete hunk deletes the range entirely", () => {
		const anchor = tag(2, "bbb");
		expect(applyDiff(content, `delete ${anchor}`)).toBe("aaa\nccc");
		expect(applyDiff(content, `delete ${anchor}..${tag(3, "ccc")}`)).toBe("aaa");
	});

	it("rejects orphan inline-anchor shapes from old format", () => {
		const anchor = tag(2, "bbb");
		for (const diff of [`${anchor}..${tag(3, "ccc")}=NEW`, "insert head:=NEW", "insert tail:=NEW"]) {
			expect(() => parseHashline(diff)).toThrow(/payload line has no preceding hunk header/);
		}
	});

	it("emits body rows in textual order", () => {
		const diff = [
			`${sameLineRange(tag(2, "bbb"))}`,
			repl("above 1"),
			repl("above 2"),
			repl("BBB"),
			repl("below 1"),
			repl("below 2"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nabove 1\nabove 2\nBBB\nbelow 1\nbelow 2\nccc");
	});

	it("inserts around an anchor with explicit insert hunks", () => {
		const diff = [
			`insert before ${tag(2, "bbb")}:`,
			repl("before"),
			`insert after ${tag(2, "bbb")}:`,
			repl("after"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nbefore\nbbb\nafter\nccc");
	});

	it("escapes literal leading payload sigils with literal rows", () => {
		// `+` is the canonical sigil; payload rows like `+|literal` emit
		// `|literal` verbatim. Same for `^literal` and `↓literal` — none of
		// these are recognized sigils once they sit inside a `+TEXT` row.
		const diff = [`${sameLineRange(tag(2, "bbb"))}`, repl("|literal"), repl("^literal"), repl("↓literal")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\n|literal\n^literal\n↓literal\nccc");
	});

	it("accepts literal payload at virtual insert head:/insert tail: anchors", () => {
		expect(applyDiff(content, ["insert head:", repl("HEAD")].join("\n"))).toBe("HEAD\naaa\nbbb\nccc");
		expect(applyDiff(content, ["insert tail:", repl("TAIL")].join("\n"))).toBe("aaa\nbbb\nccc\nTAIL");
	});

	it("auto-pipes unprefixed payload continuation lines as literal text", () => {
		const anchor = tag(2, "bbb");
		const { edits, warnings } = parseHashline(`${sameLineRange(anchor)}\n${repl("FIRST")}\nSECOND`);
		expect(applyHashlineEdits("aaa\nbbb\nccc", edits).lines).toBe("aaa\nFIRST\nSECOND\nccc");
		expect(warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("preserves whitespace-bearing payload exactly", () => {
		const anchor = tag(2, "bbb");
		const payload = "\tconst streamKeepaliveMs = opts.streamKeepaliveMs;";
		expect(applyDiff(content, [`insert after ${anchor}:`, repl(payload)].join("\n"))).toBe(
			`aaa\nbbb\n${payload}\nccc`,
		);
		expect(applyDiff(content, [`insert before ${anchor}:`, repl(payload)].join("\n"))).toBe(
			`aaa\n${payload}\nbbb\nccc`,
		);
	});

	it("keeps duplicated multiline replacement boundaries literal", () => {
		const prefixSource = ["// one", "// two", "old();"].join("\n");
		const prefixDiff = [`${sameLineRange(tag(3, "old();"))}`, repl("// one"), repl("// two"), repl("new();")].join(
			"\n",
		);
		expect(applyDiff(prefixSource, prefixDiff)).toBe(["// one", "// two", "// one", "// two", "new();"].join("\n"));

		const suffixSource = ["old();", "// one", "// two"].join("\n");
		const suffixDiff = [`${sameLineRange(tag(1, "old();"))}`, repl("new();"), repl("// one"), repl("// two")].join(
			"\n",
		);
		expect(applyDiff(suffixSource, suffixDiff)).toBe(["new();", "// one", "// two", "// one", "// two"].join("\n"));
	});

	it("de-duplicates structural replacement boundaries (balance-validated)", () => {
		// `replace 1..1:` replaces `old();` but the payload also restates the `};` that
		// survives at line 2 — a duplicate close that would unbalance braces.
		const suffixSource = ["old();", "};"].join("\n");
		const suffixDiff = [`${sameLineRange(tag(1, "old();"))}`, repl("new();"), repl("};")].join("\n");
		expect(applyDiff(suffixSource, suffixDiff)).toBe(["new();", "};"].join("\n"));

		// Mirror case at the leading edge.
		const prefixSource = ["};", "old();"].join("\n");
		const prefixDiff = [`${sameLineRange(tag(2, "old();"))}`, repl("};"), repl("new();")].join("\n");
		expect(applyDiff(prefixSource, prefixDiff)).toBe(["};", "new();"].join("\n"));

		const result = applyHashlineEdits(suffixSource, parseHashline(suffixDiff).edits);
		expect(result.warnings?.some(w => /delimiter-balance/.test(w))).toBe(true);
	});

	it("keeps duplicated single non-structural replacement boundaries literal", () => {
		const prefixSource = ["const X = …", "", "const LEGACY = {", "  a: 1,", "}"].join("\n");
		const prefixDiff = [`replace ${tag(2, "")}..${tag(5, "}")}:`, repl("const X = …")].join("\n");
		expect(applyDiff(prefixSource, prefixDiff)).toBe(["const X = …", "const X = …"].join("\n"));

		const suffixSource = ["## Legacy", "", "stale content", "", "## Subagents"].join("\n");
		const suffixDiff = [`replace ${tag(1, "## Legacy")}..${tag(4, "")}:`, repl("## Subagents")].join("\n");
		expect(applyDiff(suffixSource, suffixDiff)).toBe(["## Subagents", "## Subagents"].join("\n"));
	});

	it("does not emit warnings for duplicated replacement boundaries", () => {
		const source = ["// one", "// two", "old();"].join("\n");
		const diff = [`${sameLineRange(tag(3, "old();"))}`, repl("// one"), repl("// two"), repl("new();")].join("\n");

		const result = applyHashlineEdits(source, parseHashline(diff).edits);
		expect(result.lines).toBe(["// one", "// two", "// one", "// two", "new();"].join("\n"));
		expect(result.warnings).toBeUndefined();
	});

	it("preserves a legitimate single-line replacement that happens to match an adjacent line", () => {
		const source = ["foo", "bar", "baz"].join("\n");
		const diff = [`${sameLineRange(tag(2, "bar"))}`, repl("foo")].join("\n");

		expect(applyDiff(source, diff)).toBe(["foo", "foo", "baz"].join("\n"));
	});

	it("keeps pure-insert payload that duplicates adjacent file context", () => {
		const eofSource = ["aaa", "bbb", "ccc"].join("\n");
		const eofDiff = ["insert tail:", repl("bbb"), repl("ccc"), repl("NEW")].join("\n");
		expect(applyDiff(eofSource, eofDiff)).toBe("aaa\nbbb\nccc\nbbb\nccc\nNEW");

		const bofSource = ["aaa", "bbb", "ccc", "ddd"].join("\n");
		const bofDiff = ["insert head:", repl("NEW"), repl("aaa"), repl("bbb")].join("\n");
		expect(applyDiff(bofSource, bofDiff)).toBe("NEW\naaa\nbbb\naaa\nbbb\nccc\nddd");
	});

	it("preserves duplicated structural pure-insert payload", () => {
		const source = ["if ok {", "   keep();", "   }"].join("\n");
		const diff = ["insert tail:", repl("   added();"), repl("   }")].join("\n");

		expect(applyDiff(source, diff)).toBe(["if ok {", "   keep();", "   }", "   added();", "   }"].join("\n"));
	});

	it("preserves an intentional non-structural duplicate for after insert", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`insert after ${tag(2, "bbb")}:`, repl("bbb"), repl("NEW")].join("\n");

		expect(applyDiff(source, diff)).toBe("aaa\nbbb\nbbb\nNEW\nccc");
	});

	it("preserves an intentional non-structural duplicate for before insert", () => {
		const source = ["aaa", "bbb", "ccc"].join("\n");
		const diff = [`insert before ${tag(2, "bbb")}:`, repl("NEW"), repl("bbb")].join("\n");

		expect(applyDiff(source, diff)).toBe("aaa\nNEW\nbbb\nbbb\nccc");
	});

	it("keeps a single structural pure-insert suffix when it preserves balance", () => {
		const source = ["if outer {", "}"].join("\n");
		const diff = [`insert before ${tag(2, "}")}:`, repl("if inner {"), repl("}")].join("\n");

		expect(applyDiff(source, diff)).toBe(["if outer {", "if inner {", "}", "}"].join("\n"));
	});

	it("preserves payload text exactly", () => {
		const diff = [
			`${sameLineRange(tag(2, "bbb"))}`,
			repl(""),
			repl("# not a header"),
			repl("+ not an op"),
			repl("\\ not an op"),
			repl("  spaced"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\n\n# not a header\n+ not an op\n\\ not an op\n  spaced\nccc");
	});

	it("treats explicit empty replace payload rows as blank lines", () => {
		const diff = [`${sameLineRange(tag(2, "bbb"))}`, repl("first"), repl(""), repl(""), repl("after")].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nfirst\n\n\nafter\nccc");
	});

	it("skips markdown-comment lines immediately before an operation", () => {
		const diff = [
			"# This is a comment line from a model explanation.",
			"## Another comment line.",
			`${sameLineRange(tag(2, "bbb"))}`,
			repl("BBB"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("aaa\nBBB\nccc");
	});

	it("does not skip comment lines when they are not immediately before an operation", () => {
		const diff = ["# This is a stray comment.", "", `${sameLineRange(tag(2, "bbb"))}`, repl("BBB")].join("\n");
		expect(() => parseHashline(diff)).toThrow(/payload line has no preceding/);
	});

	it("preserves raw blank separators between ops", () => {
		const diff = [
			`${sameLineRange(tag(1, "aaa"))}`,
			repl("AAA"),
			"",
			"",
			`${sameLineRange(tag(3, "ccc"))}`,
			repl("CCC"),
		].join("\n");
		expect(applyDiff(content, diff)).toBe("AAA\nbbb\nCCC");
	});

	it("inserts explicit blank lines above and below an anchor", () => {
		expect(applyDiff(content, `insert before ${tag(1, "aaa")}:\n${repl("")}`)).toBe("\naaa\nbbb\nccc");
		expect(applyDiff(content, `insert after ${tag(1, "aaa")}:\n${repl("")}`)).toBe("aaa\n\nbbb\nccc");
	});

	it("rejects orphan payload lines with no preceding op", () => {
		expect(() => parseHashline(repl("orphan")).edits).toThrow(/payload line has no preceding/);
	});

	it("rejects empty replace bodies; use delete instead", () => {
		expect(() => parseHashline(`${sameLineRange(tag(2, "bbb"))}`)).toThrow(/To delete lines, use `delete/);
		expect(parseHashline(`delete ${tag(2, "bbb")}`).edits).toEqual([
			{ kind: "delete", anchor: { line: 2 }, lineNum: 1, index: 0 },
		]);
	});

	it("rejects `LINE:TEXT` copied verbatim from read output", () => {
		const anchor = tag(2, "bbb");
		expect(() => parseHashline(`${sameLineRange(anchor)}:BBB`)).toThrow(/payload line has no preceding hunk header/);
		expect(() => parseHashline(`${anchor}..${tag(3, "ccc")}:BBB`)).toThrow(
			/payload line has no preceding hunk header/,
		);
	});

	it("rejects arrow replace syntax as an unrecognized payload line", () => {
		expect(() => parseHashline(`2→\nBBB`).edits).toThrow(/payload line has no preceding/);
		expect(() => parseHashline(`2-3→\nBBB`).edits).toThrow(/payload line has no preceding/);
	});

	it("preserves payload text containing arrow sigils after the leading payload sigil", () => {
		const anchor = tag(2, "bbb");
		expect(applyDiff(content, `${sameLineRange(anchor)}\n${repl("bbb↑")}\n${repl("tail↓")}`)).toBe(
			"aaa\nbbb↑\ntail↓\nccc",
		);
	});

	it("accepts insert head:/insert tail: inserts with literal payload rows", () => {
		expect(applyDiff(content, `insert head:\n${repl("HEAD")}`)).toBe("HEAD\naaa\nbbb\nccc");
		expect(applyDiff(content, `insert tail:\n${repl("TAIL")}`)).toBe("aaa\nbbb\nccc\nTAIL");
	});

	it("rejects two replace ops targeting the same single line", () => {
		const diff = `${sameLineRange(tag(2, "bbb"))}\n${repl("BBB")}\n${sameLineRange(tag(2, "bbb"))}\n${repl("BBB2")}`;
		expect(() => parseHashline(diff).edits).toThrow(/anchor line 2 is already targeted/);
	});

	it("rejects two replace ops covering the same range", () => {
		const diff = `replace ${tag(2, "bbb")}..${tag(3, "ccc")}:\n${repl("OLD")}\n${repl("OLD2")}\nreplace ${tag(2, "bbb")}..${tag(3, "ccc")}:\n${repl("NEW")}\n${repl("NEW2")}`;
		expect(() => parseHashline(diff).edits).toThrow(/anchor line 2 is already targeted/);
	});

	it("still rejects two replace ops whose ranges partially overlap without containment", () => {
		// 3-5 extends past the outer 2-4, so it is neither identical nor contained.
		// The inner anchors still clash with the outer range's deletes and the
		// post-hoc validator catches the overlap.
		const diff = `replace ${tag(2, "bbb")}..${tag(4, "ddd")}:\n${repl("NEW1")}\nreplace ${tag(3, "ccc")}..${tag(5, "eee")}:\n${repl("NEW2")}`;
		expect(() => parseHashline(diff).edits).toThrow(/anchor line 3 is already targeted by another hunk on line 1/);
	});

	it("uses `|` payload lines inside a multi-line replacement", () => {
		const diff = `replace ${tag(2, "bbb")}..${tag(4, "ddd")}:\n${repl("line one")}\n${repl("line two")}\n${repl("line three")}`;
		const { edits, warnings } = parseHashline(diff);
		expect(applyHashlineEdits("aaa\nbbb\nccc\nddd\neee", edits).lines).toBe(
			"aaa\nline one\nline two\nline three\neee",
		);
		expect(warnings).toEqual([]);
	});

	it("auto-pipes read-output `N:TEXT` lines inside a pending hunk as literal text", () => {
		const diff = `replace ${tag(2, "bbb")}..${tag(4, "ddd")}:\n${repl("line one")}\n${tag(3, "ccc")}:line two`;
		const { edits, warnings } = parseHashline(diff);
		expect(applyHashlineEdits("aaa\nbbb\nccc\nddd\neee", edits).lines).toBe("aaa\nline one\n3:line two\neee");
		expect(warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("treats `N:` outside the pending range as a separate op", () => {
		const diff = `replace ${tag(2, "bbb")}..${tag(3, "ccc")}:\n${repl("line one")}\n${sameLineRange(tag(5, "eee"))}\n${repl("line five")}`;
		const { edits, warnings } = parseHashline(diff);
		expect(applyHashlineEdits("aaa\nbbb\nccc\nddd\neee\nfff", edits).lines).toBe(
			"aaa\nline one\nddd\nline five\nfff",
		);
		expect(warnings).toEqual([]);
	});

	it("accepts multiple literal rows before an anchor", () => {
		const diff = `insert before ${tag(2, "bbb")}:\n${repl("X")}\n${repl("Y")}`;
		expect(applyDiff(content, diff)).toBe("aaa\nX\nY\nbbb\nccc");
	});

	it("accepts a replace alongside surrounding literal rows", () => {
		const diff = `${sameLineRange(tag(2, "bbb"))}\n${repl("ABOVE")}\n${repl("NEW")}`;
		expect(applyDiff(content, diff)).toBe("aaa\nABOVE\nNEW\nccc");
	});
});

describe("hashline — snapshot tag binding", () => {
	it("rejects line-hash anchors as unrecognized payload lines", () => {
		expect(() => parseHashline(`2ab:\n${repl("BBB")}`).edits).toThrow(/payload line has no preceding/);
	});

	it("applies line-number edits without per-anchor hash validation", () => {
		const diff = `${sameLineRange(tag(2, "bbb"))}\n${repl("BBB")}`;
		expect(applyDiff("aaa\nbbb\nccc", diff)).toBe("aaa\nBBB\nccc");
	});
});

describe("splitHashlineInput — @ headers", () => {
	it("extracts path, snapshot tag, and diff body from @path#tag header", () => {
		const input = [`¶src/foo.ts#1A2B`, `${sameLineRange(tag(2, "bbb"))}`, repl("BBB")].join("\n");
		expect(splitHashlineInput(input)).toEqual({
			path: "src/foo.ts",
			fileHash: "1A2B",
			diff: `${sameLineRange(tag(2, "bbb"))}\n${repl("BBB")}`,
		});
	});

	it("strips leading blank lines", () => {
		expect(splitHashlineInput(`\n¶foo.ts\ninsert head:\n${repl("x")}`)).toEqual({
			path: "foo.ts",
			diff: `insert head:\n${repl("x")}`,
		});
	});

	it("normalizes cwd-prefixed absolute paths to cwd-relative paths", () => {
		const cwd = process.cwd();
		const absolute = path.join(cwd, "src", "foo.ts");
		expect(splitHashlineInput(`¶${absolute}\ninsert head:\n${repl("x")}`, { cwd }).path).toBe("src/foo.ts");
	});

	it("uses explicit fallback path only when input has recognizable operations", () => {
		expect(splitHashlineInput(`insert head:\n${repl("x")}`, { path: "a.ts" })).toEqual({
			path: "a.ts",
			diff: `insert head:\n${repl("x")}`,
		});
		expect(() => splitHashlineInput("plain text", { path: "a.ts" })).toThrow(/must begin with/);
	});

	it("splits multiple edit sections", () => {
		const input = ["¶a.ts", "insert head:", repl("a"), "¶b.ts", "insert tail:", repl("b")].join("\n");
		expect(splitHashlineInputs(input)).toEqual([
			{ path: "a.ts", diff: `insert head:\n${repl("a")}` },
			{ path: "b.ts", diff: `insert tail:\n${repl("b")}` },
		]);
	});
	it("rejects a unified-diff hunk header on the first line as contamination", () => {
		const input = ["@@ -1,3 +1,3 @@", "insert head:", repl("x")].join("\n");
		expect(() => splitHashlineInputs(input)).toThrow(/unified-diff hunk header/);
	});

	it("rejects a unified-diff hunk header (`-N,M +N,M`)", () => {
		const input = ["@@ -1,3 +1,3 @@", "insert head:", repl("x")].join("\n");
		expect(() => splitHashlineInputs(input)).toThrow(/unified-diff hunk header/);
	});

	it("silently drops a trailing header with no operations", () => {
		const input = ["¶a.ts", "insert head:", repl("a"), "¶b.ts"].join("\n");
		expect(splitHashlineInputs(input)).toEqual([{ path: "a.ts", diff: `insert head:\n${repl("a")}` }]);
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
	const snapshots = new FileReadCache();
	const aTag = recordFullSnapshot(snapshots, "a.ts", "aaa\n");
	const bTag = recordFullSnapshot(snapshots, "b.ts", "bbb\n");
	const input = [
		header("a.ts", aTag),
		`${sameLineRange(tag(1, "aaa"))}`,
		repl("AAA"),
		header("b.ts", bTag),
		`${sameLineRange(tag(1, "bbb"))}`,
		repl("BBB"),
	].join("\n");

	await expect(new Patcher({ fs: fixture, snapshots }).apply(Patch.parse(input))).rejects.toThrow(
		/blocked write: b\.ts/,
	);
	expect(fixture.get("a.ts")).toBe("aaa\n");
	expect(fixture.get("b.ts")).toBe("bbb\n");
});

describe("hashline executor", () => {
	it("rejects file creation and directs to the write tool", async () => {
		await withTempDir(async tempDir => {
			const input = `¶new.ts\ninsert head:\n${repl("export const x = 1;")}\n`;
			await expect(executeHashlineSingle(hashlineExecuteOptions(tempDir, input))).rejects.toThrow(/write tool/);
			expect(await Bun.file(path.join(tempDir, "new.ts")).exists()).toBe(false);
		});
	});
	it("applies duplicate pure-insert payload literally", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const source = ["aaa", "bbb", "ccc"].join("\n");
			const session = makeHashlineSession(tempDir);

			await Bun.write(filePath, source);
			const sourceTag = recordFullSnapshot(getFileReadCache(session), filePath, source);
			const input = `${header("a.ts", sourceTag)}\ninsert tail:\n${repl("bbb")}\n${repl("ccc")}\n${repl("NEW")}\n`;
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session));
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(await Bun.file(filePath).text()).toBe("aaa\nbbb\nccc\nbbb\nccc\nNEW");
			expect(text).not.toContain("Auto-dropped");
			expect(text).not.toContain("Auto-absorbed");
		});
	});

	it("emits an actionable no-op diagnostic when the payload matches the file byte-for-byte", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const source = "aaa\nbbb\nccc\n";
			await Bun.write(filePath, source);
			const session = makeHashlineSession(tempDir);
			const sourceTag = recordFullSnapshot(getFileReadCache(session), filePath, source);
			// Replace line 2 with `bbb` — identical to the file content. The
			// patch applies but produces no change.
			const input = `${header("a.ts", sourceTag)}\n${sameLineRange(tag(2, "bbb"))}\n${repl("bbb")}\n`;
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session));
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("parsed and applied cleanly, but produced no change");
			expect(text).toContain("byte-identical to the file");
			expect(text).toContain("re-read the file");
			// The file is untouched.
			expect(await Bun.file(filePath).text()).toBe(source);
		});
	});

	it("preflights every section before writing multi-file edits", async () => {
		await withTempDir(async tempDir => {
			const aPath = path.join(tempDir, "a.ts");
			const bPath = path.join(tempDir, "b.ts");
			await Bun.write(aPath, "aaa\n");
			await Bun.write(bPath, "bbb\n");
			const session = makeHashlineSession(tempDir);
			const aTag = recordFullSnapshot(getFileReadCache(session), aPath, "aaa\n");
			const bHeader = "¶b.ts#FFFF";
			const input = [
				header("a.ts", aTag),
				`${sameLineRange(tag(1, "aaa"))}`,
				repl("AAA"),
				bHeader,
				`${sameLineRange(tag(1, "bbb"))}`,
				repl("BBB"),
			].join("\n");

			await expect(
				executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session)),
			).rejects.toThrow(/file changed between read and edit|file hashes to|section is bound to/);
			expect(await Bun.file(aPath).text()).toBe("aaa\n");
			expect(await Bun.file(bPath).text()).toBe("bbb\n");
		});
	});

	it("rejects duplicate canonical targets before writing stale section results", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const source = "one\ntwo\n";
			await Bun.write(filePath, source);
			const session = makeHashlineSession(tempDir);
			const sourceTag = recordFullSnapshot(getFileReadCache(session), filePath, source);
			const input = [
				header("a.ts", sourceTag),
				`${sameLineRange(tag(1, "one"))}`,
				repl("ONE"),
				header("./a.ts", sourceTag),
				`${sameLineRange(tag(2, "two"))}`,
				repl("TWO"),
			].join("\n");

			await expect(
				executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session)),
			).rejects.toThrow(/resolve to the same file/);
			expect(await Bun.file(filePath).text()).toBe(source);
		});
	});

	it("applies multiple sections targeting the same file against the original snapshot", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const original = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"].join("\n");
			await Bun.write(filePath, `${original}\n`);
			const session = makeHashlineSession(tempDir);
			const originalTag = recordFullSnapshot(getFileReadCache(session), filePath, `${original}\n`);

			// Two sections, both anchored against the ORIGINAL file. Section 1 expands
			// line 2 into 9 lines (net +8 shift). Section 2's anchor points at line 8
			// of the original; after section 1 applies, that content moves to line 16.
			// A naive sequential apply reads the modified disk and fails anchor
			// validation outright.
			const input = [
				header("a.ts", originalTag),
				`${sameLineRange(tag(2, "L2"))}`,
				repl("L2a"),
				repl("L2b"),
				repl("L2c"),
				repl("L2d"),
				repl("L2e"),
				repl("L2f"),
				repl("L2g"),
				repl("L2h"),
				repl("L2i"),
				header("a.ts", originalTag),
				`insert after ${tag(8, "L8")}:`,
				repl("INSERTED"),
			].join("\n");

			await executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session));

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
		expect(
			hashlineEditParamsSchema.safeParse({ path: "x.ts", input: `¶x.ts\ninsert head:\n${repl("x")}` }).success,
		).toBe(true);
	});

	it("accepts `_input` as a provider-emitted alias for `input`", () => {
		const parsed = hashlineEditParamsSchema.safeParse({ _input: `¶x.ts\ninsert head:\n${repl("x")}` });
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.input).toBe(`¶x.ts\ninsert head:\n${repl("x")}`);
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
			const v0Tag = recordFullSnapshot(getFileReadCache(session), filePath, v0Text);

			// External actor (linter, subagent, user) insert heads 7 lines. Anchors
			// authored against V0 no longer match V1, so the model's edit cannot
			// land without consulting the cached snapshot.
			const headerLines = ["H1", "H2", "H3", "H4", "H5", "H6", "H7"];
			const v1Lines = [...headerLines, ...v0Lines];
			await Bun.write(filePath, `${v1Lines.join("\n")}\n`);

			// Model authors anchor against V0 — line 2 is "L2" in V0.
			const input = `${header("a.ts", v0Tag)}\n${sameLineRange(tag(2, "L2"))}\n${repl("L2-MODEL")}\n`;
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session));

			const finalLines = (await Bun.file(filePath).text()).replace(/\n$/, "").split("\n");
			// The external insert head AND the model's edit must both be present.
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
			// Record the full V0 snapshot. The external change below rewrites the
			// exact line the model anchors against, so neither the 3-way merge nor
			// session replay can land — recovery must decline.
			const v0Tag = recordFullSnapshot(getFileReadCache(session), filePath, v0Text);

			const v1Lines = [...v0Lines];
			v1Lines[5] = "L6-CHANGED";
			await Bun.write(filePath, `${v1Lines.join("\n")}\n`);

			const input = `${header("a.ts", v0Tag)}\n${sameLineRange(tag(6, "L6"))}\n${repl("L6-MODEL")}\n`;
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
		const snapshotTag = recordFullSnapshot(cache, fakePath, snapshotText);

		// Live file is completely different — patch context cannot match even
		// with fuzz tolerance.
		const currentText = "totally\nunrelated\ncontent\nhere\nnow\n";
		const edits = parseHashline(`${sameLineRange(tag(2, "beta"))}\n${repl("BETA-MODEL")}`).edits;

		const recovered = tryRecoverHashlineWithCache({
			cache,
			absolutePath: fakePath,
			currentText,
			edits,
			tag: snapshotTag,
		});
		expect(recovered).toBeNull();
	});

	it("isolates caches across sessions", () => {
		const a = new FileReadCache();
		const b = new FileReadCache();
		const fakePath = "/tmp/__hashline-cache-isolation__.ts";
		a.record(fakePath, "x\ny\nz\n");
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
			const v0Tag = recordFullSnapshot(getFileReadCache(session), filePath, v0Text);

			// First edit: change line 2 : BETA. After the write, the cache should
			// reflect V1 (post-edit), not V0.
			const firstInput = `${header("a.ts", v0Tag)}\n${sameLineRange(tag(2, "beta"))}\n${repl("BETA")}\n`;
			await executeHashlineSingle(hashlineExecuteOptions(tempDir, firstInput, undefined, session));
			const v1Lines = ["alpha", "BETA", "gamma", "delta", "epsilon"];
			const v1Text = `${v1Lines.join("\n")}\n`;
			expect(await Bun.file(filePath).text()).toBe(v1Text);
			const v1Tag = recordFullSnapshot(getFileReadCache(session), filePath, v1Text);
			const snap = getFileReadCache(session).head(filePath);
			expect(snap?.text).toBe(v1Text);

			// External actor insert heads 7 lines after the edit. Anchors authored
			// against V1 (the post-edit state the model just observed) no longer
			// match V2 — recovery must consult the cached V1 snapshot to land the
			// second edit.
			const v2Lines = ["H1", "H2", "H3", "H4", "H5", "H6", "H7", ...v1Lines];
			await Bun.write(filePath, `${v2Lines.join("\n")}\n`);

			const secondInput = `${header("a.ts", v1Tag)}\n${sameLineRange(tag(3, "gamma"))}\n${repl("GAMMA")}\n`;
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
			const v0Tag = recordFullSnapshot(getFileReadCache(session), filePath, v0Text);

			// First edit lands cleanly against v0: line 5 becomes L5-FIRST.
			const firstInput = `${header("a.ts", v0Tag)}\n${sameLineRange(tag(5, "L5"))}\n${repl("L5-FIRST")}\n`;
			await executeHashlineSingle(hashlineExecuteOptions(tempDir, firstInput, undefined, session));

			const v1Lines = [...v0Lines];
			v1Lines[4] = "L5-FIRST";
			expect(await Bun.file(filePath).text()).toBe(`${v1Lines.join("\n")}\n`);

			// Second edit: model is still anchored against v0 (stale hash) and
			// again targets line 5 — the very line the first edit rewrote.
			// Recovery must refuse so the model re-reads instead of silently
			// overwriting L5-FIRST with payload authored against L5.
			const secondInput = `${header("a.ts", v0Tag)}\n${sameLineRange(tag(5, "L5"))}\n${repl("L5-SECOND")}\n`;
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

		const v0Tag = recordFullSnapshot(cache, fakePath, v0Text);
		recordFullSnapshot(cache, fakePath, v1Text);

		const recovered = tryRecoverHashlineWithCache({
			cache,
			absolutePath: fakePath,
			currentText,
			tag: v0Tag,
			edits: parseHashline(`replace 10..10:\n${repl("L10-EDITED")}`).edits,
		});

		expect(recovered).not.toBeNull();
		expect(recovered?.lines).toContain("L10-EDITED");
	});

	it("retains older versions per path so stale tags still resolve", () => {
		const cache = new FileReadCache();
		const fakePath = "/tmp/__hashline-cache-history__.ts";
		const oneTag = recordFullSnapshot(cache, fakePath, "one\n");
		const twoTag = recordFullSnapshot(cache, fakePath, "two\n");
		recordFullSnapshot(cache, fakePath, "three\n");
		expect(cache.head(fakePath)?.text).toBe("three\n");
		expect(cache.byHash(fakePath, oneTag)?.text).toBe("one\n");
		expect(cache.byHash(fakePath, twoTag)?.text).toBe("two\n");
	});
	it("evicts the least-recently-used path beyond the LRU cap", () => {
		const cache = new FileReadCache({ maxPaths: 4 });
		for (let i = 0; i < 6; i++) {
			recordFullSnapshot(cache, `/tmp/file-${i}.ts`, `x${i}\n`);
		}
		// The two oldest paths aged out; the four most-recent survive.
		expect(cache.head("/tmp/file-0.ts")).toBeNull();
		expect(cache.head("/tmp/file-1.ts")).toBeNull();
		expect(cache.head("/tmp/file-2.ts")?.text).toBe("x2\n");
		expect(cache.head("/tmp/file-5.ts")?.text).toBe("x5\n");
	});
});

describe("hashline *** Abort recovery sentinel (harmony-leak mitigation)", () => {
	const sentinel = "*** Abort";

	it("parser breaks at *** Abort silently (no warning)", () => {
		const diff = [
			`insert after ${tag(1, "alpha")}:`,
			repl("HELLO"),
			sentinel,
			`insert after ${tag(99, "junk")}:`,
			repl("never"),
		].join("\n");
		const { edits, warnings } = parseHashline(diff);
		expect(edits).toHaveLength(1);
		expect(edits[0]).toMatchObject({ kind: "insert", text: "HELLO" });
		// The "*** Abort" marker terminates parsing but no longer surfaces a
		// warning: by the time the marker arrives the stream is already gone
		// and the prior wording ("truncated mid-call") was speculative.
		expect(warnings).toEqual([]);
	});

	it("inserted sentinel from harmony-leak truncation: ops above are preserved", () => {
		// Mirrors the exact shape harmony-leak emits inside a single section.
		const diff = `insert after ${tag(1, "alpha")}:\n${repl("KEPT")}\n*** Abort\n`;
		const { edits, warnings } = parseHashline(diff);
		expect(edits).toHaveLength(1);
		expect(edits[0]).toMatchObject({ text: "KEPT" });
		expect(warnings).toEqual([]);
	});

	it("splitter respects *** Abort like *** End Patch", () => {
		const input = [
			`¶a.ts`,
			`insert after ${tag(1, "alpha")}:`,
			repl("a-payload"),
			sentinel,
			`¶b.ts`,
			`insert after ${tag(1, "beta")}:`,
			repl("never-emitted"),
		].join("\n");
		const sections = splitHashlineInputs(input);
		expect(sections).toHaveLength(1);
		expect(sections[0].path).toBe("a.ts");
		expect(sections[0].diff.includes("never-emitted")).toBe(false);
	});

	it("clean input without sentinel produces no warning", () => {
		const diff = `insert after ${tag(1, "alpha")}:\n${repl("PAYLOAD")}\n`;
		const { warnings } = parseHashline(diff);
		expect(warnings).toEqual([]);
	});
});

describe("hashline parser — delete and empty-block semantics", () => {
	it("inline delete deletes a single line", () => {
		const text = "line1\nline2\nline3\n";
		const { diff } = splitHashlineInput(`¶a.ts\ndelete 2\n`);
		expect(applyDiff(text, diff)).toBe("line1\nline3\n");
	});

	it("inline delete deletes the range", () => {
		const text = "line1\nline2\nline3\nline4\n";
		const { diff } = splitHashlineInput(`¶a.ts\ndelete 2..3\n`);
		expect(applyDiff(text, diff)).toBe("line1\nline4\n");
	});

	it("empty replace errors; delete removes the range", () => {
		const text = "line1\nline2\nline3\n";
		expect(() => splitHashlineInput(`¶a.ts\nreplace 2..2:\n`).diff).not.toThrow();
		expect(() => applyDiff(text, `replace 2..2:`)).toThrow(/To delete lines, use `delete/);
	});

	it("`2..2=replacement` (old format) parses as orphan body, not as inline payload", () => {
		const { diff } = splitHashlineInput(`¶a.ts\n2..2=replacement\n`);
		expect(() => parseHashline(diff)).toThrow(/payload line has no preceding hunk header/);
	});

	it("explicit empty literal rows insert blank lines when the anchor is repeated", () => {
		const text = "line1\nline2\nline3\n";
		const aboveDiff = splitHashlineInput(`¶a.ts\ninsert before 2:\n${repl("")}\n`).diff;
		expect(applyDiff(text, aboveDiff)).toBe("line1\n\nline2\nline3\n");

		const belowDiff = splitHashlineInput(`¶a.ts\ninsert after 2:\n${repl("")}\n`).diff;
		expect(applyDiff(text, belowDiff)).toBe("line1\nline2\n\nline3\n");
	});
});

describe("hashline parser — explicit blank payload rows", () => {
	it("raw blank lines between ops are ignored", () => {
		const text = "a\nb\nc\nd\ne\n";
		const ops = `¶a.ts\nreplace 1..1:\n${repl("A")}\n\nreplace 3..3:\n${repl("C")}\n`;
		const { diff } = splitHashlineInput(ops);
		expect(applyDiff(text, diff)).toBe("A\nb\nC\nd\ne\n");
	});

	it("empty replacement payload rows are appended as blank payload lines", () => {
		const text = "a\nb\nc\nd\ne\n";
		const ops = `¶a.ts\nreplace 1..1:\n${repl("A")}\n${repl("")}\n${repl("")}\nreplace 3..3:\n${repl("C")}\n`;
		const { diff } = splitHashlineInput(ops);
		expect(applyDiff(text, diff)).toBe("A\n\n\nb\nC\nd\ne\n");
	});

	it("`replace N..N:` followed by two empty replace rows replaces the line with two blanks", () => {
		const text = "a\nb\nc\nd\ne\n";
		const ops = `¶a.ts\nreplace 2..2:\n${repl("")}\n${repl("")}\nreplace 4..4:\n${repl("D")}\n`;
		const { diff } = splitHashlineInput(ops);
		expect(applyDiff(text, diff)).toBe("a\n\n\nc\nD\ne\n");
	});

	it("empty replace row inside payload between two content lines is preserved", () => {
		const text = "a\nb\nc\n";
		const ops = `¶a.ts\nreplace 2..2:\n${repl("first")}\n${repl("")}\n${repl("second")}\n`;
		const { diff } = splitHashlineInput(ops);
		expect(applyDiff(text, diff)).toBe("a\nfirst\n\nsecond\nc\n");
	});
});

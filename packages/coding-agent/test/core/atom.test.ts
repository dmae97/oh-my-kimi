import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	applyAtomEdits,
	atomEditParamsSchema,
	computeLineHash,
	type ExecuteAtomSingleOptions,
	executeAtomSingle,
	HashlineMismatchError,
	parseAtom,
	splitAtomInput,
	splitAtomInputs,
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

// Convenience: parse a diff against a content snapshot and return the resulting text.
function applyDiff(content: string, diff: string): string {
	const edits = parseAtom(diff);
	return applyAtomEdits(content, edits).lines;
}

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atom-edit-"));
	try {
		await fn(tempDir);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

function atomExecuteOptions(tempDir: string, input: string): ExecuteAtomSingleOptions {
	return {
		session: { cwd: tempDir } as ToolSession,
		input,
		writethrough: async () => {
			throw new Error("unexpected write");
		},
		beginDeferredDiagnosticsForPath: () => {
			throw new Error("unexpected diagnostics");
		},
	};
}

// ───────────────────────────────────────────────────────────────────────────
// Form coverage
// ───────────────────────────────────────────────────────────────────────────

describe("atom parser — basic forms", () => {
	const content = "aaa\nbbb\nccc";

	it("canonical set replaces a single line", () => {
		const diff = `${tag(2, "bbb")}=BBB`;
		expect(applyDiff(content, diff)).toBe("aaa\nBBB\nccc");
	});

	it("prefix delete `-Lid` removes a single line", () => {
		const diff = `-${tag(2, "bbb")}`;
		expect(applyDiff(content, diff)).toBe("aaa\nccc");
	});

	it("`@Lid` moves the cursor after the anchored line", () => {
		const diff = `@${tag(2, "bbb")}\n+INSERTED`;
		expect(applyDiff(content, diff)).toBe("aaa\nbbb\nINSERTED\nccc");
	});

	it("$ + + lines prepend to the file", () => {
		const diff = `$\n+ZZZ\n+YYY`;
		expect(applyDiff(content, diff)).toBe("ZZZ\nYYY\naaa\nbbb\nccc");
	});

	it("^ + + lines append to the file", () => {
		const diff = `^\n+DDD\n+EEE`;
		expect(applyDiff(content, diff)).toBe("aaa\nbbb\nccc\nDDD\nEEE");
	});

	it("+ lines with no cursor move append to the file", () => {
		const diff = `+DDD\n+EEE`;
		expect(applyDiff(content, diff)).toBe("aaa\nbbb\nccc\nDDD\nEEE");
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Cursor binding rule
// ───────────────────────────────────────────────────────────────────────────

describe("atom parser — cursor binding", () => {
	const content = "aaa\nbbb\nccc";

	it("set moves the cursor after the set line", () => {
		const diff = `${tag(1, "aaa")}=AAA\n+INSERTED\n@${tag(2, "bbb")}`;
		expect(applyDiff(content, diff)).toBe("AAA\nINSERTED\nbbb\nccc");
	});

	it("set before another set keeps inserts at the previous cursor", () => {
		const diff = `${tag(1, "aaa")}=AAA\n+INSERTED\n${tag(2, "bbb")}=BBB`;
		expect(applyDiff(content, diff)).toBe("AAA\nINSERTED\nBBB\nccc");
	});

	it("bare Lid moves the cursor before a following set", () => {
		const diff = `@${tag(1, "aaa")}\n+INSERTED\n${tag(2, "bbb")}=BBB`;
		expect(applyDiff(content, diff)).toBe("aaa\nINSERTED\nBBB\nccc");
	});

	it("preserves contiguous + lines at the same cursor", () => {
		const diff = `${tag(1, "aaa")}=AAA\n+I1\n+I2\n+I3\n@${tag(2, "bbb")}`;
		expect(applyDiff(content, diff)).toBe("AAA\nI1\nI2\nI3\nbbb\nccc");
	});

	it("+ with only a previous anchor inserts after that anchor", () => {
		const diff = `@${tag(2, "bbb")}\n+INSERTED`;
		expect(applyDiff(content, diff)).toBe("aaa\nbbb\nINSERTED\nccc");
	});

	it("+ before any cursor move uses the initial EOF cursor", () => {
		const diff = `+INSERTED\n@${tag(2, "bbb")}`;
		expect(applyDiff(content, diff)).toBe("aaa\nbbb\nccc\nINSERTED");
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Edge cases
// ───────────────────────────────────────────────────────────────────────────

describe("atom parser — edge cases", () => {
	const content = "aaa\nbbb\nccc";

	it("empty set blanks the line", () => {
		const diff = `${tag(2, "bbb")}=`;
		expect(applyDiff(content, diff)).toBe("aaa\n\nccc");
	});

	it("set value starting with `!` keeps the leading `!`", () => {
		const diff = `${tag(2, "bbb")}=!hello`;
		expect(applyDiff(content, diff)).toBe("aaa\n!hello\nccc");
	});

	it("set value starting with `|` keeps the leading `|`", () => {
		const diff = `${tag(2, "bbb")}=|hello`;
		expect(applyDiff(content, diff)).toBe("aaa\n|hello\nccc");
	});

	it("set preserves leading/trailing whitespace exactly", () => {
		const diff = `${tag(2, "bbb")}=  spaced  `;
		expect(applyDiff(content, diff)).toBe("aaa\n  spaced  \nccc");
	});

	it("empty `+` line inserts a blank line", () => {
		const diff = `${tag(1, "aaa")}=AAA\n+\n@${tag(2, "bbb")}`;
		expect(applyDiff(content, diff)).toBe("AAA\n\nbbb\nccc");
	});

	it("`+` block with no cursor emits EOF cursor inserts", () => {
		expect(parseAtom(`+lonely`)).toMatchObject([{ kind: "insert", cursor: { kind: "eof" }, text: "lonely" }]);
	});

	it("out-of-order anchors are accepted (sorted internally)", () => {
		const diff = `${tag(3, "ccc")}=CCC\n${tag(1, "aaa")}=AAA`;
		expect(applyDiff(content, diff)).toBe("AAA\nbbb\nCCC");
	});

	it("delete + post: insertions take the deleted line's slot", () => {
		const diff = `-${tag(2, "bbb")}\n+INSERTED`;
		expect(applyDiff(content, diff)).toBe("aaa\nINSERTED\nccc");
	});

	it("CRLF input is normalized line-by-line", () => {
		const diff = `${tag(2, "bbb")}=BBB\r\n${tag(1, "aaa")}=AAA\r`;
		expect(applyDiff(content, diff)).toBe("AAA\nBBB\nccc");
	});

	it("trailing newline at file end is preserved", () => {
		const c = "aaa\nbbb\nccc\n";
		const diff = `${tag(2, "bbb")}=BBB`;
		expect(applyDiff(c, diff)).toBe("aaa\nBBB\nccc\n");
	});

	it("empty diff is a no-op", () => {
		expect(parseAtom("")).toEqual([]);
		expect(parseAtom("\n\n\n")).toEqual([]);
	});

	it("`Lid=TEXT` is the canonical set form", () => {
		const content = "aaa\nbbb\nccc";
		expect(applyDiff(content, `${tag(2, "bbb")}=BBB`)).toBe("aaa\nBBB\nccc");
	});

	it("legacy set and locator forms remain accepted", () => {
		const content = "aaa\nbbb\nccc";
		const t = tag(2, "bbb");
		expect(applyDiff(content, `${t}|BBB`)).toBe("aaa\nBBB\nccc");
		expect(applyDiff(content, `@@ ${t}\n+INSERTED`)).toBe("aaa\nbbb\nINSERTED\nccc");
	});

	it("recovers common replacement slips with @ and @@ prefixes", () => {
		const content = "aaa\nbbb\nccc";
		const t = tag(2, "bbb");
		expect(applyDiff(content, `@${t}=BBB`)).toBe("aaa\nBBB\nccc");
		expect(applyDiff(content, `@${t}|BBB`)).toBe("aaa\nBBB\nccc");
		expect(applyDiff(content, `@@ ${t}=BBB`)).toBe("aaa\nBBB\nccc");
		expect(applyDiff(content, `@@ ${t}|BBB`)).toBe("aaa\nBBB\nccc");
	});

	it("recovers common delete slips with whitespace and @@ prefixes", () => {
		const content = "aaa\nbbb\nccc";
		const t = tag(2, "bbb");
		expect(applyDiff(content, `- ${t}`)).toBe("aaa\nccc");
		expect(applyDiff(content, `@@ -${t}`)).toBe("aaa\nccc");
		expect(applyDiff(content, `@@ - ${t}`)).toBe("aaa\nccc");
	});

	it("ignores whitespace before replacement separator and preserves whitespace after it", () => {
		const content = "aaa\nbbb\nccc";
		const t = tag(2, "bbb");
		expect(applyDiff(content, `${t} = BBB `)).toBe("aaa\n BBB \nccc");
		expect(applyDiff(content, `@${t} | BBB `)).toBe("aaa\n BBB \nccc");
		expect(applyDiff(content, `@@ ${t} | BBB `)).toBe("aaa\n BBB \nccc");
	});

	it("rejects partial and missing Lids with repairable diagnostics", () => {
		expect(() => parseAtom("@@ 98")).toThrow(/`@@ 98` is missing the two-letter Lid suffix/);
		expect(() => parseAtom("yh=TEXT")).toThrow(/`yh` is not a full Lid/);
		expect(() => parseAtom("123=TEXT")).toThrow(/`123` is missing the two-letter Lid suffix/);
		expect(() => parseAtom("123|TEXT")).toThrow(/`123` is missing the two-letter Lid suffix/);
	});

	it("canonical equals replacement does not apply legacy OLD|NEW repair", () => {
		const content = "aaa\nbbb\nccc";
		const t = tag(2, "bbb");
		expect(applyDiff(content, `${t}=bbb|BBB`)).toBe("aaa\nbbb|BBB\nccc");
	});

	it("silently ignores identical replacements when another operation changes the file", () => {
		const content = "aaa\nbbb\nccc";
		const t = tag(2, "bbb");
		const result = applyAtomEdits(content, parseAtom(`${t}=bbb\n+DDD`));
		expect(result.lines).toBe("aaa\nbbb\nDDD\nccc");
		expect(result.noopEdits).toBeUndefined();
		expect(result.warnings).toBeUndefined();
	});

	it("locator-only patches report the cursor diagnostic", async () => {
		await expect(
			executeAtomSingle({
				session: { cwd: process.cwd() } as ToolSession,
				input: "---a.ts\n@123ab",
				writethrough: async () => {
					throw new Error("unexpected write");
				},
				beginDeferredDiagnosticsForPath: () => {
					throw new Error("unexpected diagnostics");
				},
			} as ExecuteAtomSingleOptions),
		).rejects.toThrow(
			"Cursor moved but no mutation found. Add +TEXT to insert, -Lid to delete, or Lid=TEXT to replace.",
		);
	});

	it("@Lid move syntax is accepted as canonical", () => {
		expect(parseAtom(`@${tag(2, "bbb")}`)).toEqual([]);
	});

	it("anchor with non-pipe trailing characters is rejected", () => {
		// `1aa/foo/bar/` doesn't match any recognized op; the parser must
		// reject it rather than silently treating it as an insert.
		expect(() => parseAtom(`${tag(1, "aaa")}/foo/bar/`)).toThrow(/unrecognized op/);
	});

	it("duplicate sets on the same anchor: last set wins", () => {
		const t = tag(2, "bbb");
		const diff = `${t}=OLD\n${t}=NEW`;
		expect(applyDiff(content, diff)).toBe("aaa\nNEW\nccc");
	});

	it("same-line OLD|NEW repairs to the new line when OLD is current content", () => {
		const t = tag(2, "bbb");
		const diff = `${t}|bbb|BBB`;
		expect(applyDiff(content, diff)).toBe("aaa\nBBB\nccc");
	});

	it("same-line OLD|NEW repair works through `@` prefix slip", () => {
		const t = tag(2, "bbb");
		const diff = `@${t}|bbb|BBB`;
		expect(applyDiff(content, diff)).toBe("aaa\nBBB\nccc");
	});

	it("same-line OLD|NEW repair works through `@@ ` prefix slip", () => {
		const t = tag(2, "bbb");
		const diff = `@@ ${t}|bbb|BBB`;
		expect(applyDiff(content, diff)).toBe("aaa\nBBB\nccc");
	});

	it("`-Lid` followed by `+Lid|TEXT` fuses into a single replacement", () => {
		const t = tag(2, "bbb");
		const diff = `-${t}\n+${t}|REPLACED`;
		expect(applyDiff(content, diff)).toBe("aaa\nREPLACED\nccc");
	});

	it("`-Lid` followed by `+Lid=TEXT` fuses into a single replacement", () => {
		const t = tag(2, "bbb");
		const diff = `-${t}\n+${t}=REPLACED`;
		expect(applyDiff(content, diff)).toBe("aaa\nREPLACED\nccc");
	});

	it("standalone `+Lid|TEXT` is rejected with a diff-ish replacement diagnostic", () => {
		const t = tag(2, "bbb");
		expect(() => parseAtom(`+${t}|REPLACED`)).toThrow(
			new RegExp(`\`\\+${t}\\|\\.\\.\\.\` looks like a unified-diff replacement marker. Use \`${t}=TEXT\``),
		);
	});

	it("standalone `+Lid=TEXT` is rejected with a diff-ish replacement diagnostic", () => {
		const t = tag(2, "bbb");
		expect(() => parseAtom(`+${t}=REPLACED`)).toThrow(/looks like a unified-diff replacement marker/);
	});

	it("`-Lid` followed by `+OtherLid|TEXT` (mismatched) is rejected", () => {
		const t1 = tag(1, "aaa");
		const t2 = tag(2, "bbb");
		expect(() => parseAtom(`-${t1}\n+${t2}|REPLACED`)).toThrow(
			/references a Lid that was not deleted in the preceding run/,
		);
	});

	it("plain `+TEXT` insertion is unaffected by diff-ish detection", () => {
		// `+5xa hello` — no `=` or `|` separator after the Lid-shaped prefix —
		// remains a literal insert, including the `5xa hello` text.
		const diff = `+5xa hello`;
		expect(applyDiff(content, diff)).toBe("aaa\nbbb\nccc\n5xa hello");
	});

	it("multi-line hunk: deletes followed by inserts becomes a block replacement at the FIRST deleted slot", () => {
		const c = "aaa\nbbb\nccc\nddd\neee";
		const t2 = tag(2, "bbb");
		const t3 = tag(3, "ccc");
		const t4 = tag(4, "ddd");
		const diff = `-${t2}\n-${t3}\n-${t4}\n+X1\n+X2\n+X3`;
		expect(applyDiff(c, diff)).toBe("aaa\nX1\nX2\nX3\neee");
	});

	it("multi-line hunk: more inserts than deletes is allowed", () => {
		const c = "aaa\nbbb\nccc\nddd";
		const t2 = tag(2, "bbb");
		const diff = `-${t2}\n+X1\n+X2\n+X3`;
		expect(applyDiff(c, diff)).toBe("aaa\nX1\nX2\nX3\nccc\nddd");
	});

	it("multi-line hunk: fewer inserts than deletes is allowed", () => {
		const c = "aaa\nbbb\nccc\nddd\neee";
		const t2 = tag(2, "bbb");
		const t3 = tag(3, "ccc");
		const t4 = tag(4, "ddd");
		const diff = `-${t2}\n-${t3}\n-${t4}\n+X`;
		expect(applyDiff(c, diff)).toBe("aaa\nX\neee");
	});

	it("multi-line hunk: `+Lid|TEXT` add lines must reference a deleted Lid", () => {
		const c = "aaa\nbbb\nccc\nddd";
		const t2 = tag(2, "bbb");
		const t3 = tag(3, "ccc");
		const t4 = tag(4, "ddd");
		// `+Lid|TEXT` for t2 and t3 (in delete run) is OK; t4 (also deleted) is OK.
		const diff = `-${t2}\n-${t3}\n-${t4}\n+${t2}|X1\n+${t3}|X2\n+${t4}|X3`;
		expect(applyDiff(c, diff)).toBe("aaa\nX1\nX2\nX3");
	});

	it("multi-line hunk: `+Lid|TEXT` referencing a Lid not in the delete run is rejected", () => {
		const t1 = tag(1, "aaa");
		const t2 = tag(2, "bbb");
		const t3 = tag(3, "ccc");
		expect(() => parseAtom(`-${t1}\n-${t2}\n+${t3}|X`)).toThrow(
			/references a Lid that was not deleted in the preceding run/,
		);
	});

	it("`-Lid|OLD` deletes when OLD matches the current line", () => {
		const t = tag(2, "bbb");
		const diff = `-${t}|bbb`;
		expect(applyDiff(content, diff)).toBe("aaa\nccc");
	});

	it("`-Lid=OLD` deletes when OLD matches the current line", () => {
		const t = tag(2, "bbb");
		const diff = `-${t}=bbb`;
		expect(applyDiff(content, diff)).toBe("aaa\nccc");
	});

	it("`-Lid|OLD` is rejected when OLD does not match the current line", () => {
		const t = tag(2, "bbb");
		const diff = `-${t}|XXX`;
		expect(() => applyAtomEdits(content, parseAtom(diff))).toThrow(
			/asserts the deleted line is "XXX", but the file has "bbb"/,
		);
	});

	it("hunk with `-Lid|OLD` validates each OLD against current line", () => {
		const c = "aaa\nbbb\nccc\nddd";
		const t2 = tag(2, "bbb");
		const t3 = tag(3, "ccc");
		// Both OLDs match → accepted.
		const ok = `-${t2}|bbb\n-${t3}|ccc\n+X1\n+X2`;
		expect(applyDiff(c, ok)).toBe("aaa\nX1\nX2\nddd");
		// Second OLD wrong → rejected.
		const bad = `-${t2}|bbb\n-${t3}|wrong\n+X1\n+X2`;
		expect(() => applyAtomEdits(c, parseAtom(bad))).toThrow(/asserts the deleted line is "wrong"/);
	});

	it("set with current content reports identical replacement as a no-op", () => {
		const t = tag(2, "bbb");
		const result = applyAtomEdits(content, parseAtom(`${t}=bbb`));
		expect(result.lines).toBe(content);
		expect(result.noopEdits).toEqual([
			{
				editIndex: 0,
				loc: t,
				reason:
					"replacement is identical to the current line content; use `Lid=NEW_TEXT` and do not copy an unchanged read line",
				current: "bbb",
			},
		]);
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Combined ops on a single anchor
// ───────────────────────────────────────────────────────────────────────────

describe("atom — combining set + post on one anchor", () => {
	it("set then `+` lines insert after the set line", () => {
		const content = "aaa\nbbb\nccc";
		const t = tag(2, "bbb");
		const diff = `${t}=NEW\n+POST`;
		expect(applyDiff(content, diff)).toBe("aaa\nNEW\nPOST\nccc");
	});

	it("a leading `+` starts at EOF, and a trailing `+` uses the current anchor cursor", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const t2 = tag(2, "bbb");
		const t3 = tag(3, "ccc");
		const diff = `+BEFORE\n${t2}=BBB\n+AFTER\n@${t3}`;
		expect(applyDiff(content, diff)).toBe("aaa\nBBB\nAFTER\nccc\nddd\nBEFORE");
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Hash mismatch flow
// ───────────────────────────────────────────────────────────────────────────

describe("atom — hash mismatch", () => {
	it("propagates HashlineMismatchError on stale hash", () => {
		const content = "aaa\nbbb\nccc";
		const diff = `2zz=BBB`;
		const edits = parseAtom(diff);
		expect(() => applyAtomEdits(content, edits)).toThrow(HashlineMismatchError);
	});

	it("does not use replacement text as a rebase content hint", () => {
		const content = "aaa\nchanged\nNEW";
		const stale = tag(2, "bbb");
		expect(() => applyAtomEdits(content, parseAtom(`${stale}=NEW`))).toThrow(HashlineMismatchError);
	});

	it("single rebase is permitted (one stale anchor recovers silently)", () => {
		// Insert an unrelated line at the top, shifting line 2 to line 3.
		// A `Lid=` op that targeted the original line 2 must auto-rebase to line 3.
		const content = "aaa\nINSERTED\nbbb\nccc";
		const stale = tag(2, "bbb"); // hash for "bbb" computed at line 2
		const result = applyAtomEdits(content, parseAtom(`${stale}=BBB`));
		expect(result.lines).toBe("aaa\nINSERTED\nBBB\nccc");
	});

	it("multiple mutating anchors all rebasing is rejected as a miscounted block edit", () => {
		// Simulate the failure mode: agent stacked `Lid=X` over a contiguous range
		// whose actual position drifted (insertion shifted everything by 1). All
		// three mutating anchors need rebasing — this is the signature of a block
		// edit done with the wrong recipe.
		const content = "aaa\nINSERTED\nbbb\nccc\nddd";
		const t2 = tag(2, "bbb"); // bbb is actually at line 3
		const t3 = tag(3, "ccc"); // ccc is actually at line 4
		const t4 = tag(4, "ddd"); // ddd is actually at line 5
		const diff = `${t2}=BBB\n${t3}=CCC\n${t4}=DDD`;
		expect(() => applyAtomEdits(content, parseAtom(diff))).toThrow(/auto-rebase/);
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Internal AtomEdit shapes
// ───────────────────────────────────────────────────────────────────────────

describe("parseAtom — emits internal AtomEdit shapes", () => {
	it("emits delete op", () => {
		const t = tag(2, "bbb");
		const edits = parseAtom(`-${t}`);
		expect(edits).toHaveLength(1);
		expect(edits[0]).toMatchObject({ kind: "delete", anchor: { line: 2 } });
	});

	it("emits EOF cursor insert for ^ + +", () => {
		const edits = parseAtom(`^\n+x`);
		expect(edits).toMatchObject([{ kind: "insert", cursor: { kind: "eof" }, text: "x" }]);
	});

	it("emits EOF cursor insert for bare + +", () => {
		const edits = parseAtom(`+x`);
		expect(edits).toMatchObject([{ kind: "insert", cursor: { kind: "eof" }, text: "x" }]);
	});

	it("emits BOF cursor insert for $ + +", () => {
		const edits = parseAtom(`$\n+x`);
		expect(edits).toMatchObject([{ kind: "insert", cursor: { kind: "bof" }, text: "x" }]);
	});

	it("delete + set on same anchor is rejected by validateNoConflictingAnchorOps", () => {
		const content = "aaa\nbbb\nccc";
		const t = tag(2, "bbb");
		const diff = `${t}=NEW\n-${t}`;
		const edits = parseAtom(diff);
		expect(() => applyAtomEdits(content, edits)).toThrow(/Conflicting ops/);
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Wire format header
// ───────────────────────────────────────────────────────────────────────────

describe("splitAtomInput — wire-format header", () => {
	it("extracts path and diff body from `--- path` header", () => {
		const input = `---src/foo.ts\n${tag(2, "bbb")}=BBB`;
		const { path, diff } = splitAtomInput(input);
		expect(path).toBe("src/foo.ts");
		expect(diff).toBe(`${tag(2, "bbb")}=BBB`);
	});

	it("extracts path and diff body from legacy `--- path` header", () => {
		const input = `--- src/foo.ts\n${tag(2, "bbb")}=BBB`;
		const { path, diff } = splitAtomInput(input);
		expect(path).toBe("src/foo.ts");
		expect(diff).toBe(`${tag(2, "bbb")}=BBB`);
	});

	it("strips leading blank lines before the first header", () => {
		const input = `\n\n---a.ts\n+export const A = 1;`;
		expect(splitAtomInput(input)).toEqual({ path: "a.ts", diff: "+export const A = 1;" });
	});

	it("unquotes matching path quotes", () => {
		expect(splitAtomInput(`---"foo bar.ts"\n+x`).path).toBe("foo bar.ts");
		expect(splitAtomInput(`---'foo bar.ts'\n+x`).path).toBe("foo bar.ts");
	});

	it("normalizes cwd-prefixed absolute paths to cwd-relative paths", () => {
		const cwd = path.join(process.cwd(), "packages", "coding-agent");
		const absolute = path.join(cwd, "src", "foo.ts");
		expect(splitAtomInput(`---${absolute}\n+x`, { cwd }).path).toBe("src/foo.ts");
	});

	it("preserves absolute paths outside cwd", () => {
		const cwd = path.join(process.cwd(), "packages", "coding-agent");
		const outside = path.resolve(process.cwd(), "..", "outside.ts");
		expect(splitAtomInput(`---${outside}\n+x`, { cwd }).path).toBe(outside);
	});

	it("uses explicit fallback path only when input has operations and no header", () => {
		expect(splitAtomInput(`${tag(1, "aaa")}=AAA`, { path: "a.ts" })).toEqual({
			path: "a.ts",
			diff: `${tag(1, "aaa")}=AAA`,
		});
		expect(() => splitAtomInput("plain text", { path: "a.ts" })).toThrow(/must begin with/);
		expect(() => splitAtomInput("---\n+x", { path: "a.ts" })).toThrow(/empty/);
	});

	it("throws if header is missing", () => {
		expect(() => splitAtomInput("124aa=NEW")).toThrow(/must begin with/);
	});

	it("throws if header path is empty", () => {
		expect(() => splitAtomInput("--- \n124aa=NEW")).toThrow(/empty/);
	});

	it("tolerates CRLF after header", () => {
		const input = `--- a.ts\r\n${tag(1, "alpha")}=ALPHA`;
		const { path, diff } = splitAtomInput(input);
		expect(path).toBe("a.ts");
		expect(diff).toBe(`${tag(1, "alpha")}=ALPHA`);
	});

	it("strips BOM from input", () => {
		const input = `\uFEFF---a.ts\n${tag(1, "alpha")}=ALPHA`;
		const { path } = splitAtomInput(input);
		expect(path).toBe("a.ts");
	});

	it("splits multiple --- path sections", () => {
		const input = `---a.ts\n+export const A = 1;\n--- b.ts\n+export const B = 2;`;
		expect(splitAtomInputs(input)).toEqual([
			{ path: "a.ts", diff: "+export const A = 1;" },
			{ path: "b.ts", diff: "+export const B = 2;" },
		]);
	});

	it("rejects the old colon header after the syntax cutover", () => {
		expect(() => splitAtomInput(":a.ts\n+export const A = 1;")).toThrow(/must begin with/);
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Whole-file operations
// ───────────────────────────────────────────────────────────────────────────

describe("atom executor — whole-file operations", () => {
	it("deletes the section file with !rm", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "file.ts");
			await Bun.write(filePath, "export const x = 1;\n");

			const result = await executeAtomSingle(atomExecuteOptions(tempDir, "---file.ts\n!rm\n"));

			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("Deleted file.ts");
			expect(result.details?.op).toBe("delete");
			expect(await Bun.file(filePath).exists()).toBe(false);
		});
	});

	it("renames the section file with !mv", async () => {
		await withTempDir(async tempDir => {
			const sourcePath = path.join(tempDir, "file.ts");
			const destinationPath = path.join(tempDir, "file2.ts");
			await Bun.write(sourcePath, "export const x = 1;\n");

			const result = await executeAtomSingle(atomExecuteOptions(tempDir, "---file.ts\n!mv file2.ts\n"));

			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
				"Moved file.ts to file2.ts",
			);
			expect(result.details?.op).toBe("update");
			expect(result.details?.move).toBe("file2.ts");
			expect(await Bun.file(sourcePath).exists()).toBe(false);
			expect(await Bun.file(destinationPath).text()).toBe("export const x = 1;\n");
		});
	});

	it("rejects sections that mix whole-file operations with line edits", async () => {
		await withTempDir(async tempDir => {
			await Bun.write(path.join(tempDir, "file.ts"), "export const x = 1;\n");

			await expect(
				executeAtomSingle(atomExecuteOptions(tempDir, "---file.ts\n!rm\n+export const y = 2;\n")),
			).rejects.toThrow(/mixes !rm with line edits/);
			await expect(
				executeAtomSingle(atomExecuteOptions(tempDir, "---file.ts\n!mv file2.ts\n-1ab\n")),
			).rejects.toThrow(/mixes !mv with line edits/);
		});
	});

	it("rejects !mv without a destination", async () => {
		await withTempDir(async tempDir => {
			await Bun.write(path.join(tempDir, "file.ts"), "export const x = 1;\n");

			await expect(executeAtomSingle(atomExecuteOptions(tempDir, "---file.ts\n!mv\n"))).rejects.toThrow(
				/!mv requires exactly one non-empty destination path/,
			);
		});
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Heuristic: post-edit duplicate-line detection
// ───────────────────────────────────────────────────────────────────────────

describe("applyAtomEdits — adjacent duplicate detection", () => {
	it("auto-fixes a duplicate line when removing it restores bracket balance", () => {
		// Original: function on lines 3-5, single `}` at line 5.
		const content = "const X = 1;\n\nexport function f() {\n\treturn X;\n}";
		// Botched block rewrite: delete only the declaration + body, not the closing
		// brace. Insert a replacement that includes its own `}`. Without auto-fix
		// the result would have `}\n}` and brace balance off by one.
		const t3 = tag(3, "export function f() {");
		const t4 = tag(4, "\treturn X;");
		const diff = `-${t3}\n-${t4}\n+export function f(): number {\n+\treturn X * 2;\n+}`;
		const result = applyAtomEdits(content, parseAtom(diff));
		expect(result.lines).toBe("const X = 1;\n\nexport function f(): number {\n\treturn X * 2;\n}");
		expect(result.warnings ?? []).toEqual(
			expect.arrayContaining([expect.stringMatching(/Auto-fixed: removed duplicate line/)]),
		);
	});

	it("auto-fixes a duplicated function signature (missed leading delete)", () => {
		// Original: function on lines 2-4. Block rewrite forgets to delete the
		// original signature on line 2 and inserts a new one, producing two
		// adjacent identical `export function f() {` lines and an extra `{`.
		const content = "alpha\nexport function f() {\n\treturn 1;\n}\nbeta";
		const t3 = tag(3, "\treturn 1;");
		const t4 = tag(4, "}");
		const diff = `-${t3}\n-${t4}\n+export function f() {\n+\treturn 2;\n+}`;
		const result = applyAtomEdits(content, parseAtom(diff));
		expect(result.lines).toBe("alpha\nexport function f() {\n\treturn 2;\n}\nbeta");
		expect(result.warnings ?? []).toEqual(
			expect.arrayContaining([expect.stringMatching(/Auto-fixed: removed duplicate line/)]),
		);
	});

	it("warns but does not auto-fix when bracket balance is unchanged", () => {
		// Insert a duplicate non-bracket line — balance is unaffected so we cannot
		// safely decide which copy to remove. Should warn only.
		const content = "alpha\nbeta\ngamma";
		const t1 = tag(1, "alpha");
		const result = applyAtomEdits(content, parseAtom(`@${t1}\n+alpha`));
		expect(result.lines).toBe("alpha\nalpha\nbeta\ngamma");
		expect(result.warnings ?? []).toEqual(expect.arrayContaining([expect.stringMatching(/Suspicious duplicate/)]));
	});

	it("does not warn when the original already had adjacent duplicates", () => {
		// Original has `\t}\n\t}` (nested closing braces). Edit doesn't add new pairs.
		const content = "fn outer() {\n\tfn inner() {\n\t\treturn 1;\n\t}\n}";
		const t3 = tag(3, "\t\treturn 1;");
		const result = applyAtomEdits(content, parseAtom(`${t3}=\t\treturn 2;`));
		expect(result.warnings ?? []).not.toEqual(
			expect.arrayContaining([expect.stringMatching(/Suspicious duplicate/)]),
		);
	});

	it("does not warn on adjacent blank lines", () => {
		const content = "a\nb\nc";
		// Insert two blank lines after line 1 — adjacent blanks should be ignored.
		const t1 = tag(1, "a");
		const result = applyAtomEdits(content, parseAtom(`@${t1}\n+\n+`));
		expect(result.warnings ?? []).not.toEqual(
			expect.arrayContaining([expect.stringMatching(/Suspicious duplicate/)]),
		);
	});

	it("auto-splits `+@Lid` (op prefixed with `+`) into cursor move + blank insert", () => {
		// Original failure: agent wrote `+@13du` meaning to move cursor and chain
		// inserts; parser would otherwise insert the literal text `@13du`.
		const content = "alpha\nbeta\ngamma";
		const t1 = tag(1, "alpha");
		const t2 = tag(2, "beta");
		const diff = `@${t1}\n+inserted\n+@${t2}\n+after`;
		const result = applyAtomEdits(content, parseAtom(diff));
		// `+@${t2}` auto-splits to: cursor move to after beta, then blank insert.
		expect(result.lines).toBe("alpha\ninserted\nbeta\n\nafter\ngamma");
	});

	it("auto-splits `+-Lid` (delete prefixed with `+`) into delete + blank insert", () => {
		const content = "alpha\nbeta\ngamma";
		const t2 = tag(2, "beta");
		const result = applyAtomEdits(content, parseAtom(`+-${t2}`));
		// `+-${t2}` auto-splits to: delete beta, then blank insert at the deletion slot.
		expect(result.lines).toBe("alpha\n\ngamma");
	});

	it("does not auto-split `+@plain text` that isn't a valid op", () => {
		// `@plain text` doesn't match any op shape; body is inserted as literal text.
		const content = "x";
		const result = applyAtomEdits(content, parseAtom(`+@plain text`));
		expect(result.lines).toBe("x\n@plain text");
	});

	it("non-contiguous deletes followed by an insert: insert lands at the last contiguous sub-run, not the first delete", () => {
		// Regression: agent emitted `-186 -197 -198 -199 +TEXT` intending to drop
		// a debug line at 186 AND replace lines 197-199 with TEXT. normalizeHunks
		// used to fuse all four deletes into one block and place the insert at
		// line 186, breaking the function. Now sub-runs are split and the insert
		// attaches to [197,198,199].
		const content = "A\nB\nC\nD\nE\nF\nG\nH\nI\nJ";
		const t1 = tag(1, "A");
		const t5 = tag(5, "E");
		const t6 = tag(6, "F");
		const t7 = tag(7, "G");
		const diff = `-${t1}\n-${t5}\n-${t6}\n-${t7}\n+REPLACED`;
		const result = applyAtomEdits(content, parseAtom(diff));
		expect(result.lines).toBe("B\nC\nD\nREPLACED\nH\nI\nJ");
	});

	it("multiple far-apart non-contiguous deletes still attach inserts to only the last sub-run", () => {
		const content = "A\nB\nC\nD\nE\nF\nG";
		const t1 = tag(1, "A");
		const t3 = tag(3, "C");
		const t6 = tag(6, "F");
		const t7 = tag(7, "G");
		const diff = `-${t1}\n-${t3}\n-${t6}\n-${t7}\n+REPLACED`;
		const result = applyAtomEdits(content, parseAtom(diff));
		// Sub-runs: [1], [3], [6,7]. Insert attaches to [6,7] → at line 6 slot.
		expect(result.lines).toBe("B\nD\nE\nREPLACED");
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Schema is permissive for small models that pass extra fields
// ───────────────────────────────────────────────────────────────────────────

describe("atomEditParamsSchema — extra-field tolerance", () => {
	it("accepts extra `path` field alongside `input`", () => {
		const args = { path: "x.ts", input: "---x.ts\n1aa=NEW" };
		expect(Value.Check(atomEditParamsSchema, args)).toBe(true);
	});

	it("accepts extra free-form fields like `_`", () => {
		const args = { _: "fixing inverted boolean", input: "---x.ts\n1aa=NEW" };
		expect(Value.Check(atomEditParamsSchema, args)).toBe(true);
	});

	it("still requires `input`", () => {
		const args = { path: "x.ts" };
		expect(Value.Check(atomEditParamsSchema, args)).toBe(false);
	});
});

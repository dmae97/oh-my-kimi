import { describe, expect, it } from "bun:test";
import {
	type BlockResolver,
	type BlockSpan,
	computeFileHash,
	type Edit,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	MismatchError,
	Patch,
	Patcher,
	parsePatch,
	resolveBlockEdits,
} from "@oh-my-pi/hashline";

const PATH = "x.ts";

// Deterministic stub: the block beginning on line N spans [N, N+1]. The exact
// shape does not matter — the unit tests only need a resolver that is not the
// real tree-sitter native (that is exercised by the coding-agent integration
// test).
const stubResolver: BlockResolver = ({ line }): BlockSpan => ({ start: line, end: line + 1 });

/** Strip parser/transform bookkeeping that `applyEdits` re-derives anyway. */
function normalizeEdits(edits: readonly Edit[]): unknown[] {
	return edits.map(edit => {
		if (edit.kind === "insert") return { kind: edit.kind, cursor: edit.cursor, text: edit.text, mode: edit.mode };
		if (edit.kind === "delete") return { kind: edit.kind, anchor: edit.anchor };
		return edit;
	});
}

describe("replace block parsing", () => {
	it("parses `replace block N:` into a single deferred block edit", () => {
		const { edits } = parsePatch("replace block 2:\n+A\n+B");

		expect(edits).toHaveLength(1);
		const edit = edits[0];
		expect(edit?.kind).toBe("block");
		if (edit?.kind !== "block") throw new Error("expected a block edit");
		expect(edit.anchor.line).toBe(2);
		expect(edit.payloads).toEqual(["A", "B"]);
	});

	it("still parses a literal `replace N..M:` range (block sub-keyword is optional)", () => {
		const { edits } = parsePatch("replace 2..3:\n+A");
		expect(edits.some(edit => edit.kind === "block")).toBe(false);
		expect(edits.some(edit => edit.kind === "delete")).toBe(true);
	});

	it("rejects a `replace block N:` hunk with no body row", () => {
		expect(() => parsePatch("replace block 2:")).toThrow("`replace block N:` needs at least one");
	});
});

describe("resolveBlockEdits", () => {
	it("expands a block edit exactly like the equivalent `replace start..end:`", () => {
		const blockEdits = parsePatch("replace block 2:\n+A\n+B").edits;
		const resolved = resolveBlockEdits(blockEdits, "ignored", PATH, stubResolver);
		const replaceEdits = parsePatch("replace 2..3:\n+A\n+B").edits;

		expect(resolved.some(edit => edit.kind === "block")).toBe(false);
		expect(normalizeEdits(resolved)).toEqual(normalizeEdits(replaceEdits));
	});

	it("returns the input untouched when there are no block edits (fast path)", () => {
		const edits = parsePatch("replace 1..1:\n+X").edits;
		expect(resolveBlockEdits(edits, "ignored", PATH, stubResolver)).toBe(edits);
	});

	it("throws (default) when no resolver is wired", () => {
		const edits = parsePatch("replace block 2:\n+X").edits;
		expect(() => resolveBlockEdits(edits, "ignored", PATH, undefined)).toThrow("not available here");
	});

	it("drops an unresolvable block edit in `drop` mode", () => {
		const edits = parsePatch("replace block 2:\n+X").edits;
		const resolved = resolveBlockEdits(edits, "ignored", PATH, () => null, { onUnresolved: "drop" });
		expect(resolved).toHaveLength(0);
	});

	it("throws a block-unresolved error in `throw` mode when the resolver returns null", () => {
		const edits = parsePatch("replace block 7:\n+X").edits;
		expect(() => resolveBlockEdits(edits, "ignored", PATH, () => null)).toThrow(
			"could not resolve a syntactic block beginning on line 7",
		);
	});
});

describe("PatchSection.applyTo / applyPartialTo with block edits", () => {
	const text = "function x() {\n  if (y) {\n  }\n}\n";

	it("applyTo resolves a block edit and matches the equivalent `replace`", () => {
		const blockSection = Patch.parseSingle(`¶${PATH}#1A2B\nreplace block 2:\n+  if (y || z) {\n+  }`);
		const replaceSection = Patch.parseSingle(`¶${PATH}#1A2B\nreplace 2..3:\n+  if (y || z) {\n+  }`);

		const blockResult = blockSection.applyTo(text, stubResolver);
		const replaceResult = replaceSection.applyTo(text);

		expect(blockResult.text).toBe("function x() {\n  if (y || z) {\n  }\n}\n");
		expect(blockResult.text).toBe(replaceResult.text);
	});

	it("applyTo throws when a block edit has no resolver", () => {
		const section = Patch.parseSingle(`¶${PATH}#1A2B\nreplace block 2:\n+X`);
		expect(() => section.applyTo(text)).toThrow("replace block");
	});

	it("applyPartialTo drops an unresolvable block edit instead of throwing", () => {
		const section = Patch.parseSingle(`¶${PATH}#1A2B\nreplace block 2:\n+X`);
		// No resolver → drop. The lone block edit vanishes, so the text is unchanged.
		const result = section.applyPartialTo(text);
		expect(result.text).toBe(text);
	});
});

describe("Patcher with a block resolver", () => {
	const text = "function x() {\n  if (y) {\n  }\n}\n";

	it("applies a block edit on the hash-match path", async () => {
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, text);
		const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver });

		const result = await patcher.apply(Patch.parse(`¶${PATH}#${tag}\nreplace block 2:\n+  if (y || z) {\n+  }`));

		expect(result.sections[0]?.op).toBe("update");
		expect(fs.get(PATH)).toBe("function x() {\n  if (y || z) {\n  }\n}\n");
	});

	it("resolves against the tagged snapshot and recovers onto drifted content", async () => {
		const snapshotText = "line0\nline1\nline2\nline3\nline4\n";
		// The live file gained a trailing line after the read minted the tag.
		const liveText = "line0\nline1\nline2\nline3\nline4\nline5\n";
		const fs = new InMemoryFilesystem([[PATH, liveText]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, snapshotText);
		const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver });

		// `block 2` resolves against the SNAPSHOT → span [2,3] → replace
		// "line1","line2"; recovery 3-way-merges the change onto the live file.
		const result = await patcher.apply(Patch.parse(`¶${PATH}#${tag}\nreplace block 2:\n+NEW`));

		expect(result.sections[0]?.op).toBe("update");
		expect(fs.get(PATH)).toBe("line0\nNEW\nline3\nline4\nline5\n");
		expect(result.sections[0]?.warnings.some(w => /Recovered/.test(w))).toBe(true);
	});

	it("rejects a block edit whose tag was never recorded for this path", async () => {
		const liveText = "line0\nline1\nline2\n";
		const fs = new InMemoryFilesystem([[PATH, liveText]]);
		const snapshots = new InMemorySnapshotStore();
		const live = computeFileHash(liveText);
		const bogus = live === "FFFF" ? "0000" : "FFFF";
		const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver });

		await expect(patcher.apply(Patch.parse(`¶${PATH}#${bogus}\nreplace block 2:\n+NEW`))).rejects.toBeInstanceOf(
			MismatchError,
		);
		expect(fs.get(PATH)).toBe(liveText);
	});

	it("throws a block-unresolved error when the resolver returns null", async () => {
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, text);
		const patcher = new Patcher({ fs, snapshots, blockResolver: () => null });

		await expect(patcher.apply(Patch.parse(`¶${PATH}#${tag}\nreplace block 2:\n+X`))).rejects.toThrow(
			"could not resolve a syntactic block",
		);
		expect(fs.get(PATH)).toBe(text);
	});
});

describe("delete block", () => {
	const text = "function x() {\n  if (y) {\n  }\n}\n";

	it("parses `delete block N` into a block edit with no payloads", () => {
		const { edits } = parsePatch("delete block 2");

		expect(edits).toHaveLength(1);
		const edit = edits[0];
		expect(edit?.kind).toBe("block");
		if (edit?.kind !== "block") throw new Error("expected a block edit");
		expect(edit.anchor.line).toBe(2);
		expect(edit.payloads).toEqual([]);
	});

	it("rejects body rows under `delete block N`", () => {
		expect(() => parsePatch("delete block 2\n+X")).toThrow("`delete block N` does not take body rows");
	});

	it("resolveBlockEdits expands a delete-block edit into pure deletes", () => {
		const edits = parsePatch("delete block 2").edits;
		const resolved = resolveBlockEdits(edits, "ignored", PATH, stubResolver);

		expect(resolved.every(edit => edit.kind === "delete")).toBe(true);
		expect(resolved.map(edit => (edit.kind === "delete" ? edit.anchor.line : -1))).toEqual([2, 3]);
	});

	it("applyTo deletes the resolved block span", () => {
		const section = Patch.parseSingle(`¶${PATH}#1A2B\ndelete block 2`);
		// stub span [2,3] → drop "  if (y) {" and "  }".
		expect(section.applyTo(text, stubResolver).text).toBe("function x() {\n}\n");
	});

	it("applyPartialTo drops an unresolvable delete-block edit instead of throwing", () => {
		const section = Patch.parseSingle(`¶${PATH}#1A2B\ndelete block 2`);
		expect(section.applyPartialTo(text).text).toBe(text);
	});

	it("Patcher applies a delete-block edit on the hash-match path", async () => {
		const fs = new InMemoryFilesystem([[PATH, text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, text);
		const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver });

		const result = await patcher.apply(Patch.parse(`¶${PATH}#${tag}\ndelete block 2`));

		expect(result.sections[0]?.op).toBe("update");
		expect(fs.get(PATH)).toBe("function x() {\n}\n");
	});
});

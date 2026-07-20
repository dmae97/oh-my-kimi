import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
	hashProposalLine,
	hashProposalSource,
	parseHashlineProposal,
} from "../src/proposal.ts";

const begin = "*** Begin Patch";
const end = "*** End Patch";
const zeroHash = "0".repeat(64);
const za = (line) => `${line}@sha256:${zeroHash}`;
const zr = (a, b) => `${za(a)}.=${za(b)}`;
const patch = (bodyLines) => [begin, ...bodyLines, end].join("\n");
const header = `[f#sha256:${zeroHash}]`;

async function fixture() {
	const source = ["line1", "line2", "line3", "line4", "line5", ""].join("\n");
	const fileDigest = await hashProposalSource(source);
	const lineDigests = [];
	for (const text of ["line1", "line2", "line3", "line4", "line5"]) {
		lineDigests.push(await hashProposalLine(text));
	}
	const anchorText = (line) => `${line}@sha256:${lineDigests[line - 1]}`;
	const rangeText = (a, b) => `${anchorText(a)}.=${anchorText(b)}`;
	const anchor = (line) => ({ line, digest: lineDigests[line - 1] });
	return { fileDigest, lineDigests, anchorText, rangeText, anchor };
}

async function allOpsText() {
	const { fileDigest, anchorText, rangeText } = await fixture();
	return patch([
		`[path/to/file.ts#sha256:${fileDigest}]`,
		`SWAP ${rangeText(1, 2)}:`,
		"+new1",
		"+new2",
		`SWAP.BLK ${anchorText(3)}:`,
		"+blk",
		`INS.PRE ${anchorText(2)}:`,
		"+before2",
		`INS.POST ${anchorText(4)}:`,
		"+after4",
		`INS.BLK.POST ${anchorText(4)}:`,
		"+afterblk4",
		"INS.HEAD:",
		"+head",
		"INS.TAIL:",
		"+tail",
		`DEL.BLK ${anchorText(4)}`,
		`DEL ${rangeText(5, 5)}`,
		"MV other/path.ts",
	]);
}

describe("parseHashlineProposal", () => {
	it("parses every op into exact discriminated records", async () => {
		const { fileDigest, lineDigests, anchor } = await fixture();
		const result = parseHashlineProposal(await allOpsText());
		ok(result.ok, result.ok === false ? result.error.message : undefined);
		deepStrictEqual(result.value, {
			sections: [
				{
					path: "path/to/file.ts",
					digest: fileDigest,
					edits: [
						{ kind: "replace", sourceLine: 3, start: anchor(1), end: anchor(2), body: ["new1", "new2"] },
						{ kind: "replace-block", sourceLine: 6, anchor: anchor(3), body: ["blk"] },
						{ kind: "insert-before", sourceLine: 8, anchor: anchor(2), body: ["before2"] },
						{ kind: "insert-after", sourceLine: 10, anchor: anchor(4), body: ["after4"] },
						{ kind: "insert-after-block", sourceLine: 12, anchor: anchor(4), body: ["afterblk4"] },
						{ kind: "insert-head", sourceLine: 14, body: ["head"] },
						{ kind: "insert-tail", sourceLine: 16, body: ["tail"] },
						{ kind: "delete-block", sourceLine: 18, anchor: anchor(4) },
						{ kind: "delete", sourceLine: 19, start: anchor(5), end: anchor(5) },
						{ kind: "move", sourceLine: 20, to: "other/path.ts" },
					],
				},
			],
			expectedFileHashes: [{ path: "path/to/file.ts", digest: fileDigest }],
			expectedLineHashes: [1, 2, 3, 4, 5].map((line) => ({
				path: "path/to/file.ts",
				line,
				digest: lineDigests[line - 1],
			})),
		});
		deepStrictEqual(
			result.value.sections[0].edits.map((edit) => edit.kind),
			[
				"replace",
				"replace-block",
				"insert-before",
				"insert-after",
				"insert-after-block",
				"insert-head",
				"insert-tail",
				"delete-block",
				"delete",
				"move",
			],
		);
	});

	it("rejects missing or malformed envelope", () => {
		for (const text of ["", header, `${begin}\n${header}\nINS.HEAD:\n+x`, begin]) {
			const result = parseHashlineProposal(text);
			ok(!result.ok);
			strictEqual(result.error.code, "syntax");
		}
	});

	it("permits a single terminal newline and rejects trailing data", () => {
		const base = patch([header, "INS.HEAD:", "+x"]);
		ok(parseHashlineProposal(base).ok);
		ok(parseHashlineProposal(`${base}\n`).ok);
		for (const text of [`${base}\nleftover`, `${base}\n\n`, `${base}x`]) {
			const result = parseHashlineProposal(text);
			ok(!result.ok);
			strictEqual(result.error.code, "syntax");
		}
	});

	it("requires at least one section and one hunk per section", () => {
		const empty = parseHashlineProposal(patch([]));
		ok(!empty.ok);
		strictEqual(empty.error.code, "syntax");
		const noHunks = parseHashlineProposal(patch([header]));
		ok(!noHunks.ok);
		strictEqual(noHunks.error.code, "syntax");
		strictEqual(noHunks.error.line, 2);
		const blankOnly = parseHashlineProposal(patch([header, ""]));
		ok(!blankOnly.ok);
		strictEqual(blankOnly.error.code, "syntax");
	});

	it("rejects malformed header and anchors", () => {
		const badHash = parseHashlineProposal(patch(["[bad#sha256:GGGG]"]));
		ok(!badHash.ok);
		strictEqual(badHash.error.code, "syntax");
		const badAnchor = parseHashlineProposal(patch([header, `SWAP 0@sha256:${zeroHash}.=${za(1)}:`]));
		ok(!badAnchor.ok);
		strictEqual(badAnchor.error.code, "syntax");
	});

	it("rejects orphan payload and payload after file or delete ops", () => {
		const cases = [
			["+orphan"],
			["REM", "+x"],
			["MV x", "+x"],
			[`DEL ${zr(1, 1)}`, "+x"],
			[`DEL.BLK ${za(1)}`, "+x"],
		];
		for (const bodyLines of cases) {
			const result = parseHashlineProposal(patch([header, ...bodyLines]));
			ok(!result.ok);
			strictEqual(result.error.code, "payload");
		}
	});

	it("rejects empty bodies for every insert variant and SWAP.BLK", () => {
		const hunks = [
			`INS.PRE ${za(1)}:`,
			`INS.POST ${za(1)}:`,
			`INS.BLK.POST ${za(1)}:`,
			"INS.HEAD:",
			"INS.TAIL:",
			`SWAP.BLK ${za(1)}:`,
		];
		for (const hunk of hunks) {
			const result = parseHashlineProposal(patch([header, hunk]));
			ok(!result.ok, hunk);
			strictEqual(result.error.code, "payload");
		}
	});

	it("keeps SWAP zero-payload semantics as a pure range deletion", () => {
		const result = parseHashlineProposal(patch([header, `SWAP ${zr(1, 2)}:`]));
		ok(result.ok);
		deepStrictEqual(result.value.sections[0].edits[0], {
			kind: "replace",
			sourceLine: 3,
			start: { line: 1, digest: zeroHash },
			end: { line: 2, digest: zeroHash },
			body: [],
		});
	});

	it("rejects file hash and line hash conflicts", async () => {
		const sourceDigest = await hashProposalSource("x");
		const fileConflict = parseHashlineProposal(
			patch([`[f#sha256:${sourceDigest}]`, "INS.HEAD:", "+x", header, "INS.HEAD:", "+x"]),
		);
		ok(!fileConflict.ok);
		strictEqual(fileConflict.error.code, "hash-conflict");
		const l1 = await hashProposalLine("a");
		const l2 = await hashProposalLine("b");
		const lineConflict = parseHashlineProposal(
			patch([header, `SWAP 1@sha256:${l1}.=2@sha256:${l2}:`, "+n", `INS.PRE ${za(1)}:`, "+x"]),
		);
		ok(!lineConflict.ok);
		strictEqual(lineConflict.error.code, "hash-conflict");
	});

	it("dedupes repeated file and line expectations by path and line", () => {
		const result = parseHashlineProposal(
			patch([header, `INS.POST ${za(1)}:`, "+a", header, `INS.POST ${za(1)}:`, "+b"]),
		);
		ok(result.ok);
		strictEqual(result.value.sections.length, 2);
		deepStrictEqual(result.value.expectedFileHashes, [{ path: "f", digest: zeroHash }]);
		deepStrictEqual(result.value.expectedLineHashes, [{ path: "f", line: 1, digest: zeroHash }]);
	});

	it("rejects overlapping concrete spans", async () => {
		const l1 = await hashProposalLine("a");
		const l2 = await hashProposalLine("b");
		const l3 = await hashProposalLine("c");
		const result = parseHashlineProposal(
			patch([header, `SWAP 1@sha256:${l1}.=3@sha256:${l3}:`, "+new", `DEL 2@sha256:${l2}.=2@sha256:${l2}`]),
		);
		ok(!result.ok);
		strictEqual(result.error.code, "overlap");
	});

	it("rejects conflicting duplicate block anchors but not block-adjacent inserts", () => {
		const conflict = parseHashlineProposal(patch([header, `SWAP.BLK ${za(3)}:`, "+x", `DEL.BLK ${za(3)}`]));
		ok(!conflict.ok);
		strictEqual(conflict.error.code, "overlap");
		const twiceDeleted = parseHashlineProposal(patch([header, `DEL.BLK ${za(3)}`, `DEL.BLK ${za(3)}`]));
		ok(!twiceDeleted.ok);
		strictEqual(twiceDeleted.error.code, "overlap");
		const adjacent = parseHashlineProposal(patch([header, `INS.BLK.POST ${za(3)}:`, "+x", `DEL.BLK ${za(3)}`]));
		ok(adjacent.ok);
	});

	it("rejects unsafe line numbers and reversed ranges", () => {
		const reversed = parseHashlineProposal(patch([header, `SWAP ${zr(2, 2).replace("2@", "3@")}:`]));
		ok(!reversed.ok);
		strictEqual(reversed.error.code, "syntax");
		const big = Number.MAX_SAFE_INTEGER + 1;
		const unsafe = parseHashlineProposal(patch([header, `SWAP ${big}@sha256:${zeroHash}.=${za(1)}:`]));
		ok(!unsafe.ok);
		strictEqual(unsafe.error.code, "limit");
	});

	it("rejects resource limits without huge fixtures", () => {
		let sections = "";
		for (let i = 0; i < 257; i++) sections += `[f${i}#sha256:${zeroHash}]\nINS.HEAD:\n+x\n`;
		const tooManySections = parseHashlineProposal(`${begin}\n${sections}${end}`);
		ok(!tooManySections.ok);
		strictEqual(tooManySections.error.code, "limit");
		let hunks = "";
		for (let i = 1; i <= 10_001; i++) hunks += `INS.HEAD:\n+${i}\n`;
		const tooManyHunks = parseHashlineProposal(`${begin}\n${header}\n${hunks}${end}`);
		ok(!tooManyHunks.ok);
		strictEqual(tooManyHunks.error.code, "limit");
		const tooLarge = parseHashlineProposal("x".repeat((1 << 20) + 1));
		ok(!tooLarge.ok);
		strictEqual(tooLarge.error.code, "too-large");
	});

	it("rejects ill-formed UTF-16 patch text", () => {
		const result = parseHashlineProposal(`${begin}\n\uD800\n${end}`);
		ok(!result.ok);
		strictEqual(result.error.code, "encoding");
	});

	it("preserves same-cursor insertion order", () => {
		const result = parseHashlineProposal(
			patch([header, `INS.POST ${za(1)}:`, "+first", `INS.POST ${za(1)}:`, "+second"]),
		);
		ok(result.ok);
		const edits = result.value.sections[0].edits;
		strictEqual(edits.length, 2);
		deepStrictEqual(
			edits.map((edit) => ({ kind: edit.kind, first: edit.body[0] })),
			[
				{ kind: "insert-after", first: "first" },
				{ kind: "insert-after", first: "second" },
			],
		);
	});

	it("parses a lone REM section into the remove discriminant", () => {
		const result = parseHashlineProposal(patch([header, "REM"]));
		ok(result.ok);
		deepStrictEqual(result.value.sections[0].edits, [{ kind: "remove", sourceLine: 3 }]);
	});

	it("rejects incompatible or trailing file ops", () => {
		const cases = [
			["REM", "MV x"],
			["MV x", `SWAP ${zr(1, 1)}:`],
			["REM stray-argument"],
		];
		for (const bodyLines of cases) {
			const result = parseHashlineProposal(patch([header, ...bodyLines]));
			ok(!result.ok);
			strictEqual(result.error.code, "syntax");
		}
	});

	it("is deterministic and deeply immutable down to nested records", async () => {
		const text = await allOpsText();
		const first = parseHashlineProposal(text);
		const second = parseHashlineProposal(text);
		ok(first.ok && second.ok);
		deepStrictEqual(first.value, second.value);
		ok(Object.isFrozen(first));
		const value = first.value;
		ok(Object.isFrozen(value));
		ok(Object.isFrozen(value.sections));
		for (const section of value.sections) {
			ok(Object.isFrozen(section));
			ok(Object.isFrozen(section.edits));
			for (const edit of section.edits) {
				ok(Object.isFrozen(edit));
				if ("body" in edit) ok(Object.isFrozen(edit.body));
				if ("start" in edit) {
					ok(Object.isFrozen(edit.start));
					ok(Object.isFrozen(edit.end));
				}
				if ("anchor" in edit) ok(Object.isFrozen(edit.anchor));
			}
		}
		ok(Object.isFrozen(value.expectedFileHashes));
		for (const expectation of value.expectedFileHashes) ok(Object.isFrozen(expectation));
		ok(Object.isFrozen(value.expectedLineHashes));
		for (const expectation of value.expectedLineHashes) ok(Object.isFrozen(expectation));
		throws(() => {
			value.sections.push(null);
		});
		throws(() => {
			value.sections[0].edits[0].body.push("x");
		});
		throws(() => {
			value.expectedLineHashes[0].line = 99;
		});
		const failed = parseHashlineProposal("nope");
		ok(!failed.ok);
		ok(Object.isFrozen(failed));
		ok(Object.isFrozen(failed.error));
	});

	it("mutates no external state", async () => {
		const before = { x: 1 };
		parseHashlineProposal(await allOpsText());
		deepStrictEqual(before, { x: 1 });
	});
});

describe("hashing", () => {
	it("treats LF, CRLF, and BOM as equivalent for source hash", async () => {
		const a = await hashProposalSource("abc\n");
		const b = await hashProposalSource("abc\r\n");
		const c = await hashProposalSource("\uFEFFabc\n");
		const d = await hashProposalSource("abc\r");
		strictEqual(a, b);
		strictEqual(a, c);
		strictEqual(a, d);
	});

	it("preserves whitespace and distinguishes NFC/NFD", async () => {
		const a = await hashProposalSource("café");
		const b = await hashProposalSource("cafe\u0301");
		ok(a !== b);
		const c = await hashProposalSource("  a\tb ");
		strictEqual(c, await hashProposalSource("  a\tb "));
	});

	it("rejects ill-formed UTF-16 and newlines in line hash", async () => {
		await rejects(async () => hashProposalSource("\uD800"), (err) => err instanceof Error);
		await rejects(async () => hashProposalLine("a\nb"), (err) => err instanceof Error);
		await rejects(async () => hashProposalLine("a\rb"), (err) => err instanceof Error);
	});
});

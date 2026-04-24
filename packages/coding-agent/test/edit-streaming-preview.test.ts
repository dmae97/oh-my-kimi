import { describe, expect, test } from "bun:test";
import { dropIncompleteLastEdit, EDIT_MODE_STRATEGIES } from "@oh-my-pi/pi-coding-agent/edit";

describe("dropIncompleteLastEdit", () => {
	test("keeps all entries when partialJson is undefined", () => {
		const edits = [{ path: "a" }, { path: "b" }];
		expect(dropIncompleteLastEdit(edits, undefined, "edits")).toEqual(edits);
	});

	test("keeps all entries when the trailing object is closed", () => {
		const edits = [{ path: "a" }, { path: "b" }];
		const partial = '{"edits":[{"path":"a"},{"path":"b"}]}';
		expect(dropIncompleteLastEdit(edits, partial, "edits")).toEqual(edits);
	});

	test("drops the last entry when its closing } has not arrived", () => {
		const edits = [{ path: "a" }, { path: "b" }];
		const partial = '{"edits":[{"path":"a"},{"path":"b"';
		expect(dropIncompleteLastEdit(edits, partial, "edits")).toEqual([{ path: "a" }]);
	});

	test("drops the last entry when a new {} has opened after the last close", () => {
		const edits = [{ path: "a" }, { path: "b" }];
		const partial = '{"edits":[{"path":"a"},{"pat';
		expect(dropIncompleteLastEdit(edits, partial, "edits")).toEqual([{ path: "a" }]);
	});

	test("leaves empty edits alone", () => {
		expect(dropIncompleteLastEdit([], '{"edits":[', "edits")).toEqual([]);
	});
});

describe("chunk extractCompleteEdits", () => {
	const strategy = EDIT_MODE_STRATEGIES.chunk;

	test("passes through a single complete entry", () => {
		const args = {
			edits: [{ path: "a.ts", write: "foo" }],
			__partialJson: '{"edits":[{"path":"a.ts","write":"foo"}]}',
		};
		const out = strategy.extractCompleteEdits(args, args.__partialJson) as typeof args;
		expect(out.edits).toHaveLength(1);
	});

	test("drops trailing entry when partial JSON has open-brace after last close", () => {
		const args = {
			edits: [{ path: "a.ts", write: "foo" }, { path: "b.ts" }],
			__partialJson: '{"edits":[{"path":"a.ts","write":"foo"},{"path":"b.ts"',
		};
		const out = strategy.extractCompleteEdits(args, args.__partialJson) as typeof args;
		expect(out.edits).toHaveLength(1);
		expect(out.edits[0].path).toBe("a.ts");
	});

	test("drops trailing entry when partial JSON ends in ':nu' (write: null guard)", () => {
		const args = {
			edits: [
				{ path: "a.ts", write: "foo" },
				{ path: "b.ts", write: null },
			],
			// simulates partial-json coercing the in-flight `nu` to `null`
			__partialJson: '{"edits":[{"path":"a.ts","write":"foo"},{"path":"b.ts","write":nu',
		};
		const out = strategy.extractCompleteEdits(args, args.__partialJson) as typeof args;
		// Last entry should be dropped because its `}` hasn't arrived yet, so
		// incomplete null-write errors are suppressed while streaming.
		expect(out.edits).toHaveLength(1);
		expect(out.edits[0].path).toBe("a.ts");
	});
});

describe("apply_patch extractCompleteEdits", () => {
	const strategy = EDIT_MODE_STRATEGIES.apply_patch;

	test("returns args unchanged (payload is plain text)", () => {
		const args = { input: "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch\n" };
		expect(strategy.extractCompleteEdits(args, undefined)).toEqual(args);
	});
});

describe("vim extractCompleteEdits", () => {
	const strategy = EDIT_MODE_STRATEGIES.vim;

	test("returns args unchanged (vim stream handled elsewhere)", () => {
		const args = { file: "a.ts", steps: [] };
		expect(strategy.extractCompleteEdits(args, undefined)).toEqual(args);
	});
});

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

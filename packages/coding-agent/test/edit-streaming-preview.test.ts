import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

describe("hashline streaming preview (multi-section)", () => {
	const strategy = EDIT_MODE_STRATEGIES.hashline;
	let tmpDir: string;
	let fileA: string;
	let fileB: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-stream-"));
		fileA = path.join(tmpDir, "a.ts");
		fileB = path.join(tmpDir, "b.ts");
		await Bun.write(fileA, "const a = 1;\nconst b = 2;\n");
		await Bun.write(fileB, "export const c = 3;\n");
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal });

	test("keeps section A's preview when section B's header just arrived", async () => {
		const input = ["@a.ts", "+ BOF", "~// new", "@b.ts"].join("\n");
		const previews = await strategy.computeDiffPreview({ input } as never, ctx(tmpDir) as never);
		expect(previews).not.toBeNull();
		expect(previews).toHaveLength(1);
		expect(previews?.[0]?.path).toBe("a.ts");
		expect(previews?.[0]?.diff).toBeTruthy();
		expect(previews?.[0]?.error).toBeUndefined();
	});

	test("ignores parse errors from the trailing in-progress section", async () => {
		// `+ 7` is a malformed anchor — the trailing section is still being typed.
		const input = ["@a.ts", "+ BOF", "~// new", "@b.ts", "+ 7"].join("\n");
		const previews = await strategy.computeDiffPreview({ input } as never, ctx(tmpDir) as never);
		expect(previews).not.toBeNull();
		expect(previews).toHaveLength(1);
		expect(previews?.[0]?.path).toBe("a.ts");
		expect(previews?.[0]?.diff).toBeTruthy();
	});

	test("renders both sections once each has at least one valid op", async () => {
		const input = ["@a.ts", "+ BOF", "~// new a", "@b.ts", "+ BOF", "~// new b"].join("\n");
		const previews = await strategy.computeDiffPreview({ input } as never, ctx(tmpDir) as never);
		expect(previews).toHaveLength(2);
		expect(previews?.map(p => p.path).sort()).toEqual(["a.ts", "b.ts"]);
		for (const p of previews ?? []) {
			expect(p.diff).toBeTruthy();
			expect(p.error).toBeUndefined();
		}
	});
});

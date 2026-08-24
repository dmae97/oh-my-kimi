import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGrepTool } from "../src/core/tools/grep.ts";

/**
 * `path:line: text` repeats the full path on every match. On this repository a
 * targeted search spends 20-33% of its output re-printing the same paths.
 * Grouping is a run-length compression of consecutive identical paths: it never
 * reorders matches, and a single-match file costs the same as before because
 * the `:` after the path simply becomes a newline.
 */

const roots: string[] = [];

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "omk-grep-grouped-"));
	roots.push(root);
	return root;
}

async function run(root: string, args: Record<string, unknown> = {}): Promise<string> {
	const result = await createGrepTool(root).execute("t", { path: root, pattern: "NEEDLE", ...args });
	return result.content[0].type === "text" ? result.content[0].text : "";
}

/** Match rows are `<line>: <text>`; headers are everything else. */
function matchRows(output: string): string[] {
	return output.split("\n").filter((line) => /^\d+: /.test(line));
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("grep grouped output", () => {
	it("prints one path header for consecutive matches in the same file", async () => {
		const root = fixture();
		writeFileSync(join(root, "alpha.ts"), "NEEDLE one\nfiller\nNEEDLE two\nNEEDLE three\n");

		const output = await run(root);
		expect(output.split("\n").filter((line) => line === "alpha.ts")).toHaveLength(1);
		expect(matchRows(output)).toEqual(["1: NEEDLE one", "3: NEEDLE two", "4: NEEDLE three"]);
	});

	it("still identifies the file for a single match", async () => {
		const root = fixture();
		writeFileSync(join(root, "solo.ts"), "filler\nNEEDLE here\n");

		const output = await run(root);
		expect(output).toContain("solo.ts");
		expect(matchRows(output)).toEqual(["2: NEEDLE here"]);
	});

	it("never costs more than the flat rendering", async () => {
		const root = fixture();
		// One match per file is the worst case for grouping.
		for (let index = 0; index < 6; index++) {
			writeFileSync(join(root, `a-fairly-long-module-name-${index}.ts`), "NEEDLE only\n");
		}

		const output = await run(root);
		const rows = matchRows(output);
		const flatLength = rows.reduce((sum, row, index) => {
			const path = `a-fairly-long-module-name-${index}.ts`;
			return sum + path.length + 1 + row.length;
		}, 0);
		const groupedLength = output
			.split("\n")
			.filter((line) => line.trim() !== "")
			.reduce((sum, line) => sum + line.length, 0);

		expect(groupedLength).toBeLessThanOrEqual(flatLength);
	});

	it("compresses more as matches concentrate in fewer files", async () => {
		const root = fixture();
		const path = join(root, "a-fairly-long-module-name.ts");
		writeFileSync(path, Array.from({ length: 12 }, (_, i) => `NEEDLE ${i}`).join("\n"));

		const output = await run(root);
		const rows = matchRows(output);
		expect(rows).toHaveLength(12);
		// The path is printed once, not twelve times.
		expect(output.split("a-fairly-long-module-name.ts")).toHaveLength(2);
	});

	it("re-emits the header when files interleave", async () => {
		const root = fixture();
		mkdirSync(join(root, "nested"), { recursive: true });
		writeFileSync(join(root, "first.ts"), "NEEDLE a\n");
		writeFileSync(join(root, "nested", "second.ts"), "NEEDLE b\n");

		const output = await run(root);
		expect(matchRows(output)).toHaveLength(2);
		expect(output).toContain("first.ts");
		expect(output).toContain("second.ts");
	});

	it("preserves match order", async () => {
		const root = fixture();
		writeFileSync(join(root, "ordered.ts"), "NEEDLE 1\nx\nNEEDLE 2\ny\nNEEDLE 3\n");

		const output = await run(root);
		expect(matchRows(output).map((row) => Number(row.split(":")[0]))).toEqual([1, 3, 5]);
	});

	it("leaves the context rendering untouched", async () => {
		const root = fixture();
		writeFileSync(join(root, "ctx.ts"), "before\nNEEDLE hit\nafter\n");

		const output = await run(root, { context: 1 });
		expect(output).toContain("ctx.ts-1- before");
		expect(output).toContain("ctx.ts:2: NEEDLE hit");
		expect(output).toContain("ctx.ts-3- after");
	});

	it("keeps the match-limit notice", async () => {
		const root = fixture();
		writeFileSync(join(root, "many.ts"), "NEEDLE 1\nNEEDLE 2\nNEEDLE 3\n");

		const output = await run(root, { limit: 1 });
		expect(output).toContain("1 matches limit reached");
		expect(matchRows(output)).toHaveLength(1);
	});
});

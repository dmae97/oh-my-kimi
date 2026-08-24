import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildBaseline,
	countPureLoc,
	evaluateModuleSizes,
	isCheckedModule,
	measureModules,
	MODULE_SIZE_CEILING,
} from "../check-module-size.mjs";

describe("countPureLoc", () => {
	it("ignores blank lines and line comments", () => {
		assert.equal(countPureLoc("const a = 1;\n\n// comment\nconst b = 2;\n"), 2);
	});

	it("ignores block comments including doc blocks", () => {
		const source = ["/**", " * Doc block.", " */", "export const a = 1;", "/* one-liner */", "export const b = 2;"].join(
			"\n",
		);
		assert.equal(countPureLoc(source), 2);
	});

	it("counts a line that merely contains a comment marker", () => {
		assert.equal(countPureLoc('const url = "https://example.com";'), 1);
	});

	it("returns zero for an empty or comment-only file", () => {
		assert.equal(countPureLoc(""), 0);
		assert.equal(countPureLoc("/*\n * only docs\n */\n"), 0);
	});
});

describe("isCheckedModule", () => {
	it("accepts ordinary source modules", () => {
		assert.equal(isCheckedModule("agent-session.ts"), true);
	});

	it("skips tests, declarations, generated output, and non-TypeScript", () => {
		for (const name of ["thing.test.ts", "thing.d.ts", "models.generated.ts", "readme.md"]) {
			assert.equal(isCheckedModule(name), false, name);
		}
	});
});

describe("evaluateModuleSizes", () => {
	it("passes a file under the ceiling with no baseline entry", () => {
		const result = evaluateModuleSizes(new Map([["a.ts", 100]]), {});
		assert.deepEqual(result.violations, []);
	});

	it("fails a new file over the ceiling", () => {
		const result = evaluateModuleSizes(new Map([["a.ts", MODULE_SIZE_CEILING + 1]]), {});
		assert.equal(result.violations.length, 1);
		assert.equal(result.violations[0].kind, "new_violation");
	});

	it("allows a baselined file to stay at its recorded size", () => {
		const result = evaluateModuleSizes(new Map([["big.ts", 900]]), { "big.ts": 900 });
		assert.deepEqual(result.violations, []);
		assert.deepEqual(result.tightenings, []);
	});

	it("fails a baselined file that grows by even one line", () => {
		const result = evaluateModuleSizes(new Map([["big.ts", 901]]), { "big.ts": 900 });
		assert.equal(result.violations.length, 1);
		assert.equal(result.violations[0].kind, "grew_past_baseline");
	});

	it("reports a shrinking baselined file as a tightening, not a violation", () => {
		const result = evaluateModuleSizes(new Map([["big.ts", 400]]), { "big.ts": 900 });
		assert.deepEqual(result.violations, []);
		assert.equal(result.tightenings.length, 1);
	});

	it("reports a deleted baselined file as a tightening", () => {
		const result = evaluateModuleSizes(new Map(), { "gone.ts": 900 });
		assert.deepEqual(result.violations, []);
		assert.equal(result.tightenings[0].file, "gone.ts");
	});

	it("never lets the baseline authorize a brand-new oversized module", () => {
		// A baseline entry for one file must not shelter a different new file.
		const result = evaluateModuleSizes(new Map([["fresh.ts", 5000]]), { "big.ts": 900 });
		assert.equal(result.violations.length, 1);
		assert.equal(result.violations[0].file, "fresh.ts");
	});

	it("orders violations deterministically by path", () => {
		const sizes = new Map([
			["z.ts", 5000],
			["a.ts", 5000],
		]);
		const result = evaluateModuleSizes(sizes, {});
		assert.deepEqual(
			result.violations.map((violation) => violation.file),
			["a.ts", "z.ts"],
		);
	});
});

describe("buildBaseline", () => {
	it("records only modules above the ceiling", () => {
		const sizes = new Map([
			["small.ts", 10],
			["big.ts", 900],
		]);
		assert.deepEqual(buildBaseline(sizes), { "big.ts": 900 });
	});
});

describe("repository state", () => {
	it("measures real modules and holds the committed baseline", async () => {
		const sizes = measureModules();
		assert.ok(sizes.size > 100, `expected to measure many modules, got ${sizes.size}`);

		const baseline = JSON.parse(
			await import("node:fs/promises").then((fs) =>
				fs.readFile(new URL("../module-size-baseline.json", import.meta.url), "utf-8"),
			),
		);
		const { violations } = evaluateModuleSizes(sizes, baseline);
		assert.deepEqual(
			violations.map((violation) => `${violation.file}:${violation.size}`),
			[],
		);
	});

	it("excludes generated output from the baseline", () => {
		const sizes = measureModules();
		for (const file of sizes.keys()) {
			assert.ok(!file.endsWith(".generated.ts"), `generated file leaked into the scan: ${file}`);
		}
	});
});

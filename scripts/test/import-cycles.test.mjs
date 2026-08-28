import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildImportGraph,
	collectModules,
	cyclicModules,
	evaluateCycles,
	findCycles,
	measureCyclicModules,
	resolveImportTarget,
} from "../check-import-cycles.mjs";

/** Injected reader over an in-memory module map. */
function readerFor(files) {
	return (path) => files[path];
}

describe("resolveImportTarget", () => {
	it("resolves sibling and parent specifiers", () => {
		assert.equal(resolveImportTarget("src/core/a.ts", "./b.ts"), "src/core/b.ts");
		assert.equal(resolveImportTarget("src/core/deep/a.ts", "../b.ts"), "src/core/b.ts");
	});

	it("appends the TypeScript extension when a specifier omits it", () => {
		assert.equal(resolveImportTarget("src/a.ts", "./b"), "src/b.ts");
	});

	it("ignores bare specifiers, which cross a package boundary", () => {
		assert.equal(resolveImportTarget("src/a.ts", "node:path"), undefined);
		assert.equal(resolveImportTarget("src/a.ts", "omk-agent-core"), undefined);
	});
});

describe("buildImportGraph", () => {
	it("keeps only edges that land on known modules", () => {
		const files = {
			"src/a.ts": 'import { b } from "./b.ts";\nimport { x } from "omk-tui";',
			"src/b.ts": "export const b = 1;",
		};

		const graph = buildImportGraph(Object.keys(files), readerFor(files));

		assert.deepEqual([...(graph.get("src/a.ts") ?? [])], ["src/b.ts"]);
		assert.deepEqual([...(graph.get("src/b.ts") ?? [])], []);
	});

	it("records dynamic imports as edges", () => {
		const files = { "src/a.ts": 'await import("./b.ts");', "src/b.ts": "" };

		const graph = buildImportGraph(Object.keys(files), readerFor(files));

		assert.deepEqual([...(graph.get("src/a.ts") ?? [])], ["src/b.ts"]);
	});
});

describe("findCycles", () => {
	it("finds a two-module cycle", () => {
		const files = { "src/a.ts": 'from "./b.ts"', "src/b.ts": 'from "./a.ts"' };
		const cycles = findCycles(buildImportGraph(Object.keys(files), readerFor(files)));

		assert.equal(cycles.length, 1);
		assert.deepEqual([...cycles[0]].sort(), ["src/a.ts", "src/b.ts"]);
	});

	it("finds a three-module cycle", () => {
		const files = { "src/a.ts": 'from "./b.ts"', "src/b.ts": 'from "./c.ts"', "src/c.ts": 'from "./a.ts"' };
		const cycles = findCycles(buildImportGraph(Object.keys(files), readerFor(files)));

		assert.equal(cycles.length, 1);
		assert.equal(cycles[0].length, 3);
	});

	it("reports nothing for an acyclic graph", () => {
		const files = { "src/a.ts": 'from "./b.ts"', "src/b.ts": 'from "./c.ts"', "src/c.ts": "" };

		assert.deepEqual(findCycles(buildImportGraph(Object.keys(files), readerFor(files))), []);
	});

	it("separates independent cycles", () => {
		const files = {
			"src/a.ts": 'from "./b.ts"',
			"src/b.ts": 'from "./a.ts"',
			"src/c.ts": 'from "./d.ts"',
			"src/d.ts": 'from "./c.ts"',
		};

		assert.equal(findCycles(buildImportGraph(Object.keys(files), readerFor(files))).length, 2);
	});
});

describe("cyclicModules", () => {
	it("flattens cycle members into one sorted list", () => {
		assert.deepEqual(cyclicModules([["src/b.ts", "src/a.ts"], ["src/c.ts", "src/d.ts"]]), [
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/d.ts",
		]);
	});
});

describe("evaluateCycles", () => {
	it("passes when the cyclic set matches the baseline", () => {
		const result = evaluateCycles(["src/a.ts", "src/b.ts"], ["src/a.ts", "src/b.ts"]);

		assert.deepEqual(result.violations, []);
		assert.deepEqual(result.tightenings, []);
	});

	it("fails when a module is newly dragged into a cycle", () => {
		const result = evaluateCycles(["src/a.ts", "src/b.ts", "src/new.ts"], ["src/a.ts", "src/b.ts"]);

		assert.deepEqual(result.violations, ["src/new.ts"]);
	});

	it("reports a module that escaped its cycle as a tightening, not a failure", () => {
		const result = evaluateCycles(["src/a.ts"], ["src/a.ts", "src/b.ts"]);

		assert.deepEqual(result.violations, []);
		assert.deepEqual(result.tightenings, ["src/b.ts"]);
	});

	it("orders violations deterministically", () => {
		const result = evaluateCycles(["src/z.ts", "src/a.ts"], []);

		assert.deepEqual(result.violations, ["src/a.ts", "src/z.ts"]);
	});
});

describe("repository state", () => {
	it("holds the committed cycle baseline", async () => {
		// Imported as JSON so a malformed baseline is a load error with a location,
		// not a bare parse throw from inside the assertion.
		const { default: baseline } = await import("../import-cycle-baseline.json", { with: { type: "json" } });

		assert.deepEqual(evaluateCycles(measureCyclicModules(), baseline.modules).violations, []);
	});

	it("measures a real module graph rather than an empty one", () => {
		// The scan must actually reach the package sources; an empty result would
		// make this gate pass vacuously forever.
		assert.ok(collectModules().length > 100);
	});
});

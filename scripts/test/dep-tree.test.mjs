import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	binDirectories,
	collectDanglingBinLinks,
	danglingLinks,
	evaluateTree,
	parseTreeProblems,
	readBaseline,
} from "../check-dep-tree.mjs";

/** Workspace skeleton with the bin directories npm would materialize. */
function makeWorkspace(spec) {
	const root = mkdtempSync(join(tmpdir(), "omk-dep-tree-"));
	for (const [packageName, links] of Object.entries(spec)) {
		const binDir =
			packageName === "." ? join(root, "node_modules", ".bin") : join(root, "packages", packageName, "node_modules", ".bin");
		mkdirSync(binDir, { recursive: true });
		for (const [linkName, target] of Object.entries(links)) {
			symlinkSync(target, join(binDir, linkName));
		}
	}
	return root;
}

describe("parseTreeProblems", () => {
	it("returns no problems for a clean tree", () => {
		assert.deepEqual(parseTreeProblems(JSON.stringify({ name: "root", dependencies: {} })), []);
	});

	it("collects problems reported at the root", () => {
		const json = JSON.stringify({ problems: ["invalid: pkg@1.0.0 /path"] });
		assert.deepEqual(parseTreeProblems(json), ["invalid: pkg@1.0.0 /path"]);
	});

	it("collects problems nested inside dependencies", () => {
		const json = JSON.stringify({
			dependencies: { a: { dependencies: { b: { problems: ["invalid: b@2 /p"] } } } },
		});
		assert.deepEqual(parseTreeProblems(json), ["invalid: b@2 /p"]);
	});

	it("deduplicates a problem npm repeats at several depths", () => {
		const json = JSON.stringify({
			problems: ["invalid: dup@1 /p"],
			dependencies: { a: { problems: ["invalid: dup@1 /p"] } },
		});
		assert.deepEqual(parseTreeProblems(json), ["invalid: dup@1 /p"]);
	});

	it("reports unparseable output rather than throwing", () => {
		assert.deepEqual(parseTreeProblems("not json"), ["npm ls did not return parseable JSON"]);
	});
});

describe("danglingLinks", () => {
	it("finds a symlink whose target is absent", () => {
		const root = makeWorkspace({ ".": { omk: "../missing/dist/cli.js" } });
		try {
			const broken = danglingLinks(join(root, "node_modules", ".bin"));
			assert.equal(broken.length, 1);
			assert.equal(broken[0].target, "../missing/dist/cli.js");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts a symlink whose target resolves", () => {
		const root = mkdtempSync(join(tmpdir(), "omk-dep-tree-"));
		try {
			const binDir = join(root, "node_modules", ".bin");
			mkdirSync(binDir, { recursive: true });
			writeFileSync(join(root, "node_modules", "real.js"), "");
			symlinkSync("../real.js", join(binDir, "real"));
			assert.deepEqual(danglingLinks(binDir), []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("binDirectories", () => {
	it("covers the root and each workspace package", () => {
		const root = makeWorkspace({ ".": {}, agent: {}, ai: {} });
		try {
			const dirs = binDirectories(root);
			assert.equal(dirs.length, 3);
			assert.ok(dirs.some((d) => d.endsWith(join("packages", "agent", "node_modules", ".bin"))));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips packages that have no bin directory", () => {
		const root = makeWorkspace({ ".": {} });
		try {
			mkdirSync(join(root, "packages", "empty"), { recursive: true });
			assert.equal(binDirectories(root).length, 1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("collectDanglingBinLinks", () => {
	it("aggregates breakage across workspace packages", () => {
		const root = makeWorkspace({
			".": { good: "../pkg/cli.js" },
			agent: { "omk-ai": "../omk-ai/dist/cli.js" },
		});
		try {
			mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
			writeFileSync(join(root, "node_modules", "pkg", "cli.js"), "");
			const broken = collectDanglingBinLinks(root);
			assert.equal(broken.length, 1);
			assert.ok(broken[0].path.includes(join("agent", "node_modules", ".bin")));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("evaluateTree", () => {
	const baseline = { problems: ["invalid: known@1 /p"] };

	it("holds a baselined problem", () => {
		const result = evaluateTree(["invalid: known@1 /p"], [], baseline);
		assert.deepEqual(result.newProblems, []);
		assert.deepEqual(result.resolved, []);
	});

	it("flags a problem absent from the baseline", () => {
		const result = evaluateTree(["invalid: known@1 /p", "invalid: fresh@2 /q"], [], baseline);
		assert.deepEqual(result.newProblems, ["invalid: fresh@2 /q"]);
	});

	it("reports a baselined problem that disappeared so the gate can tighten", () => {
		const result = evaluateTree([], [], baseline);
		assert.deepEqual(result.resolved, ["invalid: known@1 /p"]);
	});

	it("passes dangling links straight through, never baselining them", () => {
		const link = { path: "/p/.bin/x", target: "../gone" };
		const result = evaluateTree([], [link], baseline);
		assert.deepEqual(result.dangling, [link]);
	});
});

describe("readBaseline", () => {
	it("treats a missing baseline as an empty accepted set", () => {
		assert.deepEqual(readBaseline(join(tmpdir(), "omk-dep-tree-absent.json")), { problems: [] });
	});

	it("treats a corrupt baseline as empty rather than throwing", () => {
		const root = mkdtempSync(join(tmpdir(), "omk-dep-tree-"));
		try {
			const path = join(root, "baseline.json");
			writeFileSync(path, "{ broken");
			assert.deepEqual(readBaseline(path), { problems: [] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

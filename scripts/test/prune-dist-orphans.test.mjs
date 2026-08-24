import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { compiledBase, findDistOrphans, isOrphan } from "../prune-dist-orphans.mjs";

const roots = [];

after(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture(files) {
	const root = mkdtempSync(join(tmpdir(), "omk-prune-dist-"));
	roots.push(root);
	for (const [path, body] of Object.entries(files)) {
		const absolute = join(root, path);
		mkdirSync(join(absolute, ".."), { recursive: true });
		writeFileSync(absolute, body ?? "");
	}
	return root;
}

describe("compiledBase", () => {
	it("strips every emitted suffix", () => {
		assert.equal(compiledBase("core/a.js"), "core/a");
		assert.equal(compiledBase("core/a.js.map"), "core/a");
		assert.equal(compiledBase("core/a.d.ts"), "core/a");
		assert.equal(compiledBase("core/a.d.ts.map"), "core/a");
	});

	it("ignores copied assets", () => {
		for (const asset of ["theme/dark.json", "assets/logo.png", "export-html/template.css", "photon.wasm"]) {
			assert.equal(compiledBase(asset), undefined, asset);
		}
	});

	it("prefers the longest suffix so .d.ts is not read as .ts", () => {
		assert.equal(compiledBase("core/a.d.ts"), "core/a");
	});
});

describe("isOrphan", () => {
	const has = (...paths) => {
		const set = new Set(paths);
		return (candidate) => set.has(candidate);
	};

	it("keeps output whose TypeScript source exists", () => {
		assert.equal(isOrphan("core/a.js", has("core/a.ts")), false);
		assert.equal(isOrphan("core/a.d.ts", has("core/a.ts")), false);
	});

	it("keeps a verbatim-copied .js asset", () => {
		const vendored = "export-html/vendor/marked.min.js";
		assert.equal(isOrphan(vendored, has(vendored)), false);
	});

	it("flags output with no source at all", () => {
		assert.equal(isOrphan("core/tools/omp-seam-runtime.js", has("core/tools/read.ts")), true);
	});

	it("never flags a non-compiled asset", () => {
		assert.equal(isOrphan("theme/dark.json", has()), false);
	});
});

describe("findDistOrphans", () => {
	it("removes nothing when every artifact has a source", () => {
		const root = fixture({
			"dist/core/a.d.ts": "",
			"dist/core/a.js": "",
			"dist/core/a.js.map": "",
			"src/core/a.ts": "",
		});
		assert.deepEqual(findDistOrphans(root), []);
	});

	it("finds an orphan and all of its sibling artifacts", () => {
		const root = fixture({
			"dist/core/gone.d.ts": "",
			"dist/core/gone.d.ts.map": "",
			"dist/core/gone.js": "",
			"dist/core/gone.js.map": "",
			"dist/core/kept.js": "",
			"src/core/kept.ts": "",
		});
		assert.deepEqual(findDistOrphans(root).sort(), [
			"core/gone.d.ts",
			"core/gone.d.ts.map",
			"core/gone.js",
			"core/gone.js.map",
		]);
	});

	it("keeps vendored and templated JS copied out of src", () => {
		const root = fixture({
			"dist/core/export-html/template.js": "",
			"dist/core/export-html/vendor/marked.min.js": "",
			"src/core/export-html/template.js": "",
			"src/core/export-html/vendor/marked.min.js": "",
		});
		assert.deepEqual(findDistOrphans(root), []);
	});

	it("keeps copied assets that are not build outputs", () => {
		const root = fixture({
			"dist/modes/theme/dark.json": "",
			"dist/photon.wasm": "",
			"src/core/a.ts": "",
		});
		assert.deepEqual(findDistOrphans(root), []);
	});

	it("does not walk wholesale-copied trees", () => {
		const root = fixture({
			"dist/docs/guide.js": "",
			"dist/examples/demo.js": "",
			"src/core/a.ts": "",
		});
		assert.deepEqual(findDistOrphans(root), []);
	});

	it("returns nothing when the package has no dist", () => {
		assert.deepEqual(findDistOrphans(fixture({ "src/core/a.ts": "" })), []);
	});
});

describe("repository state", () => {
	it("leaves the built coding-agent dist free of stale outputs", () => {
		const packageRoot = new URL("../../packages/coding-agent/", import.meta.url).pathname;
		assert.deepEqual(findDistOrphans(packageRoot), []);
	});
});

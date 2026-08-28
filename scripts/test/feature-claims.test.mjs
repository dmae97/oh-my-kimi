import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CLAIMS,
	evaluateFeatureClaims,
	findImporters,
	PLACEHOLDER_SYMBOLS,
	resolveRelativeImport,
	runFeatureClaimsCheck,
} from "../check-feature-claims.mjs";

/** Minimal injected reader over an in-memory file map. */
function readerFor(files) {
	return (path) => files[path];
}

/** A claim whose evidence is present, symbol-backed, and imported. */
function claimFixture(over = {}) {
	return {
		claim: "example",
		readmeMarker: /example/i,
		evidence: [{ file: "src/a.ts", symbols: ["doThing"] }],
		...over,
	};
}

function ioFixture(over = {}) {
	return {
		readme: "we support example things",
		readSource: readerFor({ "src/a.ts": "export function doThing() {}" }),
		importerCount: () => 1,
		...over,
	};
}

describe("resolveRelativeImport", () => {
	it("resolves a sibling specifier to a repo-relative path", () => {
		assert.equal(resolveRelativeImport("src/core/a.ts", "./b.ts"), "src/core/b.ts");
	});

	it("resolves a parent specifier", () => {
		assert.equal(resolveRelativeImport("src/core/deep/a.ts", "../b.ts"), "src/core/b.ts");
	});

	it("ignores bare package specifiers", () => {
		assert.equal(resolveRelativeImport("src/core/a.ts", "node:path"), undefined);
		assert.equal(resolveRelativeImport("src/core/a.ts", "omk-agent-core"), undefined);
	});
});

describe("findImporters", () => {
	const files = {
		"src/core/target.ts": "export const x = 1;",
		"src/core/user.ts": 'import { x } from "./target.ts";',
		"src/core/deep/other.ts": 'import { x } from "../target.ts";',
		"src/core/unrelated.ts": 'import { y } from "./somewhere-else.ts";',
	};

	it("finds importers through sibling and parent specifiers", () => {
		const importers = findImporters("src/core/target.ts", Object.keys(files), readerFor(files));

		assert.deepEqual(importers.sort(), ["src/core/deep/other.ts", "src/core/user.ts"]);
	});

	it("never counts a module as importing itself", () => {
		const selfImporting = { "src/a.ts": 'import { x } from "./a.ts";' };

		assert.deepEqual(findImporters("src/a.ts", ["src/a.ts"], readerFor(selfImporting)), []);
	});

	it("does not confuse a same-named file in another directory", () => {
		// `hooks/types.ts` and `extensions/types.ts` both exist in this repo, so a
		// basename match would credit the wrong module with being wired.
		const collision = {
			"src/hooks/types.ts": "export const A = 1;",
			"src/extensions/types.ts": "export const B = 2;",
			"src/user.ts": 'import { A } from "./hooks/types.ts";',
		};

		assert.deepEqual(findImporters("src/extensions/types.ts", Object.keys(collision), readerFor(collision)), []);
		assert.deepEqual(findImporters("src/hooks/types.ts", Object.keys(collision), readerFor(collision)), ["src/user.ts"]);
	});

	it("does not count erased type-only imports or re-exports", () => {
		const typeOnly = {
			"src/a.ts": "export interface A {}",
			"src/import-type.ts": 'import type { A } from "./a.ts";',
			"src/inline-type.ts": 'import { type A } from "./a.ts";',
			"src/export-type.ts": 'export type { A } from "./a.ts";',
		};

		assert.deepEqual(findImporters("src/a.ts", Object.keys(typeOnly), readerFor(typeOnly)), []);
	});

	it("counts dynamic imports and runtime re-exports", () => {
		const runtime = {
			"src/a.ts": "export const x = 1;",
			"src/dynamic.ts": 'await import("./a.ts");',
			"src/export.ts": 'export { x } from "./a.ts";',
		};

		assert.deepEqual(findImporters("src/a.ts", Object.keys(runtime), readerFor(runtime)).sort(), [
			"src/dynamic.ts",
			"src/export.ts",
		]);
	});
});

describe("evaluateFeatureClaims", () => {
	it("passes a claim whose evidence exists, names a symbol, and is imported", () => {
		const result = evaluateFeatureClaims([claimFixture()], ioFixture());

		assert.deepEqual(result.failures, []);
		assert.equal(result.checked, 1);
	});

	it("skips a claim the README does not make", () => {
		const result = evaluateFeatureClaims([claimFixture()], ioFixture({ readme: "nothing claimed here" }));

		assert.deepEqual(result.failures, []);
		assert.equal(result.checked, 0);
	});

	it("fails when the evidence file is gone", () => {
		const result = evaluateFeatureClaims([claimFixture()], ioFixture({ readSource: () => undefined }));

		assert.equal(result.failures.length, 1);
		assert.match(result.failures[0], /does not exist/);
	});

	it("fails when the named symbol is gone", () => {
		const io = ioFixture({ readSource: readerFor({ "src/a.ts": "export function other() {}" }) });
		const result = evaluateFeatureClaims([claimFixture()], io);

		assert.equal(result.failures.length, 1);
		assert.match(result.failures[0], /no longer contains/);
	});

	it("fails when the evidence module is unreachable from the rest of the source", () => {
		// The defect this rule exists for: a claim backed by a module nothing
		// imports is a claim backed by dead code.
		const result = evaluateFeatureClaims([claimFixture()], ioFixture({ importerCount: () => 0 }));

		assert.equal(result.failures.length, 1);
		assert.match(result.failures[0], /not imported/);
	});

	it("fails a claim whose evidence names a language keyword instead of a symbol", () => {
		// `symbols: ["export"]` matches any TypeScript file and proves nothing.
		const weak = claimFixture({ evidence: [{ file: "src/a.ts", symbols: ["export"] }] });
		const result = evaluateFeatureClaims([weak], ioFixture());

		assert.equal(result.failures.length, 1);
		assert.match(result.failures[0], /placeholder/);
	});

	it("treats every placeholder token as too generic to be evidence", () => {
		for (const symbol of PLACEHOLDER_SYMBOLS) {
			const weak = claimFixture({ evidence: [{ file: "src/a.ts", symbols: [symbol] }] });
			const io = ioFixture({ readSource: readerFor({ "src/a.ts": `export function doThing() {} // ${symbol}` }) });

			assert.equal(evaluateFeatureClaims([weak], io).failures.length, 1, symbol);
		}
	});

	it("reports missing companion documentation", () => {
		const withDocs = claimFixture({ docs: "docs/missing.md" });
		const io = ioFixture({
			readSource: readerFor({ "src/a.ts": "export function doThing() {}" }),
		});

		const result = evaluateFeatureClaims([withDocs], io);

		assert.equal(result.failures.length, 1);
		assert.match(result.failures[0], /documentation/);
	});

	it("reports every independent failure rather than the first", () => {
		const broken = claimFixture({ evidence: [{ file: "src/a.ts", symbols: ["missingSymbol"] }] });
		const result = evaluateFeatureClaims([broken], ioFixture({ importerCount: () => 0 }));

		assert.equal(result.failures.length, 2);
	});
});

describe("repository state", () => {
	it("backs every README claim with reachable, symbol-bearing evidence", () => {
		const { failures } = runFeatureClaimsCheck();

		assert.deepEqual(failures, []);
	});

	it("names a real symbol for every declared claim", () => {
		for (const claim of CLAIMS) {
			for (const evidence of claim.evidence) {
				for (const symbol of evidence.symbols) {
					assert.ok(!PLACEHOLDER_SYMBOLS.has(symbol), `${claim.claim} leans on placeholder "${symbol}"`);
				}
			}
		}
	});
});

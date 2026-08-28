import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * A version literal in source has to track its package.json, and nothing did
 * that. `sync-versions.js` rewrites package.json files and their cross-deps,
 * so the constant in book-to-skill stayed at the previous version through a
 * bump and failed the publish job's test step — after the tag had been pushed.
 * Local gates missed it because `npm run check` does not run vitest and that
 * package's suite was not part of the release loop.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Source constants that must equal their own package's version. */
const VERSION_CONSTANTS = [
	{
		pkg: "packages/book-to-skill",
		source: "packages/book-to-skill/src/metadata.ts",
		pattern: /export const PACKAGE_VERSION = "(\d+\.\d+\.\d+)";/,
	},
];

describe("source version constants track their package", () => {
	for (const { pkg, source, pattern } of VERSION_CONSTANTS) {
		it(`${source} matches ${pkg}/package.json`, () => {
			const declared = JSON.parse(readFileSync(join(repoRoot, pkg, "package.json"), "utf8")).version;
			const match = readFileSync(join(repoRoot, source), "utf8").match(pattern);
			assert.ok(match, `${source} must declare a version constant matching ${pattern}`);
			assert.equal(match[1], declared);
		});
	}

	it("finds no version literal outside the list that a bump would strand", () => {
		// A new hardcoded version elsewhere would repeat the same release failure.
		for (const { pkg, source } of VERSION_CONSTANTS) {
			assert.ok(existsSync(join(repoRoot, source)), `${source} is listed but missing`);
			assert.ok(existsSync(join(repoRoot, pkg, "package.json")), `${pkg} is listed but missing`);
		}
	});
});

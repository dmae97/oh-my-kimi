// Direct Node smoke for the pure read/search seams: the `./pure/read` and
// `./pure/search` package exports must load under plain `node` (type-stripped
// erasable syntax, zero runtime imports) and behave identically to Bun.
// Run: node test/pure/node-import.mjs
import { strict as assert } from "node:assert";
import { planRead, presentRead } from "@oh-my-pi/pi-coding-agent/pure/read";
import { planSearch, presentSearch } from "@oh-my-pi/pi-coding-agent/pure/search";

const readPlanResult = planRead({ path: "src/a.ts", offset: 2, limit: 2 });
assert.equal(readPlanResult.ok, true);
const readResult = presentRead(readPlanResult.plan, {
	text: "alpha\nbravo\ncharlie\ndelta\n",
	sourceDigest: "d0",
	lineDigests: [{ line: 3, digest: "h3" }],
});
assert.equal(readResult.ok, true);
assert.equal(readResult.presentation.text, "[src/a.ts#sha256:d0]\n2|bravo\n3@sha256:h3|charlie\n[+1 more lines]");
assert.deepEqual(readResult.presentation.lines, [
	{ line: 2, text: "bravo" },
	{ line: 3, text: "charlie", expectedLineHash: "h3" },
]);
assert.deepEqual(readResult.presentation.window, { startLine: 2, endLine: 3, totalLines: 4, truncated: true });
assert.equal(Object.isFrozen(readResult), true);
assert.equal(Object.isFrozen(readResult.presentation.window), true);
assert.equal(planRead(null).ok, false);
const readConflict = presentRead(readPlanResult.plan, {
	text: "alpha",
	lineDigests: [
		{ line: 1, digest: "a" },
		{ line: 1, digest: "b" },
	],
});
assert.equal(readConflict.ok, false);
assert.deepEqual(readConflict.conflicts, [{ line: 1, digests: ["a", "b"] }]);

const searchPlanResult = planSearch({ pattern: "b" });
assert.equal(searchPlanResult.ok, true);
assert.deepEqual(searchPlanResult.plan, {
	pattern: "b",
	path: ".",
	ignoreCase: false,
	literal: false,
	context: 0,
	limit: 100,
});
assert.equal(planSearch({ pattern: "(" }).ok, false);
assert.equal(planSearch({ pattern: "(", literal: true }).ok, true);
const searchResult = presentSearch(
	searchPlanResult.plan,
	[
		{ file: "b.ts", line: 2, column: 1, text: "bb" },
		{ file: "a.ts", line: 1, text: "ab", expectedLineHash: "h1" },
	],
	[{ path: "a.ts", digest: "da" }],
);
assert.equal(searchResult.ok, true);
assert.equal(searchResult.presentation.text, "[a.ts#sha256:da]\n1@sha256:h1|ab\n\nb.ts\n2|bb");
assert.deepEqual(searchResult.presentation.groups[1].matches, [{ line: 2, column: 1, text: "bb" }]);
assert.equal(searchResult.presentation.totalMatches, 2);
assert.equal(searchResult.presentation.truncated, false);
assert.equal(Object.isFrozen(searchResult.presentation.groups), true);
const searchConflict = presentSearch(searchPlanResult.plan, [], [
	{ path: "a.ts", digest: "d1" },
	{ path: "a.ts", digest: "d2" },
]);
assert.equal(searchConflict.ok, false);
assert.deepEqual(searchConflict.conflicts, [{ kind: "source_digest", path: "a.ts", digests: ["d1", "d2"] }]);

process.stdout.write("pure seams node import ok\n");

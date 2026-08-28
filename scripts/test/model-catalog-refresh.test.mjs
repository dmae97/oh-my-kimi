import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The catalog generators fetch live provider endpoints. Every provider pass used
 * to catch its own error and return an empty result, so a timeout, rate limit,
 * or transient 5xx deleted that provider from the catalog while the script still
 * exited 0 and overwrote the committed file. The resulting diff is
 * indistinguishable from upstream retiring models, which makes the refresh
 * unreviewable — a reviewer sees deletions and cannot tell cause from accident.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const modelsGenerator = readFileSync(join(root, "packages/ai/scripts/generate-models.ts"), "utf8");
const imageGenerator = readFileSync(join(root, "packages/ai/scripts/generate-image-models.ts"), "utf8");

describe("model catalog generators fail loudly on a short read", () => {
	it("routes every swallowed fetch error through the failure recorder", () => {
		// The defect is a catch that logs and then returns an *empty* result. A
		// catch returning a curated constant is a real fallback, so match the
		// pairing rather than the log line: Zyloo legitimately keeps its own
		// message because it falls back to ZYLOO_STATIC_MODELS.
		assert.doesNotMatch(
			modelsGenerator,
			/console\.error\("Failed to (?:fetch|load)[^"]*",\s*error\);\s*\n\s*return (?:new Map\(\)|\[\]);/,
		);
		for (const source of ["NVIDIA NIM", "OpenRouter", "Vercel AI Gateway", "models.dev"]) {
			assert.match(
				modelsGenerator,
				new RegExp(`recordFetchFailure\\("${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
				`${source} must report its failure instead of returning empty`,
			);
		}
	});

	it("checks upstream completeness before overwriting the committed catalog", () => {
		const guardIndex = modelsGenerator.indexOf("assertUpstreamComplete(");
		const writeIndex = modelsGenerator.indexOf('writeFileSync(join(packageRoot, "src/models.generated.ts")');
		assert.ok(guardIndex > 0, "generator must assert upstream completeness");
		assert.ok(writeIndex > 0, "generator must write the catalog");
		assert.ok(guardIndex < writeIndex, "the completeness check must run before the write");
	});

	it("keeps a deliberate override for a loss that is real", () => {
		assert.match(modelsGenerator, /--allow-partial/);
	});

	it("does not write an empty image catalog", () => {
		assert.doesNotMatch(imageGenerator, /console\.error\("Failed to fetch[^"]*",\s*error\);\s*\n\s*return \[\];/);
		assert.match(imageGenerator, /models\.length === 0/);
		assert.match(imageGenerator, /throw new Error/);
	});

	it("preserves the static fallback that is a known-good list, not an empty one", () => {
		// Zyloo degrades to a curated constant rather than nothing, which is a
		// legitimate fallback and must not be swept up by the fail-loud change.
		assert.match(modelsGenerator, /return ZYLOO_STATIC_MODELS;/);
	});
});

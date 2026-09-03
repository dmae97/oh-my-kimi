import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(process.cwd(), "..", "..");
const rootScripts = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).scripts as Record<
	string,
	string
>;
const ciWorkflow = readFileSync(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");

/**
 * A verification command that edits the tree cannot fail on the dirt it just
 * removed. `npm run check` is the gate CI and contributors trust, so formatting
 * lives in its own command and CI asserts the tree is still clean afterwards.
 */
describe("repository verification commands", () => {
	it("keeps npm run check non-mutating", () => {
		expect(rootScripts.check).toBeDefined();
		expect(rootScripts.check).not.toContain("--write");
		expect(rootScripts.check).not.toContain("--update");
	});

	it("exposes formatting as its own command", () => {
		expect(rootScripts.format).toContain("biome check --write");
	});

	it("still fails on unformatted source instead of fixing it", () => {
		expect(rootScripts.check).toContain("biome check --error-on-warnings");
	});

	it("fails CI when a check leaves the tree dirty", () => {
		expect(ciWorkflow).toContain("git diff --exit-code");
	});
});

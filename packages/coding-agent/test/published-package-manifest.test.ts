import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifestText = readFileSync(new URL("../package.json", import.meta.url), "utf8");

describe("published package manifest", () => {
	it("does not invoke development-only lifecycle scripts in consumer installs", () => {
		expect(manifestText).not.toMatch(/"(?:preinstall|install|postinstall|prepare)"\s*:/u);
	});
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../src/metadata.ts";

interface PackageJson {
	version: string;
}

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageJson;

describe("compiler metadata", () => {
	it("matches the package version", () => {
		expect(PACKAGE_VERSION).toBe(packageJson.version);
	});
});

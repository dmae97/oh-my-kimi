import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isExplicitExtensionDiagnostic, resolveCliPaths } from "../src/main.ts";

function fixture(): string {
	return mkdtempSync(join(tmpdir(), "omk-cli-resource-paths-"));
}

describe("resolveCliPaths", () => {
	it("resolves local paths and preserves package sources", () => {
		const cwd = fixture();
		expect(resolveCliPaths(cwd, ["./extension.ts", "npm:example"])).toEqual([
			join(cwd, "extension.ts"),
			"npm:example",
		]);
	});
});

describe("isExplicitExtensionDiagnostic", () => {
	it("matches direct files and fails closed on unmatched errors when an explicit source exists", () => {
		const cwd = fixture();
		const direct = join(cwd, "direct.ts");
		const other = join(cwd, "other.ts");
		writeFileSync(direct, "export default {}", "utf8");
		expect(isExplicitExtensionDiagnostic(direct, [direct])).toBe(true);
		expect(isExplicitExtensionDiagnostic(other, [direct])).toBe(true);
		expect(isExplicitExtensionDiagnostic(other, undefined)).toBe(false);
	});

	it("matches resolved entry points beneath explicit directories and manifests", () => {
		const cwd = fixture();
		const packageDir = join(cwd, "extension-package");
		const entry = join(packageDir, "src", "index.ts");
		mkdirSync(join(packageDir, "src"), { recursive: true });
		writeFileSync(join(packageDir, "package.json"), "{}", "utf8");
		writeFileSync(entry, "export default {}", "utf8");

		expect(isExplicitExtensionDiagnostic(entry, [packageDir])).toBe(true);
		expect(isExplicitExtensionDiagnostic(entry, [join(packageDir, "package.json")])).toBe(true);
	});

	it("fails closed for inline and non-local explicit sources", () => {
		expect(isExplicitExtensionDiagnostic("<inline:1>", undefined)).toBe(true);
		expect(isExplicitExtensionDiagnostic("/cache/example/index.js", ["npm:example"])).toBe(true);
		expect(isExplicitExtensionDiagnostic("/cache/example/index.js", undefined)).toBe(false);
	});

	it("keeps a symlinked explicit package entry fatal", () => {
		if (process.platform === "win32") return;
		const cwd = fixture();
		const packageDir = join(cwd, "package");
		const outside = join(fixture(), "outside.ts");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(outside, "throw new Error('broken')", "utf8");
		symlinkSync(outside, join(packageDir, "index.ts"));

		expect(isExplicitExtensionDiagnostic(outside, [packageDir])).toBe(true);
	});
});

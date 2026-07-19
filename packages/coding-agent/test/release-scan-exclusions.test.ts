import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts");
const pinnedDepsScript = join(scriptsRoot, "check-pinned-deps.mjs");
const tsImportsScript = join(scriptsRoot, "check-ts-relative-imports.mjs");
const fixtureRoots = new Set<string>();

afterEach(() => {
	let teardownError: unknown;

	for (const root of fixtureRoots) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch (error) {
			teardownError ??= error;
		}
	}

	fixtureRoots.clear();

	if (teardownError) throw teardownError;
});

describe("check-pinned-deps root scratch exclusion", () => {
	it("excludes only the exact root ~ scratch directory", () => {
		const root = createFixture();
		writePackageJson(join(root, "~", "package.json"), { dependencies: { thirdParty: "^1.0.0" } });

		expectScannerSuccess(pinnedDepsScript, root);
	});

	it("rejects unpinned dependencies in a nested ~ directory", () => {
		const root = createFixture();
		const packageJsonPath = join(root, "workspace", "~", "package.json");
		writePackageJson(packageJsonPath, { dependencies: { thirdParty: "^1.0.0" } });

		expectPinnedDepsFailure(root, packageJsonPath);
	});

	it("rejects unpinned dependencies in an ordinary included directory", () => {
		const root = createFixture();
		const packageJsonPath = join(root, "workspace", "included", "package.json");
		writePackageJson(packageJsonPath, { dependencies: { thirdParty: "^1.0.0" } });

		expectPinnedDepsFailure(root, packageJsonPath);
	});
});

describe("check-ts-relative-imports root scratch exclusion", () => {
	it("excludes only the exact root ~ scratch directory", () => {
		const root = createFixture();
		writeTypescript(join(root, "~", "ignored.ts"));

		expectScannerSuccess(tsImportsScript, root);
	});

	it("rejects relative JavaScript imports in a nested ~ directory", () => {
		const root = createFixture();
		writeTypescript(join(root, "workspace", "~", "bad.ts"));

		expectTypescriptFailure(root);
	});

	it("rejects relative JavaScript imports in an ordinary included directory", () => {
		const root = createFixture();
		writeTypescript(join(root, "workspace", "included", "bad.ts"));

		expectTypescriptFailure(root);
	});
});

function createFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "omk-release-scan-"));
	fixtureRoots.add(root);
	writePackageJson(join(root, "package.json"), { dependencies: { pinned: "1.0.0" } });
	return root;
}

function writePackageJson(path: string, contents: object): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(contents)}\n`);
}

function writeTypescript(path: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, 'import "./dependency.js";\n');
}

function runScanner(script: string, root: string) {
	return spawnSync(process.execPath, [script, root], { encoding: "utf8" });
}

function expectScannerSuccess(script: string, root: string): void {
	const result = runScanner(script, root);

	expect(result.error).toBeUndefined();
	expect(result.status).toBe(0);
}

function expectPinnedDepsFailure(root: string, packageJsonPath: string): void {
	const result = runScanner(pinnedDepsScript, root);
	const output = result.stderr + result.stdout;

	expect(result.error).toBeUndefined();
	expect(result.status).toBe(1);
	expect(output).toContain("Direct external dependencies must use exact versions:");
	expect(output).toContain(packageJsonPath);
	expect(output).toContain("dependencies.thirdParty must be pinned, found ^1.0.0");
}

function expectTypescriptFailure(root: string): void {
	const result = runScanner(tsImportsScript, root);
	const output = result.stderr + result.stdout;

	expect(result.error).toBeUndefined();
	expect(result.status).toBe(1);
	expect(output).toContain("Relative .js imports are not allowed in non-declaration .ts files:");
	expect(output).toContain("bad.ts");
	expect(output).toContain("./dependency.js");
}

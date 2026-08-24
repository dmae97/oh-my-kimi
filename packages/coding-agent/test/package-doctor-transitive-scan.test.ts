import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPackageCompatibility } from "../src/core/package-doctor.ts";
import { scanPackageExtensionSources } from "../src/core/package-doctor-source-scan.ts";

/**
 * The doctor answers "can OMK run this package". Scanning only the manifest's
 * entry file made that answer wrong for any package that keeps its handlers in
 * imported modules — the real shape of every non-trivial extension.
 */

const roots: string[] = [];

function fixture(name: string): string {
	const root = mkdtempSync(join(tmpdir(), `omk-doctor-transitive-${name}-`));
	roots.push(root);
	return root;
}

function write(root: string, relativePath: string, text: string): string {
	const absolute = join(root, relativePath);
	mkdirSync(join(absolute, ".."), { recursive: true });
	writeFileSync(absolute, text);
	return absolute;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("package doctor transitive source scan", () => {
	it("follows relative imports out of the entry file", () => {
		const root = fixture("basic");
		const entry = write(root, "index.ts", 'import { install } from "./lib/lifecycle.ts";\nexport default install;\n');
		write(root, "lib/lifecycle.ts", 'export const install = (pi) => pi.on("agent_end", () => {});\n');

		const { sources } = scanPackageExtensionSources(root, [entry]);
		expect(sources.map((source) => source.file).sort()).toEqual(["index.ts", "lib/lifecycle.ts"]);
	});

	it("resolves extensionless and index specifiers", () => {
		const root = fixture("resolve");
		const entry = write(root, "index.ts", 'import "./a";\nimport "./nested";\nimport "./b.js";\n');
		write(root, "a.ts", "export const a = 1;\n");
		write(root, "nested/index.ts", "export const n = 1;\n");
		write(root, "b.ts", "export const b = 1;\n");

		const { sources } = scanPackageExtensionSources(root, [entry]);
		expect(sources.map((source) => source.file).sort()).toEqual(["a.ts", "b.ts", "index.ts", "nested/index.ts"]);
	});

	it("ignores bare package specifiers", () => {
		const root = fixture("bare");
		const entry = write(root, "index.ts", 'import "node:fs";\nimport "some-package";\nimport "./local.ts";\n');
		write(root, "local.ts", "export const local = 1;\n");

		const { sources } = scanPackageExtensionSources(root, [entry]);
		expect(sources.map((source) => source.file).sort()).toEqual(["index.ts", "local.ts"]);
	});

	it("never escapes the package root", () => {
		const root = fixture("escape");
		const outside = mkdtempSync(join(tmpdir(), "omk-doctor-outside-"));
		roots.push(outside);
		writeFileSync(join(outside, "secret.ts"), 'export const leaked = "nope";\n');
		const entry = write(root, "index.ts", `import "../${join(outside, "secret.ts")}";\nimport "../../etc/passwd";\n`);

		const { sources } = scanPackageExtensionSources(root, [entry]);
		expect(sources.map((source) => source.file)).toEqual(["index.ts"]);
	});

	it("does not follow a symlink that points outside the package", () => {
		const root = fixture("symlink");
		const outside = mkdtempSync(join(tmpdir(), "omk-doctor-symlink-target-"));
		roots.push(outside);
		writeFileSync(join(outside, "evil.ts"), 'export const evil = "nope";\n');
		const entry = write(root, "index.ts", 'import "./linked.ts";\n');
		symlinkSync(join(outside, "evil.ts"), join(root, "linked.ts"));

		const { sources } = scanPackageExtensionSources(root, [entry]);
		expect(sources.map((source) => source.file)).toEqual(["index.ts"]);
	});

	it("terminates on an import cycle", () => {
		const root = fixture("cycle");
		const entry = write(root, "index.ts", 'import "./a.ts";\n');
		write(root, "a.ts", 'import "./b.ts";\n');
		write(root, "b.ts", 'import "./a.ts";\nimport "./index.ts";\n');

		const { sources } = scanPackageExtensionSources(root, [entry]);
		expect(sources.map((source) => source.file).sort()).toEqual(["a.ts", "b.ts", "index.ts"]);
	});

	it("reports an unsupported lifecycle event reached only through an import", () => {
		const root = fixture("lifecycle");
		write(root, "index.ts", 'import "./lib/lifecycle.ts";\n');
		// A host-specific event OMK does not emit; entry-only scanning missed these.
		write(root, "lib/lifecycle.ts", 'pi.on("terminal_attach", () => {});\n');

		const report = inspectPackageCompatibility({
			packageRoot: root,
			resources: { extensions: [join(root, "index.ts")], prompts: [], skills: [], themes: [] },
			source: "npm:fixture",
		});

		const lifecycle = report.checks.find((check) => check.id === "lifecycle-events");
		expect(lifecycle?.status).not.toBe("pass");
		expect(lifecycle?.message).toContain("terminal_attach");
		expect(report.compatible).toBe(false);
	});
});

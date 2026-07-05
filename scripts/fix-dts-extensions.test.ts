import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fixDtsExtensions, fixDtsFile, resolveDtsSpecifier } from "./fix-dts-extensions";

// Each test builds a real `dist/types`-shaped tree under a fresh temp dir, runs
// the transform, and reads the bytes the code wrote back off disk. We assert on
// the rewritten content / return counts (the observable contract), never on the
// source text of the helper.
const tempDirs: string[] = [];

async function makeTree(files: Record<string, string>): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "fix-dts-"));
	tempDirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(root, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content);
	}
	return root;
}

function read(...segments: string[]): Promise<string> {
	return fs.readFile(path.join(...segments), "utf8");
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("resolveDtsSpecifier", () => {
	it("returns null for bare, scoped, node:, and already-suffixed specifiers", async () => {
		const root = await makeTree({ "placeholder.d.ts": "export {};\n" });
		for (const spec of ["@oh-my-pi/pi-tui", "zod/v4", "node:fs", "./x.js", "./data.json", "./m.mjs", "./c.cjs"]) {
			expect(await resolveDtsSpecifier(root, spec)).toBeNull();
		}
	});

	it("maps a .d.ts specifier to .js without consulting the filesystem", async () => {
		// No `foo.d.ts` planted: the .d.ts → .js mapping is a pure rewrite.
		const root = await makeTree({ "placeholder.d.ts": "export {};\n" });
		expect(await resolveDtsSpecifier(root, "./foo.d.ts")).toBe("./foo.js");
	});

	it("resolves relative to the given fromDir, not the tree root", async () => {
		const root = await makeTree({
			"sibling.d.ts": "export declare const s: number;\n",
			"sub/index.d.ts": "export {};\n",
		});
		// From the subdir, `../sibling` reaches root/sibling.d.ts.
		expect(await resolveDtsSpecifier(path.join(root, "sub"), "../sibling")).toBe("../sibling.js");
		// From root, `./sibling` also reaches it (control: sibling resolution works).
		expect(await resolveDtsSpecifier(root, "./sibling")).toBe("./sibling.js");
	});
});

describe("fixDtsFile", () => {
	it("appends .js to a sibling declaration re-export and returns count 1", async () => {
		const root = await makeTree({
			"sdk.d.ts": "export declare const sdk: number;\n",
			"index.d.ts": 'export * from "./sdk";\n',
		});
		const count = await fixDtsFile(path.join(root, "index.d.ts"));
		expect(count).toBe(1);
		expect(await read(root, "index.d.ts")).toBe('export * from "./sdk.js";\n');
	});

	it("resolves a directory barrel to its index.js", async () => {
		const root = await makeTree({
			"modes/index.d.ts": "export declare const X: string;\n",
			"index.d.ts": 'import { X } from "./modes";\nexport { X };\n',
		});
		const count = await fixDtsFile(path.join(root, "index.d.ts"));
		expect(count).toBe(1);
		expect(await read(root, "index.d.ts")).toBe('import { X } from "./modes/index.js";\nexport { X };\n');
	});

	it("rewrites `export type * from` and `export type { A } from` like value exports", async () => {
		const root = await makeTree({
			"sdk.d.ts": "export type A = number;\n",
			"star.d.ts": 'export type * from "./sdk";\n',
			"named.d.ts": 'export type { A } from "./sdk";\n',
		});
		expect(await fixDtsFile(path.join(root, "star.d.ts"))).toBe(1);
		expect(await fixDtsFile(path.join(root, "named.d.ts"))).toBe(1);
		expect(await read(root, "star.d.ts")).toBe('export type * from "./sdk.js";\n');
		expect(await read(root, "named.d.ts")).toBe('export type { A } from "./sdk.js";\n');
	});

	it("rewrites inline import type references", async () => {
		const inlineImport = "import" + '("./types")';
		const inlineExpected = "import" + '("./types.js")';
		const root = await makeTree({
			"types.d.ts": "export type Thing = number;\n",
			"index.d.ts": `export declare const typed: ${inlineImport}.Thing;\n`,
		});
		const count = await fixDtsFile(path.join(root, "index.d.ts"));
		expect(count).toBe(1);
		expect(await read(root, "index.d.ts")).toBe(`export declare const typed: ${inlineExpected}.Thing;\n`);
	});

	it("rewrites relative declare module specifiers", async () => {
		const root = await makeTree({
			"types.d.ts": "export interface Custom {}\n",
			"augment.d.ts": 'declare module "./types" {\n\tinterface CustomMessages {}\n}\n',
		});
		const count = await fixDtsFile(path.join(root, "augment.d.ts"));
		expect(count).toBe(1);
		expect(await read(root, "augment.d.ts")).toBe(
			'declare module "./types.js" {\n\tinterface CustomMessages {}\n}\n',
		);
	});

	it("leaves a file of bare and already-suffixed specifiers byte-for-byte unchanged", async () => {
		const source =
			'export * from "@oh-my-pi/pi-tui";\n' +
			'import { z } from "zod/v4";\n' +
			'import * as nodefs from "node:fs";\n' +
			'export * from "./x.js";\n' +
			'import data from "./data.json";\n';
		const root = await makeTree({ "index.d.ts": source });
		const count = await fixDtsFile(path.join(root, "index.d.ts"));
		expect(count).toBe(0);
		expect(await read(root, "index.d.ts")).toBe(source);
	});

	it("resolves `../sibling` against the importing file's dir at depth", async () => {
		const root = await makeTree({
			"sibling.d.ts": "export declare const s: number;\n",
			"sub/index.d.ts": 'export * from "../sibling";\n',
		});
		const count = await fixDtsFile(path.join(root, "sub", "index.d.ts"));
		expect(count).toBe(1);
		expect(await read(root, "sub", "index.d.ts")).toBe('export * from "../sibling.js";\n');
	});

	it("is idempotent — a second pass returns 0 and never doubles the extension", async () => {
		const root = await makeTree({
			"sdk.d.ts": "export declare const sdk: number;\n",
			"index.d.ts": 'export * from "./sdk";\n',
		});
		const file = path.join(root, "index.d.ts");
		expect(await fixDtsFile(file)).toBe(1);
		const afterFirst = await read(root, "index.d.ts");
		expect(await fixDtsFile(file)).toBe(0);
		expect(await read(root, "index.d.ts")).toBe(afterFirst);
		expect(afterFirst).toBe('export * from "./sdk.js";\n');
		expect(afterFirst).not.toContain(".js.js");
	});

	it("leaves an unresolvable relative specifier unchanged and returns 0", async () => {
		const source = 'export * from "./does-not-exist";\n';
		const root = await makeTree({ "index.d.ts": source });
		expect(await resolveDtsSpecifier(root, "./does-not-exist")).toBeNull();
		expect(await fixDtsFile(path.join(root, "index.d.ts"))).toBe(0);
		expect(await read(root, "index.d.ts")).toBe(source);
	});

	it("counts only resolvable specifiers, excluding an unresolvable one in the same file", async () => {
		const root = await makeTree({
			"sdk.d.ts": "export declare const sdk: number;\n",
			"index.d.ts": 'export * from "./sdk";\nexport * from "./ghost";\n',
		});
		const count = await fixDtsFile(path.join(root, "index.d.ts"));
		expect(count).toBe(1);
		expect(await read(root, "index.d.ts")).toBe('export * from "./sdk.js";\nexport * from "./ghost";\n');
	});
});

describe("fixDtsExtensions", () => {
	it("recursively fixes every .d.ts and totals files + specifiers", async () => {
		const root = await makeTree({
			// 2 resolvable specifiers: ./sdk (sibling) + ./modes (barrel).
			"index.d.ts": 'export * from "./sdk";\nexport { M } from "./modes";\n',
			// 0 specifiers.
			"sdk.d.ts": "export declare const sdk: number;\n",
			// 1 resolvable specifier: ./config (sibling within modes/).
			"modes/index.d.ts": 'export * from "./config";\nexport declare const M: string;\n',
			// 0 specifiers.
			"modes/config.d.ts": "export declare const config: boolean;\n",
		});
		const totals = await fixDtsExtensions(root);
		expect(totals).toEqual({ files: 2, specifiers: 3 });
		expect(await read(root, "index.d.ts")).toBe('export * from "./sdk.js";\nexport { M } from "./modes/index.js";\n');
		expect(await read(root, "modes/index.d.ts")).toBe(
			'export * from "./config.js";\nexport declare const M: string;\n',
		);
	});

	it("integration: leaves the root barrel fully .js-suffixed with no bare forms remaining", async () => {
		const root = await makeTree({
			"index.d.ts": 'export * from "./sdk";\nexport { M } from "./modes";\n',
			"sdk.d.ts": "export declare const sdk: number;\n",
			"modes/index.d.ts": "export declare const M: string;\n",
		});
		await fixDtsExtensions(root);
		const barrel = await read(root, "index.d.ts");
		expect(barrel).toContain('from "./sdk.js"');
		expect(barrel).toContain('from "./modes/index.js"');
		// The trailing quote disambiguates: `from "./sdk"` is not a substring of
		// `from "./sdk.js"`, so this proves no bare specifier survived.
		expect(barrel).not.toContain('from "./sdk"');
		expect(barrel).not.toContain('from "./modes"');
	});
});

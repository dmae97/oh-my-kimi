import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
	__resetLegacyPiResolutionCache,
	installLegacyPiSpecifierShim,
	loadLegacyPiModule,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { Type as TypeBoxShimType } from "@oh-my-pi/pi-coding-agent/extensibility/typebox";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// pi-ai 15.1.0 removed the runtime `Type` export from `@oh-my-pi/pi-ai`'s
// package root. Legacy extensions (and their aliased-scope variants such as
// `@earendil-works/pi-ai`) still author parameter schemas as
// `import { Type } from "@earendil-works/pi-ai"` and then `Type.Object(...)`.
// `legacy-pi-compat.ts` patches that gap by redirecting bare pi-ai root
// imports through `legacy-pi-ai-shim.ts`, which re-exports the canonical
// pi-ai surface plus the Zod-backed `Type` runtime from the same TypeBox shim
// `@sinclair/typebox` is served from.
installLegacyPiSpecifierShim();

const tempRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	for (const dir of tempRoots) {
		await removeWithRetries(dir);
	}
});

async function writeFixtureExtension(source: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pi-ai-type-remap-"));
	tempRoots.push(dir);
	const entry = path.join(dir, "index.ts");
	await fs.writeFile(entry, source, "utf8");
	return entry;
}

describe("legacy-pi @(scope)/pi-ai root `Type` remap (issue #1437)", () => {
	it('redirects `import { Type } from "@earendil-works/pi-ai"` to the TypeBox shim', async () => {
		const entry = await writeFixtureExtension(
			[
				'import { Type } from "@earendil-works/pi-ai";',
				"export const probe = Type;",
				"export const schema = Type.Object({ name: Type.String() }, { additionalProperties: false });",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			probe: typeof TypeBoxShimType;
			schema: { safeParse: (input: unknown) => { success: boolean } };
		};

		expect(loaded.probe).toBe(TypeBoxShimType);
		expect(loaded.schema.safeParse({ name: "ok" }).success).toBe(true);
		expect(loaded.schema.safeParse({}).success).toBe(false);
		expect(loaded.schema.safeParse({ name: "ok", extra: 1 }).success).toBe(false);
	});

	it('redirects `import { Type } from "@oh-my-pi/pi-ai"` for plugins published against the canonical scope', async () => {
		const entry = await writeFixtureExtension(
			['import { Type } from "@oh-my-pi/pi-ai";', "export const probe = Type;"].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as { probe: typeof TypeBoxShimType };
		expect(loaded.probe).toBe(TypeBoxShimType);
	});

	it("preserves canonical pi-ai exports alongside the shimmed Type (z is still re-exported)", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { Type, z } from "@earendil-works/pi-ai";',
				"export const obj = Type.Object({ name: Type.String() });",
				"export const zodObj = z.object({ name: z.string() });",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			obj: { safeParse: (input: unknown) => { success: boolean } };
			zodObj: { safeParse: (input: unknown) => { success: boolean } };
		};

		expect(loaded.obj.safeParse({ name: "ok" }).success).toBe(true);
		expect(loaded.zodObj.safeParse({ name: "ok" }).success).toBe(true);
		expect(loaded.zodObj.safeParse({}).success).toBe(false);
	});

	it("does not redirect subpath imports such as @oh-my-pi/pi-ai/utils/schema", async () => {
		const entry = await writeFixtureExtension(
			[
				// `zodToWireSchema` is only exported from the subpath, not the root,
				// so a successful import proves the subpath still resolves directly
				// against the bundled pi-ai package rather than the shim.
				'import { zodToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";',
				"export const fn = zodToWireSchema;",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as { fn: unknown };
		expect(typeof loaded.fn).toBe("function");
	});

	it("exports getModel as getBundledModel", async () => {
		const loaded = (await loadLegacyPiModule(
			await writeFixtureExtension(
				'import { getModel } from "@oh-my-pi/pi-ai"; export const testGetModel = getModel;',
			),
		)) as { testGetModel: unknown };
		expect(loaded.testGetModel).toBe(getBundledModel);
	});

	it("exports getModels as getBundledModels", async () => {
		const loaded = (await loadLegacyPiModule(
			await writeFixtureExtension(
				'import { getModels } from "@oh-my-pi/pi-ai"; export const testGetModels = getModels;',
			),
		)) as { testGetModels: unknown };
		expect(loaded.testGetModels).toBe(getBundledModels);
	});

	it("exports StringEnum as a schema builder with options support", async () => {
		const loaded = (await loadLegacyPiModule(
			await writeFixtureExtension(
				[
					'import { StringEnum } from "@oh-my-pi/pi-ai";',
					'export const schema = StringEnum(["red", "green"] as const, { description: "primary colors" });',
				].join("\n"),
			),
		)) as { schema: { safeParse: (input: unknown) => { success: boolean }; toJSON?: () => any } };

		expect(loaded.schema.safeParse("red").success).toBe(true);
		expect(loaded.schema.safeParse("blue").success).toBe(false);
		expect(loaded.schema.toJSON?.()?.description).toBe("primary colors");
	});
});

describe("legacy pi package root remaps (issue #1474)", () => {
	it("loads @earendil-works/pi-coding-agent root imports when host package resolution is unavailable", async () => {
		const realResolveSync = Bun.resolveSync.bind(Bun);
		vi.spyOn(Bun, "resolveSync").mockImplementation((specifier: string, from: string) => {
			if (specifier === "@oh-my-pi/pi-coding-agent" && from.endsWith(path.join("src", "extensibility", "plugins"))) {
				throw new Error("compiled binary host package resolution unavailable");
			}
			return realResolveSync(specifier, from);
		});
		const entry = await writeFixtureExtension(
			['import { VERSION } from "@earendil-works/pi-coding-agent";', "export const loadedVersion = VERSION;"].join(
				"\n",
			),
		);

		const loaded = (await loadLegacyPiModule(entry)) as { loadedVersion: string };
		expect(loaded.loadedVersion).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("preserves legacy defineTool root imports and usable coding tools", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-coding-tools-"));
		tempRoots.push(dir);
		await fs.writeFile(path.join(dir, "sample.txt"), "legacy read body", "utf8");
		const entry = path.join(dir, "index.ts");
		await fs.writeFile(
			entry,
			[
				'import { dirname } from "node:path";',
				'import { fileURLToPath } from "node:url";',
				'import { createCodingTools, defineTool, Type } from "@earendil-works/pi-coding-agent";',
				"const definition = {",
				'\tname: "legacy_define_tool",',
				'\tlabel: "Legacy Define Tool",',
				'\tdescription: "legacy helper probe",',
				"\tparameters: Type.Object({}),",
				'\texecute: async () => ({ content: [{ type: "text", text: "ok" }] }),',
				"};",
				"const cwd = dirname(fileURLToPath(import.meta.url));",
				"const codingTools = createCodingTools(cwd);",
				"const readTool = codingTools.find(tool => tool.name === 'read');",
				"export const tool = defineTool(definition);",
				"export const sameReference = tool === definition;",
				"export const codingToolNames = codingTools.map(tool => tool.name);",
				"export const readResult = await readTool?.execute('legacy-read', { path: 'sample.txt' });",
			].join("\n"),
			"utf8",
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			tool: { name: string; parameters: { safeParse: (input: unknown) => { success: boolean } } };
			sameReference: boolean;
			codingToolNames: string[];
			readResult: { content: Array<{ type: string; text?: string }> };
		};

		expect(loaded.sameReference).toBe(true);
		expect(loaded.tool.name).toBe("legacy_define_tool");
		expect(loaded.codingToolNames).toEqual(["read", "bash", "edit", "write"]);
		expect(loaded.readResult.content[0]?.text).toContain("legacy read body");
	});

	it("preserves legacy frontmatter helper root imports", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { parseFrontmatter, stripFrontmatter } from "@earendil-works/pi-coding-agent";',
				"const content = ['---', 'name: demo', '---', '# Body'].join('\\n');",
				"export const parsed = parseFrontmatter(content);",
				"export const stripped = stripFrontmatter(content);",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			parsed: { frontmatter: { name?: string }; body: string };
			stripped: string;
		};

		expect(loaded.parsed.frontmatter.name).toBe("demo");
		expect(loaded.parsed.body).toBe("# Body");
		expect(loaded.stripped).toBe("# Body");
	});

	it("falls back to legacy-scoped subpath peers for direct plugin imports", async () => {
		const realResolveSync = Bun.resolveSync.bind(Bun);
		vi.spyOn(Bun, "resolveSync").mockImplementation((specifier: string, from: string) => {
			if (specifier === "@oh-my-pi/pi-ai/oauth") {
				throw new Error(`canonical peer unavailable from ${from}`);
			}
			return realResolveSync(specifier, from);
		});

		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-direct-subpath-"));
		tempRoots.push(dir);
		const packageDir = path.join(dir, "node_modules", "@mariozechner", "pi-ai");
		await fs.mkdir(packageDir, { recursive: true });
		await fs.writeFile(
			path.join(packageDir, "package.json"),
			JSON.stringify({ type: "module", exports: { "./oauth": "./oauth.js" } }),
			"utf8",
		);
		await fs.writeFile(path.join(packageDir, "oauth.js"), 'export const marker = "legacy-oauth";', "utf8");
		const entry = path.join(dir, "index.ts");
		await fs.writeFile(
			entry,
			['import { marker } from "@mariozechner/pi-ai/oauth";', "export const loadedMarker = marker;"].join("\n"),
			"utf8",
		);

		const loaded = (await import(`${url.pathToFileURL(entry).href}?nonce=${Date.now()}`)) as {
			loadedMarker: string;
		};
		expect(loaded.loadedMarker).toBe("legacy-oauth");
	});

	it("routes @earendil-works/pi-utils through canonical Bun.resolveSync in non-compiled mode", async () => {
		// Regression: when omp runs from a node_modules install (not the monorepo
		// and not a compiled binary), the bundled packages live at
		// `node_modules/@oh-my-pi/pi-*`, not next to the source tree. Hardcoding
		// a sibling `packages/<pkg>/src/index.ts` path would miss them, so the
		// non-compiled branch must delegate to `Bun.resolveSync` against the
		// canonical specifier.
		// The resolver memoizes canonical lookups process-wide; clear it so this
		// assertion observes the Bun.resolveSync delegation rather than a warm
		// cache populated by an earlier test in the full suite.
		__resetLegacyPiResolutionCache();
		const realResolveSync = Bun.resolveSync.bind(Bun);
		let canonicalLookupSeen = false;
		vi.spyOn(Bun, "resolveSync").mockImplementation((specifier: string, from: string) => {
			if (specifier === "@oh-my-pi/pi-utils") {
				canonicalLookupSeen = true;
			}
			return realResolveSync(specifier, from);
		});
		const entry = await writeFixtureExtension(
			[
				'import { isCompiledBinary } from "@earendil-works/pi-utils";',
				"export const probe = isCompiledBinary;",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as { probe: () => boolean };
		expect(typeof loaded.probe).toBe("function");
		expect(canonicalLookupSeen).toBe(true);
	});
});

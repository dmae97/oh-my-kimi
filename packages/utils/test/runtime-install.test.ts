import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as Module from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import {
	installRuntimeModuleResolver,
	resolveRuntimeModule,
	splitBareSpecifier,
	writeRuntimeManifest,
} from "../src/runtime-install";

// Contract under test: runtime-installed packages (fastembed, Transformers.js
// graphs) load inside compiled binaries through resolveRuntimeModule, which
// must honor `exports` (CommonJS conditions), then `main` (including `.node`
// targets without an extension probe match), then `index.js` — the shapes the
// stock compiled-binary resolver gets wrong (Bun #1763).

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

interface ResolveFilenameModule {
	_resolveFilename(request: string, parent: unknown, isMain: boolean, options?: unknown): string;
}

async function makeNodeModules(packages: Record<string, { manifest: Record<string, unknown>; files: string[] }>) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-runtime-install-"));
	tempDirs.push(root);
	const nodeModules = path.join(root, "node_modules");
	for (const name in packages) {
		const pkg = packages[name];
		const pkgDir = path.join(nodeModules, ...name.split("/"));
		await Bun.write(path.join(pkgDir, "package.json"), JSON.stringify({ name, ...pkg.manifest }));
		for (const file of pkg.files) {
			await Bun.write(path.join(pkgDir, file), "");
		}
	}
	return nodeModules;
}

describe("splitBareSpecifier", () => {
	test("splits scoped and unscoped specifiers with subpaths", () => {
		expect(splitBareSpecifier("fastembed")).toEqual({ packageName: "fastembed", subpath: undefined });
		expect(splitBareSpecifier("tar/lib/extract")).toEqual({ packageName: "tar", subpath: "lib/extract" });
		expect(splitBareSpecifier("@anush008/tokenizers")).toEqual({
			packageName: "@anush008/tokenizers",
			subpath: undefined,
		});
		expect(splitBareSpecifier("@huggingface/transformers/types")).toEqual({
			packageName: "@huggingface/transformers",
			subpath: "types",
		});
	});
});

describe("resolveRuntimeModule", () => {
	test("resolves conditional exports preferring require over import", async () => {
		const nodeModules = await makeNodeModules({
			fastembed: {
				manifest: {
					exports: {
						".": {
							import: { default: "./lib/esm/index.js" },
							require: { default: "./lib/cjs/index.js" },
						},
					},
					main: "./lib/cjs/index.js",
				},
				files: ["lib/esm/index.js", "lib/cjs/index.js"],
			},
		});
		expect(resolveRuntimeModule(nodeModules, "fastembed")).toBe(
			path.join(nodeModules, "fastembed", "lib", "cjs", "index.js"),
		);
	});

	test("falls back to main pointing at a .node binding (napi-rs platform package)", async () => {
		const nodeModules = await makeNodeModules({
			"@anush008/tokenizers-darwin-arm64": {
				manifest: { main: "tokenizers.darwin-arm64.node" },
				files: ["tokenizers.darwin-arm64.node"],
			},
		});
		expect(resolveRuntimeModule(nodeModules, "@anush008/tokenizers-darwin-arm64")).toBe(
			path.join(nodeModules, "@anush008", "tokenizers-darwin-arm64", "tokenizers.darwin-arm64.node"),
		);
	});

	test("probes extensions and directory index for extensionless main", async () => {
		const nodeModules = await makeNodeModules({
			"onnxruntime-node": {
				manifest: { main: "dist/index" },
				files: ["dist/index.js"],
			},
			"onnxruntime-common": {
				manifest: { main: "dist" },
				files: ["dist/index.js"],
			},
		});
		expect(resolveRuntimeModule(nodeModules, "onnxruntime-node")).toBe(
			path.join(nodeModules, "onnxruntime-node", "dist", "index.js"),
		);
		expect(resolveRuntimeModule(nodeModules, "onnxruntime-common")).toBe(
			path.join(nodeModules, "onnxruntime-common", "dist", "index.js"),
		);
	});

	test("resolves subpath requests through the exports map and via plain joining", async () => {
		const nodeModules = await makeNodeModules({
			mapped: {
				manifest: { exports: { ".": "./index.js", "./util": { require: "./lib/util.cjs" } } },
				files: ["index.js", "lib/util.cjs"],
			},
			plain: {
				manifest: { main: "index.js" },
				files: ["index.js", "lib/helper.js"],
			},
		});
		expect(resolveRuntimeModule(nodeModules, "mapped/util")).toBe(
			path.join(nodeModules, "mapped", "lib", "util.cjs"),
		);
		expect(resolveRuntimeModule(nodeModules, "plain/lib/helper")).toBe(
			path.join(nodeModules, "plain", "lib", "helper.js"),
		);
	});

	test("returns null for absent packages and import-only exports", async () => {
		const nodeModules = await makeNodeModules({
			"esm-only": {
				manifest: { exports: { ".": { import: "./index.mjs" } } },
				files: ["index.mjs"],
			},
		});
		expect(resolveRuntimeModule(nodeModules, "missing-package")).toBeNull();
		expect(resolveRuntimeModule(nodeModules, "esm-only")).toBeNull();
	});

	test("falls back to index.js when manifest has no usable entry", async () => {
		const nodeModules = await makeNodeModules({
			bare: { manifest: {}, files: ["index.js"] },
		});
		expect(resolveRuntimeModule(nodeModules, "bare")).toBe(path.join(nodeModules, "bare", "index.js"));
	});
});

describe("installRuntimeModuleResolver", () => {
	test("keeps runtime-parent bare requests inside the runtime cache", async () => {
		const nodeModules = await makeNodeModules({
			"@huggingface/transformers": {
				manifest: { main: "dist/transformers.node.cjs" },
				files: ["dist/transformers.node.cjs"],
			},
			"kokoro-js": {
				manifest: { main: "dist/kokoro.cjs" },
				files: ["dist/kokoro.cjs"],
			},
		});
		const runtimeDir = path.dirname(nodeModules);
		const sharpStub = path.join(runtimeDir, "sharp-stub.cjs");
		await Bun.write(sharpStub, "module.exports = {};\n");

		installRuntimeModuleResolver({ runtimeNodeModules: nodeModules, stubs: { sharp: sharpStub } });

		const moduleWithResolver = Module as unknown as { default?: ResolveFilenameModule } & ResolveFilenameModule;
		const resolver = moduleWithResolver.default ?? moduleWithResolver;
		const runtimeParent = { filename: path.join(nodeModules, "kokoro-js", "dist", "kokoro.cjs") };
		expect(resolver._resolveFilename("@huggingface/transformers", runtimeParent, false)).toBe(
			path.join(nodeModules, "@huggingface", "transformers", "dist", "transformers.node.cjs"),
		);
		expect(resolver._resolveFilename("sharp", runtimeParent, false)).toBe(sharpStub);
	});
});

describe("writeRuntimeManifest", () => {
	async function readManifest(install: Parameters<typeof writeRuntimeManifest>[1]) {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-runtime-manifest-"));
		tempDirs.push(dir);
		await writeRuntimeManifest(dir, install);
		return JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
	}

	test("emits overrides so a transitive pin is forced across the runtime tree", async () => {
		const manifest = await readManifest({
			dependencies: { "kokoro-js": "1.2.1" },
			overrides: { "onnxruntime-node": "1.26.0" },
			trustedDependencies: ["onnxruntime-node"],
		});
		expect(manifest.dependencies).toEqual({ "kokoro-js": "1.2.1" });
		expect(manifest.overrides).toEqual({ "onnxruntime-node": "1.26.0" });
		expect(manifest.trustedDependencies).toEqual(["onnxruntime-node"]);
	});

	test("omits overrides when none are provided or the map is empty", async () => {
		const without = await readManifest({ dependencies: { "kokoro-js": "1.2.1" } });
		expect("overrides" in without).toBe(false);
		const empty = await readManifest({ dependencies: { "kokoro-js": "1.2.1" }, overrides: {} });
		expect("overrides" in empty).toBe(false);
	});
});

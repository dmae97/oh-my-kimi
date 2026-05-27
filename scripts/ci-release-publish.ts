#!/usr/bin/env bun
/**
 * Publish workspace packages.
 *
 * For each public TypeScript package we:
 *   1. Emit `.d.ts` declarations into `dist/types/` so consumers get
 *      stable types regardless of their tsconfig `lib`.
 *   2. Rewrite `package.json` in place — every `types`/`exports[*].types`
 *      that points at `./src/*.ts(x)` is repointed to `./dist/types/*.d.ts`
 *      and `dist/types` (plus `dist/client` for `stats`) is added to
 *      `files`. The on-repo manifest keeps pointing at source so local
 *      dev resolves types without any build.
 *   3. Invoke `bun publish` on the (now publish-shaped) manifest.
 *
 * Intended for CI. Mutates `package.json` in place — if you run this
 * locally, expect a dirty working tree and `git restore` after.
 */

import * as path from "node:path";
import { $ } from "bun";

interface PublishPackage {
	dir: string;
	kind: "typescript" | "native";
	/** Extra build steps before manifest rewrite (e.g. esbuild bundles). */
	preBuild?: readonly (readonly string[])[];
	/** Extra entries to splice into `files`. */
	extraFiles?: readonly string[];
	/** Extra tsgo invocations beyond `tsconfig.publish.json`. */
	extraTypeConfigs?: readonly string[];
}

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
	[key: string]: JsonValue;
}
interface PackageManifest extends JsonObject {
	name?: string;
	private?: boolean;
}

const repoRoot = path.join(import.meta.dir, "..");
const isDryRun = process.argv.includes("--dry-run");
const packages: PublishPackage[] = [
	{ dir: "packages/utils", kind: "typescript" },
	{ dir: "packages/ai", kind: "typescript" },
	{ dir: "packages/natives", kind: "native" },
	{ dir: "packages/tui", kind: "typescript" },
	{ dir: "packages/hashline", kind: "typescript" },
	{
		dir: "packages/stats",
		kind: "typescript",
		preBuild: [["bun", "run", "build"]],
		extraFiles: ["dist/client"],
		extraTypeConfigs: ["tsconfig.publish.client.json"],
	},
	{ dir: "packages/agent", kind: "typescript" },
	{ dir: "packages/coding-agent", kind: "typescript" },
];

function rewriteSrcPath(value: string): string {
	if (!value.startsWith("./src/")) return value;
	const rel = value.slice("./src/".length).replace(/\.tsx?$/, "");
	return `./dist/types/${rel}.d.ts`;
}

function rewriteExports(exports: JsonValue): JsonValue {
	if (exports === null || typeof exports !== "object" || Array.isArray(exports)) return exports;
	const src = exports as JsonObject;
	const out: JsonObject = {};
	for (const key in src) {
		const val = src[key];
		if (
			val !== null &&
			typeof val === "object" &&
			!Array.isArray(val) &&
			typeof (val as JsonObject).types === "string" &&
			((val as JsonObject).types as string).startsWith("./src/")
		) {
			const next: JsonObject = { ...(val as JsonObject) };
			next.types = rewriteSrcPath(next.types as string);
			out[key] = next;
		} else {
			out[key] = val;
		}
	}
	return out;
}

async function rewriteManifest(pkgDir: string, extraFiles: readonly string[]): Promise<PackageManifest> {
	const manifestPath = path.join(pkgDir, "package.json");
	const manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
	if (typeof manifest.types === "string" && manifest.types.startsWith("./src/")) {
		manifest.types = rewriteSrcPath(manifest.types);
	}
	if (manifest.exports !== undefined) manifest.exports = rewriteExports(manifest.exports);
	const files = Array.isArray(manifest.files) ? [...manifest.files] : [];
	const hasDist = files.includes("dist");
	if (!hasDist && !files.includes("dist/types")) files.push("dist/types");
	for (const extra of extraFiles) {
		if (!hasDist && !files.includes(extra)) files.push(extra);
	}
	manifest.files = files;
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

async function preparePackage(pkg: PublishPackage): Promise<PackageManifest> {
	const pkgDir = path.join(repoRoot, pkg.dir);
	if (pkg.kind === "native") {
		return (await Bun.file(path.join(pkgDir, "package.json")).json()) as PackageManifest;
	}
	for (const argv of pkg.preBuild ?? []) {
		await $`${argv}`.cwd(pkgDir);
	}
	await $`bun x tsgo -p tsconfig.publish.json`.cwd(pkgDir);
	for (const cfg of pkg.extraTypeConfigs ?? []) {
		await $`bun x tsgo -p ${cfg}`.cwd(pkgDir);
	}
	return rewriteManifest(pkgDir, pkg.extraFiles ?? []);
}

async function publishPackage(pkg: PublishPackage): Promise<void> {
	const pkgDir = path.join(repoRoot, pkg.dir);
	const manifest = await preparePackage(pkg);
	const name = manifest.name ?? path.basename(pkg.dir);
	if (manifest.private) {
		console.log(`Skipping ${name} (private)`);
		return;
	}
	if (isDryRun) {
		console.log(`DRY RUN bun publish --access public --tolerate-republish (${pkg.dir})`);
		return;
	}
	console.log(`Publishing ${name}…`);
	const result = await $`bun publish --access public --tolerate-republish`.cwd(pkgDir).quiet().nothrow();
	const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
	if (output) console.log(output);
	if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

for (const pkg of packages) {
	await publishPackage(pkg);
}

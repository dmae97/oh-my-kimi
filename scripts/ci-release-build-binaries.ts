#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

interface BinaryTarget {
	platform: string;
	arch: string;
	target: string;
	outfile: string;
}

const repoRoot = path.join(import.meta.dir, "..");
const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");
const entrypoint = "./packages/coding-agent/src/cli.ts";
const isDryRun = process.argv.includes("--dry-run");
const targets: BinaryTarget[] = [
	{
		platform: "darwin",
		arch: "arm64",
		target: "bun-darwin-arm64",
		outfile: "packages/coding-agent/binaries/omp-darwin-arm64",
	},
	{
		platform: "darwin",
		arch: "x64",
		target: "bun-darwin-x64",
		outfile: "packages/coding-agent/binaries/omp-darwin-x64",
	},
	{
		platform: "linux",
		arch: "x64",
		target: "bun-linux-x64-modern",
		outfile: "packages/coding-agent/binaries/omp-linux-x64",
	},
	{
		platform: "linux",
		arch: "arm64",
		target: "bun-linux-arm64",
		outfile: "packages/coding-agent/binaries/omp-linux-arm64",
	},
	{
		platform: "win32",
		arch: "x64",
		target: "bun-windows-x64-modern",
		outfile: "packages/coding-agent/binaries/omp-windows-x64.exe",
	},
];

async function embedNative(target: BinaryTarget): Promise<void> {
	if (isDryRun) {
		console.log(`DRY RUN bun --cwd=packages/natives run embed:native [${target.platform}/${target.arch}]`);
		return;
	}

	await $`bun --cwd=packages/natives run embed:native`
		.cwd(repoRoot)
		.env({
			...Bun.env,
			TARGET_PLATFORM: target.platform,
			TARGET_ARCH: target.arch,
		});
}

async function buildBinary(target: BinaryTarget): Promise<void> {
	console.log(`Building ${target.outfile}...`);
	await embedNative(target);
	if (isDryRun) {
		console.log(`DRY RUN bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv --define PI_COMPILED=true --root . --external mupdf --target=${target.target} ${entrypoint} --outfile ${target.outfile}`);
		return;
	}

	await $`bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv --define PI_COMPILED=true --root . --external mupdf --target=${target.target} ${entrypoint} --outfile ${target.outfile}`.cwd(
		repoRoot,
	);
}

async function generateBundle(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun --cwd=packages/stats scripts/generate-client-bundle.ts --generate");
		return;
	}
	await $`bun --cwd=packages/stats scripts/generate-client-bundle.ts --generate`.cwd(repoRoot);
}

async function resetArtifacts(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun --cwd=packages/natives run embed:native --reset");
		console.log("DRY RUN bun --cwd=packages/stats scripts/generate-client-bundle.ts --reset");
		return;
	}
	await $`bun --cwd=packages/natives run embed:native --reset`.cwd(repoRoot);
	await $`bun --cwd=packages/stats scripts/generate-client-bundle.ts --reset`.cwd(repoRoot);
}

async function main(): Promise<void> {
	await fs.mkdir(binariesDir, { recursive: true });
	await generateBundle();
	try {
		for (const target of targets) {
			await buildBinary(target);
		}
	} finally {
		await resetArtifacts();
	}
}

await main();

#!/usr/bin/env bun

import * as path from "node:path";
import { $ } from "bun";

interface PublishPackage {
	dir: string;
}

interface PackageJson {
	private?: boolean;
}

const repoRoot = path.join(import.meta.dir, "..");
const isDryRun = process.argv.includes("--dry-run");
const packageDirs: PublishPackage[] = [
	{ dir: "packages/utils" },
	{ dir: "packages/ai" },
	{ dir: "packages/natives" },
	{ dir: "packages/tui" },
	{ dir: "packages/stats" },
	{ dir: "packages/agent" },
	{ dir: "packages/coding-agent" },
];
const alreadyPublishedPatterns = [
	"previously published",
	"cannot publish over",
	"You cannot publish over",
];

function isAlreadyPublished(output: string): boolean {
	return alreadyPublishedPatterns.some((pattern) => output.includes(pattern));
}

async function readPackageJson(packageDir: string): Promise<PackageJson> {
	return (await Bun.file(path.join(repoRoot, packageDir, "package.json")).json()) as PackageJson;
}

async function publishPackage(pkg: PublishPackage): Promise<void> {
	const packageJson = await readPackageJson(pkg.dir);
	const packageName = path.basename(pkg.dir);
	if (packageJson.private) {
		console.log(`Skipping ${packageName} (private)`);
		return;
	}

	if (isDryRun) {
		console.log(`DRY RUN bun publish --access public (${pkg.dir})`);
		return;
	}

	console.log(`Publishing ${packageName}...`);
	const result = await $`bun publish --access public`.cwd(path.join(repoRoot, pkg.dir)).quiet().nothrow();
	const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
	if (result.exitCode === 0) {
		if (output) console.log(output);
		return;
	}
	if (output) console.log(output);
	if (isAlreadyPublished(output)) {
		console.log("Already published, skipping");
		return;
	}
	process.exit(result.exitCode ?? 1);
}

async function main(): Promise<void> {
	for (const pkg of packageDirs) {
		await publishPackage(pkg);
	}
}

await main();

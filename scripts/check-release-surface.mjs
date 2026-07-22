#!/usr/bin/env node

// Release-surface guard: the published npm tarballs and binary staging must never
// contain .omk project/local state, paths escaping the package root, or nested
// node_modules inside shipped examples.
//
// Usage: node scripts/check-release-surface.mjs

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = ["packages/ai", "packages/tui", "packages/agent", "packages/adaptorch-wpl", "packages/coding-agent"];

const forbidden = [
	{
		name: ".omk project/local state",
		test: (path) => /(^|\/)\.omk(\/|$)/.test(path),
	},
	{
		name: "path escaping package root",
		test: (path) => path.startsWith(".."),
	},
	{
		name: "nested node_modules in shipped examples",
		test: (path) => /^examples\/.*node_modules\//.test(path),
	},
];

const failures = [];

for (const pkg of packages) {
	const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
		cwd: join(repoRoot, pkg),
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		failures.push(`${pkg}: npm pack --dry-run failed\n${result.stderr}`);
		continue;
	}
	const packed = JSON.parse(result.stdout)[0];
	for (const file of packed.files) {
		for (const rule of forbidden) {
			if (rule.test(file.path)) {
				failures.push(`${pkg}: ${rule.name}: ${file.path}`);
			}
		}
	}
	console.log(`${pkg}: ${packed.files.length} files checked`);
}

if (failures.length > 0) {
	console.error("\nRelease-surface check failed:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log("Release surface OK: no .omk state, escaping paths, or nested node_modules.");

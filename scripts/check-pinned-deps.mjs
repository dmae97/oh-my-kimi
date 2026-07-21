import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];
const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
// These paths are relative to the scan root; keep exclusions exact.
const ignoredDirectoryPaths = new Set([".omk/git", ".omk/goals", ".omk/npm", join("vendor", "oh-my-pi")]);
// The pre-existing third-party scratch tree is only the exact `~` child of the scan root.
const rootScratchDirectory = "~";
const internalWorkspaceDependencies = new Set(["omk-adaptorch-wpl", "omk-agent-core", "omk-ai", "omk-tui"]);
const packageJsonFiles = [];
const scanRoot = process.argv[2] ?? ".";

function collectPackageJsonFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			const childDirectory = join(directory, entry.name);
			if (!isIgnoredDirectory(directory, entry.name, childDirectory)) {
				collectPackageJsonFiles(childDirectory);
			}
			continue;
		}

		if (entry.isFile() && entry.name === "package.json") {
			packageJsonFiles.push(join(directory, entry.name));
		}
	}
}
function isIgnoredDirectory(directory, name, childDirectory) {
	return (
		ignoredDirectories.has(name) ||
		ignoredDirectoryPaths.has(relative(scanRoot, childDirectory)) ||
		(directory === scanRoot && name === rootScratchDirectory)
	);
}


function isInternalWorkspaceDependency(name) {
	return internalWorkspaceDependencies.has(name);
}

function isNonRegistrySpecifier(specifier) {
	return /^(?:workspace:|file:|link:|portal:|git\+|github:|git:|https?:|ssh:|git:\/\/)/.test(specifier);
}

function getVersionSpecifier(specifier) {
	if (!specifier.startsWith("npm:")) return specifier;
	const aliasTarget = specifier.slice("npm:".length);
	const versionSeparator = aliasTarget.lastIndexOf("@");
	if (versionSeparator <= 0) return specifier;
	return aliasTarget.slice(versionSeparator + 1);
}

const failures = [];

collectPackageJsonFiles(scanRoot);

for (const file of packageJsonFiles.sort()) {
	const packageJson = JSON.parse(readFileSync(file, "utf8"));

	for (const section of dependencySections) {
		const dependencies = packageJson[section];
		if (!dependencies) continue;

		for (const [name, specifier] of Object.entries(dependencies)) {
			if (isInternalWorkspaceDependency(name) || isNonRegistrySpecifier(specifier)) continue;
			if (exactVersionPattern.test(getVersionSpecifier(specifier))) continue;
			failures.push(`${file}: ${section}.${name} must be pinned, found ${specifier}`);
		}
	}
}

if (failures.length > 0) {
	console.error("Direct external dependencies must use exact versions:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}

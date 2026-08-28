#!/usr/bin/env node

/**
 * Syncs all workspace package dependency versions to match their current versions.
 * This ensures lockstep versioning across the monorepo.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const packagesDir = join(process.cwd(), 'packages');
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
	.filter(dirent => dirent.isDirectory())
	.map(dirent => dirent.name);

// Read all package.json files and build version map
const packages = {};
const versionMap = {};

for (const dir of packageDirs) {
	const pkgPath = join(packagesDir, dir, 'package.json');
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		packages[dir] = { path: pkgPath, data: pkg };
		versionMap[pkg.name] = pkg.version;
	} catch (e) {
		console.error(`Failed to read ${pkgPath}:`, e.message);
	}
}

console.log('Current versions:');
for (const [name, version] of Object.entries(versionMap).sort()) {
	console.log(`  ${name}: ${version}`);
}

// Verify all versions are the same (lockstep)
const versions = new Set(Object.values(versionMap));
if (versions.size > 1) {
	console.error('\n❌ ERROR: Not all packages have the same version!');
	console.error('Expected lockstep versioning. Run one of:');
	console.error('  npm run version:patch');
	console.error('  npm run version:minor');
	console.error('  npm run version:major');
	process.exit(1);
}

console.log('\n✅ All packages at same version (lockstep)');

// Update all inter-package dependencies
let totalUpdates = 0;
for (const [dir, pkg] of Object.entries(packages)) {
	let updated = false;
	
	// Check dependencies
	if (pkg.data.dependencies) {
		for (const [depName, currentVersion] of Object.entries(pkg.data.dependencies)) {
			if (versionMap[depName]) {
				const newVersion = `^${versionMap[depName]}`;
				if (currentVersion !== newVersion) {
					console.log(`\n${pkg.data.name}:`);
					console.log(`  ${depName}: ${currentVersion} → ${newVersion}`);
					pkg.data.dependencies[depName] = newVersion;
					updated = true;
					totalUpdates++;
				}
			}
		}
	}
	
	// Check devDependencies
	if (pkg.data.devDependencies) {
		for (const [depName, currentVersion] of Object.entries(pkg.data.devDependencies)) {
			if (versionMap[depName]) {
				const newVersion = `^${versionMap[depName]}`;
				if (currentVersion !== newVersion) {
					console.log(`\n${pkg.data.name}:`);
					console.log(`  ${depName}: ${currentVersion} → ${newVersion} (devDependencies)`);
					pkg.data.devDependencies[depName] = newVersion;
					updated = true;
					totalUpdates++;
				}
			}
		}
	}
	
	// Write if updated
	if (updated) {
		writeFileSync(pkg.path, JSON.stringify(pkg.data, null, '\t') + '\n');
	}
}

// Version literals that live in source rather than in package.json. Nothing
// kept these in step with a bump, so book-to-skill carried a stale
// PACKAGE_VERSION through a release and failed the publish job's test step
// after the tag had already been pushed. This list sits beside the dependency
// sync above because both exist for the same reason: a bump has to reach
// everything that states a version.
const sourceVersionConstants = [
	{
		packageName: 'omk-book-to-skill',
		path: join(packagesDir, 'book-to-skill', 'src', 'metadata.ts'),
		pattern: /(export const PACKAGE_VERSION = ")(\d+\.\d+\.\d+)(";)/,
	},
];

let constantUpdates = 0;
for (const { packageName, path, pattern } of sourceVersionConstants) {
	const target = versionMap[packageName];
	if (!target) continue;
	const source = readFileSync(path, 'utf8');
	const match = source.match(pattern);
	if (!match) {
		console.error(`\n${path}: no version constant matching ${pattern}`);
		process.exit(1);
	}
	if (match[2] !== target) {
		console.log(`\n${packageName}:`);
		console.log(`  PACKAGE_VERSION: ${match[2]} → ${target}`);
		writeFileSync(path, source.replace(pattern, `$1${target}$3`));
		constantUpdates++;
	}
}

if (totalUpdates === 0) {
	console.log('\nAll inter-package dependencies already in sync.');
} else {
	console.log(`\n✅ Updated ${totalUpdates} dependency version(s)`);
}

if (constantUpdates > 0) {
	console.log(`✅ Updated ${constantUpdates} source version constant(s)`);
}

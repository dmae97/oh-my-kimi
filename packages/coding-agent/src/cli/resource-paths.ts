import * as fs from "node:fs";
import * as path from "node:path";
import { isLocalPath, resolvePath } from "../utils/paths.ts";

export function resolveCliPaths(cwd: string, paths: readonly string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

/** Classify an extension load error against explicit CLI sources, failing closed for opaque package sources. */
export function isExplicitExtensionDiagnostic(
	errorPath: string,
	explicitSources: readonly string[] | undefined,
): boolean {
	if (/^<inline:\d+>$/u.test(errorPath)) return true;
	if (!explicitSources || explicitSources.length === 0) return false;
	const error = canonicalPath(errorPath);
	let hasOpaqueSource = false;
	for (const source of explicitSources) {
		if (!isLocalPath(source)) {
			hasOpaqueSource = true;
			continue;
		}
		const resolvedSource = resolvePath(source);
		const sourceStat = statOrNull(resolvedSource);
		if (sourceStat?.isDirectory()) {
			if (isWithin(canonicalPath(resolvedSource), error)) return true;
			continue;
		}
		if (sourceStat?.isFile() && path.basename(resolvedSource) === "package.json") {
			if (isWithin(canonicalPath(path.dirname(resolvedSource)), error)) return true;
			continue;
		}
		if (canonicalPath(resolvedSource) === error) return true;
	}
	// Provenance is unavailable for unmatched loader paths. When the user supplied
	// any explicit source, fail closed rather than downgrading its error.
	return hasOpaqueSource || explicitSources.length > 0;
}

function canonicalPath(value: string): string {
	try {
		return fs.realpathSync(value);
	} catch {
		return resolvePath(value);
	}
}

function statOrNull(value: string): fs.Stats | null {
	try {
		return fs.statSync(value);
	} catch {
		return null;
	}
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

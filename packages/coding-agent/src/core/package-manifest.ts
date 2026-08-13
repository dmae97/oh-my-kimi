import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export const PACKAGE_RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"] as const;

export type PackageResourceKey = (typeof PACKAGE_RESOURCE_KEYS)[number];
export type PackageManifestKey = "omk" | "pi";

export interface PackageResourceManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export interface PackageManifestDiagnostic {
	path: string;
	message: string;
}

export interface PackageManifestResolution {
	key: PackageManifestKey | null;
	manifest: PackageResourceManifest | null;
	diagnostics: PackageManifestDiagnostic[];
	present: { omk: boolean; pi: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}

function isPackageRelativeEntry(entry: string): boolean {
	const candidate = entry.startsWith("!") || entry.startsWith("+") ? entry.slice(1) : entry;
	if (!candidate || candidate.includes("\0") || candidate.includes("\\")) return false;
	if (isAbsolute(candidate) || /^[A-Za-z]:[\\/]/u.test(candidate)) return false;
	return !candidate.split("/").includes("..");
}

function parseManifest(
	key: PackageManifestKey,
	value: unknown,
): {
	manifest: PackageResourceManifest;
	diagnostics: PackageManifestDiagnostic[];
} {
	if (!isRecord(value)) {
		return {
			manifest: {},
			diagnostics: [{ path: key, message: `${key} must be an object` }],
		};
	}

	const manifest: PackageResourceManifest = {};
	const diagnostics: PackageManifestDiagnostic[] = [];
	for (const resourceKey of PACKAGE_RESOURCE_KEYS) {
		if (!hasOwn(value, resourceKey)) continue;
		const entries = value[resourceKey];
		if (!Array.isArray(entries)) {
			diagnostics.push({ path: `${key}.${resourceKey}`, message: `${key}.${resourceKey} must be an array` });
			continue;
		}
		const validEntries: string[] = [];
		for (const [index, entry] of entries.entries()) {
			if (typeof entry !== "string") {
				diagnostics.push({
					path: `${key}.${resourceKey}[${index}]`,
					message: `${key}.${resourceKey}[${index}] must be a string`,
				});
				continue;
			}
			if (!isPackageRelativeEntry(entry)) {
				diagnostics.push({
					path: `${key}.${resourceKey}[${index}]`,
					message: `${key}.${resourceKey}[${index}] must be a package-relative path or glob`,
				});
				continue;
			}
			validEntries.push(entry);
		}
		manifest[resourceKey] = validEntries;
	}
	return { manifest, diagnostics };
}

/** Resolve package resources with the stable precedence omk > pi > convention. */
export function resolvePackageManifest(value: unknown): PackageManifestResolution {
	const pkg = isRecord(value) ? value : {};
	const present = { omk: hasOwn(pkg, "omk"), pi: hasOwn(pkg, "pi") };
	let key: PackageManifestKey | null = null;
	if (present.omk) key = "omk";
	else if (present.pi) key = "pi";
	if (key === null) {
		return { key, manifest: null, diagnostics: [], present };
	}
	const parsed = parseManifest(key, pkg[key]);
	return { key, manifest: parsed.manifest, diagnostics: parsed.diagnostics, present };
}

export function readPackageManifest(packageJsonPath: string): PackageManifestResolution | null {
	try {
		return resolvePackageManifest(JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown);
	} catch {
		return {
			key: null,
			manifest: null,
			diagnostics: [{ path: "package.json", message: "package.json must contain valid JSON" }],
			present: { omk: false, pi: false },
		};
	}
}

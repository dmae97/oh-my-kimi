import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
	GALLERY_RESOURCE_ORDER,
	type GalleryManifest,
	type GalleryManifestKey,
	type GalleryPreview,
	type GalleryPreviewInput,
	type GalleryResourceType,
} from "./package-gallery-types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

function normalizeOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function manifestSection(input: Record<string, unknown>, key: GalleryManifestKey): Record<string, unknown> | undefined {
	const section = input[key];
	return isRecord(section) ? section : undefined;
}

export function normalizeGalleryManifest(input: unknown): GalleryManifest | null {
	if (!isRecord(input)) return null;

	const manifestKey: GalleryManifestKey | undefined = manifestSection(input, "omk")
		? "omk"
		: manifestSection(input, "pi")
			? "pi"
			: undefined;
	if (!manifestKey) return null;

	const section = manifestSection(input, manifestKey);
	if (!section) return null;

	const manifest: GalleryManifest = {
		manifestKey,
		extensions: normalizeStringArray(section.extensions),
		skills: normalizeStringArray(section.skills),
		prompts: normalizeStringArray(section.prompts),
		themes: normalizeStringArray(section.themes),
		video: normalizeOptionalString(section.video),
		image: normalizeOptionalString(section.image),
		description: normalizeOptionalString(section.description),
	};
	return hasManifestResource(manifest) ? manifest : null;
}

export function hasGalleryKeyword(input: unknown): boolean {
	if (!isRecord(input) || !Array.isArray(input.keywords)) return false;
	return input.keywords.some((keyword) => keyword === "omk-package" || keyword === "pi-package");
}

export function classifyGalleryResourceTypes(
	manifest: GalleryManifest | null,
	conventionDirs: readonly string[] = [],
): GalleryResourceType[] {
	const types = new Set<GalleryResourceType>();
	if ((manifest?.extensions.length ?? 0) > 0) types.add("extension");
	if ((manifest?.skills.length ?? 0) > 0) types.add("skill");
	if ((manifest?.prompts.length ?? 0) > 0) types.add("prompt");
	if ((manifest?.themes.length ?? 0) > 0) types.add("theme");

	for (const dir of conventionDirs) {
		const facet = resolveGalleryTypeFacet(dir);
		if (facet) types.add(facet);
	}

	return GALLERY_RESOURCE_ORDER.filter((type) => types.has(type));
}

export function resolveGalleryTypeFacet(value: string | undefined): GalleryResourceType | undefined {
	const normalized = value?.trim().toLowerCase();
	switch (normalized) {
		case "extension":
		case "extensions":
			return "extension";
		case "skill":
		case "skills":
			return "skill";
		case "prompt":
		case "prompts":
			return "prompt";
		case "theme":
		case "themes":
			return "theme";
		default:
			return undefined;
	}
}

export function filterGalleryEntriesByType<T extends { readonly resourceTypes: readonly GalleryResourceType[] }>(
	entries: readonly T[],
	type: string | undefined,
): T[] {
	const facet = resolveGalleryTypeFacet(type);
	if (type === undefined) return [...entries];
	if (!facet) return [];
	return entries.filter((entry) => entry.resourceTypes.includes(facet));
}

export function isValidGalleryVideoUrl(value: string | undefined): value is string {
	return isValidHttpsMediaUrl(value, new Set([".mp4"]));
}

export function isValidGalleryImageUrl(value: string | undefined): value is string {
	return isValidHttpsMediaUrl(value, new Set([".png", ".jpg", ".jpeg", ".webp"]));
}

export function selectGalleryPreview(input: GalleryPreviewInput): GalleryPreview | null {
	if (isValidGalleryVideoUrl(input.video)) {
		return { kind: "video", url: input.video };
	}
	if (isValidGalleryImageUrl(input.image)) {
		return { kind: "image", url: input.image };
	}
	if (input.themeName && input.resourceTypes?.includes("theme")) {
		return { kind: "generated-theme", marker: input.themeName };
	}
	return null;
}

export function filterManifestEntriesInsideRoot(root: string, entries: readonly string[]): string[] {
	const rootAbs = resolve(root);
	const rootExists = existsSync(rootAbs);
	const rootReal = realpathOrSelf(rootAbs);
	return entries.flatMap((entry) => {
		const trimmed = entry.trim();
		if (!trimmed || isAbsolute(trimmed)) return [];

		const candidate = resolve(rootAbs, trimmed);
		if (!isInsideRoot(rootAbs, candidate)) return [];
		if (rootExists) {
			const checked = nearestExistingRealpath(candidate);
			if (checked !== undefined && !isInsideRoot(rootReal, checked)) return [];
		}

		const rel = toSlashPath(relative(rootAbs, candidate));
		return rel && !rel.startsWith("..") ? [rel] : [];
	});
}

function hasManifestResource(manifest: GalleryManifest): boolean {
	return (
		manifest.extensions.length > 0 ||
		manifest.skills.length > 0 ||
		manifest.prompts.length > 0 ||
		manifest.themes.length > 0 ||
		manifest.video !== undefined ||
		manifest.image !== undefined ||
		manifest.description !== undefined
	);
}

function isValidHttpsMediaUrl(value: string | undefined, extensions: ReadonlySet<string>): value is string {
	if (!value) return false;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:") return false;
		if (url.username || url.password) return false;
		const lowerPath = url.pathname.toLowerCase();
		return [...extensions].some((extension) => lowerPath.endsWith(extension));
	} catch {
		return false;
	}
}

function toSlashPath(path: string): string {
	return path.replace(/\\/g, "/");
}

function isInsideRoot(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function nearestExistingRealpath(path: string): string | undefined {
	let current = path;
	while (true) {
		if (existsSync(current)) {
			return realpathOrSelf(current);
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

import { resolve } from "node:path";
import type { GalleryPackageIdentity } from "./package-gallery-types.ts";

export function normalizeRepoIdentity(repo: string): string {
	return repo.trim().replace(/\.git$/i, "");
}

export function trialIdentity(identity: GalleryPackageIdentity): string {
	if (identity.kind === "npm") return `npm:${identity.name}`;
	if (identity.kind === "git") return `git:${normalizeRepoIdentity(identity.repo)}`;
	return `local:${resolve(identity.path)}`;
}

function identityKey(identity: GalleryPackageIdentity): string {
	if (identity.kind === "npm") return `npm:${identity.name}`;
	if (identity.kind === "git") return `git:${normalizeRepoIdentity(identity.repo)}`;
	return `local:${resolve(identity.path)}`;
}

export function dedupeGalleryEntries<T extends { readonly identity: GalleryPackageIdentity }>(
	entries: readonly T[],
): T[] {
	const seen = new Set<string>();
	const deduped: T[] = [];
	for (const entry of entries) {
		const key = identityKey(entry.identity);
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(entry);
	}
	return deduped;
}

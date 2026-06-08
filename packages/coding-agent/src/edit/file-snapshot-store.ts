/**
 * Session-bound file snapshot store.
 *
 * Used by `read` and `search` to record exactly what the model saw, and by
 * the hashline patcher to verify or recover from stale section tags (file
 * changed externally between read and edit, or a prior in-session edit
 * advanced the tag). The store is the {@link InMemorySnapshotStore}
 * from `@oh-my-pi/hashline`; the only coding-agent-specific concern here
 * is wiring it onto the per-session owner object.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { InMemorySnapshotStore } from "@oh-my-pi/hashline";
import { normalizeToLF } from "./normalize";

/**
 * Upper bound on the file size we snapshot. A section tag is a content hash of
 * the *whole* file, so minting one means holding the full normalized text in
 * the store. Files above this cap emit no `[path#tag]` header — line-anchored
 * editing of multi-megabyte files is out of scope under the full-content model.
 */
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

interface FileSnapshotStoreOwner {
	fileSnapshotStore?: InMemorySnapshotStore;
}

/**
 * Look up (or lazily create) the file snapshot store attached to a session.
 * Storage lives on `session.fileSnapshotStore` so it ages out exactly with
 * the session itself.
 */
export function getFileSnapshotStore(session: FileSnapshotStoreOwner): InMemorySnapshotStore {
	if (!session.fileSnapshotStore) session.fileSnapshotStore = new InMemorySnapshotStore();
	return session.fileSnapshotStore;
}

/**
 * Canonicalize an absolute path into the stable key the snapshot store uses.
 *
 * Different code paths reach the snapshot store via different path forms:
 * `read local://foo.md` records under the file's `fs.realpath` (the local
 * protocol handler resolves symlinks); a subsequent `edit` may address the
 * same artifact via `local://foo.md`, whose resolver does NOT realpath, or
 * via the absolute path returned in the `[path#tag]` header. macOS adds the
 * same hazard at the working-tree level (`/tmp/...` vs `/private/tmp/...`).
 * Collapsing every key through `realpath` makes those forms fuse onto one
 * snapshot entry, so a freshly-minted tag is never rejected as stale just
 * because the lookup spelled the same file differently.
 *
 * Non-existent paths (new-file writes) fall back to a realpath of the parent
 * directory + basename, then to the input. This keeps creates and updates on
 * the same canonical key.
 */
export function canonicalSnapshotKey(absolutePath: string): string {
	try {
		return fs.realpathSync.native(absolutePath);
	} catch {
		try {
			const parent = fs.realpathSync.native(path.dirname(absolutePath));
			return path.join(parent, path.basename(absolutePath));
		} catch {
			return absolutePath;
		}
	}
}

/**
 * Read the full text of `absolutePath` (within {@link SNAPSHOT_MAX_BYTES}),
 * record it as a version snapshot, and return its content-hash tag. Returns
 * `undefined` when the file exceeds the cap or cannot be read — callers then
 * omit the section header so the model never sees a tag it can't anchor against.
 *
 * Producers that only displayed a slice of the file (range reads, search hits)
 * use this to mint a whole-file tag: the displayed lines stay partial, but the
 * tag fingerprints the entire file so a follow-up edit anchored at any line
 * validates whenever the live file is byte-identical to what was read.
 */
export async function recordFileSnapshot(
	session: FileSnapshotStoreOwner,
	absolutePath: string,
): Promise<string | undefined> {
	try {
		const file = Bun.file(absolutePath);
		if (file.size > SNAPSHOT_MAX_BYTES) return undefined;
		const normalized = normalizeToLF(await file.text());
		return getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalized);
	} catch {
		return undefined;
	}
}

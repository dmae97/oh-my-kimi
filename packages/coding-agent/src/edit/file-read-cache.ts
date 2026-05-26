/**
 * Per-session cache of file contents as they were rendered to the model by
 * the `read` and `search` tools in the current agent session.
 *
 * Used by hashline-mode anchor-stale recovery: if the model authored anchors
 * against a version of the file that no longer matches what is on disk —
 * because a subagent, the user, a linter, or a formatter modified the file
 * between the read and the edit — we replay the edits against the cached
 * pre-edit snapshot and 3-way-merge the result onto the live file.
 *
 * Scoped per `ToolSession`: the cache lives on the session object itself, so
 * different sessions never share snapshots and entries get reclaimed when
 * the session goes out of scope. Each session keeps a small LRU window of
 * paths; each path keeps a short ring of recent snapshots so follow-up edits
 * can recover from the agent's own prior writes as well as stale reads.
 */
import { LRUCache } from "lru-cache/raw";
import type { ToolSession } from "../tools";

const MAX_PATHS_PER_SESSION = 30;
const MAX_SNAPSHOTS_PER_PATH = 4;

export interface FileReadSnapshot {
	/** 1-indexed line number → exact line content as observed by `read`/`search`. */
	lines: Map<number, string>;
	/** Full normalized text when the read path observed the whole file. */
	fullText?: string;
	/** 4-hex hash of `fullText`, or a sparse snapshot hash supplied by search. */
	fileHash?: string;
	recordedAt: number;
}

interface FileReadSnapshotMetadata {
	fullText?: string;
	fileHash?: string;
}

export class FileReadCache {
	#snapshots = new LRUCache<string, FileReadSnapshot[]>({ max: MAX_PATHS_PER_SESSION });

	/** Look up the most recent snapshot for `absPath`, or `null` if absent. */
	get(absPath: string): FileReadSnapshot | null {
		return this.#snapshots.get(absPath)?.[0] ?? null;
	}

	/** Look up the most recent snapshot for `absPath` whose file hash matches. */
	getByHash(absPath: string, fileHash: string): FileReadSnapshot | null {
		const history = this.#snapshots.get(absPath);
		return history?.find(snapshot => snapshot.fileHash === fileHash) ?? null;
	}

	/** Record a contiguous run of lines (e.g. from a `read` tool). `startLine` is 1-indexed. */
	recordContiguous(
		absPath: string,
		startLine: number,
		lines: readonly string[],
		metadata: FileReadSnapshotMetadata = {},
	): void {
		if (lines.length === 0 && metadata.fullText === undefined) return;
		const entries: Array<readonly [number, string]> = lines.map((line, idx) => [startLine + idx, line] as const);
		this.#record(absPath, entries, metadata);
	}

	/** Record sparse `(lineNumber, content)` pairs (e.g. `search` matches plus context). */
	recordSparse(
		absPath: string,
		entries: Iterable<readonly [number, string]>,
		metadata: FileReadSnapshotMetadata = {},
	): void {
		const arr = Array.from(entries);
		if (arr.length === 0 && metadata.fullText === undefined) return;
		this.#record(absPath, arr, metadata);
	}

	/** Drop the snapshot history for a single path. */
	invalidate(absPath: string): void {
		this.#snapshots.delete(absPath);
	}

	/** Drop every snapshot history. */
	clear(): void {
		this.#snapshots.clear();
	}

	#record(
		absPath: string,
		entries: ReadonlyArray<readonly [number, string]>,
		metadata: FileReadSnapshotMetadata,
	): void {
		const history = this.#snapshots.get(absPath) ?? [];
		const head = history[0];
		const now = Date.now();
		if (head && !hasConflict(head.lines, entries) && !hasHashConflict(head, metadata)) {
			for (const [lineNum, content] of entries) head.lines.set(lineNum, content);
			if (metadata.fullText !== undefined) head.fullText = metadata.fullText;
			if (metadata.fileHash !== undefined) head.fileHash = metadata.fileHash;
			head.recordedAt = now;
			// `get` above already touched LRU recency for this key.
			return;
		}

		const nextSnapshot: FileReadSnapshot = {
			lines: new Map(entries),
			...metadata,
			recordedAt: now,
		};
		const dedupedHistory = history.filter(snapshot => !isSameSnapshotIdentity(snapshot, nextSnapshot));
		this.#snapshots.set(absPath, [nextSnapshot, ...dedupedHistory].slice(0, MAX_SNAPSHOTS_PER_PATH));
	}
}

function hasConflict(existing: Map<number, string>, incoming: ReadonlyArray<readonly [number, string]>): boolean {
	for (const [lineNum, content] of incoming) {
		const prior = existing.get(lineNum);
		if (prior !== undefined && prior !== content) return true;
	}
	return false;
}

function hasHashConflict(existing: FileReadSnapshot, metadata: FileReadSnapshotMetadata): boolean {
	return metadata.fileHash !== undefined && existing.fileHash !== undefined && metadata.fileHash !== existing.fileHash;
}

function isSameSnapshotIdentity(left: FileReadSnapshot, right: FileReadSnapshot): boolean {
	if (left.fileHash !== undefined && right.fileHash !== undefined) return left.fileHash === right.fileHash;
	if (left.fullText !== undefined && right.fullText !== undefined) return left.fullText === right.fullText;
	return false;
}

/**
 * Look up (or lazily create) the file-read cache attached to a session. The
 * cache is stored as `session.fileReadCache` so it lives exactly as long as
 * the session itself.
 */
export function getFileReadCache(session: ToolSession): FileReadCache {
	if (!session.fileReadCache) session.fileReadCache = new FileReadCache();
	return session.fileReadCache;
}

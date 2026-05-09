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
 * paths; the cache always reflects what *this* session most recently saw,
 * so it stays correct by construction even when this session writes the
 * file itself — the next read after the write refreshes the entry.
 */
import { LRUCache } from "lru-cache/raw";
import type { ToolSession } from "../tools";

const MAX_PATHS_PER_SESSION = 30;

export interface FileReadSnapshot {
	/** 1-indexed line number → exact line content as observed by `read`/`search`. */
	lines: Map<number, string>;
	recordedAt: number;
}

export class FileReadCache {
	#snapshots = new LRUCache<string, FileReadSnapshot>({ max: MAX_PATHS_PER_SESSION });

	/** Look up the most recent snapshot for `absPath`, or `null` if absent. */
	get(absPath: string): FileReadSnapshot | null {
		return this.#snapshots.get(absPath) ?? null;
	}

	/** Record a contiguous run of lines (e.g. from a `read` tool). `startLine` is 1-indexed. */
	recordContiguous(absPath: string, startLine: number, lines: readonly string[]): void {
		if (lines.length === 0) return;
		const entries: Array<readonly [number, string]> = lines.map((line, idx) => [startLine + idx, line] as const);
		this.#record(absPath, entries);
	}

	/** Record sparse `(lineNumber, content)` pairs (e.g. `search` matches plus context). */
	recordSparse(absPath: string, entries: Iterable<readonly [number, string]>): void {
		const arr = Array.from(entries);
		if (arr.length === 0) return;
		this.#record(absPath, arr);
	}

	/** Drop the snapshot for a single path. */
	invalidate(absPath: string): void {
		this.#snapshots.delete(absPath);
	}

	/** Drop every snapshot. */
	clear(): void {
		this.#snapshots.clear();
	}

	#record(absPath: string, entries: ReadonlyArray<readonly [number, string]>): void {
		const existing = this.#snapshots.get(absPath);
		if (existing && hasConflict(existing.lines, entries)) {
			// File content has changed since we last recorded. Drop the stale
			// snapshot and start fresh with whatever we just observed.
			this.#snapshots.set(absPath, { lines: new Map(entries), recordedAt: Date.now() });
			return;
		}
		if (existing) {
			for (const [lineNum, content] of entries) existing.lines.set(lineNum, content);
			existing.recordedAt = Date.now();
			// `get` above already touched LRU recency for this key.
			return;
		}
		this.#snapshots.set(absPath, { lines: new Map(entries), recordedAt: Date.now() });
	}
}

function hasConflict(existing: Map<number, string>, incoming: ReadonlyArray<readonly [number, string]>): boolean {
	for (const [lineNum, content] of incoming) {
		const prior = existing.get(lineNum);
		if (prior !== undefined && prior !== content) return true;
	}
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

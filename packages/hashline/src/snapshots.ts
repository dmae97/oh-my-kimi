/**
 * Per-session snapshot store used by {@link Recovery} to rescue patches when
 * a section's file hash has drifted (file changed externally or a prior
 * in-session edit advanced the hash).
 *
 * Producers (typically a `read` tool) record snapshots as they observe file
 * content. Consumers (the patcher) query for the snapshot whose hash matches
 * a stale section, then 3-way-merge the would-be edit onto the live content.
 *
 * The abstract base class lets callers plug in whatever storage they like
 * (LRU, persistent SQLite, etc.). {@link InMemorySnapshotStore} ships as a
 * sensible default backed by `lru-cache` so paths age out automatically.
 */
import { LRUCache } from "lru-cache/raw";

/**
 * One snapshot of a file as it was observed at a point in time. Either the
 * full text is recorded (`fullText` set) for full-file reads, or a sparse
 * map of `(lineNumber, content)` pairs for partial views (search matches,
 * range reads).
 */
export interface Snapshot {
	/** 1-indexed line number → exact content as observed. */
	readonly lines: Map<number, string>;
	/** Full normalized text when the read observed the whole file. */
	fullText?: string;
	/** 4-hex hash carried alongside the read, when known. */
	fileHash?: string;
	/** Timestamp (ms since epoch) the snapshot was recorded. */
	recordedAt: number;
}

/** Optional metadata supplied at snapshot record time. */
export interface SnapshotMetadata {
	/** Full normalized text, when the producer observed the whole file. */
	fullText?: string;
	/** 4-hex hash carried by the read, when known. */
	fileHash?: string;
}

/**
 * Storage seam for file-content snapshots. The patcher calls {@link head}
 * for the latest snapshot of a path and {@link byHash} when it needs the
 * specific historical snapshot that matches a section's stale hash.
 */
export abstract class SnapshotStore {
	/** Most-recent snapshot for `path`, or `null` if none. */
	abstract head(path: string): Snapshot | null;

	/** Most-recent snapshot for `path` whose `fileHash` equals `fileHash`. */
	abstract byHash(path: string, fileHash: string): Snapshot | null;

	/** Record a contiguous run of lines (e.g. from a `read` tool). `startLine` is 1-indexed. */
	abstract recordContiguous(
		path: string,
		startLine: number,
		lines: readonly string[],
		metadata?: SnapshotMetadata,
	): void;

	/** Record sparse `(lineNumber, content)` pairs (e.g. a `search` match plus context). */
	abstract recordSparse(path: string, entries: Iterable<readonly [number, string]>, metadata?: SnapshotMetadata): void;

	/** Drop the snapshot history for a single path. */
	abstract invalidate(path: string): void;

	/** Drop every snapshot history. */
	abstract clear(): void;
}

const DEFAULT_MAX_PATHS = 30;
const DEFAULT_MAX_SNAPSHOTS_PER_PATH = 4;

function hasConflict(
	existing: ReadonlyMap<number, string>,
	incoming: ReadonlyArray<readonly [number, string]>,
): boolean {
	for (const [lineNum, content] of incoming) {
		const prior = existing.get(lineNum);
		if (prior !== undefined && prior !== content) return true;
	}
	return false;
}

function hasHashConflict(existing: Snapshot, metadata: SnapshotMetadata): boolean {
	return metadata.fileHash !== undefined && existing.fileHash !== undefined && metadata.fileHash !== existing.fileHash;
}

function isSameSnapshotIdentity(left: Snapshot, right: Snapshot): boolean {
	if (left.fileHash !== undefined && right.fileHash !== undefined) return left.fileHash === right.fileHash;
	if (left.fullText !== undefined && right.fullText !== undefined) return left.fullText === right.fullText;
	return false;
}

export interface InMemorySnapshotStoreOptions {
	/** Maximum number of distinct paths tracked at once (default 30). LRU eviction. */
	maxPaths?: number;
	/** Maximum snapshots retained per path (default 4). Oldest dropped first. */
	maxSnapshotsPerPath?: number;
}

/**
 * In-memory {@link SnapshotStore} backed by `lru-cache`. Per-path snapshot
 * history is a short ring (oldest dropped first); per-session path tracking
 * is LRU-bounded so cold paths age out automatically.
 *
 * Newer snapshots merge into the head when their entries don't conflict and
 * the recorded `fileHash` (if any) still agrees; otherwise a fresh snapshot
 * is pushed onto the front of the history list.
 */
export class InMemorySnapshotStore extends SnapshotStore {
	readonly #snapshots: LRUCache<string, Snapshot[]>;
	readonly #maxSnapshotsPerPath: number;

	constructor(options: InMemorySnapshotStoreOptions = {}) {
		super();
		this.#snapshots = new LRUCache<string, Snapshot[]>({ max: options.maxPaths ?? DEFAULT_MAX_PATHS });
		this.#maxSnapshotsPerPath = options.maxSnapshotsPerPath ?? DEFAULT_MAX_SNAPSHOTS_PER_PATH;
	}

	head(path: string): Snapshot | null {
		return this.#snapshots.get(path)?.[0] ?? null;
	}

	byHash(path: string, fileHash: string): Snapshot | null {
		const history = this.#snapshots.get(path);
		return history?.find(entry => entry.fileHash === fileHash) ?? null;
	}

	recordContiguous(path: string, startLine: number, lines: readonly string[], metadata: SnapshotMetadata = {}): void {
		if (lines.length === 0 && metadata.fullText === undefined) return;
		const entries: Array<readonly [number, string]> = lines.map((line, idx) => [startLine + idx, line] as const);
		this.#record(path, entries, metadata);
	}

	recordSparse(path: string, entries: Iterable<readonly [number, string]>, metadata: SnapshotMetadata = {}): void {
		const arr = Array.from(entries);
		if (arr.length === 0 && metadata.fullText === undefined) return;
		this.#record(path, arr, metadata);
	}

	invalidate(path: string): void {
		this.#snapshots.delete(path);
	}

	clear(): void {
		this.#snapshots.clear();
	}

	#record(path: string, entries: ReadonlyArray<readonly [number, string]>, metadata: SnapshotMetadata): void {
		const history = this.#snapshots.get(path) ?? [];
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

		const nextSnapshot: Snapshot = {
			lines: new Map(entries),
			...metadata,
			recordedAt: now,
		};
		const deduped = history.filter(entry => !isSameSnapshotIdentity(entry, nextSnapshot));
		this.#snapshots.set(path, [nextSnapshot, ...deduped].slice(0, this.#maxSnapshotsPerPath));
	}
}

/**
 * Per-session snapshot store used by {@link Recovery} and {@link Patcher} to
 * bind hashline section tags to the exact file view that minted them.
 *
 * Producers (typically `read` / `search` tools) record the lines they showed
 * the model. The store returns a three-hex opaque tag. Consumers resolve that
 * tag back to the recorded snapshot and verify the recorded lines against the
 * live file before applying anchored edits.
 *
 * Tags are scrambled by a deterministic permutation of the 12-bit hex space
 * built once at module load. Slot index `i` always maps to the same tag
 * across restarts (good for tests and reproducibility), but consecutive slot
 * indices produce unrelated tags — `mint()` followed by another `mint()` does
 * not return e.g. `000` then `001`, and the first tag a store ever hands out
 * is not `000`. This is hallucination prevention, not adversarial security: it
 * stops an LLM from guessing `001` after observing `000`, or assuming any
 * monotonic counter pattern. The patcher catches stale-tag misuse via
 * content verification at apply time, so determinism doesn't reduce safety.
 *
 * Tag → slot resolution is a single `Map` lookup (no `parseInt`, no regex):
 * the inverse table is populated with both lowercase and uppercase forms of
 * every tag at module load.
 *
 * Snapshots are an open abstract type. The two concrete impls cover the
 * shapes producers actually emit: {@link ContiguousSnapshot} for `read`-style
 * runs (no map allocation, range arithmetic for lookup and superset checks)
 * and {@link SparseSnapshot} for `search`-style hits.
 *
 * The abstract base class lets callers plug in whatever storage they like.
 * {@link InMemorySnapshotStore} ships as a single 4096-slot ring shared across
 * paths — snapshots carry their own path, so the global ring is fine and
 * `byHash` rejects cross-path lookups.
 */

/**
 * One snapshot of a file view as observed at a point in time. The two
 * primitive methods subclasses must supply — `get` and `entries` — give callers
 * (and the default `isSuperset` / `matchesLiveFile` impls) everything they
 * need to verify recorded content against the live file.
 */
export abstract class Snapshot {
	/** Canonical path this snapshot belongs to. */
	abstract readonly path: string;
	/** Timestamp (ms since epoch) the snapshot was recorded. */
	abstract readonly recordedAt: number;
	/** Full normalized text when the read observed the whole file. */
	abstract readonly fullText?: string;

	/** Recorded content for 1-indexed `lineNumber`, or `undefined` if this snapshot doesn't cover that line. */
	abstract get(lineNumber: number): string | undefined;

	/** Iterate (1-indexed lineNumber, content) pairs in stable order. */
	abstract entries(): Iterable<[number, string]>;

	/** True iff every (line, content) the `other` snapshot asserts is also present here with matching content. */
	isSuperset(other: Snapshot): boolean {
		for (const [lineNumber, content] of other.entries()) {
			if (this.get(lineNumber) !== content) return false;
		}
		return true;
	}

	/** True iff every recorded line matches `currentLines` (0-indexed array of live file lines). */
	matchesLiveFile(currentLines: readonly string[]): boolean {
		for (const [lineNumber, content] of this.entries()) {
			if (currentLines[lineNumber - 1] !== content) return false;
		}
		return true;
	}
}

/**
 * A contiguous run of lines starting at `offset` (1-indexed). Backed by a
 * plain `string[]`; lookup is `lines[n - offset]`, superset against another
 * contiguous snapshot is pure range arithmetic.
 */
export class ContiguousSnapshot extends Snapshot {
	constructor(
		public readonly path: string,
		public readonly offset: number,
		public readonly lines: readonly string[],
		public readonly fullText?: string,
		public readonly recordedAt: number = Date.now(),
	) {
		super();
	}

	get(lineNumber: number): string | undefined {
		const index = lineNumber - this.offset;
		if (index < 0 || index >= this.lines.length) return undefined;
		return this.lines[index];
	}

	*entries(): IterableIterator<[number, string]> {
		for (let index = 0; index < this.lines.length; index++) {
			yield [this.offset + index, this.lines[index] ?? ""];
		}
	}

	override isSuperset(other: Snapshot): boolean {
		if (other instanceof ContiguousSnapshot) {
			if (other.offset < this.offset) return false;
			const skip = other.offset - this.offset;
			if (skip + other.lines.length > this.lines.length) return false;
			for (let index = 0; index < other.lines.length; index++) {
				if (this.lines[skip + index] !== other.lines[index]) return false;
			}
			return true;
		}
		return super.isSuperset(other);
	}

	override matchesLiveFile(currentLines: readonly string[]): boolean {
		for (let index = 0; index < this.lines.length; index++) {
			if (currentLines[this.offset + index - 1] !== this.lines[index]) return false;
		}
		return true;
	}
}

/**
 * A sparse `(lineNumber → content)` map, used for snapshots that don't cover a
 * single contiguous run — e.g. search hits plus their context windows.
 */
export class SparseSnapshot extends Snapshot {
	constructor(
		public readonly path: string,
		public readonly lines: ReadonlyMap<number, string>,
		public readonly fullText?: string,
		public readonly recordedAt: number = Date.now(),
	) {
		super();
	}

	get(lineNumber: number): string | undefined {
		return this.lines.get(lineNumber);
	}

	entries(): IterableIterator<[number, string]> {
		return this.lines.entries();
	}
}

/** Optional metadata supplied at snapshot record time. */
export interface SnapshotMetadata {
	/** Full normalized text, when the producer observed the whole file. */
	fullText?: string;
}

/**
 * Storage seam for file-content snapshots. Hashline section tags are opaque
 * store pointers; without the store that minted them they carry no meaning.
 */
export abstract class SnapshotStore {
	/** Most-recently pushed snapshot for `path`, or `null` if none. */
	abstract head(path: string): Snapshot | null;

	/** Snapshot currently occupying `tag`'s slot for `path`, or `null`. */
	abstract byHash(path: string, tag: string): Snapshot | null;

	/** Record a contiguous run of lines (e.g. from a `read` tool). `startLine` is 1-indexed. */
	abstract recordContiguous(
		path: string,
		startLine: number,
		lines: readonly string[],
		metadata?: SnapshotMetadata,
	): string;

	/** Record sparse `(lineNumber, content)` pairs (e.g. a `search` match plus context). */
	abstract recordSparse(
		path: string,
		entries: Iterable<readonly [number, string]>,
		metadata?: SnapshotMetadata,
	): string;

	/** Drop snapshots belonging to a single path. */
	abstract invalidate(path: string): void;

	/** Drop every snapshot. */
	abstract clear(): void;
}

const RING_SIZE = 0x1000;
const RING_MASK = RING_SIZE - 1;
const FALLBACK_TAG = "000";
const HEX_DIGITS = "0123456789ABCDEF";

/**
 * Deterministic permutation of `[0..4095]` → 3-hex tag, plus its inverse.
 *
 * Built once at module load via Mulberry32 + Fisher–Yates with a fixed seed.
 * Verified properties (see test suite): bijection over the 4096 hex values,
 * `FORWARD[0] !== "000"`, no recoverable arithmetic pattern in consecutive
 * tags. Cryptographic strength is not required — this only has to defeat
 * trivial LLM extrapolation like "after `000` comes `001`".
 */
const { FORWARD, INVERSE } = buildHexTables();

function formatSlotTag(value: number): string {
	return (
		(HEX_DIGITS[(value >>> 8) & 0xf] ?? "0") +
		(HEX_DIGITS[(value >>> 4) & 0xf] ?? "0") +
		(HEX_DIGITS[value & 0xf] ?? "0")
	);
}

function buildHexTables(): { FORWARD: readonly string[]; INVERSE: ReadonlyMap<string, number> } {
	let state = 0x9e3779b9 | 0;
	const rng = (): number => {
		state = (state + 0x6d2b79f5) | 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
	};

	const order = Array.from({ length: RING_SIZE }, (_, index) => index);
	for (let index = RING_SIZE - 1; index > 0; index--) {
		const swapIndex = Math.floor(rng() * (index + 1));
		const tmp = order[index] ?? 0;
		order[index] = order[swapIndex] ?? 0;
		order[swapIndex] = tmp;
	}

	const forward = order.map(formatSlotTag);
	const inverse = new Map<string, number>();
	for (let slot = 0; slot < RING_SIZE; slot++) {
		const tag = forward[slot] ?? FALLBACK_TAG;
		inverse.set(tag, slot);
		inverse.set(tag.toLowerCase(), slot);
	}
	return { FORWARD: forward, INVERSE: inverse };
}

/**
 * In-memory {@link SnapshotStore} backed by a flat 4096-slot ring shared across
 * all paths. Slot allocation is a simple `counter & 0xfff`; the tag the model
 * sees is `FORWARD[slot]` from the module-level permutation, so consecutive
 * pushes hand out unrelated tags. Slot reuse on wrap is intentional: stale tags
 * may alias after 4096 distinct pushes, and the patcher catches misuse by
 * verifying the resolved snapshot's content (and path) against the live file
 * before applying edits.
 */
export class InMemorySnapshotStore extends SnapshotStore {
	readonly #slots: Array<Snapshot | null> = new Array<Snapshot | null>(RING_SIZE).fill(null);
	#nextCounter = 0;
	#filled = 0;

	head(path: string): Snapshot | null {
		for (let offset = 1; offset <= this.#filled; offset++) {
			const snapshot = this.#slots[(this.#nextCounter - offset) & RING_MASK];
			if (snapshot && snapshot.path === path) return snapshot;
		}
		return null;
	}

	byHash(path: string, tag: string): Snapshot | null {
		const slot = INVERSE.get(tag);
		if (slot === undefined) return null;
		const snapshot = this.#slots[slot];
		if (!snapshot || snapshot.path !== path) return null;
		return snapshot;
	}

	recordContiguous(
		path: string,
		startLine: number,
		lines: readonly string[],
		metadata: SnapshotMetadata = {},
	): string {
		return this.#record(new ContiguousSnapshot(path, startLine, lines, metadata.fullText));
	}

	recordSparse(path: string, entries: Iterable<readonly [number, string]>, metadata: SnapshotMetadata = {}): string {
		const lines = new Map<number, string>();
		for (const [lineNumber, content] of entries) lines.set(lineNumber, content);
		return this.#record(new SparseSnapshot(path, lines, metadata.fullText));
	}

	invalidate(path: string): void {
		for (let index = 0; index < RING_SIZE; index++) {
			if (this.#slots[index]?.path === path) this.#slots[index] = null;
		}
	}

	clear(): void {
		this.#slots.fill(null);
	}

	#record(incoming: Snapshot): string {
		const dedup = this.#dedup(incoming);
		if (dedup !== null) return dedup;

		const slot = this.#nextCounter & RING_MASK;
		this.#slots[slot] = incoming;
		this.#nextCounter++;
		if (this.#filled < RING_SIZE) this.#filled++;
		return FORWARD[slot] ?? FALLBACK_TAG;
	}

	#dedup(incoming: Snapshot): string | null {
		for (let offset = 1; offset <= this.#filled; offset++) {
			const slot = (this.#nextCounter - offset) & RING_MASK;
			const existing = this.#slots[slot];
			if (!existing || existing.path !== incoming.path) continue;
			if (existing.isSuperset(incoming)) return FORWARD[slot] ?? FALLBACK_TAG;
		}
		return null;
	}
}

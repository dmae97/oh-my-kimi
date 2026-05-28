/**
 * High-level patch orchestrator. Reads each section's target file via the
 * configured {@link Filesystem}, strips BOM and normalizes line endings,
 * validates the section snapshot tag (with {@link Recovery}), applies the
 * result back through the same {@link Filesystem}.
 *
 * Two layers:
 *
 * - {@link Patcher.apply} — high-level, all-or-nothing. Preflights every
 *   section in memory before any write hits disk, then commits in order.
 * - {@link Patcher.prepare} / {@link Patcher.commit} — granular primitives
 *   for callers that need per-section control (e.g. batched LSP flush,
 *   custom interleaving). `prepare` performs all the read-side work,
 *   validates the section snapshot tag (with recovery), and applies the
 *   edits in memory. `commit` writes the prepared result and records a
 *   fresh snapshot.
 *
 * Because `prepare` already runs the full apply, a multi-section batch is
 * naturally all-or-nothing: by the time any `commit` runs, every section
 * has been validated.
 *
 * The patcher itself is stateless across calls; reuse one instance per
 * filesystem configuration.
 */
import { applyEdits } from "./apply";
import { formatHashlineHeader, HL_FILE_HASH_SEP, HL_FILE_PREFIX } from "./format";
import type { Filesystem, WriteResult } from "./fs";
import { isNotFound } from "./fs";
import type { Patch, PatchSection } from "./input";
import { MismatchError } from "./mismatch";
import { detectLineEnding, type LineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./normalize";
import { Recovery, type RecoveryResult } from "./recovery";
import type { Snapshot, SnapshotStore } from "./snapshots";
import type { ApplyResult, Edit } from "./types";

export interface PatcherOptions {
	/** Storage backend used for all reads and writes. */
	fs: Filesystem;
	/** Snapshot store that minted and resolves hashline section tags. Required. */
	snapshots: SnapshotStore;
}

/** Per-section result returned by {@link Patcher.apply} / {@link Patcher.commit}. */
export interface PatchSectionResult {
	/** Section path (as authored, after cwd-resolution at parse time). */
	path: string;
	/** Filesystem-canonical key for this section (e.g. absolute path). */
	canonicalPath: string;
	/** `"noop"` when the apply produced no change; otherwise `"create"` / `"update"`. */
	op: "create" | "update" | "noop";
	/** Pre-edit text (LF-normalized, BOM-stripped). */
	before: string;
	/** Post-edit text (LF-normalized, BOM-stripped). For `"noop"` equals `before`. */
	after: string;
	/** Same text as `after` but with the original BOM and line ending restored. */
	persisted: string;
	/** Final text that the {@link Filesystem} actually wrote (may differ if the FS transformed it). */
	written: string;
	/** 3-hex opaque snapshot tag for `after`. Use to anchor follow-up edits. */
	fileHash: string;
	/** Hashline section header (`¶path#tag`) of the post-edit content. */
	header: string;
	/** 1-indexed first changed line in `after`, or `undefined` for noops. */
	firstChangedLine?: number;
	/** Warnings collected by the parser, applier, and (optionally) recovery. */
	warnings: string[];
}

export interface PatcherApplyResult {
	sections: PatchSectionResult[];
}

/**
 * Opaque token returned by {@link Patcher.prepare}. Carries the section, the
 * raw file content read off disk, and the in-memory apply result.
 * {@link Patcher.commit} just writes the {@link PreparedSection.applyResult}.
 */
export class PreparedSection {
	/** @internal */
	constructor(
		readonly section: PatchSection,
		readonly canonicalPath: string,
		readonly exists: boolean,
		readonly rawContent: string,
		readonly bom: string,
		readonly lineEnding: LineEnding,
		readonly normalized: string,
		readonly applyResult: ApplyResult,
		readonly parseWarnings: readonly string[],
	) {}

	/** Convenience: returns true when the apply produced no change. */
	get isNoop(): boolean {
		return this.applyResult.text === this.normalized;
	}
}

function hasAnchorScopedEdit(edits: readonly Edit[]): boolean {
	return edits.some(edit => {
		if (edit.kind === "delete" || edit.kind === "repeat") return true;
		return edit.cursor.kind === "before_anchor";
	});
}

function assertSectionHashAllowed(sectionPath: string, fileHash: string | undefined, edits: readonly Edit[]): void {
	if (fileHash !== undefined || !hasAnchorScopedEdit(edits)) return;
	throw new Error(
		`Missing hashline snapshot tag for anchored edit to ${sectionPath}; use \`${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}tag\` from your latest read/search output.`,
	);
}

function recoveryToApplyResult(result: RecoveryResult): ApplyResult {
	return {
		text: result.text,
		firstChangedLine: result.firstChangedLine,
		warnings: result.warnings,
	};
}

/**
 * Decide whether `snapshot` proves the live file is byte-for-byte the read
 * the model authored against. Two shapes:
 *   - Full-text snapshot: cheap string equality.
 *   - Sparse snapshot (e.g. selector reads, search hits): every anchor line
 *     must be in the snapshot AND every recorded line must match the live
 *     file. Without this branch, sparse reads can't short-circuit and fall
 *     through to recovery, which declines them as "patcher-owned direct
 *     apply" — yielding a spurious MismatchError on unchanged files.
 */
function snapshotProvesUnchanged(snapshot: Snapshot, currentText: string, section: PatchSection): boolean {
	if (snapshot.fullText !== undefined) return snapshot.fullText === currentText;
	for (const lineNumber of section.collectAnchorLines()) {
		if (snapshot.get(lineNumber) === undefined) return false;
	}
	return snapshot.matchesLiveFile(currentText.split("\n"));
}

function mergeWarnings(...sources: ReadonlyArray<readonly string[] | undefined>): string[] {
	const out: string[] = [];
	for (const source of sources) {
		if (!source) continue;
		for (const warning of source) out.push(warning);
	}
	return out;
}

function assertUniqueCanonicalPaths(prepared: readonly PreparedSection[]): void {
	const seen = new Map<string, string>();
	for (const entry of prepared) {
		const previous = seen.get(entry.canonicalPath);
		if (previous !== undefined) {
			throw new Error(
				`Multiple hashline sections resolve to the same file (${previous} and ${entry.section.path}). Merge their ops under one header before applying.`,
			);
		}
		seen.set(entry.canonicalPath, entry.section.path);
	}
}

/**
 * High-level patcher. Wires a {@link Filesystem} and a required
 * {@link SnapshotStore} together with the parsing + applying core.
 *
 * Construct once per FS configuration; reuse across patches.
 */
export class Patcher {
	readonly fs: Filesystem;
	readonly snapshots: SnapshotStore;
	readonly recovery: Recovery;

	constructor(options: PatcherOptions) {
		if (!options.snapshots) {
			throw new Error("Hashline Patcher requires a SnapshotStore; section tags are opaque store pointers.");
		}
		this.fs = options.fs;
		this.snapshots = options.snapshots;
		this.recovery = new Recovery(options.snapshots);
	}

	/**
	 * Apply every section in `patch`. `prepare` runs the full apply for each
	 * section in memory before any write hits the filesystem, so a
	 * multi-section batch is naturally all-or-nothing. Returns one
	 * {@link PatchSectionResult} per section in the original patch order.
	 */
	async apply(patch: Patch): Promise<PatcherApplyResult> {
		// Single-section fast path.
		if (patch.sections.length === 1) {
			const prepared = await this.prepare(patch.sections[0]);
			return { sections: [await this.commit(prepared)] };
		}

		// Prepare every section first so any failure (stale hash, missing
		// file, parse error, in-memory no-op) surfaces before any write.
		const prepared: PreparedSection[] = [];
		for (const section of patch.sections) prepared.push(await this.prepare(section));
		assertUniqueCanonicalPaths(prepared);
		for (const entry of prepared) {
			if (entry.isNoop) {
				throw new Error(`Edits to ${entry.section.path} resulted in no changes being made.`);
			}
		}

		const results: PatchSectionResult[] = [];
		for (const entry of prepared) results.push(await this.commit(entry));
		return { sections: results };
	}

	/**
	 * Run the preflight pass only: read, parse, validate, apply-in-memory.
	 * No writes hit the filesystem. Use for CI checks and dry runs.
	 */
	async preflight(patch: Patch): Promise<void> {
		const prepared: PreparedSection[] = [];
		for (const section of patch.sections) prepared.push(await this.prepare(section));
		assertUniqueCanonicalPaths(prepared);
		for (const entry of prepared) {
			if (entry.isNoop) {
				throw new Error(`Edits to ${entry.section.path} resulted in no changes being made.`);
			}
		}
	}

	/**
	 * Read a section's target file, parse the section, validate the snapshot
	 * tag (with recovery), and apply the edits in memory. Returns a
	 * {@link PreparedSection} which can be fed to {@link commit} to land
	 * the result on the filesystem.
	 *
	 * Throws on parse error, missing-file-for-anchored-edit, or unrecovered
	 * tag mismatch ({@link MismatchError}).
	 */
	async prepare(section: PatchSection): Promise<PreparedSection> {
		const { edits, warnings: parseWarnings } = section.parse();
		assertSectionHashAllowed(section.path, section.fileHash, edits);

		const canonicalPath = this.fs.canonicalPath(section.path);
		await this.fs.preflightWrite(section.path);
		const { exists, rawContent } = await this.#tryRead(section.path);
		if (!exists && hasAnchorScopedEdit(edits)) {
			throw new Error(`File not found: ${section.path}`);
		}

		const { bom, text } = stripBom(rawContent);
		const lineEnding = detectLineEnding(text);
		const normalized = normalizeToLF(text);

		const applyResult = this.#applyWithRecovery({
			section,
			canonicalPath,
			exists,
			normalized,
			edits,
		});

		return new PreparedSection(
			section,
			canonicalPath,
			exists,
			rawContent,
			bom,
			lineEnding,
			normalized,
			applyResult,
			parseWarnings,
		);
	}

	/**
	 * Commit a previously {@link prepare}d section to the filesystem.
	 * Restores line endings and BOM, writes via the {@link Filesystem}, and
	 * records a fresh snapshot in the {@link SnapshotStore} keyed by the
	 * filesystem-canonical path.
	 */
	async commit(prepared: PreparedSection): Promise<PatchSectionResult> {
		const { section, normalized, bom, lineEnding, parseWarnings, exists, applyResult, canonicalPath } = prepared;
		const after = applyResult.text;
		const warnings = mergeWarnings(parseWarnings, applyResult.warnings);

		if (after === normalized) {
			const hash = this.#recordFullSnapshot(canonicalPath, normalized);
			return {
				path: section.path,
				canonicalPath,
				op: "noop",
				before: normalized,
				after: normalized,
				persisted: prepared.rawContent,
				written: prepared.rawContent,
				fileHash: hash,
				header: formatHashlineHeader(section.path, hash),
				warnings,
			};
		}

		const persisted = bom + restoreLineEndings(after, lineEnding);
		const write: WriteResult = await this.fs.writeText(section.path, persisted);
		const fileHash = this.#recordFullSnapshot(canonicalPath, after);
		const op = exists ? "update" : "create";

		return {
			path: section.path,
			canonicalPath,
			op,
			before: normalized,
			after,
			persisted,
			written: write.text,
			fileHash,
			header: formatHashlineHeader(section.path, fileHash),
			firstChangedLine: applyResult.firstChangedLine,
			warnings,
		};
	}

	async #tryRead(path: string): Promise<{ exists: boolean; rawContent: string }> {
		try {
			const content = await this.fs.readText(path);
			return { exists: true, rawContent: content };
		} catch (error) {
			if (isNotFound(error)) return { exists: false, rawContent: "" };
			throw error;
		}
	}

	#recordFullSnapshot(canonicalPath: string, normalized: string): string {
		return this.snapshots.recordContiguous(canonicalPath, 1, normalized.split("\n"), { fullText: normalized });
	}

	#applyWithRecovery(args: {
		section: PatchSection;
		canonicalPath: string;
		exists: boolean;
		normalized: string;
		edits: readonly Edit[];
	}): ApplyResult {
		const { section, canonicalPath, exists, normalized, edits } = args;
		const expected = exists ? section.fileHash : undefined;
		if (expected === undefined) return applyEdits(normalized, [...edits]);

		const snapshot = this.snapshots.byHash(canonicalPath, expected);
		if (snapshot && snapshotProvesUnchanged(snapshot, normalized, section)) {
			return applyEdits(normalized, [...edits]);
		}
		if (snapshot) {
			const recovered = this.recovery.tryRecover({
				path: canonicalPath,
				currentText: normalized,
				fileHash: expected,
				edits,
			});
			if (recovered) return recoveryToApplyResult(recovered);
		}

		const currentHash = this.#recordFullSnapshot(canonicalPath, normalized);
		throw new MismatchError({
			path: section.path,
			expectedFileHash: expected,
			actualFileHash: currentHash,
			fileLines: normalized.split("\n"),
			anchorLines: section.collectAnchorLines(),
		});
	}
}

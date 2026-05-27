/**
 * High-level patch orchestrator. Reads each section's target file via the
 * configured {@link Filesystem}, strips BOM and normalizes line endings,
 * validates the section file hash (with optional {@link Recovery}), applies
 * the edits, and writes the result back through the same {@link Filesystem}.
 *
 * Two layers:
 *
 * - {@link Patcher.apply} — high-level, all-or-nothing. Preflights every
 *   section in memory before any write hits disk, then commits in order.
 * - {@link Patcher.prepare} / {@link Patcher.commit} — granular primitives
 *   for callers that need per-section control (e.g. batched LSP flush,
 *   custom interleaving). `prepare` performs all the read-side work,
 *   validates the section file hash (with recovery), and applies the
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
import { computeFileHash, formatHashlineHeader, HL_FILE_HASH_SEP, HL_FILE_PREFIX } from "./format";
import type { Filesystem, WriteResult } from "./fs";
import { isNotFound } from "./fs";
import type { Patch, PatchSection } from "./input";
import { MismatchError } from "./mismatch";
import { detectLineEnding, type LineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./normalize";
import { Recovery, type RecoveryResult } from "./recovery";
import type { SnapshotStore } from "./snapshots";
import type { ApplyOptions, ApplyResult, Edit } from "./types";

export interface PatcherOptions {
	/** Storage backend used for all reads and writes. */
	fs: Filesystem;
	/**
	 * Optional snapshot store that enables stale-hash recovery. When set, a
	 * section with a stale hash tries a 3-way merge against a cached
	 * snapshot before the apply fails with {@link MismatchError}.
	 */
	snapshots?: SnapshotStore;
	/**
	 * Optional default {@link ApplyOptions} forwarded to every section.
	 * Per-call overrides win on a key-by-key basis.
	 */
	applyOptions?: ApplyOptions;
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
	/** 4-hex hash of `after`. Use to anchor follow-up edits. */
	fileHash: string;
	/** Hashline section header (`¶path#hash`) of the post-edit content. */
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
		if (edit.kind === "delete") return true;
		return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor";
	});
}

function assertSectionHashAllowed(sectionPath: string, fileHash: string | undefined, edits: readonly Edit[]): void {
	if (fileHash !== undefined || !hasAnchorScopedEdit(edits)) return;
	throw new Error(
		`Missing hashline file hash for anchored edit to ${sectionPath}; use \`${HL_FILE_PREFIX}${sectionPath}${HL_FILE_HASH_SEP}hash\` from your latest read.`,
	);
}

function recoveryToApplyResult(result: RecoveryResult): ApplyResult {
	return {
		text: result.text,
		firstChangedLine: result.firstChangedLine,
		warnings: result.warnings,
	};
}

function mergeWarnings(...sources: ReadonlyArray<readonly string[] | undefined>): string[] {
	const out: string[] = [];
	for (const source of sources) {
		if (!source) continue;
		for (const warning of source) out.push(warning);
	}
	return out;
}

/**
 * High-level patcher. Wires a {@link Filesystem} and an optional
 * {@link SnapshotStore} together with the parsing + applying core.
 *
 * Construct once per FS configuration; reuse across patches.
 */
export class Patcher {
	readonly fs: Filesystem;
	readonly snapshots: SnapshotStore | undefined;
	readonly recovery: Recovery | undefined;
	readonly applyOptions: ApplyOptions;

	constructor(options: PatcherOptions) {
		this.fs = options.fs;
		this.snapshots = options.snapshots;
		this.recovery = options.snapshots ? new Recovery(options.snapshots) : undefined;
		this.applyOptions = options.applyOptions ?? {};
	}

	/**
	 * Apply every section in `patch`. `prepare` runs the full apply for each
	 * section in memory before any write hits the filesystem, so a
	 * multi-section batch is naturally all-or-nothing. Returns one
	 * {@link PatchSectionResult} per section in the original patch order.
	 */
	async apply(patch: Patch, options: ApplyOptions = {}): Promise<PatcherApplyResult> {
		const merged: ApplyOptions = { ...this.applyOptions, ...options };

		// Single-section fast path.
		if (patch.sections.length === 1) {
			const prepared = await this.prepare(patch.sections[0], merged);
			return { sections: [await this.commit(prepared)] };
		}

		// Prepare every section first so any failure (stale hash, missing
		// file, parse error, in-memory no-op) surfaces before any write.
		const prepared: PreparedSection[] = [];
		for (const section of patch.sections) prepared.push(await this.prepare(section, merged));
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
	async preflight(patch: Patch, options: ApplyOptions = {}): Promise<void> {
		const merged: ApplyOptions = { ...this.applyOptions, ...options };
		for (const section of patch.sections) {
			const prepared = await this.prepare(section, merged);
			if (prepared.isNoop) {
				throw new Error(`Edits to ${section.path} resulted in no changes being made.`);
			}
		}
	}

	/**
	 * Read a section's target file, parse the section, validate the file
	 * hash (with recovery), and apply the edits in memory. Returns a
	 * {@link PreparedSection} which can be fed to {@link commit} to land
	 * the result on the filesystem.
	 *
	 * Throws on parse error, missing-file-for-anchored-edit, or unrecovered
	 * hash mismatch ({@link MismatchError}).
	 */
	async prepare(section: PatchSection, options: ApplyOptions = {}): Promise<PreparedSection> {
		const applyOptions: ApplyOptions = { ...this.applyOptions, ...options };
		const { edits, warnings: parseWarnings } = section.parse();
		assertSectionHashAllowed(section.path, section.fileHash, edits);

		const canonicalPath = this.fs.canonicalPath(section.path);
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
			applyOptions,
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
	 * records a fresh snapshot in the {@link SnapshotStore} (when
	 * configured) keyed by the filesystem-canonical path.
	 */
	async commit(prepared: PreparedSection): Promise<PatchSectionResult> {
		const { section, normalized, bom, lineEnding, parseWarnings, exists, applyResult, canonicalPath } = prepared;
		const after = applyResult.text;
		const warnings = mergeWarnings(parseWarnings, applyResult.warnings);

		if (after === normalized) {
			const hash = computeFileHash(normalized);
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
		const fileHash = computeFileHash(after);
		const op = exists ? "update" : "create";

		if (this.snapshots) {
			this.snapshots.recordContiguous(canonicalPath, 1, after.split("\n"), {
				fullText: after,
				fileHash,
			});
		}

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

	#applyWithRecovery(args: {
		section: PatchSection;
		canonicalPath: string;
		exists: boolean;
		normalized: string;
		edits: readonly Edit[];
		applyOptions: ApplyOptions;
	}): ApplyResult {
		const { section, canonicalPath, exists, normalized, edits, applyOptions } = args;
		const expected = exists ? section.fileHash : undefined;
		if (expected === undefined) return applyEdits(normalized, [...edits], applyOptions);

		const currentHash = computeFileHash(normalized);
		if (currentHash === expected) return applyEdits(normalized, [...edits], applyOptions);

		const recovered = this.recovery?.tryRecover({
			path: canonicalPath,
			currentText: normalized,
			fileHash: expected,
			edits,
			options: applyOptions,
		});
		if (recovered) return recoveryToApplyResult(recovered);

		throw new MismatchError({
			path: section.path,
			expectedFileHash: expected,
			actualFileHash: currentHash,
			fileLines: normalized.split("\n"),
			anchorLines: section.collectAnchorLines(),
		});
	}
}

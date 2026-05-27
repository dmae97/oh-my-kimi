/**
 * Recover from a stale section file-hash by replaying the would-be edit
 * against a cached pre-edit snapshot of the file and 3-way-merging the
 * result onto the current on-disk content.
 *
 * The patcher consults this when it sees a section hash that doesn't match
 * the live file content. The recovery class is stateless apart from the
 * {@link SnapshotStore} it queries; the snapshot store is the seam that
 * lets you plug in your own caching strategy.
 */
import * as Diff from "diff";
import { applyEdits } from "./apply";
import { computeFileHash } from "./format";
import { RECOVERY_EXTERNAL_WARNING, RECOVERY_SESSION_CHAIN_WARNING } from "./messages";
import type { Snapshot, SnapshotStore } from "./snapshots";
import type { Anchor, ApplyOptions, ApplyResult, Edit } from "./types";

// Section hashes are line-precise; never let Diff.applyPatch slide a hunk
// onto a duplicate closer 100+ lines away. If snapshot replay does not
// align exactly, refuse and let the caller re-read.
const RECOVERY_FUZZ_FACTOR = 0;

export interface RecoveryArgs {
	path: string;
	currentText: string;
	fileHash: string;
	edits: readonly Edit[];
	options?: ApplyOptions;
}

export interface RecoveryResult {
	/** Post-recovery text. */
	text: string;
	/** First changed line (1-indexed) relative to the live `currentText`, or `undefined`. */
	firstChangedLine: number | undefined;
	/** Warnings collected during recovery, including the user-facing recovery banner. */
	warnings: string[];
}

function applyEditsToSnapshot(
	previousText: string,
	currentText: string,
	edits: readonly Edit[],
	options: ApplyOptions,
	recoveryWarning: string,
): RecoveryResult | null {
	let applied: ApplyResult;
	try {
		applied = applyEdits(previousText, [...edits], options);
	} catch {
		return null;
	}
	if (applied.text === previousText) return null;

	const patch = Diff.structuredPatch("file", "file", previousText, applied.text, "", "", { context: 3 });
	const merged = Diff.applyPatch(currentText, patch, { fuzzFactor: RECOVERY_FUZZ_FACTOR });
	if (typeof merged !== "string" || merged === currentText) return null;

	const firstChangedLine = findFirstChangedLine(currentText, merged) ?? applied.firstChangedLine;
	const hasNetChange = firstChangedLine !== undefined;
	const warnings = hasNetChange ? [recoveryWarning, ...(applied.warnings ?? [])] : [...(applied.warnings ?? [])];

	return { text: merged, firstChangedLine, warnings };
}

function collectAnchorLines(edits: readonly Edit[]): number[] {
	const lines: number[] = [];
	for (const edit of edits) {
		for (const anchor of getEditAnchors(edit)) lines.push(anchor.line);
	}
	return lines;
}

function getEditAnchors(edit: Edit): Anchor[] {
	if (edit.kind === "delete") return [edit.anchor];
	if (edit.cursor.kind === "before_anchor") return [edit.cursor.anchor];
	if (edit.cursor.kind === "after_anchor") return [edit.cursor.anchor];
	return [];
}

/**
 * Returns true when every anchor line in `edits` has identical content in
 * `previousText` and `currentText`. The session-chain replay fast-path
 * requires this: if the prior in-session edit rewrote the line the model is
 * now re-targeting with a stale hash, replaying onto current would silently
 * overwrite the new content with whatever the model authored against the
 * old content — a corruption window, not a recovery.
 */
function verifyAnchorContent(previousText: string, currentText: string, edits: readonly Edit[]): boolean {
	const lines = collectAnchorLines(edits);
	if (lines.length === 0) return true;
	const prev = previousText.split("\n");
	const curr = currentText.split("\n");
	for (const line of lines) {
		const idx = line - 1;
		if (idx < 0 || idx >= prev.length || idx >= curr.length) return false;
		if (prev[idx] !== curr[idx]) return false;
	}
	return true;
}

function replaySessionChainOnCurrent(
	previousText: string,
	currentText: string,
	edits: readonly Edit[],
	options: ApplyOptions,
): RecoveryResult | null {
	// Two guards. Both required.
	//   - Equal line counts: every line number in `edits` still resolves to
	//     the same logical row (no insert/delete shifted indices).
	//   - Anchor-content alignment: the prior in-session edit didn't rewrite
	//     the very line the model is now re-targeting with a stale hash. If
	//     it did, replaying onto current would land the new payload on top
	//     of content the model never saw — corruption, not recovery.
	if (previousText.split("\n").length !== currentText.split("\n").length) return null;
	if (!verifyAnchorContent(previousText, currentText, edits)) return null;
	let applied: ApplyResult;
	try {
		applied = applyEdits(currentText, [...edits], options);
	} catch {
		return null;
	}
	if (applied.text === currentText) return null;
	return {
		text: applied.text,
		firstChangedLine: applied.firstChangedLine,
		warnings: [RECOVERY_SESSION_CHAIN_WARNING, ...(applied.warnings ?? [])],
	};
}

function buildSparseOverlayText(currentText: string, snapshotLines: ReadonlyMap<number, string>): string {
	const overlaid = currentText.split("\n");
	let maxCachedLine = 0;
	for (const lineNum of snapshotLines.keys()) {
		if (lineNum > maxCachedLine) maxCachedLine = lineNum;
	}
	while (overlaid.length < maxCachedLine) overlaid.push("");
	for (const [lineNum, content] of snapshotLines) {
		overlaid[lineNum - 1] = content;
	}
	return overlaid.join("\n");
}

/** First 1-indexed line at which `a` and `b` diverge, or `undefined` if equal. */
function findFirstChangedLine(a: string, b: string): number | undefined {
	if (a === b) return undefined;
	const aLines = a.split("\n");
	const bLines = b.split("\n");
	const max = Math.max(aLines.length, bLines.length);
	for (let i = 0; i < max; i++) {
		if (aLines[i] !== bLines[i]) return i + 1;
	}
	return undefined;
}

function isHeadSnapshot(head: Snapshot | null, snapshot: Snapshot): boolean {
	return head === snapshot;
}

/**
 * Stateless recovery driver over a {@link SnapshotStore}. Construct once and
 * call {@link Recovery.tryRecover} per stale-hash incident. The default
 * implementation tries three strategies in order:
 *
 * 1. Apply on the cached `fullText` snapshot, then 3-way-merge onto current.
 * 2. (Session chain) If the snapshot wasn't the head, retry on current text
 *    when line counts match — the user's previous edit advanced the hash but
 *    didn't shift line numbers.
 * 3. Reconstruct from a sparse snapshot (lines map only), verify the rebuilt
 *    text hashes to the expected value, then 3-way-merge.
 */
export class Recovery {
	constructor(readonly store: SnapshotStore) {}

	/**
	 * Attempt recovery. Returns `null` when no path forward is found — the
	 * caller should then surface a {@link MismatchError}.
	 */
	tryRecover(args: RecoveryArgs): RecoveryResult | null {
		const { path, currentText, fileHash, edits, options = {} } = args;
		const head = this.store.head(path);
		const snapshot = this.store.byHash(path, fileHash);
		if (!snapshot || snapshot.lines.size === 0) return null;

		const isHead = isHeadSnapshot(head, snapshot);
		const recoveryWarning = isHead ? RECOVERY_EXTERNAL_WARNING : RECOVERY_SESSION_CHAIN_WARNING;
		const isSessionChain = !isHead;

		if (snapshot.fullText !== undefined) {
			const merged = applyEditsToSnapshot(snapshot.fullText, currentText, edits, options, recoveryWarning);
			if (merged !== null) return merged;
			// Session-chain fast-path: prior in-session edit changed the same
			// line(s) the user is now re-targeting with the stale hash. When
			// line counts match, the edits' line numbers still resolve to the
			// right rows — replay onto the current text directly.
			if (isSessionChain) return replaySessionChainOnCurrent(snapshot.fullText, currentText, edits, options);
			return null;
		}

		const overlayText = buildSparseOverlayText(currentText, snapshot.lines);
		if (computeFileHash(overlayText) !== fileHash) return null;
		return applyEditsToSnapshot(overlayText, currentText, edits, options, recoveryWarning);
	}
}

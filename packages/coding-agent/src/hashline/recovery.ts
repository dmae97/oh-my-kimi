import * as Diff from "diff";
import { generateDiffString } from "../edit/diff";
import type { FileReadCache, FileReadSnapshot } from "../edit/file-read-cache";
import { applyHashlineEdits, type HashlineApplyResult } from "./apply";
import { computeFileHash } from "./hash";
import type { HashlineApplyOptions, HashlineEdit } from "./types";

export interface HashlineRecoveryArgs {
	cache: FileReadCache;
	absolutePath: string;
	currentText: string;
	fileHash: string;
	edits: HashlineEdit[];
	options: HashlineApplyOptions;
}

export interface HashlineRecoveryResult {
	lines: string;
	firstChangedLine: number | undefined;
	warnings: string[];
}

// Section hashes are line-precise; never let Diff.applyPatch slide a hunk onto a
// duplicate closer 100+ lines away. If snapshot replay does not align exactly,
// refuse and let the model re-read.
const HASHLINE_RECOVERY_FUZZ_FACTOR = 0;

const HASHLINE_RECOVERY_EXTERNAL_WARNING =
	"Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).";
const HASHLINE_RECOVERY_SESSION_CHAIN_WARNING =
	"Recovered from a stale file hash using an earlier in-session snapshot (the file hash advanced after a prior edit in this session).";
const HASHLINE_RECOVERY_SESSION_REPLAY_WARNING =
	"Recovered by replaying your edits onto the current file content — your previous edit in this session changed line(s) you re-targeted with a stale hash. Verify the diff matches your intent before continuing.";

function applyEditsToSnapshot(
	previousText: string,
	currentText: string,
	edits: HashlineEdit[],
	options: HashlineApplyOptions,
	recoveryWarning: string,
): HashlineRecoveryResult | null {
	let applied: HashlineApplyResult;
	try {
		applied = applyHashlineEdits(previousText, edits, options);
	} catch {
		return null;
	}
	if (applied.lines === previousText) return null;

	const patch = Diff.structuredPatch("file", "file", previousText, applied.lines, "", "", { context: 3 });
	const merged = Diff.applyPatch(currentText, patch, { fuzzFactor: HASHLINE_RECOVERY_FUZZ_FACTOR });
	if (typeof merged !== "string" || merged === currentText) return null;

	const mergedDiff = generateDiffString(currentText, merged);
	const hasNetChange = mergedDiff.firstChangedLine !== undefined;
	const recoveryWarnings = hasNetChange
		? [recoveryWarning, ...(applied.warnings ?? [])]
		: [...(applied.warnings ?? [])];

	return {
		lines: merged,
		firstChangedLine: mergedDiff.firstChangedLine ?? applied.firstChangedLine,
		warnings: recoveryWarnings,
	};
}

function replaySessionChainOnCurrent(
	previousText: string,
	currentText: string,
	edits: HashlineEdit[],
	options: HashlineApplyOptions,
): HashlineRecoveryResult | null {
	// Only safe when no insert/delete shifted line counts in the prior edit
	// chain: if total line counts match, every line number in `edits` still
	// resolves to the same logical row.
	if (previousText.split("\n").length !== currentText.split("\n").length) return null;
	let applied: HashlineApplyResult;
	try {
		applied = applyHashlineEdits(currentText, edits, options);
	} catch {
		return null;
	}
	if (applied.lines === currentText) return null;
	return {
		lines: applied.lines,
		firstChangedLine: applied.firstChangedLine,
		warnings: [HASHLINE_RECOVERY_SESSION_REPLAY_WARNING, ...(applied.warnings ?? [])],
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

function isHeadSnapshot(head: FileReadSnapshot | null, snapshot: FileReadSnapshot): boolean {
	return head === snapshot;
}

function resolveRecoveryWarning(head: FileReadSnapshot | null, snapshot: FileReadSnapshot): string {
	return isHeadSnapshot(head, snapshot) ? HASHLINE_RECOVERY_EXTERNAL_WARNING : HASHLINE_RECOVERY_SESSION_CHAIN_WARNING;
}

/**
 * Attempt to recover from a section file-hash mismatch by replaying the edits
 * against a cached pre-edit snapshot of the file and 3-way-merging the result
 * onto the current on-disk content. Returns `null` when no recovery is possible.
 */
export function tryRecoverHashlineWithCache(args: HashlineRecoveryArgs): HashlineRecoveryResult | null {
	const { cache, absolutePath, currentText, fileHash, edits, options } = args;
	const head = cache.get(absolutePath);
	const snapshot = cache.getByHash(absolutePath, fileHash);
	if (!snapshot || snapshot.lines.size === 0) return null;

	const recoveryWarning = resolveRecoveryWarning(head, snapshot);
	const isSessionChain = !isHeadSnapshot(head, snapshot);
	if (snapshot.fullText !== undefined) {
		const merged = applyEditsToSnapshot(snapshot.fullText, currentText, edits, options, recoveryWarning);
		if (merged !== null) return merged;
		// Session-chain fast-path: prior in-session edit changed the same line(s)
		// the model is now re-targeting with the stale hash. When line counts
		// match, the edits' line numbers still resolve to the right rows — replay
		// onto the current text directly.
		if (isSessionChain) return replaySessionChainOnCurrent(snapshot.fullText, currentText, edits, options);
		return null;
	}

	const overlayText = buildSparseOverlayText(currentText, snapshot.lines);
	if (computeFileHash(overlayText) !== fileHash) return null;
	return applyEditsToSnapshot(overlayText, currentText, edits, options, recoveryWarning);
}

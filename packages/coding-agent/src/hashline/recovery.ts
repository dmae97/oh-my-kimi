import * as Diff from "diff";
import { generateDiffString } from "../edit/diff";
import type { FileReadCache } from "../edit/file-read-cache";
import { HashlineMismatchError } from "./anchors";
import { applyHashlineEdits, type HashlineApplyResult } from "./apply";
import type { HashlineApplyOptions, HashlineEdit } from "./types";

export interface HashlineRecoveryArgs {
	cache: FileReadCache;
	absolutePath: string;
	currentText: string;
	edits: HashlineEdit[];
	options: HashlineApplyOptions;
}

export interface HashlineRecoveryResult {
	lines: string;
	firstChangedLine: number | undefined;
	warnings: string[];
}

const HASHLINE_RECOVERY_FUZZ_FACTOR = 3;

const HASHLINE_RECOVERY_WARNING =
	"Recovered from stale anchors using a previous read snapshot (file changed externally between read and edit).";

/**
 * Attempt to recover from a `HashlineMismatchError` by replaying the edits
 * against a cached pre-edit snapshot of the file and 3-way-merging the result
 * onto the current on-disk content. Returns `null` when no recovery is
 * possible — callers should propagate the original mismatch error in that
 * case.
 */
export function tryRecoverHashlineWithCache(args: HashlineRecoveryArgs): HashlineRecoveryResult | null {
	const { cache, absolutePath, currentText, edits, options } = args;
	const snapshot = cache.get(absolutePath);
	if (!snapshot || snapshot.lines.size === 0) return null;

	const overlaid = currentText.split("\n");
	let maxCachedLine = 0;
	for (const lineNum of snapshot.lines.keys()) {
		if (lineNum > maxCachedLine) maxCachedLine = lineNum;
	}
	while (overlaid.length < maxCachedLine) overlaid.push("");
	for (const [lineNum, content] of snapshot.lines) {
		overlaid[lineNum - 1] = content;
	}
	const previousText = overlaid.join("\n");
	if (previousText === currentText) return null;

	let applied: HashlineApplyResult;
	try {
		applied = applyHashlineEdits(previousText, edits, options);
	} catch (err) {
		if (err instanceof HashlineMismatchError) return null;
		throw err;
	}
	if (applied.lines === previousText) return null;

	const patch = Diff.structuredPatch("file", "file", previousText, applied.lines, "", "", { context: 3 });
	const merged = Diff.applyPatch(currentText, patch, { fuzzFactor: HASHLINE_RECOVERY_FUZZ_FACTOR });
	if (typeof merged !== "string" || merged === currentText) return null;

	const mergedDiff = generateDiffString(currentText, merged);
	const recoveryWarnings = [HASHLINE_RECOVERY_WARNING, ...(applied.warnings ?? [])];

	return {
		lines: merged,
		firstChangedLine: mergedDiff.firstChangedLine ?? applied.firstChangedLine,
		warnings: recoveryWarnings,
	};
}

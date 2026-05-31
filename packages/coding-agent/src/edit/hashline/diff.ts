/**
 * Read-only hashline diff preview helpers used by the streaming edit
 * renderer. Reads the target file, parses + applies the section's edits in
 * memory (no FS write, no LSP writethrough), then hands the before/after
 * pair to {@link generateDiffString} so the renderer can show the diff
 * while the tool call is still streaming.
 *
 * Uses the same snapshot-tag semantics as the apply path: a live content-hash
 * match is accepted even when the tag was minted by a source that did not keep
 * history, and stale tags recover through the session snapshot store when possible.
 */
import {
	type ApplyResult,
	applyEdits,
	computeFileHash,
	type Edit,
	Patch as HashlinePatch,
	hasBlockEdit,
	MismatchError,
	missingSnapshotTagMessage,
	normalizeToLF,
	type Patch,
	type PatchSection,
	parsePatchStreaming,
	Recovery,
	resolveBlockEdits,
	type SnapshotStore,
	stripBom,
} from "@oh-my-pi/hashline";
import { resolveToCwd } from "../../tools/path-utils";
import { generateDiffString } from "../diff";
import { readEditFileText } from "../read-file";
import { nativeBlockResolver } from "./block-resolver";

export interface HashlineDiffOptions {
	/**
	 * Use the streaming-tolerant applier ({@link PatchSection.applyPartialTo})
	 * so trailing in-flight ops do not throw or emit phantom edits. Streaming
	 * preview path only.
	 */
	streaming?: boolean;
	/**
	 * Skip snapshot-tag validation. Streaming previews use this so transient
	 * stale/missing tags do not flash re-read errors while the model is still
	 * authoring input; the final apply path still validates through Patcher.
	 */
	skipHashValidation?: boolean;
}

async function readSectionText(absolutePath: string, sectionPath: string): Promise<string> {
	try {
		return await readEditFileText(absolutePath, sectionPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(message || `Unable to read ${sectionPath}`);
	}
}

function hasAnchorScopedEdit(edits: readonly Edit[]): boolean {
	return edits.some(edit => {
		if (edit.kind === "delete") return true;
		if (edit.kind === "block") return true;
		return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor";
	});
}

function createMismatchError(
	section: PatchSection,
	absolutePath: string,
	normalized: string,
	snapshots: SnapshotStore,
	expected: string,
): MismatchError {
	return new MismatchError({
		path: section.path,
		expectedFileHash: expected,
		actualFileHash: computeFileHash(normalized),
		fileLines: normalized.split("\n"),
		anchorLines: section.collectAnchorLines(),
		hashRecognized: snapshots.byHash(absolutePath, expected) !== null,
	});
}

function parsePreviewEdits(section: PatchSection, streaming: boolean | undefined): readonly Edit[] {
	return streaming ? parsePatchStreaming(section.diff).edits : section.edits;
}

function resolvePreviewEdits(args: {
	section: PatchSection;
	absolutePath: string;
	normalized: string;
	snapshots: SnapshotStore;
	expected: string | undefined;
	liveMatches: boolean;
	edits: readonly Edit[];
}): readonly Edit[] {
	const { section, absolutePath, normalized, snapshots, expected, liveMatches, edits } = args;
	if (!hasBlockEdit(edits)) return edits;
	const baseText = expected === undefined || liveMatches ? normalized : snapshots.byHash(absolutePath, expected)?.text;
	if (baseText === undefined) {
		throw createMismatchError(section, absolutePath, normalized, snapshots, expected ?? "");
	}
	return resolveBlockEdits(edits, baseText, section.path, nativeBlockResolver, { onUnresolved: "throw" });
}

function applyPreviewEdits(args: {
	section: PatchSection;
	absolutePath: string;
	normalized: string;
	snapshots: SnapshotStore;
	options: HashlineDiffOptions;
}): ApplyResult {
	const { section, absolutePath, normalized, snapshots, options } = args;
	const expected = section.fileHash;
	if (!options.skipHashValidation && expected === undefined) {
		throw new Error(missingSnapshotTagMessage(section.path));
	}
	const liveMatches = expected !== undefined && computeFileHash(normalized) === expected;
	const edits = parsePreviewEdits(section, options.streaming);
	const resolved = resolvePreviewEdits({ section, absolutePath, normalized, snapshots, expected, liveMatches, edits });
	if (options.skipHashValidation || expected === undefined || liveMatches) return applyEdits(normalized, resolved);
	if (!hasAnchorScopedEdit(resolved)) return applyEdits(normalized, resolved);

	const recovered = new Recovery(snapshots).tryRecover({
		path: absolutePath,
		currentText: normalized,
		fileHash: expected,
		edits: resolved,
	});
	if (recovered) return recovered;
	throw createMismatchError(section, absolutePath, normalized, snapshots, expected);
}

export async function computeHashlineSectionDiff(
	section: PatchSection,
	cwd: string,
	snapshots: SnapshotStore,
	options: HashlineDiffOptions = {},
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
	try {
		const absolutePath = resolveToCwd(section.path, cwd);
		const rawContent = await readSectionText(absolutePath, section.path);
		const { text: content } = stripBom(rawContent);
		const normalized = normalizeToLF(content);
		const result = applyPreviewEdits({ section, absolutePath, normalized, snapshots, options });
		if (normalized === result.text) return { error: `No changes would be made to ${section.path}.` };
		return generateDiffString(normalized, result.text);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export async function computeHashlineDiff(
	input: { input: string },
	cwd: string,
	snapshots: SnapshotStore,
	options: HashlineDiffOptions = {},
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
	let patch: Patch;
	try {
		patch = HashlinePatch.parse(input.input, { cwd });
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
	if (patch.sections.length !== 1) {
		return { error: "Streaming diff preview supports exactly one hashline section." };
	}
	return computeHashlineSectionDiff(patch.sections[0], cwd, snapshots, options);
}

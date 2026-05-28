/**
 * Read-only hashline diff preview helpers used by the streaming edit
 * renderer. Reads the target file, parses + applies the section's edits in
 * memory (no FS write, no LSP writethrough), then hands the before/after
 * pair to {@link generateDiffString} so the renderer can show the diff
 * while the tool call is still streaming.
 *
 * Validation is intentionally light: only the section snapshot tag is checked
 * (so the preview goes red when anchors are stale), no plan-mode guards
 * and no auto-generated-file refusal — those belong on the write path.
 */
import {
	Patch as HashlinePatch,
	normalizeToLF,
	type Patch,
	type PatchSection,
	type Snapshot,
	type SnapshotStore,
	stripBom,
} from "@oh-my-pi/hashline";
import { resolveToCwd } from "../../tools/path-utils";
import { generateDiffString } from "../diff";
import { readEditFileText } from "../read-file";

export interface HashlineDiffOptions {
	/**
	 * Use the streaming-tolerant applier ({@link PatchSection.applyPartialTo})
	 * so trailing in-flight ops do not throw or emit phantom edits. Streaming
	 * preview path only.
	 */
	streaming?: boolean;
}

async function readSectionText(absolutePath: string, sectionPath: string): Promise<string> {
	try {
		return await readEditFileText(absolutePath, sectionPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(message || `Unable to read ${sectionPath}`);
	}
}

function hasAnchorScoped(section: PatchSection): boolean {
	return section.hasAnchorScopedEdit;
}

function snapshotMatchesCurrent(snapshot: Snapshot, currentText: string, anchorLines: readonly number[]): boolean {
	if (snapshot.fullText !== undefined) return snapshot.fullText === currentText;
	for (const lineNumber of anchorLines) {
		if (snapshot.get(lineNumber) === undefined) return false;
	}
	return snapshot.matchesLiveFile(currentText.split("\n"));
}

function validateSectionHash(
	section: PatchSection,
	absolutePath: string,
	text: string,
	snapshots: SnapshotStore,
): string | null {
	if (section.fileHash === undefined) {
		return hasAnchorScoped(section)
			? `Missing hashline snapshot tag for anchored edit to ${section.path}; use \`¶${section.path}#tag\` from your latest read.`
			: null;
	}
	const snapshot = snapshots.byHash(absolutePath, section.fileHash);
	if (snapshot && snapshotMatchesCurrent(snapshot, text, section.collectAnchorLines())) return null;
	return `Hashline snapshot tag mismatch for ${section.path}: section is bound to #${section.fileHash}, but current file does not match that snapshot; re-read and try again.`;
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
		const hashError = validateSectionHash(section, absolutePath, normalized, snapshots);
		if (hashError) return { error: hashError };
		const result = options.streaming ? section.applyPartialTo(normalized) : section.applyTo(normalized);
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

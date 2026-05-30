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
	missingSnapshotTagMessage,
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

function snapshotMatchesCurrent(snapshot: Snapshot, currentText: string): boolean {
	return snapshot.text === currentText;
}
function validateSectionHash(
	section: PatchSection,
	absolutePath: string,
	text: string,
	snapshots: SnapshotStore,
): string | null {
	if (section.fileHash === undefined) {
		// The snapshot tag is mandatory on every section — head/tail inserts
		// included — to keep this preview path in lockstep with the apply path
		// (`Patcher.prepare`), which rejects tagless sections unconditionally.
		return missingSnapshotTagMessage(section.path);
	}
	const snapshot = snapshots.byHash(absolutePath, section.fileHash);
	if (snapshot && snapshotMatchesCurrent(snapshot, text)) return null;
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

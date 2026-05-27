/**
 * Read-only hashline diff preview helpers used by the streaming edit
 * renderer. Reads the target file, parses + applies the section's edits in
 * memory (no FS write, no LSP writethrough), then hands the before/after
 * pair to {@link generateDiffString} so the renderer can show the diff
 * while the tool call is still streaming.
 *
 * Validation is intentionally light: only the section file hash is checked
 * (so the preview goes red when anchors are stale), no plan-mode guards
 * and no auto-generated-file refusal — those belong on the write path.
 */
import {
	applyEdits,
	computeFileHash,
	Patch as HashlinePatch,
	normalizeToLF,
	type Patch,
	type PatchSection,
	stripBom,
} from "@oh-my-pi/hashline";
import { resolveToCwd } from "../../tools/path-utils";
import { generateDiffString } from "../diff";
import { readEditFileText } from "../read-file";

export interface HashlineDiffOptions {
	autoDropPureInsertDuplicates?: boolean;
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

function validateSectionHash(section: PatchSection, text: string): string | null {
	if (section.fileHash === undefined) {
		return hasAnchorScoped(section)
			? `Missing hashline file hash for anchored edit to ${section.path}; use \`¶${section.path}#hash\` from your latest read.`
			: null;
	}
	const currentHash = computeFileHash(text);
	if (currentHash === section.fileHash) return null;
	return `Hashline file hash mismatch for ${section.path}: section is bound to #${section.fileHash}, but current file hashes to #${currentHash}; re-read and try again.`;
}

export async function computeHashlineSectionDiff(
	section: PatchSection,
	cwd: string,
	options: HashlineDiffOptions = {},
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
	try {
		const absolutePath = resolveToCwd(section.path, cwd);
		const rawContent = await readSectionText(absolutePath, section.path);
		const { text: content } = stripBom(rawContent);
		const normalized = normalizeToLF(content);
		const hashError = validateSectionHash(section, normalized);
		if (hashError) return { error: hashError };
		const result = applyEdits(normalized, [...section.edits], options);
		if (normalized === result.text) return { error: `No changes would be made to ${section.path}.` };
		return generateDiffString(normalized, result.text);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export async function computeHashlineDiff(
	input: { input: string; path?: string },
	cwd: string,
	options: HashlineDiffOptions = {},
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
	let patch: Patch;
	try {
		patch = HashlinePatch.parse(input.input, { cwd, path: input.path });
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
	if (patch.sections.length !== 1) {
		return { error: "Streaming diff preview supports exactly one hashline section." };
	}
	return computeHashlineSectionDiff(patch.sections[0], cwd, options);
}

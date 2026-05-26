import { generateDiffString } from "../edit/diff";
import { normalizeToLF, stripBom } from "../edit/normalize";
import { readEditFileText } from "../edit/read-file";
import { resolveToCwd } from "../tools/path-utils";
import { applyHashlineEdits } from "./apply";
import { parseHashline } from "./executor";
import { computeFileHash } from "./hash";
import { splitHashlineInputs } from "./input";
import type { HashlineApplyOptions, HashlineEdit, HashlineInputSection } from "./types";

async function readHashlineFileText(
	_file: { text(): Promise<string> },
	absolutePath: string,
	pathText: string,
): Promise<string> {
	try {
		return await readEditFileText(absolutePath, pathText);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(message || `Unable to read ${pathText}`);
	}
}

function hasAnchorScopedEdit(edits: readonly HashlineEdit[]): boolean {
	return edits.some(edit => {
		if (edit.kind === "delete") return true;
		return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor";
	});
}

function validateSectionHash(
	section: HashlineInputSection,
	text: string,
	edits: readonly HashlineEdit[],
): string | null {
	if (section.fileHash === undefined) {
		return hasAnchorScopedEdit(edits)
			? `Missing hashline file hash for anchored edit to ${section.path}; use \`¶${section.path}#hash\` from your latest read.`
			: null;
	}
	const currentHash = computeFileHash(text);
	if (currentHash === section.fileHash) return null;
	return `Hashline file hash mismatch for ${section.path}: section is bound to #${section.fileHash}, but current file hashes to #${currentHash}; re-read and try again.`;
}

export async function computeHashlineSectionDiff(
	section: HashlineInputSection,
	cwd: string,
	options: HashlineApplyOptions = {},
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
	try {
		const absolutePath = resolveToCwd(section.path, cwd);
		const rawContent = await readHashlineFileText(Bun.file(absolutePath), absolutePath, section.path);
		const { text: content } = stripBom(rawContent);
		const normalized = normalizeToLF(content);
		const { edits } = parseHashline(section.diff);
		const hashError = validateSectionHash(section, normalized, edits);
		if (hashError) return { error: hashError };
		const result = applyHashlineEdits(normalized, edits, options);
		if (normalized === result.lines) return { error: `No changes would be made to ${section.path}.` };
		return generateDiffString(normalized, result.lines);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export async function computeHashlineDiff(
	input: { input: string; path?: string },
	cwd: string,
	options: HashlineApplyOptions = {},
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
	let sections: HashlineInputSection[];
	try {
		sections = splitHashlineInputs(input.input, { cwd, path: input.path });
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
	if (sections.length !== 1) {
		return { error: "Streaming diff preview supports exactly one hashline section." };
	}
	return computeHashlineSectionDiff(sections[0], cwd, options);
}

import { generateDiffString } from "../edit/diff";
import { normalizeToLF, stripBom } from "../edit/normalize";
import { readEditFileText } from "../edit/read-file";
import { resolveToCwd } from "../tools/path-utils";
import { applyHashlineEdits } from "./apply";
import { type HashlineInputSection, splitHashlineInputs } from "./input";
import { parseHashline } from "./parser";
import type { HashlineApplyOptions } from "./types";

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
		const result = applyHashlineEdits(normalized, parseHashline(section.diff), options);
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

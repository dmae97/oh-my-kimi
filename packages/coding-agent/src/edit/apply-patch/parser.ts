/**
 * Parser for the Codex `apply_patch` envelope format.
 *
 *     *** Begin Patch
 *     *** Add File: <path>
 *     +<line>
 *     *** Delete File: <path>
 *     *** Update File: <path>
 *     *** Move to: <newpath>
 *     @@ <optional context>
 *     -old
 *     +new
 *      context
 *     *** End of File
 *     *** End Patch
 *
 * Input is the full envelope text (optionally heredoc-wrapped). Output is a
 * list of `PatchInput` records, each ready to hand to the existing
 * single-file `applyPatch()` in `../modes/patch.ts`.
 *
 * Per spec §4.3 Lenient mode: a `<<EOF` / `<<'EOF'` / `<<"EOF"` heredoc
 * wrapper around the whole envelope is stripped before parsing.
 */

import { ParseError } from "../diff";
import type { PatchInput } from "../modes/patch";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";

/**
 * Parse a Codex `*** Begin Patch` envelope into a list of single-file
 * patch inputs.
 */
export function parseApplyPatch(patchText: string): PatchInput[] {
	let lines = patchText.trim().split("\n");

	// Lenient heredoc strip: <<EOF / <<'EOF' / <<"EOF" ... EOF
	if (lines.length >= 2) {
		const first = lines[0];
		const last = lines[lines.length - 1].trim();
		const validOpeners = new Set(["<<EOF", "<<'EOF'", '<<"EOF"']);
		if (validOpeners.has(first) && last === "EOF") {
			lines = lines.slice(1, lines.length - 1);
		}
	}

	if (lines.length === 0 || lines[0].trim() !== BEGIN_PATCH_MARKER) {
		throw new ParseError("The first line of the patch must be '*** Begin Patch'");
	}
	if (lines[lines.length - 1].trim() !== END_PATCH_MARKER) {
		throw new ParseError("The last line of the patch must be '*** End Patch'");
	}

	const hunks: PatchInput[] = [];
	let remaining = lines.slice(1, lines.length - 1);
	// Line numbers are 1-based and include the `*** Begin Patch` line (= 1).
	let lineNumber = 2;

	while (remaining.length > 0) {
		// Blank separator lines between hunks are ignored (spec §3.3).
		if (remaining[0].trim() === "") {
			remaining = remaining.slice(1);
			lineNumber++;
			continue;
		}

		const firstLine = remaining[0].trim();

		if (firstLine.startsWith(ADD_FILE_MARKER)) {
			const path = firstLine.slice(ADD_FILE_MARKER.length);
			let contents = "";
			let consumed = 1;

			for (let i = 1; i < remaining.length; i++) {
				const line = remaining[i];
				if (line.startsWith("+")) {
					contents += `${line.slice(1)}\n`;
					consumed++;
				} else {
					break;
				}
			}

			hunks.push({ path, op: "create", diff: contents });
			remaining = remaining.slice(consumed);
			lineNumber += consumed;
			continue;
		}

		if (firstLine.startsWith(DELETE_FILE_MARKER)) {
			const path = firstLine.slice(DELETE_FILE_MARKER.length);
			hunks.push({ path, op: "delete" });
			remaining = remaining.slice(1);
			lineNumber++;
			continue;
		}

		if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
			const path = firstLine.slice(UPDATE_FILE_MARKER.length);
			remaining = remaining.slice(1);
			lineNumber++;

			let movePath: string | undefined;
			if (remaining.length > 0 && remaining[0].startsWith(MOVE_TO_MARKER)) {
				movePath = remaining[0].slice(MOVE_TO_MARKER.length);
				remaining = remaining.slice(1);
				lineNumber++;
			}

			// The body runs until the next file-op marker or end of input.
			// `*** End of File` is a chunk-terminator and stays inside the body —
			// the downstream unified-diff parser handles it.
			const diffLines: string[] = [];
			while (remaining.length > 0) {
				const line = remaining[0];
				if (
					line.startsWith("*** Add File:") ||
					line.startsWith("*** Delete File:") ||
					line.startsWith("*** Update File:")
				) {
					break;
				}
				diffLines.push(line);
				remaining = remaining.slice(1);
				lineNumber++;
			}

			if (diffLines.length === 0) {
				throw new ParseError(`Update file hunk for path '${path}' is empty`, lineNumber);
			}

			hunks.push({ path, op: "update", rename: movePath, diff: diffLines.join("\n") });
			continue;
		}

		throw new ParseError(
			`'${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
			lineNumber,
		);
	}

	return hunks;
}

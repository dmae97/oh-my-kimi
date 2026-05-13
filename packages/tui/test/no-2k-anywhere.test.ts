/**
 * Lint guard against reintroducing `\x1b[2K` (erase-entire-line) in TUI
 * render paths.
 *
 * Background: previous render paths emitted `\x1b[2K` BEFORE the new line
 * content, all wrapped in BSU. When BSU mode 2026 splits across PTY reads
 * in tmux + ghostty (~4 KB chunks), the erase reaches the terminal before
 * the content payload, leaving a one-frame blank line. We migrated all
 * four occurrences to the inverse pattern (`\x1b[m\x1b[K` AFTER content)
 * in commit `4d412b63a`. This test exists so a future "convenient"
 * reintroduction gets caught at CI time instead of after a release.
 *
 * Scope: scans every `.ts` file under `packages/tui/src/` for the byte
 * sequence `\x1b[2K` inside a string literal (single quote, double quote,
 * or template literal). Allows the sequence in comments and docstrings —
 * we reference it in prose all over the codebase.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function* walkTs(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			yield* walkTs(full);
		} else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
			yield full;
		}
	}
}

function stripComments(source: string): string {
	// Drop `//` line comments and `/* … */` block comments. Crude but
	// adequate for a no-substring guard — false positives only happen when
	// the literal sequence sits INSIDE a comment that contains a quote on
	// the same line, which never happens in this codebase.
	return source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const LITERAL_2K = /["'`]\\x1b\[2K["'`]/;

describe("no `\x1b[2K` in TUI source", () => {
	it("no string literal in packages/tui/src emits `\\x1b[2K`", () => {
		const tuiSrc = join(import.meta.dir, "..", "src");
		const offenders: { file: string; line: number; text: string }[] = [];
		for (const file of walkTs(tuiSrc)) {
			const raw = readFileSync(file, "utf-8");
			const stripped = stripComments(raw);
			if (!LITERAL_2K.test(stripped)) continue;
			// Found one — locate the precise line(s) in the ORIGINAL source
			// for a useful error report. Iterating over the stripped source
			// would lose line numbers.
			const rawLines = raw.split("\n");
			const strippedLines = stripComments(raw).split("\n");
			for (let i = 0; i < strippedLines.length; i++) {
				if (LITERAL_2K.test(strippedLines[i])) {
					offenders.push({ file, line: i + 1, text: rawLines[i].trim() });
				}
			}
		}
		expect(
			offenders,
			`Found \`\\x1b[2K\` literals in TUI source. Use \`\\x1b[m\\x1b[K\` AFTER the new line content instead — emit-before-content erase causes a BSU-split blank flash in tmux. Offenders:\n${offenders.map(o => `  ${o.file}:${o.line}: ${o.text}`).join("\n")}`,
		).toEqual([]);
	});
});

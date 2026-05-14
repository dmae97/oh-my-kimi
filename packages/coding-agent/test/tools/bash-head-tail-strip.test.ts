import { describe, expect, it } from "bun:test";
import {
	type BashFixupResult,
	formatHeadTailStripNotice,
	stripTrailingHeadTail,
} from "../../src/tools/bash-command-fixup";

function strip(command: string): BashFixupResult {
	return stripTrailingHeadTail(command);
}

describe("stripTrailingHeadTail — strips harmless trailing limits", () => {
	const cases: Array<[string, string, string]> = [
		// [input, expected command, expected stripped suffix]
		["ls | head", "ls", "| head"],
		["ls | head -5", "ls", "| head -5"],
		["ls | head -n 5", "ls", "| head -n 5"],
		["ls | head -n5", "ls", "| head -n5"],
		["ls | head -n=5", "ls", "| head -n=5"],
		["ls | head -c 100", "ls", "| head -c 100"],
		["ls | head --lines=20", "ls", "| head --lines=20"],
		["ls | head --lines 20", "ls", "| head --lines 20"],
		["ls | head --quiet -5", "ls", "| head --quiet -5"],
		["ls | tail", "ls", "| tail"],
		["ls | tail -5", "ls", "| tail -5"],
		["ls | tail -n 5", "ls", "| tail -n 5"],
		["ls | tail --bytes=200", "ls", "| tail --bytes=200"],
		["ls|head", "ls", "|head"],
		["ls |  tail   -20  ", "ls", "|  tail   -20"],
		// cd/sub-pipeline preserved; only the trailing limit goes
		["git log --oneline | head -20", "git log --oneline", "| head -20"],
		["echo a | tr a b | head -3", "echo a | tr a b", "| head -3"],
		// command with stderr redirect before the limit stays intact
		["cargo build 2>&1 | head -50", "cargo build 2>&1", "| head -50"],
	];

	for (const [input, expectedCommand, expectedStripped] of cases) {
		it(`strips: ${input}`, () => {
			const out = strip(input);
			expect(out.command).toBe(expectedCommand);
			expect(out.stripped).toBe(expectedStripped);
		});
	}
});

describe("stripTrailingHeadTail — preserves semantics-bearing pipelines", () => {
	const untouched: string[] = [
		// follow-mode and file readers
		"tail -f /var/log/system.log",
		"tail -F file.log",
		"ls | tail -f -",
		// non-trailing head/tail
		"ls | head -5 | sort",
		"cat file | head -5 | wc -l",
		// +N offset (skip-first semantics, not a limit)
		"cat file | tail -n +2",
		"cat file | tail +5",
		// downstream commands / operators
		"ls | head -5 && echo done",
		"ls | head -5 || echo failed",
		"ls | head -5 ; echo done",
		"ls | head -5 &",
		// redirects on head's output
		"ls | head -5 > /tmp/out.txt",
		"ls | head -5 2>/dev/null",
		// inside a string / subshell — anchored end is `"` or `)`
		'echo "ls | head -5"',
		"echo $(ls | head -5)",
		// no `|` at all
		"head -5 file.txt",
		"head /etc/hosts",
		// would reduce to empty
		"| head -5",
		"head -5",
		// multiline scripts: head bounds a loop body, must stay
		"for f in *.txt; do\n  echo $f\ndone | head -5",
		"cat <<EOF | head -5\ncontent\nEOF",
		"ls\nls | head -5",
	];

	for (const input of untouched) {
		it(`leaves alone: ${JSON.stringify(input)}`, () => {
			const out = strip(input);
			expect(out.command).toBe(input);
			expect(out.stripped).toBeUndefined();
		});
	}
});

describe("formatHeadTailStripNotice", () => {
	it("returns undefined when nothing was stripped", () => {
		expect(formatHeadTailStripNotice(undefined)).toBeUndefined();
	});

	it("embeds the stripped segment in the notice", () => {
		const notice = formatHeadTailStripNotice("| head -5");
		expect(notice).toContain("| head -5");
		expect(notice).toContain("artifact://");
	});
});

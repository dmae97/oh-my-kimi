import { describe, expect, it } from "bun:test";
import { applyBashFixups, type BashFixupResult, formatBashFixupNotice } from "../../src/tools/bash-command-fixup";

function fixup(command: string): BashFixupResult {
	return applyBashFixups(command);
}

describe("applyBashFixups — strips harmless trailing head/tail", () => {
	const cases: Array<[string, string, string[]]> = [
		// [input, expected command, expected stripped list]
		["ls | head", "ls", ["| head"]],
		["ls | head -5", "ls", ["| head -5"]],
		["ls | head -n 5", "ls", ["| head -n 5"]],
		["ls | head -n5", "ls", ["| head -n5"]],
		["ls | head -n=5", "ls", ["| head -n=5"]],
		["ls | head -c 100", "ls", ["| head -c 100"]],
		["ls | head --lines=20", "ls", ["| head --lines=20"]],
		["ls | head --lines 20", "ls", ["| head --lines 20"]],
		["ls | head --quiet -5", "ls", ["| head --quiet -5"]],
		["ls | tail", "ls", ["| tail"]],
		["ls | tail -5", "ls", ["| tail -5"]],
		["ls | tail -n 5", "ls", ["| tail -n 5"]],
		["ls | tail --bytes=200", "ls", ["| tail --bytes=200"]],
		["ls|head", "ls", ["|head"]],
		["ls |  tail   -20  ", "ls", ["|  tail   -20"]],
		["git log --oneline | head -20", "git log --oneline", ["| head -20"]],
		["echo a | tr a b | head -3", "echo a | tr a b", ["| head -3"]],
		// `|&` (pipe stdout+stderr) is recognized as a pipe too.
		["just build |& head -5", "just build", ["|& head -5"]],
	];

	for (const [input, expectedCommand, expectedStripped] of cases) {
		it(`strips: ${input}`, () => {
			const out = fixup(input);
			expect(out.command).toBe(expectedCommand);
			expect(out.stripped).toEqual(expectedStripped);
		});
	}
});

describe("applyBashFixups — strips redundant 2>&1", () => {
	const cases: Array<[string, string, string[]]> = [
		["cmd 2>&1", "cmd", ["2>&1"]],
		["just build 2>&1", "just build", ["2>&1"]],
		// Combined: trailing `| tail -3` then leftover `2>&1`.
		["just build 2>&1 | tail -3", "just build", ["| tail -3", "2>&1"]],
		["cargo build 2>&1 | head -50", "cargo build", ["| head -50", "2>&1"]],
	];

	for (const [input, expectedCommand, expectedStripped] of cases) {
		it(`strips: ${input}`, () => {
			const out = fixup(input);
			expect(out.command).toBe(expectedCommand);
			expect(out.stripped).toEqual(expectedStripped);
		});
	}
});

describe("applyBashFixups — strips across compound commands", () => {
	const cases: Array<[string, string, string[]]> = [
		[
			"just build 2>&1 | tail -3 && just up && sleep 4 && just healthz",
			"just build && just up && sleep 4 && just healthz",
			["| tail -3", "2>&1"],
		],
		["cmd1 | head -5 && cmd2 && cmd3 | tail -3", "cmd1 && cmd2 && cmd3", ["| head -5", "| tail -3"]],
		["echo a; cmd | head -5; echo b", "echo a; cmd; echo b", ["| head -5"]],
		["cmd | head -5 || fallback | tail -3", "cmd || fallback", ["| head -5", "| tail -3"]],
		// Only the head/tail-bearing segment gets touched; cmd2's stderr merge survives.
		["cmd1 | head -5 && cmd2 2>&1 | grep err", "cmd1 && cmd2 2>&1 | grep err", ["| head -5"]],
	];

	for (const [input, expectedCommand, expectedStripped] of cases) {
		it(`strips: ${input}`, () => {
			const out = fixup(input);
			expect(out.command).toBe(expectedCommand);
			expect(out.stripped).toEqual(expectedStripped);
		});
	}
});

describe("applyBashFixups — preserves semantics-bearing pipelines", () => {
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
		// redirects on head's output
		"ls | head -5 > /tmp/out.txt",
		"ls | head -5 2>/dev/null",
		// inside a string / subshell — top-level end is `"` or `)`
		'echo "ls | head -5"',
		"echo $(ls | head -5)",
		// no `|` at all
		"head -5 file.txt",
		"head /etc/hosts",
		// would reduce to empty
		"| head -5",
		"head -5",
		// 2>&1 with other redirects or piped consumer — must stay
		"cmd 2>&1 | grep err",
		"cmd > file 2>&1",
		"cmd >& file",
		"cmd 2>&1 > file",
		// bail-outs: multi-line / heredoc / unbalanced quotes
		"for f in *.txt; do\n  echo $f\ndone | head -5",
		"cat <<EOF | head -5\ncontent\nEOF",
		"ls\nls | head -5",
		'echo "unterminated | head -5',
	];

	for (const input of untouched) {
		it(`leaves alone: ${JSON.stringify(input)}`, () => {
			const out = fixup(input);
			expect(out.command).toBe(input);
			expect(out.stripped).toEqual([]);
		});
	}
});

describe("formatBashFixupNotice", () => {
	it("returns undefined when nothing was stripped", () => {
		expect(formatBashFixupNotice([])).toBeUndefined();
	});

	it("embeds a single stripped segment in the notice", () => {
		const notice = formatBashFixupNotice(["| head -5"]);
		expect(notice).toContain("`| head -5`");
		expect(notice).toContain("stderr is already merged");
	});

	it("joins multiple stripped segments with commas", () => {
		const notice = formatBashFixupNotice(["| tail -3", "2>&1"]);
		expect(notice).toContain("`| tail -3`");
		expect(notice).toContain("`2>&1`");
		expect(notice).toMatch(/`\| tail -3`,\s*`2>&1`/);
	});
});

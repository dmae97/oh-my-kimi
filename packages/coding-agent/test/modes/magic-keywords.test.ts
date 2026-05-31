import { beforeAll, describe, expect, it } from "bun:test";
import { highlightMagicKeywords } from "../../src/modes/magic-keywords";
import { initTheme } from "../../src/modes/theme/theme";

beforeAll(async () => {
	// Gradient palettes read the active theme's color mode.
	await initTheme(false);
});

describe("highlightMagicKeywords", () => {
	it("paints every magic keyword in a single prose pass, preserving visible text", () => {
		const input = "first ultrathink then orchestrate the workflow";
		const decorated = highlightMagicKeywords(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b[38");
		expect(Bun.stripANSI(decorated)).toBe(input);
		// Each keyword is gradient-painted character-by-character, so none survives as a
		// contiguous run in the decorated output.
		for (const keyword of ["ultrathink", "orchestrate", "workflow"]) {
			expect(decorated).not.toContain(keyword);
			expect(Bun.stripANSI(decorated)).toContain(keyword);
		}
	});

	it("never paints keywords inside code spans, fenced blocks, or XML sections", () => {
		const input = "`ultrathink`\n```\norchestrate\n```\n<x>workflow</x>";
		expect(highlightMagicKeywords(input)).toBe(input);
	});

	it("paints only the prose occurrence when the keyword also appears in code", () => {
		const decorated = highlightMagicKeywords("`orchestrate` but please orchestrate now");
		// The code-span occurrence stays literal; the prose one is split by gradient escapes.
		expect(decorated).toContain("`orchestrate`");
		expect(Bun.stripANSI(decorated)).toBe("`orchestrate` but please orchestrate now");
		// Exactly one prose occurrence painted ⇒ one contiguous "orchestrate" remains (the code one).
		expect(decorated.split("orchestrate").length - 1).toBe(1);
	});

	it("restores the supplied foreground after each painted keyword", () => {
		const reset = "\x1b[38;2;1;2;3m";
		const decorated = highlightMagicKeywords("go orchestrate go", reset);
		expect(decorated).toContain(reset);
		// The reset must land before the trailing prose so it keeps the bubble color.
		expect(decorated.endsWith(`${reset} go`)).toBe(true);
	});
});

import { describe, expect, it } from "bun:test";
import {
	formatTitleUserMessage,
	isLowSignalTitleInput,
	MAX_TITLE_INPUT_CHARS,
	NO_TITLE_SENTINEL,
	normalizeGeneratedTitle,
	prepareTitleInput,
	stripCodeBlocks,
} from "@oh-my-pi/pi-coding-agent/tiny/text";

describe("stripCodeBlocks", () => {
	it("drops fenced code blocks but keeps the surrounding prose", () => {
		const message = "lets plan a setup screen together.\n```\nsome mockup\n```\nit should only show once.";
		const stripped = stripCodeBlocks(message);
		expect(stripped).not.toContain("some mockup");
		expect(stripped).toContain("plan a setup screen");
		expect(stripped).toContain("it should only show once.");
	});

	it("removes literal noise inside a pasted mockup (the reported regression)", () => {
		// A small title model titled this session "Setup Screen for Claude Code v2.1.158"
		// because the version string lived inside the fenced mockup.
		const message =
			"lets plan a setup screen together.\nSomething like\n```\nWelcome to Claude Code v2.1.158\n[splash]\n1. Auto\n2. Dark mode\n```\nsteps: pick provider, pick theme";
		const stripped = stripCodeBlocks(message);
		expect(stripped).not.toContain("Claude Code v2.1.158");
		expect(stripped).toContain("pick provider, pick theme");
	});

	it("handles an unterminated fence by stripping to end of message", () => {
		const stripped = stripCodeBlocks("describe the bug\n```\nthrows here and never closes");
		expect(stripped).toBe("describe the bug");
	});

	it("keeps inline code (single backticks) as high-signal context", () => {
		const stripped = stripCodeBlocks("wire up the `/login` provider step");
		expect(stripped).toContain("`/login`");
	});

	it("falls back to the original when the message is essentially only a code block", () => {
		const message = "```python\ndef merge_sort(a):\n    return a\n```";
		expect(stripCodeBlocks(message)).toBe(message);
	});

	it("returns prose unchanged when there is no code block", () => {
		expect(stripCodeBlocks("Investigate the resolver")).toBe("Investigate the resolver");
	});
});

describe("prepareTitleInput", () => {
	it("strips code blocks before bounding length", () => {
		const message = `intro prose ${"x".repeat(MAX_TITLE_INPUT_CHARS)}\n\`\`\`\n${"y".repeat(5000)}\n\`\`\``;
		const prepared = prepareTitleInput(message);
		expect(prepared).not.toContain("yyyy");
		expect(prepared.length).toBeLessThanOrEqual(MAX_TITLE_INPUT_CHARS + 1); // +1 for the ellipsis
	});
});

describe("formatTitleUserMessage", () => {
	it("wraps stripped content in user-message tags", () => {
		const formatted = formatTitleUserMessage("plan a thing\n```\nnoise\n```");
		expect(formatted.startsWith("<user-message>\n")).toBe(true);
		expect(formatted.endsWith("\n</user-message>")).toBe(true);
		expect(formatted).toContain("plan a thing");
		expect(formatted).not.toContain("noise");
	});
});

describe("normalizeGeneratedTitle", () => {
	it("returns the cleaned first line of a real title", () => {
		expect(normalizeGeneratedTitle('"Investigate the resolver"')).toBe("Investigate The Resolver");
		expect(normalizeGeneratedTitle("Investigate the resolver.")).toBe("Investigate The Resolver");
	});

	it("treats the bare none sentinel as no title (case/punctuation-insensitive)", () => {
		expect(NO_TITLE_SENTINEL).toBe("none");
		expect(normalizeGeneratedTitle("none")).toBeNull();
		expect(normalizeGeneratedTitle("None.")).toBeNull();
		expect(normalizeGeneratedTitle('"none"')).toBeNull();
	});

	it("keeps a title that merely contains the word none", () => {
		expect(normalizeGeneratedTitle("Explain python None keyword")).toBe("Explain Python None Keyword");
	});

	it("returns null for empty or whitespace-only output", () => {
		expect(normalizeGeneratedTitle("")).toBeNull();
		expect(normalizeGeneratedTitle("   ")).toBeNull();
		expect(normalizeGeneratedTitle(null)).toBeNull();
	});
});

describe("isLowSignalTitleInput", () => {
	it("treats greetings and acknowledgements as low signal (defer)", () => {
		for (const msg of [
			"hi",
			"Hi!",
			"hey there",
			"hello :)",
			"good morning",
			"thanks!",
			"ok cool",
			"yo",
			"test",
			"ping",
		]) {
			expect(isLowSignalTitleInput(msg)).toBe(true);
		}
	});

	it("treats empty / punctuation / emoji-only input as low signal", () => {
		expect(isLowSignalTitleInput("")).toBe(true);
		expect(isLowSignalTitleInput("   ")).toBe(true);
		expect(isLowSignalTitleInput("👋👋")).toBe(true);
		expect(isLowSignalTitleInput("?!")).toBe(true);
		expect(isLowSignalTitleInput("42")).toBe(true);
	});

	it("treats messages with a real task as title-worthy", () => {
		for (const msg of [
			"fix the resolver bug",
			"deploy",
			"hi, can you fix the login flow",
			"add a test for the parser",
			"what does this regex do",
		]) {
			expect(isLowSignalTitleInput(msg)).toBe(false);
		}
	});
});

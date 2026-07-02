import { describe, expect, it } from "bun:test";
import { clearRenderCache, Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

// E2 contract: the streaming incremental lexer (lex(prefix) ++ lex(tail), reusing
// frozen blank-line-bounded blocks) must produce BYTE-IDENTICAL output to a fresh
// full lex of the same text at every growth step. A faster-but-divergent render is
// a regression, so this is the gate that keeps E2 honest.
//
// Masking hazard: Markdown's module-level L2 render cache keys on (text, width),
// so a streaming render that produced WRONG lines would cache them and the "fresh"
// oracle would read the same wrong lines back. We `clearRenderCache()` around the
// oracle so it always cold-lexes, and again so the next streaming render cannot
// hit a stale entry — the streaming instance must go through its own incremental
// `#lexTokens` path every step.

const THEME = defaultMarkdownTheme;

function renderCold(text: string, width: number): readonly string[] {
	clearRenderCache();
	const out = new Markdown(text, 0, 0, THEME).render(width);
	clearRenderCache();
	return out;
}

/** Reveal `full` in `step`-char increments through ONE reused (streaming) instance
 *  and assert each step matches a cold full-lex render of the same prefix. */
function assertIdenticalGrowth(full: string, width = 60, step = 13): void {
	const streaming = new Markdown("", 0, 0, THEME);
	for (let len = 1; len <= full.length; len += step) {
		const slice = full.slice(0, len);
		clearRenderCache();
		streaming.setText(slice);
		const streamLines = streaming.render(width);
		const oracle = renderCold(slice, width);
		expect(streamLines).toEqual(oracle);
	}
	clearRenderCache();
	streaming.setText(full);
	const streamLines = streaming.render(width);
	expect(streamLines).toEqual(renderCold(full, width));
}

/** Same as {@link assertIdenticalGrowth} but with a TRANSIENT streaming instance,
 *  which activates Markdown's render-prefix cache (the transient path caches
 *  content lines for the stable lex-prefix tokens and re-renders only the tail).
 *  The split render must still be byte-identical to a cold full render at every
 *  step — a faster-but-divergent split is a regression. */
function assertIdenticalGrowthTransient(full: string, width = 60, step = 13): void {
	const streaming = new Markdown("", 0, 0, THEME);
	streaming.transientRenderCache = true;
	for (let len = 1; len <= full.length; len += step) {
		const slice = full.slice(0, len);
		clearRenderCache();
		streaming.setText(slice);
		const streamLines = streaming.render(width);
		const oracle = renderCold(slice, width);
		expect(streamLines).toEqual(oracle);
	}
	clearRenderCache();
	streaming.setText(full);
	const streamLines = streaming.render(width);
	expect(streamLines).toEqual(renderCold(full, width));
}

const PROSE =
	"Para one with **bold** and _italic_ words and a `code span` for flavor.\n\n" +
	"Para two continues the document with more sentences so the lexer has real\n" +
	"block structure to chew on, then a third paragraph grows at the tail end as\n\n" +
	"the stream appends additional content token by token over many frames here.";

const FENCED =
	"Intro paragraph before the code block begins streaming in slowly.\n\n" +
	"```ts\nconst x: number = compute(a, b) + delta;\nfor (let i = 0; i < x; i++) {\n  emit(i);\n}\nreturn x.toFixed(2);\n```\n\n" +
	"Trailing prose after the fence keeps growing with more and more sentences.";

const LIST =
	"Lead-in sentence before the list.\n\n" +
	"- first bullet item with `inline`\n- second bullet item in **bold**\n- third bullet item\n\n" +
	"1. ordered one\n2. ordered two\n3. ordered three\n\n" +
	"Closing paragraph that keeps streaming additional words to the very end here.";

const HEADINGS =
	"# Title heading\n\nIntro text under the title with some detail.\n\n" +
	"## Section two\n\nBody of section two grows over time.\n\n" +
	"### Subsection\n\nDeeper content that streams in at the tail as the reveal advances.";

const MIXED = (() => {
	const para =
		"The quick brown fox jumps over the lazy dog while a `code span` and **bold** _italic_ exercise things. ";
	const cb = "\n```ts\nconst x = compute(a, b);\nreturn x;\n```\n\n";
	const list = "\n- one\n- two `inline`\n- three\n\n";
	let out = "";
	for (let i = 1; i <= 6; i++) out += `## Section ${i}\n\n${para}${para}${cb}${list}`;
	return out;
})();

describe("Markdown incremental streaming lex (E2)", () => {
	it("prose growth is byte-identical to full lex", () => {
		assertIdenticalGrowth(PROSE);
	});

	it("fenced code growth (open then close) is byte-identical", () => {
		assertIdenticalGrowth(FENCED);
	});

	it("list growth is byte-identical", () => {
		assertIdenticalGrowth(LIST);
	});

	it("heading growth is byte-identical", () => {
		assertIdenticalGrowth(HEADINGS);
	});

	it("mixed multi-section corpus growth is byte-identical", () => {
		assertIdenticalGrowth(MIXED, 80, 29);
	});

	it("transient render-prefix cache: prose split render is byte-identical", () => {
		assertIdenticalGrowthTransient(PROSE);
	});

	it("transient render-prefix cache: fenced code split render is byte-identical", () => {
		assertIdenticalGrowthTransient(FENCED);
	});

	it("transient render-prefix cache: mixed multi-section split render is byte-identical", () => {
		assertIdenticalGrowthTransient(MIXED, 80, 29);
	});

	it("a width change mid-stream still matches a cold render at the new width", () => {
		const streaming = new Markdown("", 0, 0, THEME);
		// Warm the stream cache at width 80 across the whole message.
		for (let len = 1; len <= MIXED.length; len += 41) {
			clearRenderCache();
			streaming.setText(MIXED.slice(0, len));
			streaming.render(80);
		}
		// Now render the full text at a NARROWER width: frozen tokens are width-
		// independent, so output must match a cold full lex at the new width.
		clearRenderCache();
		streaming.setText(MIXED);
		const narrow = streaming.render(40);
		expect(narrow).toEqual(renderCold(MIXED, 40));
		// And back to a wider width.
		clearRenderCache();
		const wide = streaming.render(100);
		expect(wide).toEqual(renderCold(MIXED, 100));
	});

	it("reference-link definitions (fallback path) still render correctly while growing", () => {
		const refDoc =
			"See [the docs][d] and [the spec][s] for details on the protocol.\n\n" +
			"A middle paragraph with ordinary prose that keeps growing here.\n\n" +
			"[d]: https://example.com/docs\n[s]: https://example.com/spec\n\n" +
			"Closing paragraph streamed at the tail with extra sentences appended.";
		assertIdenticalGrowth(refDoc);
	});

	// Regression: HAS_REF_DEF must also catch labels with backslash-escaped
	// brackets (`[a\]b]: …`). marked resolves such a definition document-wide,
	// so if the detector misses it the already-frozen paragraph keeps its plain
	// text inline tokens while a cold lex rewrites `[a\]b]` into a link.
	it("an escaped-bracket reference definition falls back to a correct full render", () => {
		const escapedRef =
			"See [a\\]b] for details in the long discussion that follows below.\n\n" +
			"More prose streams in before the definition finally arrives down here.\n\n" +
			"[a\\]b]: https://example.com/escaped\n\n" +
			"Trailing paragraph after the definition keeps the stream going on.";
		assertIdenticalGrowth(escapedRef, 60, 1);
		assertIdenticalGrowth(escapedRef, 60, 13);
	});

	// Regression: marked merges a list with a following same-marker list across a
	// blank line into one renumbered loose list (CommonMark loose-list
	// continuation). Freezing across that "\n\n" cut keeps them separate and
	// renumbers/spaces wrong. These cases must hold at the production reveal
	// granularity (MIN_STEP=3) and at step=1 — the divergence is phase-sensitive.
	it("two consecutive ordered lists stay merged/renumbered while growing", () => {
		const twoLists = "1. a\n2. b\n\n1. c\n2. d";
		assertIdenticalGrowth(twoLists, 60, 1);
		assertIdenticalGrowth(twoLists, 60, 3);
	});

	it("a loose ordered list (blank lines between items) stays correct while growing", () => {
		const loose =
			"Intro line before the numbered list begins here.\n\n" +
			"1. First point with enough words to wrap nicely.\n\n" +
			"2. Second point also with sufficient words here.\n\n" +
			"3. Third and final point streamed at the tail end.";
		assertIdenticalGrowth(loose, 60, 1);
		assertIdenticalGrowth(loose, 60, 3);
	});

	it("a loose bullet list stays correct while growing", () => {
		const loose =
			"Lead-in before the bullets.\n\n" +
			"- alpha item with several words to wrap\n\n" +
			"- beta item with several words to wrap\n\n" +
			"- gamma item streamed at the tail end here.";
		assertIdenticalGrowth(loose, 60, 1);
		assertIdenticalGrowth(loose, 60, 3);
	});

	it("a non-append change (text replaced) falls back to a correct full render", () => {
		const streaming = new Markdown("", 0, 0, THEME);
		clearRenderCache();
		streaming.setText("# First document\n\nOriginal body paragraph one.\n\nOriginal body paragraph two.\n");
		streaming.render(60);
		// Replace with unrelated content that is NOT a prefix-extension.
		clearRenderCache();
		streaming.setText("## Different\n\nCompletely new content replacing the old buffer entirely.\n");
		const replaced = streaming.render(60);
		expect(replaced).toEqual(
			renderCold("## Different\n\nCompletely new content replacing the old buffer entirely.\n", 60),
		);
	});

	it("a transient non-append replacement with no block boundary is not served stale prefix lines", () => {
		// Regression: the render-prefix cache guards on #streamPrefixText, which
		// #freezeStablePrefix leaves untouched when the new text has no freezable
		// "\n\n" boundary. Without clearing it on the fallback path, a transient
		// replacement by single-line content emitted the OLD prefix's rendered lines.
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		clearRenderCache();
		streaming.setText("# First document\n\nOriginal body paragraph one.\n\nOriginal body paragraph two.\n");
		streaming.render(60);
		// Replace with unrelated single-line content — no "\n\n" boundary to freeze.
		clearRenderCache();
		streaming.setText("a flat replacement with no double newline at all");
		const replaced = streaming.render(60);
		expect(replaced).toEqual(renderCold("a flat replacement with no double newline at all", 60));
	});

	it("CRLF text (fallback path) renders identically to a cold lex", () => {
		const streaming = new Markdown("", 0, 0, THEME);
		const crlf = "Para one with content.\r\n\r\nPara two with `code`.\r\n\r\nPara three tail.\r\n";
		for (let len = 1; len <= crlf.length; len += 11) {
			clearRenderCache();
			streaming.setText(crlf.slice(0, len));
			const streamLines = streaming.render(60);
			expect(streamLines).toEqual(renderCold(crlf.slice(0, len), 60));
		}
	});
});

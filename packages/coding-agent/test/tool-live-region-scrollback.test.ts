import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, Text, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

class MutableLiveBlock implements Component {
	#lines: string[];
	#finalized: boolean;
	#commitStable: boolean | undefined;

	constructor(lines: string[], finalized = false, commitStable?: boolean) {
		this.#lines = [...lines];
		this.#finalized = finalized;
		this.#commitStable = commitStable;
	}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	// Defaults to commit-stable (matches a block that omits the method). Pass
	// false to model a provisional block (a collapsing tool preview) whose live
	// rows must never reach native scrollback.
	isTranscriptBlockCommitStable(): boolean {
		return this.#commitStable ?? true;
	}
}

function markerLines(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_unused, i) => `${prefix}${i}`);
}

function stripRows(rows: string[]): string {
	return rows.map(row => Bun.stripANSI(row).trimEnd()).join("\n");
}

describe("transcript reactive commit boundary", () => {
	it("treats growth before stable trailing chrome as append-only", async () => {
		const chat = new TranscriptContainer();
		const head = markerLines("head-", 6);
		const block = new MutableLiveBlock([...head, "bottom"]);
		chat.addChild(block);

		expect(chat.render(80)).toEqual([...head, "bottom"]);
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBeUndefined();

		block.setLines([...head, "inserted", "bottom"]);
		expect(chat.render(80)).toEqual([...head, "inserted", "bottom"]);
		// Append-only earned; the body is offered up to the volatile-tail
		// holdback (8 rows - 4).
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(4);
	});

	it("treats in-place growth of the trailing line as append-only", async () => {
		const chat = new TranscriptContainer();
		// Models a streaming assistant reply: stable head rows plus a current
		// line that grows token-by-token without adding a new row — the dominant
		// streaming shape, and the one a strict line-count-growth check missed,
		// stranding the scrolled-off head outside tmux pane history.
		const block = new MutableLiveBlock(["para one", "para two", "the quick brown"]);
		chat.addChild(block);

		chat.render(80);
		block.setLines(["para one", "para two", "the quick brown fox"]);
		chat.render(80);
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(3);
	});

	it("marks interior live re-layout volatile and defers commit", async () => {
		const chat = new TranscriptContainer();
		const mid = markerLines("mid-", 8);
		const block = new MutableLiveBlock(["top", "old", ...mid]);
		chat.addChild(block);

		chat.render(80);
		// A rewrite above the volatile-tail zone is a re-layout of
		// committed-candidate content, no matter how small the gap.
		block.setLines(["top", "new", ...mid]);
		expect(chat.render(80)).toEqual(["top", "new", ...mid]);
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBeUndefined();

		block.setLines(["top", "new", ...mid, "more"]);
		chat.render(80);
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBeUndefined();
	});

	it("treats escape placement and pad drift on visually unchanged rows as append-only", async () => {
		const chat = new TranscriptContainer();
		// Field failure shape (streaming styled thinking): the previous last row
		// carried the span-closing SGR before its width padding; when the
		// paragraph wrapped onto a new row, the close moved to the new last row
		// while the first row's visible cells stayed identical.
		const sty = "\x1b[38;2;156;163;176m";
		const head = markerLines("head-", 6);
		const block = new MutableLiveBlock([...head, `${sty}alpha beta\x1b[39m   `]);
		chat.addChild(block);

		chat.render(80);
		block.setLines([...head, `${sty}alpha beta   `, `${sty}gamma\x1b[39m        `]);
		chat.render(80);
		// Append-only earned despite the escape drift: offered up to the
		// volatile-tail holdback (8 rows - 4).
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(4);
	});

	it("treats a wrap-shrink of the trailing line as append-only", async () => {
		const chat = new TranscriptContainer();
		// A streamed token extends the last word past the wrap column, so the
		// word moves down onto an appended row and the previous bottom line
		// shrinks. The bottom line sits inside the volatile-tail zone, so this
		// is not a rewrite of committed-candidate rows.
		const head = markerLines("head-", 6);
		const block = new MutableLiveBlock([...head, "foo bar baz"]);
		chat.addChild(block);

		chat.render(80);
		block.setLines([...head, "foo bar", "bazqux and more"]);
		chat.render(80);
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(4);
	});

	it("re-earns append-only after a one-off interior rewrite heals", async () => {
		const chat = new TranscriptContainer();
		const mid = markerLines("mid-", 8);
		const block = new MutableLiveBlock(["top", "old", ...mid]);
		chat.addChild(block);

		chat.render(80);
		// Interior rewrite (a codespan finalizing across a wrap) suspends commits.
		block.setLines(["top", "new", ...mid]);
		chat.render(80);
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBeUndefined();

		// Clean static frames re-arm the block...
		for (let i = 0; i < 30; i++) chat.render(80);
		// ...and the next append-shaped frame resumes committing up to the
		// volatile-tail holdback (11 rows - 4), so the pinned emitter can
		// backfill the stalled gap contiguously.
		block.setLines(["top", "new", ...mid, "appended"]);
		chat.render(80);
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(7);
	});

	it("keeps a periodically rewriting block (spinner) deferred", async () => {
		const chat = new TranscriptContainer();
		const block = new MutableLiveBlock(["⠋ running", "body"]);
		chat.addChild(block);

		chat.render(80);
		const glyphs = ["⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⠋"];
		for (const glyph of glyphs) {
			// Spinner advances every third frame; the static frames in between
			// must never accumulate into a re-arm.
			block.setLines([`${glyph} running`, "body"]);
			chat.render(80);
			chat.render(80);
			chat.render(80);
		}
		block.setLines(["⠋ running", "body", "appended"]);
		chat.render(80);
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBeUndefined();
	});

	it("commits the settled head of a block whose tail keeps rewriting (task progress shape)", () => {
		const chat = new TranscriptContainer();
		const head = markerLines("head-", 8);
		const block = new MutableLiveBlock([...head, "⠋ agents running · 0 tools"]);
		chat.addChild(block);
		chat.render(80);

		// The progress tail rewrites every frame, but it lives inside the
		// volatile-tail zone, so the block still classifies as clean streaming
		// and the settled head is offered immediately — up to the holdback
		// (9 rows - 4). Otherwise a tall block's scrolled-off head is neither
		// committed nor on screen for the whole run — the transcript reads as
		// cut off until the tool seals.
		for (let i = 1; i <= 62; i++) {
			block.setLines([...head, `⠋ agents running · ${i} tools`]);
			chat.render(80);
		}

		expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(5);
	});

	it("retreats the settled-head boundary when a promoted row is rewritten", () => {
		const chat = new TranscriptContainer();
		const head = markerLines("head-", 8);
		const block = new MutableLiveBlock([...head, "tail-0"]);
		chat.addChild(block);
		chat.render(80);
		for (let i = 1; i <= 62; i++) {
			block.setLines([...head, `tail-${i}`]);
			chat.render(80);
		}
		// Offered up to the volatile-tail holdback (9 rows - 4).
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(5);

		// A collapse/re-layout rewrites a promoted row: the boundary retreats
		// to the divergence (the engine audit owns rows already committed).
		block.setLines([...head.slice(0, 3), "rewritten", ...head.slice(4), "tail-x"]);
		chat.render(80);
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(3);
	});

	it("stops re-promoting slow-ticking rows after the first promoted-row rewrite", () => {
		const chat = new TranscriptContainer();
		const head = markerLines("head-", 8);
		// Task progress tree shape: per-agent rows whose tool/cost counters tick
		// every few seconds — far slower than the promotion window, so each row
		// looks "settled" between updates. Without the rewrite floor, every
		// quiet stretch re-promotes the tree, every tick rewrites a
		// committed row, and the engine audit recommits — spraying a stale
		// snapshot of the block into scrollback for the whole run.
		const tree = (a: number, b: number, c: number) => [
			`agent-one · ${a} tools`,
			`agent-two · ${b} tools`,
			`agent-three · ${c} tools`,
		];
		const block = new MutableLiveBlock([...head, ...tree(0, 0, 0)]);
		chat.addChild(block);
		chat.render(80);

		// Tickers in the trailing volatile zone are never offered: the boundary
		// converges to the holdback (11 rows - 4) and never reaches into the
		// tree, so no tick can rewrite a committed row.
		let maxSafeEnd = 0;
		const counters: [number, number, number] = [0, 0, 0];
		for (let tick = 0; tick < 9; tick++) {
			counters[tick % 3] += 1;
			block.setLines([...head, ...tree(...counters)]);
			for (let frame = 0; frame < 40; frame++) {
				chat.render(80);
				maxSafeEnd = Math.max(maxSafeEnd, chat.getNativeScrollbackCommitSafeEnd() ?? 0);
			}
		}

		// The static head commits; the ticking tree stays deferred forever.
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(7);
		expect(maxSafeEnd).toBe(7);
	});

	it("keeps the rewrite floor anchored across append growth below it", () => {
		const chat = new TranscriptContainer();
		// The ticker sits ABOVE the volatile-tail zone: 4 head rows, the ticker,
		// then 6 rows of stable trailing chrome. Quiet stretches promote through
		// it; its first tick is a genuine committed-candidate rewrite.
		const head = markerLines("head-", 4);
		const chrome = markerLines("chrome-", 6);
		const block = new MutableLiveBlock([...head, "ticker · 0", ...chrome]);
		chat.addChild(block);
		chat.render(80);

		// Let the ratchet over-promote through the quiet ticker (up to the
		// holdback: 11 rows - 4), then tick it: the floor lands on the ticker
		// row (index 4) and the boundary retreats to it.
		for (let i = 0; i < 70; i++) chat.render(80);
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(7);
		block.setLines([...head, "ticker · 1", ...chrome]);
		chat.render(80);
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(4);

		// Settled rows are inserted above the ticker (append above stable
		// trailing chrome): the ticker shifts down and the floor must travel
		// with it, or the new settled rows would be barred from promoting.
		block.setLines([...head, "settled-a", "settled-b", "ticker · 1", ...chrome]);
		for (let i = 0; i < 70; i++) chat.render(80);
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(6);

		// And the shifted ticker itself never re-promotes.
		block.setLines([...head, "settled-a", "settled-b", "ticker · 2", ...chrome]);
		for (let i = 0; i < 70; i++) chat.render(80);
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(6);
	});

	it("keeps committing through streaming markdown tail jitter (re-wrap + token resolution)", () => {
		// Regression: real markdown streaming is not strictly append-only at the
		// bottom — the in-flight paragraph re-wraps (rewriting its last 2 rows)
		// and unclosed tokens (`**bold`) re-render when the closer arrives. The
		// old classifier treated every such frame as a rewrite and tripped a
		// 30-frame cooldown, so a continuously streaming reply never re-earned
		// append-only: the boundary crawled via the ratchet (~12 rows committed
		// out of 109) and the engine rewrote the window in place instead of
		// scroll-appending ("replaces instead of appending").
		const chat = new TranscriptContainer();
		const block = new MutableLiveBlock(["row-0"]);
		chat.addChild(block);
		chat.render(80);

		const rows: string[] = ["row-0"];
		let maxLag = 0;
		for (let i = 1; i <= 80; i++) {
			if (i % 7 === 0 && rows.length >= 2) {
				// Token resolution: the trailing row is replaced (not a prefix
				// extension) — e.g. literal `**thin` re-rendering as bold text.
				rows[rows.length - 1] = `resolved-${i}`;
				rows.push(`row-${i}`);
			} else if (i % 5 === 0 && rows.length >= 2) {
				// Trailing-paragraph re-wrap: the last TWO rows rewrite while
				// new rows append below.
				rows[rows.length - 2] = `rewrapped-${i}`;
				rows[rows.length - 1] = `rewrapped-tail-${i}`;
				rows.push(`row-${i}`);
			} else {
				rows.push(`row-${i}`);
			}
			block.setLines(rows);
			chat.render(80);
			const safeEnd = chat.getNativeScrollbackCommitSafeEnd() ?? 0;
			maxLag = Math.max(maxLag, rows.length - safeEnd);
		}

		// The boundary must track the stream the whole way: never more than the
		// volatile-tail holdback behind the frame.
		expect(maxLag).toBeLessThanOrEqual(4);
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(rows.length - 4);
	});

	it("defers a tall block whose head row keeps animating", () => {
		// A streaming block with an animated glyph in its header (the old
		// edit/write streaming shape) can never commit anything: commits are
		// prefix-only, and the head row rewrites every glyph advance. The
		// classifier must treat a head-row rewrite as volatile, not as
		// tail-confined jitter, regardless of how small the divergence is.
		const chat = new TranscriptContainer();
		const body = markerLines("body-", 12);
		const block = new MutableLiveBlock(["⠋ streaming", ...body]);
		chat.addChild(block);
		chat.render(80);

		const glyphs = ["⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⠋"];
		for (const [i, glyph] of glyphs.entries()) {
			block.setLines([`${glyph} streaming`, ...body, ...markerLines(`grow-${i}-`, i)]);
			chat.render(80);
			chat.render(80);
		}
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBeUndefined();
	});
});

describe("tool live-region scrollback", () => {
	beforeAll(async () => {
		await initTheme();
		// The task progress renderer reads settings (resolved-model badge).
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	it("does not splice stale pending eval preview above the running eval viewport", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const code = Array.from({ length: 20 }, (_unused, i) => `const line${i} = ${i};`).join("\n");
		const title = "call model with new prompt + check box heights";
		const args = { cells: [{ language: "js", title, code }] };
		const component = new ToolExecutionComponent("eval", args, {}, undefined, tui, process.cwd());

		try {
			chat.addChild(
				new Text("Now let me verify by calling the model and checking the box heights it produces:", 0, 0),
			);
			chat.addChild(new Text("prior filler\n".repeat(8).trimEnd(), 0, 0));
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			chat.addChild(component);
			tui.requestRender();
			await term.waitForRender();

			component.updateResult(
				{
					content: [{ type: "text", text: "" }],
					details: { cells: [{ index: 0, title, code, language: "js", output: "", status: "running" }] },
				},
				true,
			);
			tui.requestRender();
			await term.waitForRender();

			const bufferText = term
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			expect(bufferText).not.toContain("pending [1/1]");
			// The running cell renders the bounded TAIL window of the code: the
			// live edge stays visible; the head is elided behind a marker.
			expect(bufferText).toContain("const line19 = 19;");
			expect(bufferText).toContain("earlier lines");
			expect(bufferText).not.toContain("const line0 = 0;");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("does not strand a stale pending edit preview in scrollback when the result re-lays-out the block", async () => {
		if (process.platform === "win32") return;

		// Regression for the "tool call rendered inside itself" spray: an edit's
		// pending preview is a TAIL window of the streamed diff ("… N more lines
		// above" + last rows), and it goes byte-static once args complete — the
		// spinner stops while the apply + LSP pass runs. The stable-prefix
		// ratchet used to promote that settled head after
		// STABLE_PREFIX_COMMIT_FRAMES and commit it to native scrollback; the
		// result render then re-anchors the block top-first (stats header +
		// head-anchored diff), the committed-prefix audit re-anchors at the
		// divergence, and the stale call-box fragment stayed stranded above the
		// final box. Pending collapsed previews are provisional and must never
		// commit.
		const term = new VirtualTerminal(120, 10);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const diffLines: string[] = [];
		for (let i = 0; i < 14; i++) {
			diffLines.push(`-const before_${i} = ${i};`);
			diffLines.push(`+const after_${i} = ${i};`);
		}
		const diff = diffLines.join("\n");
		const args = { path: "src/sample.ts", op: "update", diff };
		const component = new ToolExecutionComponent("edit", args, {}, undefined, tui, process.cwd());

		try {
			chat.addChild(new Text("prior filler\n".repeat(6).trimEnd(), 0, 0));
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			chat.addChild(component);
			component.setArgsComplete();
			tui.requestRender();
			await term.waitForRender();

			// The tail-window preview's live edge is on screen while the tool
			// executes (its head sits above the viewport and stays uncommitted).
			const pending = term
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			expect(pending).toContain("(streaming)");

			// The tool runs with a byte-static preview — far past the
			// stable-prefix promotion window.
			for (let frame = 0; frame < 40; frame++) {
				tui.requestRender();
				await term.waitForRender();
			}

			component.updateResult(
				{
					content: [{ type: "text", text: "" }],
					details: { diff, path: "src/sample.ts", firstChangedLine: 1 },
				},
				false,
			);
			tui.requestRender();
			await term.waitForRender();

			const bufferText = term
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			// The tail-window marker exists only in the pending preview's head; any
			// occurrence after the result means a committed fragment of the call
			// box was stranded above the final block.
			expect(bufferText).not.toContain("more lines above");
			expect(bufferText).not.toContain("(streaming)");
			// The result's head-anchored diff is present.
			expect(bufferText).toContain("+const after_0 = 0;");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("scroll-appends a tall collapsed streaming task call into native scrollback mid-stream", async () => {
		if (process.platform === "win32") return;

		// Regression for the blanket commit-unstable gate: marking EVERY pending
		// collapsed preview provisional meant a task call whose context markdown
		// outgrew the viewport had its head neither on screen nor in scrollback
		// until the result landed — the transcript read as cut off for the whole
		// run. The task call preview streams top-anchored append-shaped rows the
		// result render preserves, so it stays commit-eligible while collapsed.
		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const contextLines = Array.from({ length: 60 }, (_unused, i) => `ctx_line_${i} = ${i}`);
		// Fenced code: each streamed line appends exactly one row, no re-wrap.
		const buildContext = (count: number) => `\`\`\`\n${contextLines.slice(0, count).join("\n")}\n`;
		const component = new ToolExecutionComponent(
			"task",
			{ agent: "task", context: buildContext(1) },
			{},
			undefined,
			tui,
			process.cwd(),
		);

		try {
			chat.addChild(new Text("prior filler", 0, 0));
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			chat.addChild(component);
			tui.requestRender();
			await term.waitForRender();

			for (let count = 5; count <= contextLines.length; count += 5) {
				component.updateArgs({ agent: "task", context: buildContext(count) });
				tui.requestRender();
				await term.waitForRender();
			}

			// Still streaming: no result, collapsed. The head of the context must
			// already be in the buffer (committed above the window), not cut off —
			// and the viewport itself only shows the streaming tail.
			const rows = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			const bufferText = rows.join("\n");
			expect(bufferText).toContain("ctx_line_0 = 0");
			expect(bufferText).toContain("ctx_line_30 = 30");
			expect(rows.length).toBeGreaterThan(term.rows);
			const viewportText = term
				.getViewport()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			expect(viewportText).not.toContain("ctx_line_0 = 0");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("scroll-appends a tall expanded streaming write into native scrollback mid-stream", async () => {
		if (process.platform === "win32") return;

		// Regression for "streaming previews replace instead of appending": a
		// tall expanded write preview must reach pane history WHILE args are
		// still streaming — not only after the result lands. Two ingredients:
		// the commit classifier tolerating streaming-edge jitter, and the
		// renderer keeping the animated glyph out of the block's head row.
		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const fullContent = Array.from({ length: 60 }, (_unused, i) => `const streamed_line_${i} = ${i};`).join("\n");
		const component = new ToolExecutionComponent(
			"write",
			{ file_path: "packages/coding-agent/test/probe.ts", content: "" },
			{},
			undefined,
			tui,
			process.cwd(),
		);
		component.setExpanded(true);

		try {
			chat.addChild(new Text("prior filler", 0, 0));
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			chat.addChild(component);
			tui.requestRender();
			await term.waitForRender();

			const chunk = Math.ceil(fullContent.length / 12);
			for (let off = chunk; off < fullContent.length; off += chunk) {
				component.updateArgs({
					file_path: "packages/coding-agent/test/probe.ts",
					content: fullContent.slice(0, off),
				});
				tui.requestRender();
				await term.waitForRender();
			}

			// Still streaming: no result, args incomplete. The head of the
			// preview must already be in the buffer (committed above the
			// window), not cut off — and the viewport itself only shows the
			// streaming tail.
			const rows = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			const bufferText = rows.join("\n");
			expect(bufferText).toContain("const streamed_line_0 = 0;");
			expect(bufferText).toContain("const streamed_line_30 = 30;");
			expect(rows.length).toBeGreaterThan(term.rows);
			const viewportText = term
				.getViewport()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			expect(viewportText).not.toContain("const streamed_line_0 = 0;");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("repaints a finalized write whose result lands after a card was appended below it", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 20);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const content = Array.from({ length: 5 }, (_unused, i) => `const line${i} = ${i};`).join("\n");
		const args = { file_path: "packages/coding-agent/test/probe.ts", content };
		const component = new ToolExecutionComponent("write", args, {}, undefined, tui, process.cwd());

		try {
			chat.addChild(new Text("prior filler", 0, 0));
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			// The write streams its preview while it is the live block.
			chat.addChild(component);
			tui.requestRender();
			await term.waitForRender();

			// An out-of-band card (e.g. a TTSR rule notification) is appended below
			// the still-in-flight write. Previously this froze the write on its
			// streaming preview, so the eventual result never repainted.
			chat.addChild(new Text("⚠ Injecting rule: ts-set-map", 0, 0));
			tui.requestRender();
			await term.waitForRender();

			const beforeResult = term
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			expect(beforeResult).toContain("(streaming)");

			// The write finishes after the card is already below it.
			component.updateResult({ content: [{ type: "text", text: "" }], details: { path: args.file_path } }, false);
			tui.requestRender();
			await term.waitForRender();

			const afterResult = term
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			// The streaming preview is gone and the finalized header repainted in place.
			expect(afterResult).not.toContain("(streaming)");
			expect(afterResult).toContain("· 5 lines");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("commits the scrolled-off head of an over-tall expanded streaming write to scrollback", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 20);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const body = (n: number) => Array.from({ length: n }, (_unused, i) => `MARK-${i}`).join("\n");
		const filePath = "packages/coding-agent/test/probe.txt";
		// Expanded (Ctrl+O) lifts the tail-window cap, so the preview renders the
		// whole content top-anchored — append-only growth as chunks stream in.
		const component = new ToolExecutionComponent(
			"write",
			{ file_path: filePath, content: body(12) },
			{},
			undefined,
			tui,
			process.cwd(),
		);
		component.setExpanded(true);

		try {
			chat.addChild(component);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			for (const lineCount of [24, 40]) {
				component.updateArgs({ file_path: filePath, content: body(lineCount) });
				tui.requestRender();
				await term.waitForRender();
			}

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			// MARK-0 scrolled above the viewport: it must live in native scrollback
			// (committed), not nowhere. Before the fix the tool block was not
			// append-only, so its scrolled-off head was dropped — a yanked stream.
			expect(viewportText).not.toContain("MARK-0");
			expect(scrollText).toContain("MARK-0");
			// The streaming tail stays on screen, and nothing went missing between.
			expect(viewportText).toContain("MARK-39");
			expect(viewportText).toContain("(streaming)");
			expect(scrollText).toContain("MARK-20");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("commits the scrolled-off head of an over-tall pending eval cell to scrollback", async () => {
		if (process.platform === "win32") return;

		// Collapsed eval previews are head-capped (renderCodeCell's default
		// window), so they can no longer go over-tall on their own. Expanded
		// (ctrl+o) lifts the cap — the preview renders the whole brief
		// top-anchored, append-only as chunks stream in — so the expanded eval
		// cell carries the over-tall pending content here.
		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const code = (n: number) => Array.from({ length: n }, (_unused, i) => `// - CTX-${i}`).join("\n");
		const args = (n: number) => ({
			cells: [{ language: "js", title: "probe", code: code(n) }],
		});
		const component = new ToolExecutionComponent("eval", args(4), {}, undefined, tui, process.cwd());
		component.setExpanded(true);

		try {
			chat.addChild(component);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			for (const lineCount of [12, 24, 40]) {
				component.updateArgs(args(lineCount));
				tui.requestRender();
				await term.waitForRender();
			}

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			expect(viewportText).not.toContain("CTX-0");
			expect(scrollText).toContain("CTX-0");
			expect(scrollText).toContain("CTX-20");
			expect(viewportText).toContain("CTX-39");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("keeps the static task assignment reachable in scrollback while progress ticks below it", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const assignment = Array.from({ length: 40 }, (_unused, i) => `- CTX-${i}`).join("\n");
		const args = { agent: "explore", id: "alpha", description: "probe", assignment };
		const component = new ToolExecutionComponent("task", args, {}, undefined, tui, process.cwd());
		// The multi-line assignment section only renders expanded; shimmer
		// would repaint the status line above it every frame, capping the
		// stable prefix above the assignment, so pin it off for the run.
		component.setExpanded(true);
		settings.override("display.shimmer", "disabled");
		const progressAt = (tick: number) => ({
			index: 0,
			id: "alpha",
			agent: "explore",
			agentSource: "bundled" as const,
			status: "running" as const,
			task: assignment,
			description: "probe",
			currentTool: "read",
			currentToolArgs: `probe-step-${tick}`,
			recentTools: [],
			recentOutput: [],
			toolCount: 5,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 1000,
		});
		const partial = (tick: number) =>
			component.updateResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						projectAgentsDir: null,
						results: [],
						totalDurationMs: 0,
						progress: [progressAt(tick)],
					},
				},
				true,
			);

		try {
			chat.addChild(component);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			// A running task rewrites its current-tool line (the ticking tail)
			// below the static assignment section for the whole run. The
			// assignment head that scrolled above the viewport must still reach
			// native scrollback — previously the ticking tail suspended commits
			// for the entire block, leaving the assignment neither in history
			// nor on screen. Two full promotion windows: the call→result
			// transition frame poisons the first window's minimum, the second
			// promotes the head.
			for (let i = 1; i <= 70; i++) {
				partial(i);
				tui.requestRender();
				await term.waitForRender();
			}

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			expect(viewportText).not.toContain("CTX-0");
			expect(scrollText).toContain("CTX-0");
			expect(scrollText).toContain("CTX-5");
		} finally {
			settings.clearOverride("display.shimmer");
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	}, 20000);

	it("stops growing scrollback once slow-ticking rows are floored (no recommit storm)", async () => {
		if (process.platform === "win32") return;

		// The duplication-storm shape from the field: a live block whose head is
		// static context, whose tail is a slowly-ticking agent tree plus a
		// spinner, with finalized content (IRC cards) piled below it. The pile
		// pushes the ticker rows above the window top, so any over-promotion
		// commits them; every later tick would then make the engine audit
		// recommit — native scrollback gains a stale snapshot of the tree per
		// tick for the entire run. With the rewrite floor the ratchet converges
		// after the first promoted-row re-tick and scrollback stops growing.
		const term = new VirtualTerminal(80, 10);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const head = markerLines("CTX-", 20);
		const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
		let frameSeq = 0;
		const liveLines = (a: number, b: number) => [
			...head,
			`agent-one · ${a} tools`,
			`agent-two · ${b} tools`,
			`${spinner[frameSeq % spinner.length]} running`,
		];
		const block = new MutableLiveBlock(liveLines(0, 0));
		chat.addChild(block);
		chat.addChild(new MutableLiveBlock(markerLines("IRC-", 15), true));

		const counters: [number, number] = [0, 0];
		const renderFrames = async (frames: number) => {
			for (let i = 0; i < frames; i++) {
				frameSeq++;
				block.setLines(liveLines(...counters));
				tui.requestRender();
				await term.waitForRender();
			}
		};
		const tick = async (which: 0 | 1, frames: number) => {
			counters[which] += 1;
			await renderFrames(frames);
		};

		try {
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			// Overshoot: a quiet stretch longer than the promotion window lets
			// the ratchet promote (and the engine commit) the ticker rows.
			await renderFrames(35);
			// First post-promotion tick of the topmost ticker arms the floor.
			await tick(0, 35);
			const settled = stripRows(term.getScrollBuffer());

			// Further slow ticks must not grow native scrollback at all.
			await tick(1, 12);
			await tick(0, 12);
			await tick(1, 12);
			expect(stripRows(term.getScrollBuffer())).toBe(settled);

			// The static head still reached scrollback. The ticker rows sit in
			// the hidden gap between the commit boundary and the window top
			// (the accepted cost while finalized content is piled below a live
			// block) — but history holds exactly one stale snapshot of them
			// instead of one per tick.
			expect(settled).toContain("CTX-0");
			const staleSnapshots = settled.split("\n").filter(row => row.startsWith("agent-one ·")).length;
			expect(staleSnapshots).toBeLessThanOrEqual(2);
		} finally {
			tui.stop();
			await term.flush();
		}
	}, 30000);

	it("commits the scrolled-off head of a tall finalized bottom tool result", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const content = markerLines("FINAL-", 40).join("\n");
		const args = { path: "packages/coding-agent/test/finalized.txt" };
		const component = new ToolExecutionComponent("read", args, {}, undefined, tui, process.cwd());
		component.setExpanded(true);
		component.updateResult(
			{
				content: [{ type: "text", text: content }],
				details: { displayContent: { text: content, startLine: 1 } },
			},
			false,
		);

		try {
			chat.addChild(component);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			expect(viewportText).not.toContain("FINAL-0");
			expect(scrollText).toContain("FINAL-0");
			expect(scrollText).toContain("FINAL-20");
			expect(viewportText).toContain("FINAL-39");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("commits a re-layouting commit-stable live block's durable head to scrollback (no loss)", async () => {
		if (process.platform === "win32") return;

		// A commit-stable block (a streaming assistant reply) whose interior rows
		// re-lay-out as it grows — the markdown-table shape: every previous row
		// changes when the block swaps to a taller render. Its current snapshot is
		// durable content, so the rows that scroll above the viewport MUST reach
		// native scrollback (frozen snapshot) rather than vanish — committed
		// nowhere, repainted nowhere.
		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const block = new MutableLiveBlock(markerLines("OLD-", 8));

		try {
			chat.addChild(block);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			block.setLines(markerLines("NEW-", 40));
			tui.requestRender();
			await term.waitForRender();

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			// The head scrolled above the viewport but is durable: it lives in
			// native scrollback, not nowhere.
			expect(viewportText).not.toContain("NEW-0");
			expect(scrollText).toContain("NEW-0");
			expect(scrollText).toContain("NEW-20");
			expect(viewportText).toContain("NEW-39");
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("keeps a re-layouting commit-UNSTABLE live block's changed head out of scrollback", async () => {
		if (process.platform === "win32") return;

		// A provisional block (a collapsing tool/edit preview) reports
		// isTranscriptBlockCommitStable() === false: its head is a throwaway tail
		// window that the result render replaces wholesale, so committing it would
		// strand a stale fragment in history. Its re-laid-out head must stay out of
		// scrollback (the provisional-defer contract behind #402/#351).
		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const block = new MutableLiveBlock(markerLines("OLD-", 8), false, false);

		try {
			chat.addChild(block);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			block.setLines(markerLines("NEW-", 40));
			tui.requestRender();
			await term.waitForRender();

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			expect(viewportText).not.toContain("NEW-0");
			expect(scrollText).not.toContain("NEW-0");
			expect(scrollText).not.toContain("NEW-20");
			expect(viewportText).toContain("NEW-39");
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("commits the scrolled-off head of an expanded eval whose output streams past the viewport", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const title = "stream lots of output";
		const code = "for (let i = 0; i < 40; i++) console.log('MARK-' + i);";
		const args = { cells: [{ language: "js", title, code }] };
		const component = new ToolExecutionComponent("eval", args, {}, undefined, tui, process.cwd());
		component.setExpanded(true);
		const out = (n: number) => Array.from({ length: n }, (_unused, i) => `MARK-${i}`).join("\n");
		const partial = (output: string) =>
			component.updateResult(
				{
					content: [{ type: "text", text: "" }],
					details: { cells: [{ index: 0, title, code, language: "js", output, status: "running" }] },
				},
				true,
			);

		partial(out(4));

		try {
			chat.addChild(component);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			for (const lineCount of [12, 24, 40]) {
				partial(out(lineCount));
				tui.requestRender();
				await term.waitForRender();
			}

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			// The streamed output head scrolled above the viewport: it must live in
			// native scrollback (committed), not nowhere. The fixed code cell rides
			// along as the stable prefix above it.
			expect(viewportText).not.toContain("MARK-0");
			expect(scrollText).toContain("MARK-0");
			expect(scrollText).toContain("MARK-20");
			// The streaming tail stays on screen, and nothing went missing between.
			expect(viewportText).toContain("MARK-39");
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});

	it("leaves a coherent window when a streaming write is interrupted mid-commit", async () => {
		if (process.platform === "win32") return;

		// Repro for the interrupt artifact: a streaming tool whose head rows have
		// already committed to native scrollback is aborted (Esc). The block
		// flips finalized and collapses to its aborted result in one step; the
		// window below — including the editor box — must repaint coherently, with
		// no stale frame fragments or mis-offset border rows left behind.
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const fullContent = Array.from({ length: 60 }, (_unused, i) => `const streamed_line_${i} = ${i};`).join("\n");
		const component = new ToolExecutionComponent(
			"write",
			{ file_path: "packages/coding-agent/test/probe.ts", content: "" },
			{},
			undefined,
			tui,
			process.cwd(),
		);
		component.setExpanded(true);
		const editor = new Text("╭── status ──╮\n│ >          │\n╰────────────╯", 0, 0);

		try {
			chat.addChild(new Text("prior filler", 0, 0));
			tui.addChild(chat);
			tui.addChild(editor);
			tui.start();
			await term.waitForRender();

			chat.addChild(component);
			tui.requestRender();
			await term.waitForRender();

			// Stream until the preview head scrolls off and commits.
			const chunk = Math.ceil(fullContent.length / 12);
			for (let off = chunk; off < fullContent.length; off += chunk) {
				component.updateArgs({
					file_path: "packages/coding-agent/test/probe.ts",
					content: fullContent.slice(0, off),
				});
				tui.requestRender();
				await term.waitForRender();
			}
			expect(term.getScrollBuffer().length).toBeGreaterThan(term.rows);

			// Interrupt: agent-loop synthesizes the aborted error result.
			component.updateResult(
				{ content: [{ type: "text", text: "Tool execution was aborted: Interrupted by user" }], isError: true },
				false,
			);
			tui.requestRender();
			await term.waitForRender();

			// Oracle: the settled window must match what a forced full repaint
			// produces — byte-identical rows. Stale fragments from the collapsed
			// streaming frame (mis-offset editor borders, orphaned `│`/`╰` rows)
			// diverge here.
			const settled = term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			tui.requestRender(true);
			await term.waitForRender();
			const repainted = term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			expect(settled).toEqual(repainted);

			// The aborted state and intact editor box are on screen.
			const viewportText = settled.join("\n");
			expect(viewportText).toContain("aborted");
			expect(viewportText).toContain("╭── status ──╮");
			expect(viewportText).toContain("╰────────────╯");
			expect(settled.some(row => row.startsWith("╭── status"))).toBe(true);
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	});
});

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeThinkingMessage(thinking: string): AssistantMessage {
	const message = makeAssistantMessage("");
	message.content = [{ type: "thinking", thinking }];
	return message;
}

describe("assistant live-region scrollback", () => {
	beforeAll(async () => {
		await initTheme();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	it("commits a streamed reply's scrolled-off head to scrollback instead of dropping it", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		// A streaming assistant reply, mid-stream (no message in the ctor → live).
		// A markdown list yields one stable row per item, so growth is append-only.
		const component = new AssistantMessageComponent(undefined, false);
		const markers = Array.from({ length: 40 }, (_unused, i) => `- MARK-${i}`);

		try {
			chat.addChild(component);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			component.updateContent(makeAssistantMessage(markers.slice(0, 4).join("\n")));
			tui.requestRender();
			await term.waitForRender();

			for (const lineCount of [12, 24, 40]) {
				component.updateContent(makeAssistantMessage(markers.slice(0, lineCount).join("\n")));
				tui.requestRender();
				await term.waitForRender();
			}

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			// MARK-0 scrolled above the viewport: with the fix it lives in native
			// scrollback (committed), not nowhere. The regression dropped it.
			expect(viewportText).not.toContain("MARK-0");
			expect(scrollText).toContain("MARK-0");
			// The tail is still on screen, and nothing went missing in between.
			expect(viewportText).toContain("MARK-39");
			expect(scrollText).toContain("MARK-20");
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("commits scrolled-off styled thinking paragraphs to scrollback while streaming", async () => {
		if (process.platform === "win32") return;

		const term = new VirtualTerminal(120, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const component = new AssistantMessageComponent(undefined, false);
		// Word-wrapped italic/colored paragraphs — the styled streaming shape the
		// raw-byte append detector mis-classified as volatile (the span-closing
		// SGR moves rows as the paragraph wraps), which froze the commit boundary
		// and dropped every later paragraph that scrolled past the viewport top.
		const paragraphs = Array.from(
			{ length: 8 },
			(_unused, i) =>
				`PARA-${i} considering the resolver path and the descriptor defaults, the policy layer must keep the ` +
				`reasoning flag intact while discovery maps an unknown model entry onto the bundled reference shape ` +
				`so the runtime request stays correct across upstream metadata shifts.`,
		);
		const fullText = paragraphs.join("\n\n");
		const words = fullText.split(" ");

		try {
			chat.addChild(component);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			// Stream a few words per frame so the in-flight bottom line extends,
			// wraps, and sheds words onto new rows across many coalesced frames.
			for (let i = 5; i <= words.length; i += 5) {
				component.updateContent(makeThinkingMessage(words.slice(0, i).join(" ")));
				tui.requestRender();
				await term.waitForRender();
			}

			const scrollText = stripRows(term.getScrollBuffer());
			const viewportText = stripRows(term.getViewport());

			// Early paragraphs scrolled above the viewport: they must live in
			// native scrollback, not vanish into the dropped gap.
			expect(viewportText).not.toContain("PARA-0");
			expect(scrollText).toContain("PARA-0");
			expect(scrollText).toContain("PARA-4");
			// The tail is still on screen.
			expect(viewportText).toContain("PARA-7");
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("commits the scrolled-off head of a streamed markdown table whose columns keep re-aligning", async () => {
		if (process.platform === "win32") return;

		// The reported content-loss shape: a streaming reply with a markdown table
		// whose column widths grow as rows arrive, so every already-rendered row
		// re-lays-out each frame (perpetual interior re-layout, never byte-stable
		// append-only). The block is commit-stable, so its scrolled-off head is
		// durable and must reach native scrollback rather than vanish.
		const term = new VirtualTerminal(70, 12);
		const tui = new TUI(term);
		const chat = new TranscriptContainer();
		const component = new AssistantMessageComponent(undefined, false);

		const lines: string[] = ["Here is a summary of the MARK files:", ""];
		for (let i = 0; i < 6; i++) lines.push(`Paragraph PARA-${i} with some descriptive prose about the topic.`);
		lines.push("", "| Name | Description |", "|------|-------------|");
		for (let i = 0; i < 16; i++) {
			lines.push(`| ITEM-${i} | description number ${i} growing wider and wider ${"x".repeat(i)} |`);
		}

		try {
			chat.addChild(component);
			tui.addChild(chat);
			tui.start();
			await term.waitForRender();

			const acc: string[] = [];
			for (const line of lines) {
				acc.push(line);
				component.updateContent(makeAssistantMessage(acc.join("\n")));
				tui.requestRender();
				await term.waitForRender();
			}

			const scrollText = stripRows(term.getScrollBuffer());
			// No row may vanish: every paragraph and table row reaches the tape,
			// even the band that scrolled off while the table was re-aligning.
			for (let i = 0; i < 6; i++) expect(scrollText).toContain(`PARA-${i}`);
			for (let i = 0; i < 16; i++) expect(scrollText).toContain(`ITEM-${i}`);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

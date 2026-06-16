import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type Component,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackLiveRegion,
	TUI,
} from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class LineList implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}
}

class LiveLineList extends LineList implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return 0;
	}
}

/**
 * A live block whose rendered rows only grow at the bottom and never re-layout
 * (a streaming assistant reply). Its entire body is append-only, so scrolled-off
 * head rows are safe to commit to native scrollback. `Infinity` is clamped to
 * the rendered length by TUI's aggregation.
 */
class AppendOnlyLiveLineList extends LiveLineList {
	getNativeScrollbackCommitSafeEnd(): number | undefined {
		return Number.POSITIVE_INFINITY;
	}
}

/**
 * Records the engine's committed-row claim visible at each render() call.
 * Pins the propagation contract: the claim must be fed *before* render so the
 * child (e.g. the transcript container) can skip re-deriving blocks that
 * already live in immutable native scrollback.
 */
class CommittedRowsProbe extends AppendOnlyLiveLineList implements NativeScrollbackCommittedRows {
	#committedRows = 0;
	committedRowsAtRender: number[] = [];

	setNativeScrollbackCommittedRows(rows: number): void {
		this.#committedRows = rows;
	}

	override render(width: number): string[] {
		this.committedRowsAtRender.push(this.#committedRows);
		return super.render(width);
	}
}

/**
 * A live block that is DURABLE but not byte-stable: it reports a snapshot-safe
 * end (its whole body is permanent content) but no commit-safe end, and it
 * re-lays-out an interior row on every render (a streaming markdown table whose
 * columns re-align as rows arrive). Its scrolled-off head must still reach
 * native scrollback — frozen at its scroll-off snapshot — instead of being
 * dropped, and the later drift of an already-committed row must NOT spray
 * duplicate snapshots into history.
 */
class SnapshotLiveLineList extends LineList implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return 0;
	}
	getNativeScrollbackSnapshotSafeEnd(): number | undefined {
		return Number.POSITIVE_INFINITY;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(40);
	await term.flush();
}

// The non-multiplexer resize fast path paints the viewport at once and defers
// the authoritative full replay (the ED3 scrollback rebuild) until the drag has
// been quiet for the resize settle window (120 ms). This is an integration test
// against the real render scheduler, so the window is driven with a real delay.
async function settleResize(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(160);
	await settle(term);
}

function capture(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	(term as unknown as { write: (s: string) => void }).write = (data: string) => {
		writes.push(data);
		realWrite(data);
	};
	return writes;
}

function overrideProbe(term: VirtualTerminal, answer: boolean | undefined): void {
	(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () => answer;
}

const ERASE_SCROLLBACK = /\x1b\[3J/g;

function eraseScrollbackCount(writes: string[]): number {
	return writes.join("").match(ERASE_SCROLLBACK)?.length ?? 0;
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

describe("streaming scrollback defer", () => {
	let savedTerminalEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		// A resize on Warp takes the in-place path (no ED3), so neutralize the
		// ambient terminal identity to keep the direct-terminal scrollback
		// assertions below deterministic on any dev machine.
		for (const key of ["TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE"]) {
			savedTerminalEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
	});
	afterEach(() => {
		for (const key in savedTerminalEnv) {
			const value = savedTerminalEnv[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		savedTerminalEnv = {};
	});

	it("keeps mutable live-region head rows out of native scrollback", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("prior-", 12));
		const live = new LiveLineList([]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("think-", 6));
			tui.requestRender();
			await settle(term);

			// The sealed prefix is stable and may enter native scrollback. The
			// live block's head (think-0/think-1) has physically left the viewport,
			// but it is still mutable; committing it would leave stale rows in
			// history when the live block re-renders or collapses.
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual([
				...rows("prior-", 12),
				...rows("think-", 6).slice(-4),
			]);

			live.setLines(rows("think-", 8));
			tui.requestRender();
			await settle(term);

			const buffer = term.getScrollBuffer().map(line => line.trimEnd());
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(buffer).toEqual([...rows("prior-", 12), ...rows("think-", 8).slice(-4)]);
		} finally {
			tui.stop();
		}
	});

	it("keeps a tall all-live block transient when no sealed prefix exists", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// The only block is the live one (liveRegionStart === 0). Rows above
		// the viewport are mutable, so they must stay out of native scrollback
		// instead of being committed as stale history.
		const live = new LiveLineList([]);

		try {
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("tool-", 10));
			tui.requestRender();
			await settle(term);

			// tool-0..tool-5 scrolled above the 4-row viewport, but the whole
			// block is mutable; only tool-6..tool-9 should remain in the native
			// buffer.
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(rows("tool-", 10).slice(-4));
		} finally {
			tui.stop();
		}
	});

	it("commits the scrolled-off head of an append-only live block to native scrollback", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// The only block is the live one (liveRegionStart === 0), but unlike a
		// volatile tool preview it is append-only (a streaming assistant reply).
		// Rows that scroll above the viewport must reach native scrollback rather
		// than vanishing — committed nowhere, repainted nowhere.
		const live = new AppendOnlyLiveLineList([]);

		try {
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("text-", 10));
			tui.requestRender();
			await settle(term);

			// text-0..text-5 scrolled above the 4-row viewport; because the block
			// is append-only they enter native scrollback (via `\r\n`, no ED3
			// erase) instead of being dropped like the volatile case above.
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(rows("text-", 10));
		} finally {
			tui.stop();
		}
	});

	it("does not leave stale mutable live-region rows in native scrollback after a rerender", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(24, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("prior-", 12));
		const live = new LiveLineList([]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("pending-stale-", 10));
			tui.requestRender();
			await settle(term);

			live.setLines(rows("running-fresh-", 10));
			tui.requestRender();
			await settle(term);

			const buffer = term.getScrollBuffer().map(line => line.trimEnd());
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(buffer.some(line => line.startsWith("pending-stale-"))).toBe(false);
			expect(buffer).toContain("running-fresh-9");
		} finally {
			tui.stop();
		}
	});

	it("keeps the topmost live seam when a lower sibling also reports one", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(24, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("prior-", 12));
		// Volatile live transcript block: seam at 0, no commit-safe end.
		const live = new LiveLineList([]);
		// Status loader below the transcript: also reports a seam. Commits are
		// prefix-only, so the engine must keep the TOPMOST seam — letting the
		// lower sibling's seam win would move the boundary past the transcript's
		// still-mutable rows and commit them as stale history.
		const loader = new LiveLineList(["Working..."]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.addChild(loader);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("pending-stale-", 10));
			tui.requestRender();
			await settle(term);

			live.setLines(rows("running-fresh-", 10));
			tui.requestRender();
			await settle(term);

			const buffer = term.getScrollBuffer().map(line => line.trimEnd());
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(buffer.some(line => line.startsWith("pending-stale-"))).toBe(false);
			expect(buffer).toContain("running-fresh-9");
		} finally {
			tui.stop();
		}
	});

	it("commits scrolled streaming rows to history exactly once without ED3", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(40, 10);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const component = new LineList([...rows("init-", 10), "prompt"]);

		try {
			tui.addChild(component);
			tui.start();
			await settle(term);

			const writes = capture(term);

			// Grow content past the viewport — without a live-region seam the
			// scrolled-off rows commit to native history as they pass the seam
			// (shell semantics): exactly once, in frame order, with no ED3.
			const frame1 = [...rows("init-", 10), ...rows("stream-", 30), "prompt"];
			component.setLines(frame1);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			let buffer = term.getScrollBuffer().map(line => line.trimEnd());
			expect(buffer).toEqual(frame1.slice(0, buffer.length));
			expect(
				term
					.getViewport()
					.map(line => line.trim())
					.at(-1),
			).toBe("prompt");

			// Grow further — history extends append-only: still no ED3, no
			// duplicates, and previously committed rows are untouched.
			const frame2 = [...rows("init-", 10), ...rows("stream-", 50), "prompt"];
			component.setLines(frame2);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			buffer = term.getScrollBuffer().map(line => line.trimEnd());
			expect(buffer).toEqual(frame2.slice(0, buffer.length));
			expect(buffer.length).toBeGreaterThan(frame1.length - 10);
		} finally {
			tui.stop();
		}
	});

	it("does not emit ED3 during streaming", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(40, 10);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const component = new LineList([...rows("init-", 10), "prompt"]);

		try {
			tui.addChild(component);
			tui.start();
			await settle(term);

			const writes = capture(term);

			component.setLines([...rows("grow-", 30), "prompt"]);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);

			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(
				term
					.getViewport()
					.map(line => line.trim())
					.at(-1),
			).toBe("prompt");
		} finally {
			tui.stop();
		}
	});

	it("does not duplicate committed sealed rows when the live region collapses mid-stream", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// Sealed prefix above a live block: growth commits the sealed rows to
		// native scrollback; a later collapse must not repaint them back into the
		// viewport (which would duplicate them in history with no ED3 to erase).
		const sealed = new LineList(rows("prior-", 12));
		const live = new LiveLineList([]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			// Live block overflows the viewport — sealed prefix commits once.
			live.setLines(rows("think-", 30));
			tui.requestRender();
			await settle(term);
			expect(term.getScrollBuffer().filter(line => line.startsWith("prior-"))).toEqual(rows("prior-", 12));

			// Live block collapses to its compact result. The bottom-anchored
			// viewport would re-expose committed sealed rows; the pin must clamp the
			// repaint to the committed boundary instead of duplicating them.
			live.setLines(["done"]);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(term.getScrollBuffer().filter(line => line.startsWith("prior-"))).toEqual(rows("prior-", 12));
		} finally {
			tui.stop();
		}
	});

	it("keeps committed prefix accounting after a capped streaming frame", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(24, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("base-", 12));

		try {
			tui.addChild(sealed);
			tui.start();
			await settle(term);

			const writes = capture(term);

			// No live-region marker yet: streaming caps this transient
			// frame to the viewport. The already-committed base-0..base-7 rows
			// remain physically in native scrollback and must stay accounted.
			sealed.setLines([...rows("base-", 12), ...rows("transient-", 30)]);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);

			// A later frame introduces a live region after the same sealed prefix.
			// If the cap zeroed the high-water mark, liveRegionPinned would append
			// base-0..base-11 again, duplicating base-0..base-7 in native history.
			const live = new LiveLineList(rows("live-", 20));
			sealed.setLines(rows("base-", 12));
			tui.addChild(live);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(term.getScrollBuffer().filter(line => line.startsWith("base-"))).toEqual(rows("base-", 12));
		} finally {
			tui.stop();
		}
	});

	it("erases mis-wrapped native scrollback on resize even mid-stream", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(40, 10);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const component = new LineList([...rows("init-", 5), "prompt"]);

		try {
			tui.addChild(component);
			tui.start();
			await settle(term);

			const writes = capture(term);

			// Stream past the viewport: scrolled rows commit to history in
			// order (shell semantics) and no ED3 fires.
			component.setLines([...rows("stream-", 30), "prompt"]);
			tui.requestRender();
			await settle(term);
			expect(eraseScrollbackCount(writes)).toBe(0);
			const streamed = term.getScrollBuffer().map(line => line.trimEnd());
			expect(streamed).toEqual([...rows("stream-", 30), "prompt"].slice(0, streamed.length));

			// Resize mid-stream. The terminal re-wrapped its saved lines at the old
			// width, so the authoritative rebuild must erase them (ED 3) rather than
			// leaving the corrupt history on screen. That rebuild is deferred until
			// the drag settles; while in flight only the viewport is repainted.
			term.resize(30, 10);
			await settleResize(term);

			expect(eraseScrollbackCount(writes)).toBeGreaterThan(0);
			expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual([...rows("stream-", 30), "prompt"]);
			expect(
				term
					.getViewport()
					.map(line => line.trim())
					.at(-1),
			).toBe("prompt");
		} finally {
			tui.stop();
		}
	});

	it("feeds committed native scrollback rows to interested children before render", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const probe = new CommittedRowsProbe([]);

		try {
			tui.addChild(probe);
			tui.start();
			await settle(term);

			// Grow well past the 4-row viewport: the append-only body lets the
			// engine commit the scrolled-off head to native scrollback.
			probe.setLines(rows("out-", 12));
			tui.requestRender();
			await settle(term);

			// The next compose must surface the engine's committed claim to the
			// child before render(). A severed wire here silently disables the
			// transcript's committed-block bypass (rows stay 0 forever).
			tui.requestRender();
			await settle(term);

			expect(probe.committedRowsAtRender.at(-1)!).toBeGreaterThan(0);
		} finally {
			tui.stop();
		}
	});

	it("commits the scrolled-off head of a durable snapshot block even while it re-lays-out", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// Durable but volatile: an interior row re-lays-out every frame (a table
		// re-aligning), so it never earns a byte-stable commit-safe end. The block
		// alone overflows the 4-row viewport. Its scrolled-off head must reach
		// native scrollback (snapshot-safe end), not vanish like a volatile block.
		const live = new SnapshotLiveLineList([]);

		try {
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			for (let n = 4; n <= 12; n++) {
				const lines = rows("tbl-", n);
				lines[1] = `tbl-1 [w${n}]`; // interior row re-lays-out every frame
				live.setLines(lines);
				tui.requestRender();
				await settle(term);
			}

			const buffer = term.getScrollBuffer().map(line => line.trimEnd());
			const joined = buffer.join("\n");
			// No ED3, and every logical row reached the tape (scrollback or window).
			expect(eraseScrollbackCount(writes)).toBe(0);
			for (let i = 2; i < 12; i++) expect(joined).toContain(`tbl-${i}`);
			// The interior row's snapshot is frozen (committed once); it is not lost.
			expect(joined).toContain("tbl-1");
		} finally {
			tui.stop();
		}
	});

	it("does not spray duplicate snapshots when an already-committed durable row drifts", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const live = new SnapshotLiveLineList(rows("row-", 12));

		try {
			tui.addChild(live);
			tui.start();
			await settle(term);

			// row-0 has long scrolled off and committed. Keep rewriting it (a
			// scrolled-off table row re-aligning) while appending new rows. The
			// committed-prefix audit must treat it as a durable snapshot and NOT
			// re-anchor + recommit the whole prefix on every drift (a spray storm).
			for (let n = 12; n <= 40; n++) {
				const lines = rows("row-", n);
				lines[0] = `row-0 [drift ${n}]`;
				live.setLines(lines);
				tui.requestRender();
				await settle(term);
			}

			const buffer = term.getScrollBuffer().map(line => line.trimEnd());
			// Without audit-exemption every drift frame recommits the whole prefix,
			// so the tape would balloon far past the ~40 logical rows. Bound it.
			expect(buffer.length).toBeLessThan(60);
			expect(buffer.join("\n")).toContain("row-39");
		} finally {
			tui.stop();
		}
	});
});

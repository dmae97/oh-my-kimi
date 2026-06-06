import { describe, expect, it } from "bun:test";
import { type Component, type NativeScrollbackLiveRegion, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/1974
//
// Inside tmux (and other multiplexers), a long streamed reply that grows past
// the viewport lost its scrolled-off head from pane history and, after a
// later viewport repaint, the same content reappeared inside the visible
// pane while the original streamed rows were stranded above — leaving
// "missing sections" interleaved with "repeating chunks" when the user
// scrolled back through the tmux pane buffer. The renderer's foreground-
// streaming cap-to-viewport branch clipped `lines` to the visible tail and
// reset `#scrollbackHighWater` to 0 for every streaming frame, so no rows
// ever entered tmux pane history while the assistant reply was active.
//
// The `liveRegionPinned` intent already knows how to push the sealed prefix
// of an append-only live block into native scrollback via `\r\n` without
// emitting ED3 — exactly what tmux can accept — but it used to short-circuit
// inside multiplexers. Enabling it (and skipping the cap when the planner
// picks it) commits the assistant reply's head into pane history exactly
// once while the live tail keeps repainting in place.

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

/**
 * Minimal append-only live region. Models the real omp setup where
 * `TranscriptContainer` wraps an `AssistantMessageComponent` that reports
 * itself as `isTranscriptBlockAppendOnly() === true`.
 */
class StreamingLiveRegion implements Component, NativeScrollbackLiveRegion {
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

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return 0;
	}

	getNativeScrollbackCommitSafeEnd(): number | undefined {
		return this.#lines.length;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(20);
	await term.flush();
}

async function withEnvPatch<T>(patch: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const key in patch) {
		saved[key] = Bun.env[key];
		const value = patch[key];
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
	try {
		return await run();
	} finally {
		for (const key in saved) {
			const value = saved[key];
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
	}
}

type MutableTerminalInfo = { eagerEraseScrollbackRisk: boolean };

async function withTerminalRisk<T>(risk: boolean, run: () => T | Promise<T>): Promise<T> {
	const mutable = TERMINAL as unknown as MutableTerminalInfo;
	const saved = mutable.eagerEraseScrollbackRisk;
	mutable.eagerEraseScrollbackRisk = risk;
	try {
		return await run();
	} finally {
		mutable.eagerEraseScrollbackRisk = saved;
	}
}

function overrideProbe(term: VirtualTerminal, answer: boolean | undefined): void {
	(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () => answer;
}

function strip(rows: string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

const TMUX_ENV: Record<string, string | undefined> = {
	TMUX: "1",
	STY: undefined,
	ZELLIJ: undefined,
};

const ERASE_SCROLLBACK = /\x1b\[3J/g;

function capture(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	(term as unknown as { write: (s: string) => void }).write = (data: string) => {
		writes.push(data);
		realWrite(data);
	};
	return writes;
}

function occurrencesOf(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("issue #1974: tmux scrollback rendering", () => {
	it("commits a streaming reply's scrolled-off head to pane history exactly once", async () => {
		if (process.platform === "win32") return;

		await withEnvPatch(TMUX_ENV, async () => {
			await withTerminalRisk(true, async () => {
				const term = new VirtualTerminal(80, 8, 10_000);
				// Real tmux/ProcessTerminal does not implement
				// `isNativeViewportAtBottom`, so the renderer sees `undefined`
				// in production. Match that here.
				overrideProbe(term, undefined);

				const tui = new TUI(term);
				const stream = new StreamingLiveRegion([]);
				tui.addChild(stream);

				const markers = Array.from({ length: 40 }, (_unused, i) => `MARK-${String(i).padStart(3, "0")}`);

				try {
					tui.start();
					tui.setEagerNativeScrollbackRebuild(true);
					await settle(term);

					// Stream the reply in chunks. Each chunk grows the live block
					// by 5 rows — small enough that no single frame double-
					// overflows the 8-row viewport, large enough that the head
					// must scroll into pane history between frames.
					for (let chunk = 5; chunk <= markers.length; chunk += 5) {
						stream.setLines(markers.slice(0, chunk));
						tui.requestRender();
						await settle(term);
					}

					// `getScrollBuffer()` returns pane history + the active grid
					// (i.e. what tmux would show when the user scrolled all the
					// way up). Each MARK-NNN must appear in that combined buffer
					// exactly once — no gaps ("missing sections") and no
					// duplicates ("repeating chunks").
					const scrollback = strip(term.getScrollBuffer());
					const buffer = scrollback.join("\n");
					const missing: string[] = [];
					const duplicated: string[] = [];
					for (const mark of markers) {
						const occ = occurrencesOf(buffer, mark);
						if (occ === 0) missing.push(mark);
						if (occ > 1) duplicated.push(mark);
					}
					expect(missing).toEqual([]);
					expect(duplicated).toEqual([]);

					// The visible viewport still shows the live tail.
					const viewport = strip(term.getViewport());
					expect(viewport.some(row => row.includes("MARK-039"))).toBe(true);
				} finally {
					tui.stop();
					await term.flush();
				}
			});
		});
	});

	it("never emits ED3 (CSI 3 J) inside a tmux pane during streaming", async () => {
		if (process.platform === "win32") return;

		await withEnvPatch(TMUX_ENV, async () => {
			await withTerminalRisk(true, async () => {
				const term = new VirtualTerminal(80, 8, 10_000);
				overrideProbe(term, undefined);
				const tui = new TUI(term);
				const stream = new StreamingLiveRegion([]);
				tui.addChild(stream);

				try {
					tui.start();
					tui.setEagerNativeScrollbackRebuild(true);
					await settle(term);

					const writes = capture(term);
					for (let chunk = 5; chunk <= 40; chunk += 5) {
						stream.setLines(Array.from({ length: chunk }, (_unused, i) => `row-${String(i).padStart(3, "0")}`));
						tui.requestRender();
						await settle(term);
					}

					// ED3 would either be a no-op or yank a scrolled tmux reader.
					// The tmux path must commit incrementally via \r\n.
					expect(writes.join("").match(ERASE_SCROLLBACK)?.length ?? 0).toBe(0);
				} finally {
					tui.stop();
					await term.flush();
				}
			});
		});
	});

	it("does not push chrome below the live block into pane history", async () => {
		// Models a real omp frame: streamed assistant reply on top, persistent
		// chrome (status line / editor) below. The live region ends mid-frame,
		// so the renderer must push only sealed rows of the live block into
		// pane history while keeping the chrome rows transient and confined to
		// the visible pane.
		if (process.platform === "win32") return;

		await withEnvPatch(TMUX_ENV, async () => {
			await withTerminalRisk(true, async () => {
				const term = new VirtualTerminal(80, 10, 10_000);
				overrideProbe(term, undefined);
				const tui = new TUI(term);
				const stream = new StreamingLiveRegion([]);
				const footer = new LineList(["── prompt ──", "> "]);
				tui.addChild(stream);
				tui.addChild(footer);

				const markers = Array.from({ length: 30 }, (_unused, i) => `STREAM-${String(i).padStart(3, "0")}`);

				try {
					tui.start();
					tui.setEagerNativeScrollbackRebuild(true);
					await settle(term);

					for (let chunk = 4; chunk <= markers.length; chunk += 4) {
						stream.setLines(markers.slice(0, chunk));
						tui.requestRender();
						await settle(term);
					}

					// `getScrollBuffer()` returns pane history followed by the
					// active grid (the visible viewport). For "what is in pane
					// history alone", chop off the last `rows` entries.
					const fullBuffer = strip(term.getScrollBuffer());
					const viewport = strip(term.getViewport());
					const history = fullBuffer.slice(0, Math.max(0, fullBuffer.length - viewport.length));

					// Chrome must NEVER enter pane history (it sits below the live
					// region and never sealed).
					expect(history.some(row => row.includes("── prompt ──"))).toBe(false);
					expect(history.some(row => row.includes("> "))).toBe(false);
					// Chrome stays in the visible viewport.
					expect(viewport.some(row => row.includes("── prompt ──"))).toBe(true);

					// No streamed row appears twice across pane history.
					const historyText = history.join("\n");
					const duplicated = markers.filter(m => occurrencesOf(historyText, m) > 1);
					expect(duplicated).toEqual([]);

					// The pane-history slice runs in original streaming order so
					// a tmux scroll-back is monotonic.
					const historyMarks = history
						.map(row => row.match(/STREAM-\d{3}/)?.[0] ?? null)
						.filter((m): m is string => m !== null);
					expect(historyMarks).toEqual(markers.slice(0, historyMarks.length));
				} finally {
					tui.stop();
					await term.flush();
				}
			});
		});
	});
});

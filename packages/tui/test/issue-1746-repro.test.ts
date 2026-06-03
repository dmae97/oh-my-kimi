import { describe, expect, it } from "bun:test";
import { type Component, ProcessTerminal, TERMINAL, type Terminal, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/1746
//
// Tabby — and every other non-WT ConPTY host on Windows (Hyper, VS Code,
// conhost) — reported the viewport jumping to the top of scrollback during
// streaming and after prompt submission. Root cause: the kernel32
// `GetConsoleScreenBufferInfo` probe describes the ConPTY pseudo-console
// buffer, which is pinned to the visible grid (microsoft/terminal#10191), so
// it reads "viewport at bottom" no matter where the user scrolled the host
// UI. The #1635 fix distrusted the probe only under `WT_SESSION`; Tabby sets
// no identifying env var, so the renderer kept trusting the lie:
// `#canRebuildNativeScrollbackLive(true, ...)` ran a destructive
// `historyRebuild` (`\x1b[2J\x1b[H\x1b[3J`), erasing host scrollback and
// clamping the scrolled viewport to the top.
//
// Fix: the kernel32 probe is deleted and `ProcessTerminal` no longer
// implements the optional `isNativeViewportAtBottom` at all, routing every
// Windows host through the renderer's win32 unknown-viewport guards: live
// mutations defer (no ED3, no viewport movement, dirty scrollback) and
// reconcile at explicit checkpoints (prompt submit), where the user's
// keystroke has already pinned the host viewport to the bottom.
//
// Stress-level coverage: the `win32-unknown-small` core scenario and the
// `win32-unknown-plain-*` soak scenarios drive the same contract through the
// randomized op mix (scroll-up -> eager streaming mutation).

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

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(20);
	await term.flush();
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

/**
 * Models post-fix `ProcessTerminal` on every Windows host: the viewport
 * position is permanently unknown. ConPTY pins the pseudo-console buffer to
 * the visible grid, so no kernel32 answer can describe the host UI scrollback.
 */
class ConptyHostTerminal extends VirtualTerminal {
	isNativeViewportAtBottom(): undefined {
		return undefined;
	}
}

type MutableTerminalInfo = {
	eagerEraseScrollbackRisk: boolean;
};

const mutableTerminalInfo = TERMINAL as unknown as MutableTerminalInfo;

async function withTerminalRisk<T>(risk: boolean, run: () => T | Promise<T>): Promise<T> {
	const saved = TERMINAL.eagerEraseScrollbackRisk;
	mutableTerminalInfo.eagerEraseScrollbackRisk = risk;
	try {
		return await run();
	} finally {
		mutableTerminalInfo.eagerEraseScrollbackRisk = saved;
	}
}

async function withPlatform<T>(platform: NodeJS.Platform, run: () => T | Promise<T>): Promise<T> {
	const originalPlatform = process.platform;
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
	try {
		return await run();
	} finally {
		Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
	}
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

// Tabby's environment: no WT_SESSION, no TERM_PROGRAM, no multiplexer — there
// is nothing to detect the host by.
const CONPTY_HOST_ENV: Record<string, string | undefined> = {
	TMUX: undefined,
	STY: undefined,
	ZELLIJ: undefined,
	WT_SESSION: undefined,
	TERM_PROGRAM: undefined,
};

const ERASE_SCROLLBACK = /\x1b\[3J/g;

function eraseScrollbackCount(writes: string[]): number {
	return writes.join("").match(ERASE_SCROLLBACK)?.length ?? 0;
}

describe("issue #1746: native Windows viewport probe", () => {
	it("ProcessTerminal never claims to know the native viewport position", () => {
		// ProcessTerminal deliberately does not implement the optional probe —
		// under ConPTY kernel32 describes the pseudo-console buffer (pinned to
		// the visible grid), and on legacy conhost the window tracks the output
		// cursor, not the buffer tail — so the renderer, which reads it through
		// the optional Terminal interface method, always sees "unknown".
		const terminal: Terminal = new ProcessTerminal();
		expect(terminal.isNativeViewportAtBottom?.()).toBeUndefined();
	});
});

describe("issue #1746: scrolled reader in a non-WT ConPTY host (Tabby)", () => {
	it("defers streaming-time rebuilds and reconciles at the prompt checkpoint", async () => {
		// Reproduces the win32-unknown-small stress trace (seed 0xe544f6bd op 0-1):
		// scroll up 6 rows, then an eager streaming mutation edits an offscreen
		// row. Pre-fix the trusted-but-lying probe returned `true`, the renderer
		// ran historyRebuild, and the viewport was clamped from row 28 to row 0.
		await withEnvPatch(CONPTY_HOST_ENV, async () => {
			await withPlatform("win32", async () => {
				const term = new ConptyHostTerminal(40, 6, 10_000);
				const tui = new TUI(term);
				const transcript = new LineList(Array.from({ length: 40 }, (_value, index) => `row-${index}`));
				tui.addChild(transcript);

				try {
					tui.start();
					await settle(term);

					// Reader scrolls up into host scrollback.
					term.scrollLines(-6);
					await settle(term);
					const scrolled = term.getBufferPosition();
					expect(scrolled.viewportY).toBeLessThan(scrolled.baseY);
					const visibleBefore = term.getViewport();

					const writes = capture(term);
					// Foreground streaming enables eager native scrollback rebuilds.
					tui.setEagerNativeScrollbackRebuild(true);

					// A streamed token re-lays-out a row above the viewport top.
					transcript.setLines(
						Array.from({ length: 40 }, (_value, index) =>
							index === 18 ? "row-18 streamed-update" : `row-${index}`,
						),
					);
					tui.requestRender();
					await settle(term);

					// The anti-yank contract: no destructive scrollback erase, the
					// reader's viewport position is untouched, and the history rows
					// they are looking at are not rewritten.
					expect(eraseScrollbackCount(writes)).toBe(0);
					expect(term.getBufferPosition().viewportY).toBe(scrolled.viewportY);
					expect(term.getViewport()).toEqual(visibleBefore);

					// The deferred rewrite reconciles at an explicit checkpoint
					// (prompt submit passes allowUnknownViewport: true). A destructive
					// replay is acceptable there: the Enter keystroke has already
					// snapped the host viewport to the bottom.
					expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(true);
					await settle(term);
					expect(eraseScrollbackCount(writes)).toBe(1);
				} finally {
					tui.stop();
				}
			});
		});
	});

	it("keeps POSIX eager streaming rebuilds destructive (win32 guard must not leak)", async () => {
		// Control case: on POSIX (non-ED3-risk terminal), the same eager
		// streaming mutation IS allowed to rebuild history live — that is the
		// documented purpose of setEagerNativeScrollbackRebuild. The win32
		// deferral must stay scoped to Windows, or streaming tool output would
		// stop reaching native scrollback on POSIX until the next checkpoint.
		await withEnvPatch(CONPTY_HOST_ENV, async () => {
			await withPlatform("linux", async () => {
				await withTerminalRisk(false, async () => {
					const term = new ConptyHostTerminal(40, 6, 10_000);
					const tui = new TUI(term);
					const transcript = new LineList(Array.from({ length: 40 }, (_value, index) => `row-${index}`));
					tui.addChild(transcript);

					try {
						tui.start();
						await settle(term);

						const writes = capture(term);
						tui.setEagerNativeScrollbackRebuild(true);

						transcript.setLines(
							Array.from({ length: 40 }, (_value, index) =>
								index === 18 ? "row-18 streamed-update" : `row-${index}`,
							),
						);
						tui.requestRender();
						await settle(term);

						expect(eraseScrollbackCount(writes)).toBe(1);
					} finally {
						tui.stop();
					}
				});
			});
		});
	});
});

import { describe, expect, it } from "bun:test";
import { type Component, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/1635
//
// Native Windows + Windows Terminal (ConPTY) routes `omp` through a
// pseudo-console whose `GetConsoleScreenBufferInfo` answer always reports
// "viewport at bottom" — it cannot see the WT host scrollback. When the user
// scrolled up in WT and the renderer hit a `historyRebuild` intent (the
// shrink-across-viewport branch), the destructive `\x1b[2J\x1b[H\x1b[3J`
// sequence reset the WT viewport to the top of scrollback.
//
// Fix: `ProcessTerminal` no longer implements the optional
// `isNativeViewportAtBottom` probe — no Windows host can answer it truthfully
// (ConPTY pins the pseudo-console buffer to the visible grid; legacy conhost's
// window tracks the output cursor, not the buffer tail) — so the renderer's
// deferred-rebuild path keeps streaming-time mutations non-destructive. The
// same contract for non-WT ConPTY hosts (Tabby, Hyper, VS Code) is locked
// end-to-end by issue-1746-repro.test.ts and the win32-unknown render stress
// scenarios.
//
// The renderer assertions below override the VirtualTerminal probe to simulate
// the two relevant post-fix outcomes:
//
//  - `undefined`: probe is unreportable (WT-hosted on win32, or any POSIX
//                 host where the probe never had an answer to begin with).
//  - `false`:     the host can see scrollback and reports the user scrolled
//                 up. Both must avoid `\x1b[3J`.
//
// Geometry changes are exempt: a terminal resize is now an explicit clean reset
// that always rebuilds via `\x1b[2J\x1b[H\x1b[3J` at the new size (covered by
// render-regressions.test.ts), so this file guards content mutations only.
class LineList implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = [...lines];
	}
	invalidate(): void {}
	render(width: number): string[] {
		return this.#lines.map(l => l.slice(0, width));
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

function overrideProbe(term: VirtualTerminal, answer: boolean | undefined): void {
	(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () => answer;
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

type MutableTerminalInfo = { eagerEraseScrollbackRisk: boolean };
const mutableTerminalInfo = TERMINAL as unknown as MutableTerminalInfo;

// Pin the ED3-yank risk so the "unreportable viewport" contract is deterministic
// rather than inherited from the host terminal. On POSIX the viewport probe is
// always `undefined`; the renderer only defers the destructive `\x1b[3J` rebuild
// when the terminal is known to disturb a scrolled reader on ED3
// (`eagerEraseScrollbackRisk`). On a non-risk terminal a clean history rebuild —
// `\x1b[3J` included — is the documented, safe behavior, so the no-ED3 guarantee
// this file asserts is meaningful only when the terminal would actually yank.
// Without this pin the test passes under ghostty/kitty/etc. (risk = true) and
// fails on a bare CI terminal (risk = false). Sibling repro tests (#1610, #1682,
// #1746) pin it the same way.
async function withTerminalRisk<T>(risk: boolean, run: () => T | Promise<T>): Promise<T> {
	const saved = TERMINAL.eagerEraseScrollbackRisk;
	mutableTerminalInfo.eagerEraseScrollbackRisk = risk;
	try {
		return await run();
	} finally {
		mutableTerminalInfo.eagerEraseScrollbackRisk = saved;
	}
}

const ERASE_SCROLLBACK = /\x1b\[3J/g;

describe("issue #1635: TUI must not emit \\x1b[3J when probe is unreliable", () => {
	it("content shrink with unreportable viewport must not emit \\x1b[3J", async () => {
		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(100, 24);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			const component = new LineList(Array.from({ length: 80 }, (_, i) => `init-${i}`));
			tui.addChild(component);
			try {
				tui.start();
				await settle(term);
				const writes = capture(term);
				component.setLines(Array.from({ length: 20 }, (_, i) => `shrunk-${i}`));
				tui.requestRender();
				await settle(term);
				expect(writes.join("").match(ERASE_SCROLLBACK)).toBeNull();
			} finally {
				tui.stop();
			}
		});
	});

	it("content shrink with scrolled-up viewport must not emit \\x1b[3J", async () => {
		const term = new VirtualTerminal(100, 24);
		overrideProbe(term, false);
		const tui = new TUI(term);
		const component = new LineList(Array.from({ length: 80 }, (_, i) => `init-${i}`));
		tui.addChild(component);
		try {
			tui.start();
			await settle(term);
			const writes = capture(term);
			component.setLines(Array.from({ length: 20 }, (_, i) => `shrunk-${i}`));
			tui.requestRender();
			await settle(term);
			expect(writes.join("").match(ERASE_SCROLLBACK)).toBeNull();
		} finally {
			tui.stop();
		}
	});

	it("eager overlay rebuild with unreportable Windows viewport must not emit \\x1b[3J", async () => {
		await withPlatform("win32", async () => {
			const term = new VirtualTerminal(40, 4);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			const component = new LineList(["base-0", "base-1", "base-2", "base-3"]);
			tui.addChild(component);
			try {
				tui.start();
				await settle(term);
				const writes = capture(term);
				tui.showOverlay(new LineList(["overlay-0"]), { row: 0, col: 0 });
				await settle(term);
				tui.setEagerNativeScrollbackRebuild(true);

				component.setLines(["base-0", "base-1", "base-2", "base-3", "streamed"]);
				tui.requestRender();
				await settle(term);

				expect(writes.join("").match(ERASE_SCROLLBACK)).toBeNull();
			} finally {
				tui.stop();
			}
		});
	});
});

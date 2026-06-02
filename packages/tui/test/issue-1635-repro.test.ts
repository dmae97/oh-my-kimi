import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { shouldTrustNativeViewportProbe } from "@oh-my-pi/pi-tui/terminal";
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
// Fix: `shouldTrustNativeViewportProbe` returns false under WT_SESSION so the
// probe falls back to `undefined`, and the renderer's existing
// deferred-rebuild path keeps streaming-time mutations non-destructive.
//
// The renderer assertions below override the VirtualTerminal probe to simulate
// the two relevant post-fix outcomes:
//
//  - `undefined`: probe is unreportable (WT-hosted on win32, or any POSIX
//                 host where the probe never had an answer to begin with).
//  - `false`:     the host can see scrollback and reports the user scrolled
//                 up. Both must avoid `\x1b[3J`.
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
	await new Promise<void>(r => process.nextTick(r));
	await new Promise<void>(r => setTimeout(r, 20));
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

const ERASE_SCROLLBACK = /\x1b\[3J/g;

describe("issue #1635: shouldTrustNativeViewportProbe", () => {
	it("returns true on bare native Windows (legacy console)", () => {
		expect(shouldTrustNativeViewportProbe({}, "win32")).toBe(true);
	});

	it("returns false when running under Windows Terminal", () => {
		expect(shouldTrustNativeViewportProbe({ WT_SESSION: "abcd-efgh" }, "win32")).toBe(false);
	});

	it("returns false on POSIX where the probe has no answer", () => {
		expect(shouldTrustNativeViewportProbe({}, "linux")).toBe(false);
		expect(shouldTrustNativeViewportProbe({}, "darwin")).toBe(false);
	});

	it("returns false on POSIX even if WT_SESSION leaked through (defense in depth)", () => {
		expect(shouldTrustNativeViewportProbe({ WT_SESSION: "x" }, "linux")).toBe(false);
	});
});

describe("issue #1635: TUI must not emit \\x1b[3J when probe is unreliable", () => {
	it("content shrink with unreportable viewport must not emit \\x1b[3J", async () => {
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

	it("height change with unreportable viewport must not emit \\x1b[3J", async () => {
		const term = new VirtualTerminal(100, 24);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const component = new LineList(Array.from({ length: 40 }, (_, i) => `init-${i}`));
		tui.addChild(component);
		try {
			tui.start();
			await settle(term);
			const writes = capture(term);
			term.resize(100, 25);
			await settle(term);
			expect(writes.join("").match(ERASE_SCROLLBACK)).toBeNull();
		} finally {
			tui.stop();
		}
	});

	it("width change with unreportable viewport must not emit \\x1b[3J", async () => {
		const term = new VirtualTerminal(100, 24);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const component = new LineList(Array.from({ length: 40 }, (_, i) => `init-${i}`));
		tui.addChild(component);
		try {
			tui.start();
			await settle(term);
			const writes = capture(term);
			term.resize(99, 24);
			await settle(term);
			expect(writes.join("").match(ERASE_SCROLLBACK)).toBeNull();
		} finally {
			tui.stop();
		}
	});
});

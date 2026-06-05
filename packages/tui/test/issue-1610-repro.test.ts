import { describe, expect, it } from "bun:test";
import { type Component, detectTerminalEagerEraseScrollbackRisk, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/1610
//
// WSL fronted by Windows Terminal: the TUI runs as a Linux process
// (`process.platform === "linux"`), so the kernel32 viewport probe is
// unreachable and `isNativeViewportAtBottom()` is permanently `undefined`.
// The outer Windows Terminal owns the user-visible scrollback, erases it on
// ED3 (`CSI 3 J`), and repositions the viewport against the shortened buffer.
// Eager streaming rebuilds must therefore classify WSL+WT (detected via the
// WT_SESSION variable that Windows Terminal propagates into the Linux
// environment) as ED3-risk and defer destructive history rebuilds, instead of
// yanking a scrolled-up reader to the top of the replayed history.

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

function overrideProbe(term: VirtualTerminal, answer: boolean | undefined): void {
	(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () => answer;
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

const CLEAR_MULTIPLEXER_ENV: Record<string, string | undefined> = {
	TMUX: undefined,
	STY: undefined,
	ZELLIJ: undefined,
};
const ERASE_SCROLLBACK = /\x1b\[3J/g;
const WSL_WT_ENV = {
	WT_SESSION: "5ca7376f-cd1b-4524-a45a-7e87b06b8f9e",
	WSL_DISTRO_NAME: "Ubuntu",
	WSL_INTEROP: "/run/WSL/8_interop",
} as const;

function eraseScrollbackCount(writes: string[]): number {
	return writes.join("").match(ERASE_SCROLLBACK)?.length ?? 0;
}

describe("issue #1610: WSL Windows Terminal ED3-risk detection", () => {
	it("classifies Windows Terminal fronting a Linux process as ED3-risk", () => {
		// WT propagates WT_SESSION into the WSL environment; WSL adds its own markers.
		expect(detectTerminalEagerEraseScrollbackRisk(WSL_WT_ENV, "linux")).toBe(true);
		// Containers/nested shells launched from WSL inherit WT_SESSION without
		// the WSL markers — the outer host is still Windows Terminal.
		expect(detectTerminalEagerEraseScrollbackRisk({ WT_SESSION: WSL_WT_ENV.WT_SESSION }, "linux")).toBe(true);
	});

	it("keeps native win32 off the ED3-risk path and treats unknown POSIX as risky", () => {
		// Native Windows is guarded by dedicated process.platform checks in the
		// renderer; classifying it as ED3-risk would re-freeze streaming (#1635 family).
		expect(detectTerminalEagerEraseScrollbackRisk({ WT_SESSION: WSL_WT_ENV.WT_SESSION }, "win32")).toBe(false);
		// A WSL/non-WT shell still lacks a scroll-position oracle from the renderer,
		// so default it to ED3-risk instead of assuming passive clears are safe.
		expect(detectTerminalEagerEraseScrollbackRisk({ WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toBe(true);
	});
});

describe("issue #1610: scrolled WSL Windows Terminal viewport", () => {
	it("defers eager streaming rebuilds instead of erasing scrollback under a scrolled reader", async () => {
		// Tie the renderer behavior to the detection result: if detection ever
		// regresses to `false` for WSL+WT, the eager rebuild path emits ED3 and
		// this test reproduces the reporter's yank trace (viewportY -> 0).
		const risk = detectTerminalEagerEraseScrollbackRisk(WSL_WT_ENV, "linux");
		await withEnvPatch(CLEAR_MULTIPLEXER_ENV, async () => {
			await withPlatform("linux", async () => {
				await withTerminalRisk(risk, async () => {
					const term = new VirtualTerminal(40, 6, 10_000);
					overrideProbe(term, undefined);
					const tui = new TUI(term);
					const transcript = new LineList(Array.from({ length: 40 }, (_value, index) => `row-${index}`));
					tui.addChild(transcript);

					try {
						tui.start();
						await settle(term);

						// Reader scrolls up into history (reporter trace: viewportY=12 of baseY=22).
						term.scrollLines(-10);
						await settle(term);
						const scrolled = term.getBufferPosition();
						expect(scrolled.viewportY).toBeLessThan(scrolled.baseY);

						const writes = capture(term);
						// Foreground streaming enables eager native scrollback rebuilds.
						tui.setEagerNativeScrollbackRebuild(true);

						// A streamed token re-lays-out a row above the viewport top.
						transcript.setLines(
							Array.from({ length: 40 }, (_value, index) =>
								index === 5 ? "row-5 streamed-update" : `row-${index}`,
							),
						);
						tui.requestRender();
						await settle(term);

						// The anti-yank contract: no destructive scrollback erase, and the
						// reader's viewport position is untouched.
						expect(eraseScrollbackCount(writes)).toBe(0);
						expect(term.getBufferPosition().viewportY).toBe(scrolled.viewportY);

						// Unknown viewport checkpoints no longer replay destructively; a
						// submit key is not proof that WT's host viewport is at the tail.
						expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(false);
						await settle(term);
						expect(eraseScrollbackCount(writes)).toBe(0);
					} finally {
						tui.stop();
					}
				});
			});
		});
	});
});

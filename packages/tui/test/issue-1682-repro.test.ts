import { describe, expect, it } from "bun:test";
import {
	type Component,
	detectTerminalEagerEraseScrollbackRisk,
	getTerminalInfo,
	TERMINAL,
	TUI,
} from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/1682
//
// POSIX hosts cannot report native viewport position, so live render frames see
// `isNativeViewportAtBottom()` as `undefined`. The streaming eager-rebuild mode
// intentionally used that unknown answer as permission to rewrite native
// scrollback, but the rewrite emits xterm ED3 (`CSI 3 J`, erase saved lines).
// On WezTerm/kitty/ghostty/alacritty/VTE this can disrupt a reader scrolled
// into native history while assistant/tool output is still streaming. The eager
// flag must therefore defer on those hosts, while ordinary POSIX terminals and
// direct user-input opt-ins keep their existing rebuild behavior.
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

class PromptInput implements Component {
	focused = false;
	#text = "";

	handleInput(data: string): void {
		this.#text += data;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [`prompt> ${this.#text}`.slice(0, width)];
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

function eraseScrollbackCount(writes: string[]): number {
	return writes.join("").match(ERASE_SCROLLBACK)?.length ?? 0;
}

describe("issue #1682: detectTerminalEagerEraseScrollbackRisk", () => {
	it("detects known POSIX terminal identifiers", () => {
		expect(detectTerminalEagerEraseScrollbackRisk({ WEZTERM_PANE: "1" }, "linux")).toBe(true);
		expect(detectTerminalEagerEraseScrollbackRisk({ KITTY_WINDOW_ID: "1" }, "linux")).toBe(true);
		expect(detectTerminalEagerEraseScrollbackRisk({ GHOSTTY_RESOURCES_DIR: "/ghostty" }, "darwin")).toBe(true);
		expect(detectTerminalEagerEraseScrollbackRisk({ ALACRITTY_WINDOW_ID: "1" }, "darwin")).toBe(true);
		expect(detectTerminalEagerEraseScrollbackRisk({ VTE_VERSION: "7600" }, "linux")).toBe(true);
		expect(detectTerminalEagerEraseScrollbackRisk({ TERM_PROGRAM: "ghostty" }, "linux")).toBe(true);
		expect(detectTerminalEagerEraseScrollbackRisk({ TERM_PROGRAM: "Apple_Terminal" }, "darwin")).toBe(true);
		expect(detectTerminalEagerEraseScrollbackRisk({ TERM_PROGRAM: "iTerm.app" }, "darwin")).toBe(true);
		expect(detectTerminalEagerEraseScrollbackRisk({ ITERM_SESSION_ID: "w0t0p0" }, "darwin")).toBe(true);
	});

	it("stores fixed risk on known terminal traits", () => {
		expect(getTerminalInfo("kitty").eagerEraseScrollbackRisk).toBe(true);
		expect(getTerminalInfo("ghostty").eagerEraseScrollbackRisk).toBe(true);
		expect(getTerminalInfo("wezterm").eagerEraseScrollbackRisk).toBe(true);
		expect(getTerminalInfo("iterm2").eagerEraseScrollbackRisk).toBe(true);
		expect(getTerminalInfo("alacritty").eagerEraseScrollbackRisk).toBe(true);
		expect(getTerminalInfo("base").eagerEraseScrollbackRisk).toBe(false);
		expect(getTerminalInfo("trueColor").eagerEraseScrollbackRisk).toBe(false);
	});

	it("does not trust terminal identifiers on native Windows", () => {
		expect(detectTerminalEagerEraseScrollbackRisk({ WEZTERM_PANE: "1" }, "win32")).toBe(false);
		expect(detectTerminalEagerEraseScrollbackRisk({ TERM_PROGRAM: "Apple_Terminal" }, "win32")).toBe(false);
		expect(detectTerminalEagerEraseScrollbackRisk({ ITERM_SESSION_ID: "w0t0p0" }, "win32")).toBe(false);
	});

	it("leaves unrecognized POSIX terminals on the eager path", () => {
		expect(detectTerminalEagerEraseScrollbackRisk({}, "linux")).toBe(false);
		expect(detectTerminalEagerEraseScrollbackRisk({ TERM_PROGRAM: "vscode" }, "darwin")).toBe(false);
	});
});

describe("issue #1682: TUI eager scrollback rebuild", () => {
	it("defers on ED3-risk terminal traits and rebuilds at the checkpoint", async () => {
		await withEnvPatch(CLEAR_MULTIPLEXER_ENV, async () => {
			await withTerminalRisk(true, async () => {
				const term = new VirtualTerminal(100, 24);
				overrideProbe(term, undefined);
				const tui = new TUI(term);
				const component = new LineList(Array.from({ length: 80 }, (_value, index) => `init-${index}`));
				tui.addChild(component);

				try {
					tui.start();
					await settle(term);
					const writes = capture(term);
					tui.setEagerNativeScrollbackRebuild(true);

					component.setLines(Array.from({ length: 20 }, (_value, index) => `shrunk-${index}`));
					tui.requestRender();
					await settle(term);

					expect(eraseScrollbackCount(writes)).toBe(0);
					expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(true);
					await settle(term);
					expect(eraseScrollbackCount(writes)).toBe(1);
				} finally {
					tui.stop();
				}
			});
		});
	});

	it("paints an overflowing ED3-risk shrink instead of freezing until input", async () => {
		await withEnvPatch(CLEAR_MULTIPLEXER_ENV, async () => {
			await withTerminalRisk(true, async () => {
				const term = new VirtualTerminal(40, 5);
				overrideProbe(term, undefined);
				const tui = new TUI(term);
				const component = new LineList(Array.from({ length: 30 }, (_value, index) => `init-${index}`));
				tui.addChild(component);

				try {
					tui.start();
					await settle(term);
					const writes = capture(term);
					tui.setEagerNativeScrollbackRebuild(true);

					component.setLines(Array.from({ length: 20 }, (_value, index) => `shrunk-${index}`));
					tui.requestRender();
					await settle(term);

					expect(writes.join("")).not.toBe("");
					expect(eraseScrollbackCount(writes)).toBe(0);
					expect(term.getViewport().map(line => line.trim())).toEqual([
						"shrunk-15",
						"shrunk-16",
						"shrunk-17",
						"shrunk-18",
						"shrunk-19",
					]);
					expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(true);
					await settle(term);
					expect(eraseScrollbackCount(writes)).toBe(1);
				} finally {
					tui.stop();
				}
			});
		});
	});

	it("treats focused keyboard input as a user-input opt-in after an ED3-risk shrink defers", async () => {
		await withEnvPatch(CLEAR_MULTIPLEXER_ENV, async () => {
			await withTerminalRisk(true, async () => {
				const term = new VirtualTerminal(40, 10);
				overrideProbe(term, undefined);
				const tui = new TUI(term);
				const transcript = new LineList(Array.from({ length: 80 }, (_value, index) => `init-${index}`));
				const prompt = new PromptInput();
				tui.addChild(transcript);
				tui.addChild(prompt);
				tui.setFocus(prompt);

				try {
					tui.start();
					await settle(term);
					const writes = capture(term);
					tui.setEagerNativeScrollbackRebuild(true);

					transcript.setLines(Array.from({ length: 20 }, (_value, index) => `shrunk-${index}`));
					tui.requestRender();
					await settle(term);

					expect(eraseScrollbackCount(writes)).toBe(0);
					expect(term.getViewport().map(line => line.trim())).not.toContain("prompt> x");

					term.sendInput("x");
					await settle(term);

					expect(term.getViewport().map(line => line.trim())).toContain("prompt> x");
					expect(eraseScrollbackCount(writes)).toBe(1);
					expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(false);
				} finally {
					tui.stop();
				}
			});
		});
	});

	it("keeps eager live rebuilds for other terminal traits", async () => {
		await withEnvPatch(CLEAR_MULTIPLEXER_ENV, async () => {
			await withTerminalRisk(false, async () => {
				const term = new VirtualTerminal(100, 24);
				overrideProbe(term, undefined);
				const tui = new TUI(term);
				const component = new LineList(Array.from({ length: 80 }, (_value, index) => `init-${index}`));
				tui.addChild(component);

				try {
					tui.start();
					await settle(term);
					const writes = capture(term);
					tui.setEagerNativeScrollbackRebuild(true);

					component.setLines(Array.from({ length: 20 }, (_value, index) => `shrunk-${index}`));
					tui.requestRender();
					await settle(term);

					expect(eraseScrollbackCount(writes)).toBe(1);
					expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(false);
				} finally {
					tui.stop();
				}
			});
		});
	});

	it("still honors explicit user-input opt-ins on ED3-risk terminal traits", async () => {
		await withEnvPatch(CLEAR_MULTIPLEXER_ENV, async () => {
			await withTerminalRisk(true, async () => {
				const term = new VirtualTerminal(100, 24);
				overrideProbe(term, undefined);
				const tui = new TUI(term);
				const component = new LineList(Array.from({ length: 80 }, (_value, index) => `init-${index}`));
				tui.addChild(component);

				try {
					tui.start();
					await settle(term);
					const writes = capture(term);
					tui.setEagerNativeScrollbackRebuild(true);

					component.setLines(Array.from({ length: 20 }, (_value, index) => `shrunk-${index}`));
					tui.requestRender(false, { allowUnknownViewportMutation: true });
					await settle(term);

					expect(eraseScrollbackCount(writes)).toBe(1);
					expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(false);
				} finally {
					tui.stop();
				}
			});
		});
	});
});

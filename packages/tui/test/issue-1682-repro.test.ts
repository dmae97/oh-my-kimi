import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { terminalHasEagerEraseScrollbackRisk } from "@oh-my-pi/pi-tui/terminal";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/1682
//
// POSIX hosts cannot report native viewport position, so live render frames see
// `isNativeViewportAtBottom()` as `undefined`. The streaming eager-rebuild mode
// intentionally used that unknown answer as permission to rewrite native
// scrollback, but the rewrite emits xterm ED3 (`CSI 3 J`, erase saved lines).
// On WezTerm/kitty/ghostty/alacritty this can disrupt a reader scrolled into
// native history while assistant/tool output is still streaming. The eager flag
// must therefore defer on those hosts, while ordinary POSIX terminals and
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

async function withPlatform<T>(platform: NodeJS.Platform, run: () => T | Promise<T>): Promise<T> {
	const originalPlatform = process.platform;
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
	try {
		return await run();
	} finally {
		Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
	}
}

const CLEAR_TERMINAL_RISK_ENV: Record<string, string | undefined> = {
	WEZTERM_PANE: undefined,
	KITTY_WINDOW_ID: undefined,
	GHOSTTY_RESOURCES_DIR: undefined,
	ALACRITTY_WINDOW_ID: undefined,
	TERM_PROGRAM: undefined,
	TMUX: undefined,
	STY: undefined,
	ZELLIJ: undefined,
};
const ERASE_SCROLLBACK = /\x1b\[3J/g;

function eraseScrollbackCount(writes: string[]): number {
	return writes.join("").match(ERASE_SCROLLBACK)?.length ?? 0;
}

describe("issue #1682: terminalHasEagerEraseScrollbackRisk", () => {
	it("detects known POSIX terminal identifiers", () => {
		expect(terminalHasEagerEraseScrollbackRisk({ WEZTERM_PANE: "1" }, "linux")).toBe(true);
		expect(terminalHasEagerEraseScrollbackRisk({ KITTY_WINDOW_ID: "1" }, "linux")).toBe(true);
		expect(terminalHasEagerEraseScrollbackRisk({ GHOSTTY_RESOURCES_DIR: "/ghostty" }, "darwin")).toBe(true);
		expect(terminalHasEagerEraseScrollbackRisk({ ALACRITTY_WINDOW_ID: "1" }, "darwin")).toBe(true);
		expect(terminalHasEagerEraseScrollbackRisk({ TERM_PROGRAM: "ghostty" }, "linux")).toBe(true);
	});

	it("does not trust terminal identifiers on native Windows", () => {
		expect(terminalHasEagerEraseScrollbackRisk({ WEZTERM_PANE: "1" }, "win32")).toBe(false);
		expect(terminalHasEagerEraseScrollbackRisk({ TERM_PROGRAM: "ghostty" }, "win32")).toBe(false);
	});

	it("leaves unrecognized POSIX terminals on the eager path", () => {
		expect(terminalHasEagerEraseScrollbackRisk({}, "linux")).toBe(false);
		expect(terminalHasEagerEraseScrollbackRisk({ TERM_PROGRAM: "Apple_Terminal" }, "darwin")).toBe(false);
	});
});

describe("issue #1682: TUI eager scrollback rebuild", () => {
	it("defers on ED3-risk POSIX terminals and rebuilds at the checkpoint", async () => {
		await withPlatform("linux", async () => {
			await withEnvPatch({ ...CLEAR_TERMINAL_RISK_ENV, WEZTERM_PANE: "pane-1" }, async () => {
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

	it("keeps eager live rebuilds for other POSIX terminals", async () => {
		await withPlatform("linux", async () => {
			await withEnvPatch(CLEAR_TERMINAL_RISK_ENV, async () => {
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

	it("still honors explicit user-input opt-ins on ED3-risk POSIX terminals", async () => {
		await withPlatform("linux", async () => {
			await withEnvPatch({ ...CLEAR_TERMINAL_RISK_ENV, WEZTERM_PANE: "pane-1" }, async () => {
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

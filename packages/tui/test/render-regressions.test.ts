import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

class WrappingLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		const chunkWidth = Math.max(1, width);
		const rendered: string[] = [];
		for (const line of this.#lines) {
			if (line.length === 0) {
				rendered.push("");
				continue;
			}
			for (let offset = 0; offset < line.length; offset += chunkWidth) {
				rendered.push(line.slice(offset, offset + chunkWidth));
			}
		}
		return rendered;
	}
}

class FocusedInputComponent implements Component, Focusable {
	focused = false;
	#onInput: () => void;

	constructor(onInput: () => void) {
		this.#onInput = onInput;
	}

	handleInput(): void {
		this.#onInput();
	}

	invalidate(): void {}

	render(): string[] {
		return [this.focused ? `prompt>${CURSOR_MARKER}` : "prompt>"];
	}
}

class UnknownViewportTerminal extends VirtualTerminal {
	isNativeViewportAtBottom(): undefined {
		return undefined;
	}
}

class StaleBottomViewportTerminal extends VirtualTerminal {
	#previous: boolean | undefined;
	#returnStale = false;

	isNativeViewportAtBottom(): boolean | undefined {
		const current = super.isNativeViewportAtBottom();
		if (this.#returnStale) {
			this.#returnStale = false;
			const stale = this.#previous;
			this.#previous = current;
			return stale;
		}
		this.#returnStale = true;
		this.#previous = current;
		return current;
	}
}

class CountingViewportTerminal extends VirtualTerminal {
	viewportProbeCount = 0;

	isNativeViewportAtBottom(): boolean | undefined {
		this.viewportProbeCount += 1;
		return super.isNativeViewportAtBottom();
	}
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_v, i) => `${prefix}${i}`);
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(1);
	await term.flush();
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

function countMatches(lines: string[], pattern: RegExp): number {
	let count = 0;
	for (const line of lines) {
		if (pattern.test(line)) count += 1;
	}
	return count;
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

describe("TUI terminal-state regressions", () => {
	let monotonicNow = 0;
	// Keep TUI's 16ms render throttle deterministic without sleeping a real frame per render.

	beforeEach(() => {
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("cursor + differential stability", () => {
		it("keeps stable output across repeated no-op renders", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["hello", "world", "stable"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const before = visible(term);

				for (let i = 0; i < 8; i++) {
					tui.requestRender();
					await settle(term);
				}

				expect(visible(term)).toEqual(before);
			} finally {
				tui.stop();
			}
		});

		it("updates only changed middle line without corrupting neighbors", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["AAA", "BBB", "CCC", "DDD", "EEE"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const before = visible(term);

				component.setLines(["AAA", "BBB", "XXX", "DDD", "EEE"]);
				tui.requestRender();
				await settle(term);

				const after = visible(term);
				expect(after[0]).toBe(before[0]);
				expect(after[1]).toBe(before[1]);
				expect(after[2]?.trim()).toBe("XXX");
				expect(after[3]).toBe(before[3]);
				expect(after[4]).toBe(before[4]);
			} finally {
				tui.stop();
			}
		});

		it("clears removed tail lines after shrink", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["A", "B", "C", "D", "E"]);
			tui.setClearOnShrink(true);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines(["A", "B"]);
				tui.requestRender();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]?.trim()).toBe("A");
				expect(viewport[1]?.trim()).toBe("B");
				expect(viewport[2]?.trim()).toBe("");
				expect(viewport[3]?.trim()).toBe("");
				expect(viewport[4]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});

		it("clears row 0 when content shrinks to empty without clearOnShrink", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["A"]);
			tui.setClearOnShrink(false);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines([]);
				tui.requestRender();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});

		it("appends overflowing content after a legitimately empty previous frame", async () => {
			const term = new VirtualTerminal(20, 3);
			const tui = new TUI(term);
			const component = new MutableLinesComponent([]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines(["A", "B", "C", "D", "E"]);
				tui.requestRender();
				await settle(term);

				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(["A", "B", "C", "D", "E"]);
				expect(visible(term)).toEqual(["C", "D", "E"]);
			} finally {
				tui.stop();
			}
		});

		it("does not duplicate scrollback when two forced renders coalesce in one tick", async () => {
			const term = new VirtualTerminal(20, 3);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("L", 8));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				// Two forced renders queued before the render flush must still be
				// treated as a single drop of the already-committed transcript;
				// otherwise the second one re-emits the whole frame into scrollback.
				tui.requestRender(true);
				tui.requestRender(true);
				await settle(term);

				const occurrences = term
					.getScrollBuffer()
					.map(line => line.trimEnd())
					.filter(line => line === "L0").length;
				expect(occurrences).toBe(1);
			} finally {
				tui.stop();
			}
		});

		it("keeps appended rows in scrollback when a forced render coalesces with content growth", async () => {
			const term = new VirtualTerminal(20, 3);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("L", 5));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				tui.requestRender(true);
				component.setLines(rows("L", 6));
				tui.requestRender();
				await settle(term);

				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(rows("L", 6));
				expect(visible(term)).toEqual(["L3", "L4", "L5"]);
			} finally {
				tui.stop();
			}
		});

		it("does not yank a scrolled viewport for pure tail appends", async () => {
			const term = new VirtualTerminal(20, 3, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("L", 8));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.scrollLines(-1);

				const beforePosition = term.getBufferPosition();
				const beforeView = visible(term);

				component.setLines(rows("L", 9));
				tui.requestRender();
				await settle(term);

				expect(term.getBufferPosition()).toEqual(beforePosition);
				expect(visible(term)).toEqual(beforeView);

				term.scrollLines(1_000_000);
				expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBeTrue();
				await term.flush();
				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(rows("L", 9).slice(1));
			} finally {
				tui.stop();
			}
		});
	});

	describe("resize + viewport behavior", () => {
		it("preserves preexisting shell scrollback on startup and resize redraw", async () => {
			const term = new VirtualTerminal(50, 5);
			term.write("shell-0\r\nshell-1\r\nshell-2\r\nshell-3\r\nshell-4\r\n");
			await settle(term);

			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("ui-", 8));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.resize(49, 5);
				await settle(term);

				const buffer = term.getScrollBuffer().join("\n");
				expect(buffer.includes("shell-")).toBeTruthy();
			} finally {
				tui.stop();
			}
		});

		it("rewraps committed native scrollback when the terminal widens on POSIX (unknown viewport)", async () => {
			// POSIX reports no viewport position. A width change rewraps the whole
			// transcript, so committed scrollback must be rebuilt at the new width even
			// though we cannot prove the viewport is at the tail — yank is acceptable on
			// an explicit resize. Regression: widening drops the wrapped line count, which
			// the shrink-defer branch intercepted, leaving history wrapped at the old width.
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			try {
				await withEnvPatch({ TMUX: undefined, STY: undefined, ZELLIJ: undefined }, async () => {
					// Each logical line is 36 cols: wraps to 20+16 at width 20, fits on one row at width 40.
					const logical = Array.from({ length: 10 }, (_v, i) => `L${i}:${"x".repeat(33)}`);
					const term = new UnknownViewportTerminal(20, 4, 200);
					const tui = new TUI(term);
					const component = new WrappingLinesComponent(logical);
					tui.addChild(component);

					try {
						tui.start();
						await settle(term);
						const narrow = term.getScrollBuffer().map(line => line.trimEnd());
						// Precondition: history is wrapped narrow (L0 split into a 20-col fragment).
						expect(narrow).toContain(`L0:${"x".repeat(17)}`);

						term.resize(40, 4);
						await settle(term);

						const wide = term.getScrollBuffer().map(line => line.trimEnd());
						// Offscreen history rewrapped: each logical line is now a single full row.
						for (let i = 0; i < 6; i++) {
							expect(wide).toContain(`L${i}:${"x".repeat(33)}`);
						}
						// The stale narrow fragments are gone — no duplicate old-width rows survive.
						expect(wide.some(line => line.length === 20 && line.startsWith("L"))).toBeFalse();
					} finally {
						tui.stop();
					}
				});
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});

		it("resizing width truncates visible lines without ghost wrap rows", async () => {
			const term = new VirtualTerminal(30, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent([
				"012345678901234567890123456789012345",
				"ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
			]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.resize(16, 6);
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]!.length).toBeLessThanOrEqual(16);
				expect(viewport[1]!.length).toBeLessThanOrEqual(16);
				expect(viewport[2]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});

		it("width shrink rebuilds stale native history before later appends", async () => {
			const term = new VirtualTerminal(40, 3, 200);
			const tui = new TUI(term);
			const component = new WrappingLinesComponent(["A".repeat(20), "B".repeat(20)]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				// Root cause: shrinking the width can turn a frame that fit on screen
				// into overflowing wrapped rows. A viewport repaint leaves the old
				// terminal-reflowed fragments in native history; the next append then
				// grows scrollback by fewer rows than the logical frame grew.
				term.resize(10, 3);
				await settle(term);
				component.setLines(["A".repeat(20), "B".repeat(20), "C".repeat(20)]);
				tui.requestRender();
				await settle(term);

				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual([
					"AAAAAAAAAA",
					"AAAAAAAAAA",
					"BBBBBBBBBB",
					"BBBBBBBBBB",
					"CCCCCCCCCC",
					"CCCCCCCCCC",
				]);
			} finally {
				tui.stop();
			}
		});

		it("maintains exact viewport rows across repeated width reflow on sparse mixed content", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
			];
			tui.addChild(new MutableLinesComponent(lines));

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);
				expect(visible(term)).toEqual(expectedViewport(80, 18));

				const widths = [72, 64, 56, 68, 52, 80];
				for (const width of widths) {
					term.resize(width, 18);
					await settle(term);
					expect(visible(term)).toEqual(expectedViewport(width, 18));
				}
			} finally {
				tui.stop();
			}
		});
		it("repaints viewport when width reflow grows rendered lines", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const lines = [
				...Array.from({ length: 5 }, (_v, i) => `long-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`),
				...Array.from({ length: 20 }, (_v, i) => `tail-${i}`),
			];
			tui.addChild(new WrappingLinesComponent(lines));

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = new WrappingLinesComponent(lines).render(width);
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);
				expect(visible(term)).toEqual(expectedViewport(40, 10));

				term.resize(20, 10);
				await settle(term);

				expect(visible(term)).toEqual(expectedViewport(20, 10));
			} finally {
				tui.stop();
			}
		});
		it("aggressive resize storm does not duplicate viewport content", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
			];
			tui.addChild(new MutableLinesComponent(lines));

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				const sizes: Array<[number, number]> = [];
				for (let i = 0; i < 240; i++) {
					sizes.push([i % 2 === 0 ? 79 : 80, i % 3 === 0 ? 17 : 18]);
				}

				for (const [w, h] of sizes) {
					term.resize(w, h);
				}
				await settle(term);

				const [finalWidth, finalHeight] = sizes[sizes.length - 1]!;
				expect(visible(term)).toEqual(expectedViewport(finalWidth, finalHeight));
			} finally {
				tui.stop();
			}
		});
		it("height-only resize recovers from cursor drift without duplicate rows", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
			];
			tui.addChild(new MutableLinesComponent(lines));

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				// Simulate terminal-managed cursor relocation during aggressive UI changes/resizes.
				// TUI's internal cursor row bookkeeping does not observe this external movement.
				term.write("\x1b[18;1H");
				await settle(term);

				term.resize(80, 17);
				await settle(term);

				expect(visible(term)).toEqual(expectedViewport(80, 17));
			} finally {
				tui.stop();
			}
		});
		it("streaming content under aggressive resize keeps a single consistent viewport", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const source = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
				"        ├─────────┬─────────┬────────┬──────┬──────────────┬──────────────┐",
				"        │         │         │        │      │              │              │",
				"        ▼         │         ▼        │      ▼              ▼              ▼",
				"┌──────────────┐  │  ┌────────────┐  │  ┌───────┐     ┌─────────┐     ┌───────┐",
				"│    agent     │  │  │    tui     │  │  │ utils │     │ natives │     │ stats │",
				"└───────┬──────┘  │  └──────┬─────┘  │  └───────┘     └────┬────┘     └───────┘",
				"        ├─────────┘         └────────┘                     │",
				"        ▼                                                  │",
				"┌──────────────┐     ┌────────────┐                        │",
				"│      ai      │     │ pi-natives │◄───────────────────────┘",
				"└──────────────┘     └────────────┘",
			];
			const working: string[] = [];
			const component = new MutableLinesComponent(working);
			tui.addChild(component);

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = working.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				let nextLine = 0;
				let finalWidth = term.columns;
				let finalHeight = term.rows;
				for (let i = 0; i < 180; i++) {
					if (i % 3 === 0 && nextLine < source.length) {
						working.push(source[nextLine++]!);
						component.setLines(working);
					}

					finalWidth = i % 2 === 0 ? 79 : 80;
					finalHeight = i % 4 < 2 ? 17 : 18;
					term.resize(finalWidth, finalHeight);
					tui.requestRender();
					await settle(term);
				}

				expect(visible(term)).toEqual(expectedViewport(finalWidth, finalHeight));
			} finally {
				tui.stop();
			}
		}, 15_000);
		it("forced renders during resize storm stay stable under cursor relocation", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = Array.from({ length: 40 }, (_v, i) => `row-${i}`);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				let finalWidth = term.columns;
				let finalHeight = term.rows;
				for (let i = 0; i < 80; i++) {
					finalWidth = i % 2 === 0 ? 79 : 80;
					finalHeight = i % 3 === 0 ? 17 : 18;
					term.resize(finalWidth, finalHeight);
					term.write("\x1b[18;1H");
					tui.requestRender(true);
					await settle(term);
				}

				expect(visible(term)).toEqual(expectedViewport(finalWidth, finalHeight));
			} finally {
				tui.stop();
			}
		});
		it("shrink then grow keeps tail anchored to latest rows", async () => {
			const term = new VirtualTerminal(24, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("row-", 30));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines(rows("row-", 16));
				tui.requestRender();
				await settle(term);

				component.setLines(rows("row-", 24));
				tui.requestRender();
				await settle(term);

				const viewport = visible(term).filter(line => line.trim().length > 0);
				expect(viewport).toHaveLength(6);
				expect(viewport[0]?.trim()).toBe("row-18");
				expect(viewport[5]?.trim()).toBe("row-23");
			} finally {
				tui.stop();
			}
		});
		it("mixed width/height resize storm keeps scrollback bounded for static content", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
				"        ├─────────┬─────────┬────────┬──────┬──────────────┬──────────────┐",
				"        │         │         │        │      │              │              │",
				"        ▼         │         ▼        │      ▼              ▼              ▼",
				"┌──────────────┐  │  ┌────────────┐  │  ┌───────┐     ┌─────────┐     ┌───────┐",
				"│    agent     │  │  │    tui     │  │  │ utils │     │ natives │     │ stats │",
				"└───────┬──────┘  │  └──────┬─────┘  │  └───────┘     └────┬────┘     └───────┘",
				"        ├─────────┘         └────────┘                     │",
				"        ▼                                                  │",
				"┌──────────────┐     ┌────────────┐                        │",
				"│      ai      │     │ pi-natives │◄───────────────────────┘",
				"└──────────────┘     └────────────┘",
			];
			tui.addChild(new MutableLinesComponent(lines));

			try {
				tui.start();
				await settle(term);
				const before = term.getScrollBuffer().length;

				for (let i = 0; i < 220; i++) {
					term.resize(i % 2 === 0 ? 79 : 80, i % 3 === 0 ? 17 : 18);
					await settle(term);
				}

				const after = term.getScrollBuffer().length;
				expect(after - before).toBeLessThan(120);
			} finally {
				tui.stop();
			}
		}, 15_000);

		it("keeps appended rows contiguous when a height grow coincides with new content", async () => {
			// A terminal resize fires requestRender(), and streamed content fires
			// its own requestRender(); the 16ms throttle coalesces them into a
			// single frame that is both taller and longer. The diff/append-tail
			// emitters position scrolled rows against the previous viewport top and
			// hardware cursor row, both invalidated by the reflow — so the appended
			// tail used to slip down by the height delta, leaving a blank gap.
			const term = new VirtualTerminal(40, 12);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 16));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.resize(40, 24);
				component.setLines(rows("line-", 19));
				tui.requestRender();
				await settle(term);

				// 19 lines fit inside the 24-row viewport: rows 0..18 hold content,
				// 19..23 stay blank — with no 4-row (height delta) displacement.
				expect(visible(term)).toEqual([...rows("line-", 19), "", "", "", "", ""]);
				const position = term.getBufferPosition();
				expect(position.viewportY).toBe(position.baseY);
			} finally {
				tui.stop();
			}
		});
	});

	describe("scrollback integrity", () => {
		it("does not probe native viewport state before appends can affect scrollback", async () => {
			const term = new CountingViewportTerminal(32, 5);
			const tui = new TUI(term);
			const lines = rows("line-", 3);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 3; i < 5; i++) {
					lines.push(`line-${i}`);
					component.setLines(lines);
					tui.requestRender();
					await settle(term);
				}

				expect(term.viewportProbeCount).toBe(0);
			} finally {
				tui.stop();
			}
		});

		it("overflow content appears once across buffer without duplicate row IDs", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 10));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const all = term.getScrollBuffer();
				for (let i = 0; i < 10; i++) {
					const pattern = new RegExp(`\\bline-${i}\\b`);
					expect(countMatches(all, pattern), `line-${i} should appear exactly once`).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});

		it("appending lines during aggressive resize does not duplicate history rows", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines: string[] = [];
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 0; i < 140; i++) {
					lines.push(`line-${i}`);
					component.setLines(lines);
					term.resize(i % 2 === 0 ? 79 : 80, i % 3 === 0 ? 17 : 18);
					tui.requestRender();
					await settle(term);
				}

				const scrollback = term.getScrollBuffer();
				const duplicated: number[] = [];
				let presentCount = 0;
				for (let i = 0; i < 140; i++) {
					const pattern = new RegExp(`\\bline-${i}\\b`);
					const count = countMatches(scrollback, pattern);
					if (count > 0) presentCount += 1;
					if (count > 1) duplicated.push(i);
				}
				expect(presentCount).toBeGreaterThan(30);
				expect(duplicated).toEqual([]);
			} finally {
				tui.stop();
			}
		}, 15_000);

		it("rebuilds native scrollback on a width resize without duplicating rows", async () => {
			// A width resize makes the terminal reflow its own committed scrollback
			// at the new size. Repainting only the viewport leaves those stale
			// old-width rows in history, so overflowed rows show up twice (old-width
			// wrap + new-width copy) when the user scrolls back. A real resize must
			// rebuild history synchronously, unlike a pure content mutation which is
			// deferred to the next checkpoint.
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			// Rows wider than the post-resize width so the committed scrollback
			// reflows (wraps) at the narrower size; short rows would not regress.
			const filler = "x".repeat(24);
			const component = new MutableLinesComponent(Array.from({ length: 12 }, (_v, i) => `line-${i}-${filler}`));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				// User sits at the bottom (not scrolled) and narrows the terminal.
				term.resize(28, 5);
				await settle(term);

				const scrollback = term.getScrollBuffer();
				for (let i = 0; i < 12; i++) {
					const pattern = new RegExp(`\\bline-${i}\\b`);
					expect(countMatches(scrollback, pattern), `line-${i} should appear once after resize`).toBe(1);
				}
				// The resize rebuilt history in place; nothing is left deferred.
				expect(tui.refreshNativeScrollbackIfDirty()).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("defers resize rebuild while native scrollback is scrolled", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 12));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.scrollLines(-2);
				const before = term.getBufferPosition();
				expect(before.viewportY).toBeGreaterThan(0);

				component.setLines(rows("line-", 8));
				term.resize(28, 5);
				await settle(term);

				const after = term.getBufferPosition();
				expect(after.viewportY).toBe(before.viewportY);
				expect(visible(term).map(line => line.trim())).toEqual(["line-5", "line-6", "line-7", "", ""]);
				expect(tui.refreshNativeScrollbackIfDirty()).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("keeps viewport aligned when offscreen header changes during overflow growth", async () => {
			const term = new VirtualTerminal(32, 6);
			const tui = new TUI(term);
			const logLines = rows("line-", 6);
			let tick = 0;
			const component = new MutableLinesComponent([`status-${tick}`, ...logLines]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 6; i < 70; i++) {
					tick += 1;
					logLines.push(`line-${i}`);
					component.setLines([`status-${tick}`, ...logLines]);
					tui.requestRender();
					await settle(term);
				}
				const viewport = visible(term).map(line => line.trim());
				expect(viewport.at(-1)).toBe("line-69");
				for (let i = 1; i < viewport.length; i++) {
					const prev = Number.parseInt(viewport[i - 1]!.slice(5), 10);
					const next = Number.parseInt(viewport[i]!.slice(5), 10);
					expect(next - prev).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});
		it("rebuilds history when offscreen expansion and append land together", async () => {
			const term = new VirtualTerminal(32, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["status-0", ...rows("line-", 11)]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(visible(term).map(line => line.trim())).toEqual([
					"line-5",
					"line-6",
					"line-7",
					"line-8",
					"line-9",
					"line-10",
				]);

				component.setLines(["status-1", "expanded-details", ...rows("line-", 12)]);
				tui.requestRender();
				await settle(term);

				expect(visible(term).map(line => line.trim())).toEqual([
					"line-6",
					"line-7",
					"line-8",
					"line-9",
					"line-10",
					"line-11",
				]);
				const scrollback = term.getScrollBuffer();
				expect(scrollback.join("\n")).toContain("expanded-details");
				for (let i = 0; i < 12; i++) {
					const pattern = new RegExp(`\\bline-${i}\\b`);
					expect(countMatches(scrollback, pattern), `line-${i} should appear exactly once`).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});

		it("does not duplicate the viewport-top row when an offscreen edit repeats the tail", async () => {
			// 6 rows over height 4: scrollback ["E0","E1"], viewport ["a","b","c","d"].
			const term = new VirtualTerminal(32, 4);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["E0", "E1", "a", "b", "c", "d"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(term.isNativeViewportAtBottom()).toBe(true);
				expect(visible(term).map(line => line.trim())).toEqual(["a", "b", "c", "d"]);

				// An offscreen edit (E0 -> E0x, above the viewport top) lands together
				// with a tail append whose rows make the prior last line "d" recur one
				// row early. The append-tail heuristic then mis-locates the tail and,
				// before the fix, scrolled an extra row into history — duplicating the
				// viewport-top row "b" just above the viewport.
				component.setLines(["E0x", "E1", "a", "b", "d", "e", "f"]);
				tui.requestRender();
				await settle(term);

				expect(visible(term).map(line => line.trim())).toEqual(["b", "d", "e", "f"]);
				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (const line of ["E0x", "E1", "a", "b", "d", "e", "f"]) {
					expect(buffer.filter(row => row === line).length, `${line} should appear exactly once`).toBe(1);
				}
				// The offscreen edit must be reflected in history, not left stale.
				expect(buffer).not.toContain("E0");
			} finally {
				tui.stop();
			}
		});

		it("removes collapsed ctrl-o markers from scrollback after offscreen expansion", async () => {
			const term = new VirtualTerminal(48, 6);
			const tui = new TUI(term);
			const collapsedLines = [
				"frame-top",
				"code preview … 16 more lines ⟨(Ctrl+O for more)⟩",
				"output preview … 106 more lines (ctrl+o to expand)",
				...rows("json-", 10),
				"status",
				"editor",
			];
			const component = new MutableLinesComponent(collapsedLines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(term.getScrollBuffer().join("\n")).toContain("ctrl+o");

				component.setLines([
					"frame-top",
					"code line 0",
					"code line 1",
					"output line 0",
					"output line 1",
					...rows("json-", 10),
					"status",
					"editor",
				]);
				tui.requestRender();
				await settle(term);

				const scrollback = term.getScrollBuffer();
				const scrollbackText = scrollback.join("\n");
				expect(scrollbackText).not.toContain("ctrl+o");
				expect(scrollbackText).toContain("code line 1");
				expect(scrollbackText).toContain("output line 1");
				for (let i = 0; i < 10; i++) {
					const pattern = new RegExp(`\\bjson-${i}\\b`);
					expect(countMatches(scrollback, pattern), `json-${i} should appear exactly once`).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});

		it("defers offscreen expansion rebuild when the viewport position is unknown", async () => {
			// POSIX terminals cannot report whether the user scrolled up, so an
			// ordinary offscreen expansion must NOT destructively rebuild scrollback
			// (anti-yank). The collapsed ctrl+o markers that scrolled into history
			// therefore stay stale until the next checkpoint — this is the deferral
			// that makes an un-flagged Ctrl+O expand look broken above the fold.
			const term = new UnknownViewportTerminal(48, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent([
				"frame-top",
				"code preview … 16 more lines ⟨(Ctrl+O for more)⟩",
				"output preview … 106 more lines (ctrl+o to expand)",
				...rows("json-", 10),
				"status",
				"editor",
			]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(term.isNativeViewportAtBottom()).toBeUndefined();
				expect(term.getScrollBuffer().join("\n")).toContain("ctrl+o");

				component.setLines([
					"frame-top",
					"code line 0",
					"code line 1",
					"output line 0",
					"output line 1",
					...rows("json-", 10),
					"status",
					"editor",
				]);
				tui.requestRender();
				await settle(term);

				// No flag: the rebuild is deferred, so the stale markers survive offscreen.
				expect(term.getScrollBuffer().join("\n")).toContain("ctrl+o");
			} finally {
				tui.stop();
			}
		});

		it("rebuilds scrollback on a user-driven offscreen expansion when the viewport position is unknown", async () => {
			// Pressing Ctrl+O is a direct user keystroke, so the expand reaches the
			// renderer with `allowUnknownViewportMutation: true`. On a terminal that
			// cannot report viewport position (POSIX), that opt-in is the only thing
			// that promotes the offscreen structural mutation to a clean history
			// rebuild instead of a partial viewport repaint — without it the collapsed
			// preview rows linger above the fold and the expansion renders garbled.
			const term = new UnknownViewportTerminal(48, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent([
				"frame-top",
				"code preview … 16 more lines ⟨(Ctrl+O for more)⟩",
				"output preview … 106 more lines (ctrl+o to expand)",
				...rows("json-", 10),
				"status",
				"editor",
			]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(term.isNativeViewportAtBottom()).toBeUndefined();
				expect(term.getScrollBuffer().join("\n")).toContain("ctrl+o");

				component.setLines([
					"frame-top",
					"code line 0",
					"code line 1",
					"output line 0",
					"output line 1",
					...rows("json-", 10),
					"status",
					"editor",
				]);
				tui.requestRender(false, { allowUnknownViewportMutation: true });
				await settle(term);

				const scrollback = term.getScrollBuffer();
				const scrollbackText = scrollback.join("\n");
				expect(scrollbackText).not.toContain("ctrl+o");
				expect(scrollbackText).toContain("code line 1");
				expect(scrollbackText).toContain("output line 1");
				for (let i = 0; i < 10; i++) {
					const pattern = new RegExp(`\\bjson-${i}\\b`);
					expect(countMatches(scrollback, pattern), `json-${i} should appear exactly once`).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});
		it("updates visible tail line when appending during overflow", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const lines = [...rows("line-", 7), "tail-0"];
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let tick = 1; tick <= 30; tick++) {
					lines[lines.length - 1] = `tail-${tick}`;
					lines.push(`new-${tick}`);
					component.setLines(lines);
					tui.requestRender();
					await settle(term);

					const viewport = visible(term).map(line => line.trim());
					const expectedViewport = lines.slice(Math.max(0, lines.length - term.rows)).map(line => line.trim());
					expect(viewport).toEqual(expectedViewport);
				}
			} finally {
				tui.stop();
			}
		});
		it("forced full redraws do not duplicate persistent content", async () => {
			const term = new VirtualTerminal(40, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["alpha", "beta", "gamma"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 0; i < 5; i++) {
					tui.requestRender(true);
					await settle(term);
				}

				const allText = term.getScrollBuffer().join("\n");
				expect((allText.match(/alpha/g) ?? []).length).toBe(1);
				expect((allText.match(/beta/g) ?? []).length).toBe(1);
				expect((allText.match(/gamma/g) ?? []).length).toBe(1);
			} finally {
				tui.stop();
			}
		});

		it("rebuilds scrollback when a bottom-anchored high-water preview collapses", async () => {
			const term = new VirtualTerminal(40, 5);
			const highWaterFrame = [...rows("base-", 8), ...rows("preview-", 10)];
			const finalFrame = [...rows("base-", 8), "result-0", "result-1"];
			const tui = new TUI(term);
			const component = new MutableLinesComponent(highWaterFrame);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(highWaterFrame);
				expect(term.getBufferPosition().viewportY).toBe(term.getBufferPosition().baseY);

				component.setLines(finalFrame);
				tui.requestRender();
				await settle(term);

				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(finalFrame);
				expect(term.getScrollBuffer().join("\n")).not.toContain("preview-");
				expect(tui.refreshNativeScrollbackIfDirty()).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("defers stale-history rebuild while native scrollback is scrolled", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 12));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.scrollLines(-2);
				const before = term.getBufferPosition();
				expect(before.viewportY).toBeGreaterThan(0);
				expect(visible(term).map(line => line.trim())).toEqual(["line-5", "line-6", "line-7", "line-8", "line-9"]);

				component.setLines(rows("line-", 8));
				tui.requestRender();
				await settle(term);

				const after = term.getBufferPosition();
				expect(after.viewportY).toBe(before.viewportY);
				expect(visible(term).map(line => line.trim())).toEqual(["line-5", "line-6", "line-7", "", ""]);
				expect(tui.refreshNativeScrollbackIfDirty()).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("defers offscreen expansion while native scrollback is scrolled", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 12));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.scrollLines(-2);
				const before = term.getBufferPosition();
				expect(before.viewportY).toBeGreaterThan(0);
				expect(visible(term).map(line => line.trim())).toEqual(["line-5", "line-6", "line-7", "line-8", "line-9"]);

				component.setLines(["line-0", "line-1", "expanded-0", "expanded-1", ...rows("line-", 12).slice(2)]);
				tui.requestRender();
				await settle(term);

				const after = term.getBufferPosition();
				expect(after.viewportY).toBe(before.viewportY);
				expect(visible(term).map(line => line.trim())).toEqual(["line-5", "line-6", "line-7", "line-8", "line-9"]);
				expect(term.getScrollBuffer().join("\n")).not.toContain("expanded-0");

				term.scrollLines(999);
				tui.requestRender();
				await settle(term);

				const finalPosition = term.getBufferPosition();
				expect(finalPosition.viewportY).toBe(finalPosition.baseY);
				expect(term.getScrollBuffer().join("\n")).toContain("expanded-0");
			} finally {
				tui.stop();
			}
		});

		it("defers height-changing tail preview while native scrollback is scrolled", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 12));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.scrollLines(-2);
				const before = term.getBufferPosition();
				expect(before.viewportY).toBeGreaterThan(0);
				expect(visible(term).map(line => line.trim())).toEqual(["line-5", "line-6", "line-7", "line-8", "line-9"]);

				component.setLines([...rows("line-", 9), "preview-appeared", ...rows("line-", 12).slice(9)]);
				tui.requestRender();
				await settle(term);

				const after = term.getBufferPosition();
				expect(after.viewportY).toBe(before.viewportY);
				expect(visible(term).map(line => line.trim())).toEqual(["line-5", "line-6", "line-7", "line-8", "line-9"]);
				expect(term.getScrollBuffer().join("\n")).not.toContain("preview-appeared");

				term.scrollLines(999);
				tui.requestRender();
				await settle(term);

				const finalPosition = term.getBufferPosition();
				expect(finalPosition.viewportY).toBe(finalPosition.baseY);
				expect(term.getScrollBuffer().join("\n")).toContain("preview-appeared");
			} finally {
				tui.stop();
			}
		});
		it("treats unknown Windows viewport state as scrolled", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			const term = new UnknownViewportTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 12));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.scrollLines(-2);
				const before = term.getBufferPosition();
				expect(before.viewportY).toBeGreaterThan(0);

				component.setLines(rows("line-", 8));
				tui.requestRender();
				await settle(term);

				const after = term.getBufferPosition();
				expect(after.viewportY).toBe(before.viewportY);
				expect(visible(term).map(line => line.trim())).toEqual(["line-5", "line-6", "line-7", "", ""]);
				expect(tui.refreshNativeScrollbackIfDirty()).toBe(false);
				expect(term.getBufferPosition().viewportY).toBe(before.viewportY);
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
				tui.stop();
			}
		});

		it("keeps the unknown Windows viewport guard on ordinary focused input", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			const term = new UnknownViewportTerminal(32, 5);
			const tui = new TUI(term);
			const transcript = new MutableLinesComponent(rows("line-", 12));
			const input = new FocusedInputComponent(() => {
				transcript.setLines([...rows("line-", 6), "typed-token", ...rows("line-", 12).slice(6)]);
			});
			tui.addChild(transcript);
			tui.addChild(input);
			tui.setFocus(input);

			try {
				tui.start();
				await settle(term);
				term.scrollLines(-2);
				const before = term.getBufferPosition();
				const beforeViewport = visible(term).map(line => line.trim());
				expect(before.viewportY).toBeGreaterThan(0);

				term.sendInput("x");
				await settle(term);

				const after = term.getBufferPosition();
				expect(after.viewportY).toBe(before.viewportY);
				expect(visible(term).map(line => line.trim())).toEqual(beforeViewport);
				expect(term.getScrollBuffer().join("\n")).not.toContain("typed-token");
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
				tui.stop();
			}
		});
		it("defers bottom-anchored shrink when POSIX viewport state is unknown", async () => {
			// Repro for #1566 follow-up (kitty/Linux): a bottom-anchored shrink across the
			// viewport boundary used to fall through to `viewportRepaint`, which redrew the
			// new transcript at `newLength - height` while leaving rows
			// `[newLength - height .. prevLength - height - 1]` already in native
			// scrollback — they reappeared at the top of the viewport, duplicating two rows
			// at the boundary in the captured trace.
			const term = new UnknownViewportTerminal(40, 6);
			const tui = new TUI(term);
			const body = rows("line-", 12);
			const component = new MutableLinesComponent([...body, "spinner-row", "spacer-row", "prompt-row"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines([...body, "prompt-row"]);
				tui.requestRender();
				await settle(term);

				const scrollback = term.getScrollBuffer();
				for (let i = 0; i < body.length; i++) {
					const pattern = new RegExp(`\\bline-${i}\\b`);
					expect(
						countMatches(scrollback, pattern),
						`line-${i} must not duplicate at boundary`,
					).toBeLessThanOrEqual(1);
				}

				expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(true);
				await settle(term);
				expect(visible(term).map(line => line.trim())).toEqual([
					"line-7",
					"line-8",
					"line-9",
					"line-10",
					"line-11",
					"prompt-row",
				]);
				const rebuilt = term.getScrollBuffer();
				for (let i = 0; i < body.length; i++) {
					const pattern = new RegExp(`\\bline-${i}\\b`);
					expect(countMatches(rebuilt, pattern), `line-${i} appears once post-checkpoint`).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});
		it("rebuilds history when a shrink leaves no real rows above the scrollback boundary", async () => {
			// Reviewer scenario (#1599): a large completion-style collapse (e.g. a 100-row
			// streamed transcript shrinking to a 20-row final cell in a 10-row viewport)
			// must NOT use the padded `deferredShrink` — the viewport would fall entirely
			// past the end of `newLines` and render as all blanks (no prompt visible) until
			// the next checkpoint. Yank the scrollback instead so the new tail stays on
			// screen.
			const term = new UnknownViewportTerminal(40, 10);
			const tui = new TUI(term);
			const body = rows("line-", 99);
			const component = new MutableLinesComponent([...body, "prompt-row"]);
			tui.addChild(component);
			const savedTerminalRisk = TERMINAL.eagerEraseScrollbackRisk;
			mutableTerminalInfo.eagerEraseScrollbackRisk = false;

			try {
				tui.start();
				await settle(term);

				const short = rows("short-", 19);
				component.setLines([...short, "prompt-row"]);
				tui.requestRender();
				await settle(term);

				const viewport = visible(term).map(line => line.trim());
				expect(viewport).toEqual([
					"short-10",
					"short-11",
					"short-12",
					"short-13",
					"short-14",
					"short-15",
					"short-16",
					"short-17",
					"short-18",
					"prompt-row",
				]);
				const scrollback = term.getScrollBuffer();
				for (let i = 0; i < short.length; i++) {
					const pattern = new RegExp(`\\bshort-${i}\\b`);
					expect(countMatches(scrollback, pattern), `short-${i} appears once`).toBe(1);
				}
				expect(scrollback.join("\n")).not.toContain("line-");
			} finally {
				mutableTerminalInfo.eagerEraseScrollbackRisk = savedTerminalRisk;
				tui.stop();
			}
		});

		it("defers ED3-risk huge shrink while unknown viewport is scrolled", async () => {
			// The huge-shrink fallback normally prefers `historyRebuild` over a blank
			// padded viewport. On terminals where ED3 can move an unobservable
			// scrollback viewport, that fallback is worse: it yanks the reader to the
			// top. Keep the old visible history frozen and rebuild only at checkpoint.
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			try {
				await withTerminalRisk(true, async () => {
					const term = new UnknownViewportTerminal(40, 10);
					const tui = new TUI(term);
					const body = rows("line-", 99);
					const component = new MutableLinesComponent([...body, "prompt-row"]);
					tui.addChild(component);

					try {
						tui.start();
						await settle(term);
						term.scrollLines(-2);
						const before = term.getBufferPosition();
						const beforeViewport = visible(term).map(line => line.trim());
						expect(before.viewportY).toBeGreaterThan(0);

						const short = rows("short-", 19);
						component.setLines([...short, "prompt-row"]);
						tui.requestRender();
						await settle(term);

						const after = term.getBufferPosition();
						expect(after.viewportY).toBe(before.viewportY);
						expect(visible(term).map(line => line.trim())).toEqual(beforeViewport);
						expect(term.getScrollBuffer().join("\n")).not.toContain("short-");

						term.scrollLines(999);
						expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(true);
						await settle(term);
						expect(visible(term).map(line => line.trim())).toEqual([
							"short-10",
							"short-11",
							"short-12",
							"short-13",
							"short-14",
							"short-15",
							"short-16",
							"short-17",
							"short-18",
							"prompt-row",
						]);
					} finally {
						tui.stop();
					}
				});
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});
		it("rebuilds history when prior POSIX repaint left the padded viewport past the new tail", async () => {
			const term = new UnknownViewportTerminal(40, 10);
			const tui = new TUI(term);
			const initial = rows("line-", 19);
			const component = new MutableLinesComponent([...initial, "prompt-row"]);
			tui.addChild(component);
			const savedTerminalRisk = TERMINAL.eagerEraseScrollbackRisk;
			mutableTerminalInfo.eagerEraseScrollbackRisk = false;

			try {
				tui.start();
				await settle(term);

				// Unknown-POSIX offscreen mutation: repainting the viewport commits the
				// 120-row logical frame, but `#emitViewportRepaint` intentionally does not
				// advance `#scrollbackHighWater` (it remains at the original 20-row frame's
				// 10-row overflow). The later shrink must compare against the padded viewport
				// top (`120 - height`) rather than the stale high-water mark.
				const expanded = ["edited-line", ...rows("line-", 118), "prompt-row"];
				component.setLines(expanded);
				tui.requestRender();
				await settle(term);
				expect(visible(term).map(line => line.trim())).toEqual([
					"line-109",
					"line-110",
					"line-111",
					"line-112",
					"line-113",
					"line-114",
					"line-115",
					"line-116",
					"line-117",
					"prompt-row",
				]);

				const short = [...rows("short-", 14), "prompt-row"];
				component.setLines(short);
				tui.requestRender();
				await settle(term);

				expect(visible(term).map(line => line.trim())).toEqual([
					"short-5",
					"short-6",
					"short-7",
					"short-8",
					"short-9",
					"short-10",
					"short-11",
					"short-12",
					"short-13",
					"prompt-row",
				]);
				expect(term.getScrollBuffer().join("\n")).not.toContain("line-");
			} finally {
				mutableTerminalInfo.eagerEraseScrollbackRisk = savedTerminalRisk;
				tui.stop();
			}
		});

		it("renders streaming row inserts on WSL Windows Terminal even when viewport probe is unavailable", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			try {
				await withEnvPatch(
					{ WT_SESSION: "wt-test", WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: undefined },
					async () => {
						// Simulate WSL: native viewport probe returns undefined unconditionally
						// (kernel32.dll FFI cannot bind from a Linux user-space process).
						const term = new UnknownViewportTerminal(32, 5);
						const tui = new TUI(term);
						// Bottom-anchored footer (prompt area) with streaming assistant rows above it.
						// Seed the transcript so the viewport is already saturated — the footer pins
						// to the last viewport row and streamed rows must appear above it.
						const transcript = new MutableLinesComponent(rows("seed-", 4));
						const footer = new MutableLinesComponent(["prompt>"]);
						tui.addChild(transcript);
						tui.addChild(footer);

						try {
							tui.start();
							await settle(term);
							expect(visible(term).map(line => line.trim())).toEqual([
								"seed-0",
								"seed-1",
								"seed-2",
								"seed-3",
								"prompt>",
							]);

							// Stream tokens row-by-row. Each frame inserts a new row above the footer,
							// mimicking an assistant response materializing during a turn.
							for (let i = 0; i < 4; i++) {
								transcript.setLines([...rows("seed-", 4), ...rows("token-", i + 1)]);
								tui.requestRender();
								await settle(term);

								const viewport = visible(term).map(line => line.trim());
								// The most recently streamed token MUST land in the viewport without the
								// user resizing the window. Pre-fix the viewport stayed frozen at the
								// initial seed because deferredMutation returned a no-op render.
								expect(viewport).toContain(`token-${i}`);
								expect(viewport[viewport.length - 1]).toBe("prompt>");
							}
						} finally {
							tui.stop();
						}
					},
				);
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});

		it("keeps a scrolled-up reader anchored while streaming inserts arrive on POSIX (unknown viewport)", async () => {
			// POSIX terminals cannot report scrollback position, so isNativeViewportAtBottom()
			// is undefined. Before the fix the planner optimistically treated "unknown" as
			// "at bottom" and rebuilt native scrollback (clear + replay) on every offscreen
			// streaming insert, wiping history and yanking a scrolled-up reader to the tail.
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			try {
				await withEnvPatch({ TMUX: undefined, STY: undefined, ZELLIJ: undefined }, async () => {
					const term = new UnknownViewportTerminal(32, 5);
					const tui = new TUI(term);
					// Assistant transcript that already overflows into scrollback, pinned footer below.
					const transcript = new MutableLinesComponent(rows("seed-", 12));
					const footer = new MutableLinesComponent(["prompt>"]);
					tui.addChild(transcript);
					tui.addChild(footer);

					try {
						tui.start();
						await settle(term);

						// Reader scrolls up into history.
						term.scrollLines(-4);
						const before = term.getBufferPosition();
						const anchored = visible(term).map(line => line.trim());
						expect(before.viewportY).toBeGreaterThan(0);
						expect(before.viewportY).toBeLessThan(before.baseY);

						// Stream rows above the footer — the real coding-agent shape. Each frame is a
						// length-changing insert that previously routed to a destructive historyRebuild.
						for (let i = 0; i < 4; i++) {
							transcript.setLines([...rows("seed-", 12), ...rows("token-", i + 1)]);
							tui.requestRender();
							await settle(term);

							const pos = term.getBufferPosition();
							// Still scrolled up (not snapped to the tail) and reading the same rows.
							expect(pos.viewportY).toBeLessThan(pos.baseY);
							expect(visible(term).map(line => line.trim())).toEqual(anchored);
						}

						// The incremental diff path streamed the tail straight into native
						// scrollback without a destructive rebuild: earliest history survives and
						// the live tail is reachable once the reader returns to the bottom.
						expect(term.getScrollBuffer().join("\n")).toContain("seed-0");
						expect(term.getScrollBuffer().join("\n")).toContain("token-3");

						// An offscreen reflow (edit above the fold) must defer rather than rebuild,
						// so the reader is still not yanked; the deferred rewrite is marked dirty.
						transcript.setLines(["seed-EDIT", ...rows("seed-", 12).slice(1), ...rows("token-", 4)]);
						tui.requestRender();
						await settle(term);
						const offscreenPos = term.getBufferPosition();
						expect(offscreenPos.viewportY).toBeLessThan(offscreenPos.baseY);
						expect(visible(term).map(line => line.trim())).toEqual(anchored);

						// At an explicit checkpoint (prompt submit equivalent) the deferred edit
						// reconciles into clean scrollback.
						term.scrollLines(999);
						expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(true);
						await settle(term);
						expect(term.getScrollBuffer().join("\n")).toContain("seed-EDIT");
					} finally {
						tui.stop();
					}
				});
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});

		it("does not trust a single stale at-bottom probe for live rebuilds", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			try {
				await withEnvPatch(
					{ TMUX: undefined, STY: undefined, ZELLIJ: undefined, WT_SESSION: undefined },
					async () => {
						const term = new StaleBottomViewportTerminal(32, 5, 200);
						const tui = new TUI(term);
						const component = new MutableLinesComponent(rows("seed-", 12));
						tui.addChild(component);

						try {
							tui.start();
							await settle(term);
							expect(term.isNativeViewportAtBottom()).toBe(true);

							term.scrollLines(-4);
							const before = term.getBufferPosition();
							const anchored = visible(term).map(line => line.trim());
							expect(before.viewportY).toBeLessThan(before.baseY);

							component.setLines(["seed-EDIT", ...rows("seed-", 12).slice(1), ...rows("tail-", 4)]);
							tui.requestRender();
							await settle(term);

							const after = term.getBufferPosition();
							expect(after.viewportY).toBe(before.viewportY);
							expect(visible(term).map(line => line.trim())).toEqual(anchored);
						} finally {
							tui.stop();
						}
					},
				);
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});
		it("rebuilds offscreen edits into clean scrollback while eager rebuild is enabled (active tool)", async () => {
			// The streaming-text default defers offscreen edits on POSIX (no yank, but a
			// growing/re-laying-out tool result leaves stale duplicated rows above the
			// fold). While a foreground tool is active the agent opts into eager rebuild:
			// offscreen edits rebuild native scrollback cleanly even though the viewport
			// position is unknown (a snap to the tail is acceptable mid-tool).
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			try {
				await withEnvPatch(
					{
						TMUX: undefined,
						STY: undefined,
						ZELLIJ: undefined,
						WEZTERM_PANE: undefined,
						KITTY_WINDOW_ID: undefined,
						GHOSTTY_RESOURCES_DIR: undefined,
						ALACRITTY_WINDOW_ID: undefined,
						TERM_PROGRAM: undefined,
					},
					async () => {
						const term = new UnknownViewportTerminal(40, 5, 200);
						const tui = new TUI(term);
						const component = new MutableLinesComponent(rows("row-", 16));
						tui.addChild(component);
						const savedTerminalRisk = TERMINAL.eagerEraseScrollbackRisk;
						mutableTerminalInfo.eagerEraseScrollbackRisk = false;

						try {
							tui.start();
							await settle(term);
							// Default (no active tool) would defer the offscreen edit; confirm the flag flips behavior.
							tui.setEagerNativeScrollbackRebuild(true);

							// A streaming tool result re-laying out: an offscreen header changes and the
							// block grows past the fold in the same frame.
							component.setLines(["HEADER-EDITED", ...rows("row-", 16).slice(1), ...rows("tail-", 4)]);
							tui.requestRender();
							await settle(term);

							const buffer = term.getScrollBuffer().map(line => line.trimEnd());
							// History was rebuilt at the new content: offscreen edit reflected, no stale copy.
							expect(buffer).toContain("HEADER-EDITED");
							expect(buffer).not.toContain("row-0");
							// The grown tail is reachable exactly once — no duplicated rows above the viewport.
							expect(buffer.filter(line => line === "tail-3")).toHaveLength(1);
							expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(false);
						} finally {
							mutableTerminalInfo.eagerEraseScrollbackRisk = savedTerminalRisk;
							tui.stop();
						}
					},
				);
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});

		it("paints a viewport-saturating pure-append on native Windows Terminal (no \\x1b[3J)", async () => {
			// Regression: under `WT_SESSION` on native Windows the kernel32 probe is
			// suppressed and `isNativeViewportAtBottom()` returns `undefined`. The
			// `15.7.5` #1635 fix routed pure-append-over-saturated-viewport frames to
			// `deferredMutation` here, which is a literal no-op. That froze the editor
			// on the very keystroke that grows `lines.length` past the viewport (the
			// wrap keystroke) until the next prompt-submit checkpoint flushed.
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			try {
				await withEnvPatch(
					{ WT_SESSION: "wt-test", TMUX: undefined, STY: undefined, ZELLIJ: undefined },
					async () => {
						const term = new UnknownViewportTerminal(32, 5);
						const tui = new TUI(term);
						// Five-row transcript + one editor row saturates the viewport (height = 5).
						// The user is at the tail — no scroll — but the probe still answers `undefined`.
						const transcript = new MutableLinesComponent(rows("seed-", 5));
						const editor = new MutableLinesComponent(["prompt> a"]);
						tui.addChild(transcript);
						tui.addChild(editor);

						try {
							tui.start();
							await settle(term);

							const writes: string[] = [];
							const realWrite = term.write.bind(term);
							(term as unknown as { write: (s: string) => void }).write = (data: string) => {
								writes.push(data);
								realWrite(data);
							};

							// The wrap keystroke: editor grows from one to two visual rows. This is a
							// pure append (`firstChanged === previousLines.length`, content grew) over
							// a viewport already at capacity — exactly the branch that used to defer.
							editor.setLines(["prompt> a", "wrap-row"]);
							tui.requestRender();
							await settle(term);

							// The #1635 anti-yank guarantee must survive: no destructive scrollback erase.
							expect(writes.join("")).not.toContain("\x1b[3J");
							// The wrap row paints in the same frame — viewportRepaint is non-destructive
							// but writes the visible window, so the editor's new visual row is on screen.
							expect(visible(term).map(line => line.trim())).toContain("wrap-row");
							// And the deferred-cleanup checkpoint is queued for the next prompt submit.
							expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(true);
						} finally {
							tui.stop();
						}
					},
				);
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});

		it("paints a slash-command-shaped structural mutation on native Windows Terminal (no \\x1b[3J)", async () => {
			// Sibling regression: `/plan`, `/resume`, model switches, role-badge flips,
			// status-line toggles — any structural offscreen mutation — also routed to
			// `deferredMutation` under WT, so the toggle never painted until the next
			// checkpoint. After the fix the planner falls back to `viewportRepaint`
			// instead, painting the visible window without emitting `\x1b[3J`.
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			try {
				await withEnvPatch(
					{ WT_SESSION: "wt-test", TMUX: undefined, STY: undefined, ZELLIJ: undefined },
					async () => {
						const term = new UnknownViewportTerminal(32, 5);
						const tui = new TUI(term);
						// Transcript + status + prompt; total six rows over a five-row viewport.
						const transcript = new MutableLinesComponent(rows("seed-", 4));
						const status = new MutableLinesComponent(["STATUS-OLD"]);
						const prompt = new MutableLinesComponent(["prompt>"]);
						tui.addChild(transcript);
						tui.addChild(status);
						tui.addChild(prompt);

						try {
							tui.start();
							await settle(term);

							const writes: string[] = [];
							const realWrite = term.write.bind(term);
							(term as unknown as { write: (s: string) => void }).write = (data: string) => {
								writes.push(data);
								realWrite(data);
							};

							// Slash-command toggle: an existing offscreen row flips its content and a
							// new chrome row is inserted. firstChanged lands above the viewport top,
							// length grew by one — a structural mutation, not a pure append.
							status.setLines(["STATUS-NEW", "EXTRA"]);
							tui.requestRender();
							await settle(term);

							expect(writes.join("")).not.toContain("\x1b[3J");
							const view = visible(term).map(line => line.trim());
							expect(view).toContain("STATUS-NEW");
							expect(view).toContain("EXTRA");
							expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(true);
						} finally {
							tui.stop();
						}
					},
				);
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});

		it("still defers when the native viewport probe confirms a scrolled-up reader", async () => {
			// Counterpart to the two paints above: when the probe is *reliable* and reports
			// `false`, the reader is parked in scrollback and a live-frame write is wasted.
			// `deferredMutation` (a no-op) must stay in place so the next checkpoint can
			// reconcile cleanly, and no bytes hit the terminal during the deferred frame.
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			try {
				await withEnvPatch(
					{ WT_SESSION: undefined, TMUX: undefined, STY: undefined, ZELLIJ: undefined },
					async () => {
						const term = new VirtualTerminal(32, 5);
						const tui = new TUI(term);
						const transcript = new MutableLinesComponent(rows("seed-", 5));
						const status = new MutableLinesComponent(["STATUS-OLD"]);
						const prompt = new MutableLinesComponent(["prompt>"]);
						tui.addChild(transcript);
						tui.addChild(status);
						tui.addChild(prompt);

						try {
							tui.start();
							await settle(term);

							// Pin the probe to a confirmed-scrolled answer (host reports `false`).
							(term as unknown as { isNativeViewportAtBottom: () => boolean }).isNativeViewportAtBottom = () =>
								false;

							const writes: string[] = [];
							const realWrite = term.write.bind(term);
							(term as unknown as { write: (s: string) => void }).write = (data: string) => {
								writes.push(data);
								realWrite(data);
							};

							// Same structural mutation as the slash-command test — but with the probe
							// telling us the user can't see the live frame, the planner stays a no-op.
							status.setLines(["STATUS-NEW", "EXTRA"]);
							tui.requestRender();
							await settle(term);

							// Zero bytes written — the deferral is intentional and protects the reader.
							expect(writes.join("")).toBe("");
							// Scrollback was marked dirty by the deferral; once the reader returns to
							// the tail (probe reports `true`) the next checkpoint reconciles cleanly.
							(term as unknown as { isNativeViewportAtBottom: () => boolean }).isNativeViewportAtBottom = () =>
								true;
							expect(tui.refreshNativeScrollbackIfDirty()).toBe(true);
						} finally {
							tui.stop();
						}
					},
				);
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});

		it("refreshes deferred native scrollback when the native viewport reaches bottom", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 12));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.scrollLines(-2);

				component.setLines(rows("line-", 8));
				tui.requestRender();
				await settle(term);

				term.scrollLines(999);
				tui.requestRender();
				await settle(term);

				const position = term.getBufferPosition();
				expect(position.viewportY).toBe(position.baseY);
				expect(visible(term).map(line => line.trim())).toEqual(["line-3", "line-4", "line-5", "line-6", "line-7"]);
				expect(tui.refreshNativeScrollbackIfDirty()).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("keeps transient checkpoint rows out of clean rebuilt scrollback", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const chat = new MutableLinesComponent(rows("line-", 12));
			const status = new MutableLinesComponent([]);
			const footer = new MutableLinesComponent(["FOOTER"]);
			tui.addChild(chat);
			tui.addChild(status);
			tui.addChild(footer);

			try {
				tui.start();
				await settle(term);

				chat.setLines(rows("line-", 8));
				tui.requestRender();
				await settle(term);
				term.scrollLines(999);

				expect(tui.refreshNativeScrollbackIfDirty()).toBe(false);
				status.setLines(["LOADER"]);
				tui.requestRender();
				await settle(term);

				status.setLines([]);
				tui.requestRender();
				await settle(term);

				expect(term.getScrollBuffer().join("\n")).not.toContain("LOADER");
				expect(tui.refreshNativeScrollbackIfDirty()).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("tail-cell mutation is cleaned up before the next native scrollback checkpoint", async () => {
			// Once a header has scrolled into terminal history, a bottom-anchored
			// tail cell shrink must rebuild immediately. Deferring until the next
			// checkpoint leaves stale high-water rows above the viewport and duplicates
			// retained header/tail rows when users scroll back.
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const header = new MutableLinesComponent(["HEADER-0", "HEADER-1", "HEADER-2", "HEADER-3", "HEADER-4"]);
			const tail = new MutableLinesComponent(["cell-init"]);
			tui.addChild(header);
			tui.addChild(tail);

			try {
				tui.start();
				await settle(term);

				// Stream output until the transcript exceeds the viewport.
				const out: string[] = [];
				for (let i = 0; i < 15; i++) {
					out.push(`cell-${i}`);
					tail.setLines([...out, "[footer]"]);
					tui.requestRender();
					await settle(term);
				}

				// Repeatedly shrink (collapse preview) and grow (more output)
				// across the previous viewport bottom. This is what triggers
				// the duplication: each shrink-then-grow cycle would otherwise
				// re-emit HEADER rows that are already in scrollback.
				for (let cycle = 0; cycle < 6; cycle++) {
					tail.setLines([...out.slice(0, 5), "[summary]", "[footer]"]);
					tui.requestRender();
					await settle(term);

					out.push(`cell-grew-${cycle}-a`, `cell-grew-${cycle}-b`);
					tail.setLines([...out, "[footer]"]);
					tui.requestRender();
					await settle(term);
				}

				// Final completion-style collapse: the rebuild happens on this render
				// while the viewport is bottom-anchored, so the checkpoint below should
				// have no dirty native scrollback left to repair.
				tail.setLines(["[completed: many lines]", "[footer]"]);
				tui.requestRender();
				await settle(term);
				term.scrollLines(999);
				expect(tui.refreshNativeScrollbackIfDirty()).toBe(false);
				await settle(term);
				const scrollback = term.getScrollBuffer();
				for (let i = 0; i < 5; i++) {
					const pattern = new RegExp(`\\bHEADER-${i}\\b`);
					expect(countMatches(scrollback, pattern), `HEADER-${i} should appear at most once`).toBeLessThanOrEqual(
						1,
					);
				}
			} finally {
				tui.stop();
			}
		});

		it("scrollback grows again after stale history is cleared", async () => {
			const term = new VirtualTerminal(60, 20);
			const tui = new TUI(term);
			const toast = new MutableLinesComponent(["TOAST"]);
			const userMessage = new MutableLinesComponent(["USER"]);
			const chat = new MutableLinesComponent([]);
			const footer = new MutableLinesComponent(["STATUS", "EDITOR-TOP", "EDITOR-CONTENT", "EDITOR-BOTTOM"]);

			tui.addChild(toast);
			tui.addChild(userMessage);
			tui.addChild(chat);
			tui.addChild(footer);

			try {
				tui.start();
				await settle(term);

				const thinkingLines = ["THINKING-0"];
				for (let i = 0; i < 25; i++) {
					thinkingLines.push(`THINKING-${i + 1}`);
					chat.setLines(thinkingLines);
					tui.requestRender();
					await settle(term);
				}

				// Collapse below the previous scrollback boundary, forcing the
				// stale-history reset path.
				chat.setLines(thinkingLines.slice(0, 5));
				tui.requestRender();
				await settle(term);
				const afterResetLength = term.getScrollBuffer().length;

				// Subsequent growth must be allowed to scroll normally. A
				// viewport-only repaint loop here leaves the user with no
				// terminal history to scroll back through.
				for (let i = 0; i < 30; i++) {
					thinkingLines.push(`LATER-${i}`);
					chat.setLines(thinkingLines);
					tui.requestRender();
					await settle(term);
				}

				expect(term.getScrollBuffer().length).toBeGreaterThan(afterResetLength);
			} finally {
				tui.stop();
			}
		});
		it("places hardware cursor at the focused row after a height-grow resize", async () => {
			// Mirrors the editor input layout: the focused component sits at the
			// last content row and emits CURSOR_MARKER. When the terminal grows
			// taller than the rendered content, #emitViewportRepaint must move
			// the hardware cursor up to the marker row instead of leaving it at
			// the viewport bottom (the rows below the content are blank padding).
			const term = new VirtualTerminal(40, 6);
			const tui = new TUI(term, true);
			const cursorAnchorRow = 5;
			class CursorAnchor implements Component, Focusable {
				focused = false;
				invalidate(): void {}
				render(_width: number): string[] {
					return [`anchor>${CURSOR_MARKER}`];
				}
			}
			tui.addChild(new MutableLinesComponent(rows("body-", cursorAnchorRow)));
			const anchor = new CursorAnchor();
			tui.addChild(anchor);
			tui.setFocus(anchor);

			try {
				tui.start();
				await settle(term);
				// Sanity check: content fills the viewport exactly.
				expect(term.getCursor().row).toBe(cursorAnchorRow);

				// Grow the terminal so it has more rows than the rendered content.
				term.resize(40, 20);
				await settle(term);

				// Regression: the cursor must follow the marker, not the bottom
				// of the now-taller viewport.
				expect(term.getCursor().row).toBe(cursorAnchorRow);
			} finally {
				tui.stop();
			}
		});

		it("leaves the parent shell prompt directly after short content on stop", async () => {
			const term = new VirtualTerminal(20, 5);
			const tui = new TUI(term);
			let stopped = false;
			tui.addChild(new MutableLinesComponent(["omp0", "omp1", "omp2"]));

			try {
				tui.start();
				await settle(term);
				tui.stop();
				stopped = true;
				await term.flush();
				term.write("bash$ ");
				await term.flush();

				expect(visible(term)).toEqual(["omp0", "omp1", "omp2", "bash$", ""]);
			} finally {
				if (!stopped) tui.stop();
			}
		});
	});

	describe("overlay compositing", () => {
		it("overlay show/hide restores underlying content", async () => {
			const term = new VirtualTerminal(40, 8);
			const tui = new TUI(term);
			const base = new MutableLinesComponent(rows("base-", 8));
			tui.addChild(base);

			try {
				tui.start();
				await settle(term);

				const handle = tui.showOverlay(new MutableLinesComponent(["OVERLAY-0", "OVERLAY-1"]), {
					anchor: "top-left",
					row: 2,
					col: 4,
				});
				await settle(term);

				expect(visible(term)[2]?.includes("OVERLAY-0")).toBeTruthy();
				expect(visible(term)[3]?.includes("OVERLAY-1")).toBeTruthy();

				handle.hide();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[2]?.trim()).toBe("base-2");
				expect(viewport[3]?.trim()).toBe("base-3");
			} finally {
				tui.stop();
			}
		});

		it("hiding an overlay scrubs sentinel rows leaked into scrollback by resize reflow", async () => {
			const term = new VirtualTerminal(40, 4, 200);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(rows("base-", 20)));

			try {
				tui.start();
				await settle(term);

				const handle = tui.showOverlay(
					new MutableLinesComponent(["OV_SENTINEL_4_ov4-0-0-0-0-0-0", "ov4-1-0-0-0-0"]),
					{ row: 2, col: 18 },
				);
				await settle(term);
				term.resize(20, 4);
				await settle(term);

				expect(term.getScrollBuffer().some(line => line.includes("OV_SENTINEL_4_"))).toBeTrue();

				term.scrollLines(-1);
				await settle(term);
				handle.hide();
				await settle(term);

				expect(term.getScrollBuffer().some(line => line.includes("OV_SENTINEL_4_"))).toBeFalse();
				expect(visible(term).some(line => line.includes("OV_SENTINEL_4_"))).toBeFalse();
			} finally {
				tui.stop();
			}
		});

		it("tmux overlay hide repaints rows exposed by a shorter base frame", async () => {
			await withEnvPatch({ TMUX: "1", STY: undefined, ZELLIJ: undefined }, async () => {
				const term = new UnknownViewportTerminal(40, 3);
				const tui = new TUI(term);
				tui.addChild(new MutableLinesComponent(["base-0", "base-1", "base-2"]));

				try {
					tui.start();
					await settle(term);

					const handle = tui.showOverlay(new MutableLinesComponent(["OV-0", "OV-1", "OV-2"]), {
						row: 2,
						col: 0,
					});
					await settle(term);
					expect(visible(term)).toEqual(["OV-0", "OV-1", "OV-2"]);

					// Root cause: tmux disables destructive history rebuilds, so overlay
					// removal that shrinks the composite frame must repaint the viewport;
					// diffing from the old viewport top clears only the overlay suffix.
					handle.hide();
					await settle(term);

					expect(visible(term)).toEqual(["base-0", "base-1", "base-2"]);
				} finally {
					tui.stop();
				}
			});
		});
	});

	describe("stress scenarios", () => {
		it("rapid content mutations converge to final expected screen", async () => {
			const term = new VirtualTerminal(30, 8);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["init"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 0; i < 80; i++) {
					const n = (i % 7) + 1;
					component.setLines(Array.from({ length: n }, (_v, j) => `iter-${i}-line-${j}`));
					tui.requestRender();
					await settle(term);
				}

				const expected = Array.from({ length: 3 }, (_v, j) => `iter-79-line-${j}`);
				const viewport = visible(term);
				expect(viewport[0]?.trim()).toBe(expected[0]);
				expect(viewport[1]?.trim()).toBe(expected[1]);
				expect(viewport[2]?.trim()).toBe(expected[2]);
				expect(viewport[3]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});
	});
	describe("hardware cursor preference", () => {
		const SHOW_CURSOR = "\x1b[?25h";

		class FocusedCursor implements Component, Focusable {
			focused = false;
			invalidate(): void {}
			render(_width: number): string[] {
				return [`prompt>${CURSOR_MARKER}`];
			}
		}

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("honors the requested hardware cursor preference under Ghostty (no terminal override)", async () => {
			// Regression: a Ghostty-specific override used to force the hardware
			// cursor off while the editor stayed in terminal-cursor mode (marker
			// only, no software glyph), leaving Ghostty users with no visible
			// caret at all. The preference must follow the constructor arg only.
			await withEnvPatch(
				{
					TERM_PROGRAM: "ghostty",
					TERM: "xterm-ghostty",
					GHOSTTY_RESOURCES_DIR: "/tmp/ghostty",
					GHOSTTY_SURFACE_ID: "0x1",
				},
				() => {
					expect(new TUI(new VirtualTerminal(20, 4), true).getShowHardwareCursor()).toBe(true);
					expect(new TUI(new VirtualTerminal(20, 4), false).getShowHardwareCursor()).toBe(false);
				},
			);
		});

		it("emits the show-cursor sequence for the focused marker only when enabled", async () => {
			for (const enabled of [true, false]) {
				const term = new VirtualTerminal(20, 4);
				const tui = new TUI(term, enabled);
				const writes: string[] = [];
				vi.spyOn(term, "write").mockImplementation((data: string) => {
					writes.push(data);
				});
				const anchor = new FocusedCursor();
				tui.addChild(anchor);
				tui.setFocus(anchor);

				try {
					tui.start();
					await settle(term);
					// Disabled keeps the caret hidden (\x1b[?25l only); enabled re-shows
					// it at the marker after positioning inside the synchronized paint.
					expect(writes.join("").includes(SHOW_CURSOR)).toBe(enabled);
				} finally {
					tui.stop();
					vi.restoreAllMocks();
				}
			}
		});
	});

	describe("cursor escape sequences stay inside synchronized output blocks", () => {
		// Cursor placement sequences that must not leak outside \x1b[?2026h…\x1b[?2026l
		const CURSOR_SEQ = /\x1b\[\?(?:25[hl]|\d+[A-G])/g;
		const BSU = "\x1b[?2026h";
		const ESU = "\x1b[?2026l";
		const HIDE_CURSOR = "\x1b[?25l";
		const DISABLE_AUTOWRAP = "\x1b[?7l";
		const ENABLE_AUTOWRAP = "\x1b[?7h";

		function getWrites(term: VirtualTerminal): string[] {
			const writes: string[] = [];
			const spy = vi.spyOn(term, "write");
			spy.mockImplementation((data: string) => {
				writes.push(data);
			});
			return writes;
		}

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("all cursor sequences fall inside BSU/ESU brackets on full render", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const writes = getWrites(term);

			const component = new MutableLinesComponent(["hello", "world"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		it("all cursor sequences fall inside BSU/ESU brackets on differential render", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);

			const component = new MutableLinesComponent(["AAA", "BBB", "CCC"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const writes = getWrites(term);
				component.setLines(["AAA", "XXX", "CCC"]);
				tui.requestRender();
				await settle(term);
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		it("disables terminal autowrap inside paint writes", async () => {
			const term = new VirtualTerminal(12, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["ABCDEFGHIJKL", "tail"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const writes = getWrites(term);
				component.setLines(["XXXXEFGHIJKL", "tail"]);
				tui.requestRender();
				await settle(term);

				const paintWrites = writes.filter(write => write.includes(BSU));
				expect(paintWrites.length).toBeGreaterThan(0);
				for (const write of paintWrites) {
					const begin = write.indexOf(BSU);
					expect(write.startsWith(HIDE_CURSOR)).toBe(true);
					expect(begin).toBe(HIDE_CURSOR.length);
					const disable = write.indexOf(DISABLE_AUTOWRAP, begin + BSU.length);
					const enable = write.lastIndexOf(ENABLE_AUTOWRAP);
					const end = write.lastIndexOf(ESU);
					expect(disable).toBe(begin + BSU.length);
					expect(enable).toBeGreaterThan(disable);
					expect(end).toBeGreaterThan(enable);
				}
			} finally {
				tui.stop();
			}
		});

		it("all cursor sequences fall inside BSU/ESU brackets on deleted-lines render", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			tui.setClearOnShrink(true);

			const component = new MutableLinesComponent(["A", "B", "C", "D"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const writes = getWrites(term);
				component.setLines(["A", "B"]);
				tui.requestRender();
				await settle(term);
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		it("all cursor sequences fall inside BSU/ESU brackets on repeated no-op renders", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);

			const component = new MutableLinesComponent(["hello", "world", "stable"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const writes = getWrites(term);
				for (let i = 0; i < 4; i++) {
					tui.requestRender();
					await settle(term);
				}
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		/**
		 * Assert that every cursor escape sequence in every write call appears
		 * strictly between a matched BSU/ESU pair, is the leading hideCursor that
		 * intentionally happens just before BSU, or is the sole payload of a
		 * standalone hideCursor call (from a no-change/no-cursor path).
		 */
		function assertCursorSequencesInsideSyncBlocks(writes: string[]): void {
			for (const write of writes) {
				if (write === HIDE_CURSOR) {
					// Standalone hideCursor — allowed (no-change/no-cursor path)
					continue;
				}
				// Walk through the write, tracking BSU/ESU nesting
				let depth = 0;
				let idx = 0;
				while (idx < write.length) {
					CURSOR_SEQ.lastIndex = idx;
					const match = CURSOR_SEQ.exec(write);
					if (!match) break;

					const matchIdx = match.index;
					// Count BSU/ESU depth up to the match position
					let scanIdx = idx;
					while (scanIdx < matchIdx) {
						if (write.startsWith(BSU, scanIdx)) {
							depth++;
							scanIdx += BSU.length;
						} else if (write.startsWith(ESU, scanIdx)) {
							depth--;
							scanIdx += ESU.length;
						} else {
							scanIdx++;
						}
					}

					if (match[0] === HIDE_CURSOR && write.startsWith(HIDE_CURSOR + BSU) && matchIdx === 0) {
						idx = matchIdx + match[0].length;
						continue;
					}
					expect(depth).toBeGreaterThan(0);

					idx = matchIdx + match[0].length;
				}
			}
		}
	});
});

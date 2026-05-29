import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@oh-my-pi/pi-tui";
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

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_v, i) => `${prefix}${i}`);
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
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
	});

	describe("scrollback integrity", () => {
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
		it("repaints viewport when offscreen expansion and append land together", async () => {
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
				const beforeBufferLength = term.getScrollBuffer().length;

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
				expect(term.getScrollBuffer().length - beforeBufferLength).toBe(1);
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

				component.setLines(rows("line-", 8));
				tui.requestRender();
				await settle(term);

				const after = term.getBufferPosition();
				expect(after.viewportY).toBe(before.viewportY);
				expect(tui.refreshNativeScrollbackIfDirty()).toBe(true);
			} finally {
				tui.stop();
			}
		});

		it("refreshes deferred native scrollback at an explicit bottom checkpoint", async () => {
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
				expect(tui.refreshNativeScrollbackIfDirty()).toBe(true);
				await settle(term);

				const position = term.getBufferPosition();
				expect(position.viewportY).toBe(position.baseY);
				expect(visible(term).map(line => line.trim())).toEqual(["line-3", "line-4", "line-5", "line-6", "line-7"]);
				expect(tui.refreshNativeScrollbackIfDirty()).toBe(false);
			} finally {
				tui.stop();
			}
		});

		it("refreshes dirty native scrollback before transient checkpoint rows render", async () => {
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

				expect(tui.refreshNativeScrollbackIfDirty()).toBe(true);
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

		it("tail-cell mutation is cleaned up at the next native scrollback checkpoint", async () => {
			// Repro for the old scrollback-duplication bug: once a header
			// (e.g. the welcome screen) has scrolled into terminal history, the
			// last tool cell mutating (grow/shrink cycles, completion collapse)
			// makes native scrollback stale. Live frames now defer the destructive
			// clear+replay until a user-run checkpoint rather than yanking users who
			// are reading scrollback mid-stream.
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

				// Final completion-style collapse: full transcript fits in the
				// viewport again, even though scrollback already holds an
				// earlier copy of HEADER. Rebuild at the next checkpoint to clean the
				// stale native history.
				tail.setLines(["[completed: many lines]", "[footer]"]);
				tui.requestRender();
				await settle(term);
				term.scrollLines(999);
				expect(tui.refreshNativeScrollbackIfDirty()).toBe(true);
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
	describe("cursor escape sequences stay inside synchronized output blocks", () => {
		// Cursor placement sequences that must not leak outside \x1b[?2026h…\x1b[?2026l
		const CURSOR_SEQ = /\x1b\[\?(?:25[hl]|\d+[A-G])/g;
		const BSU = "\x1b[?2026h";
		const ESU = "\x1b[?2026l";

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
		 * strictly between a matched BSU/ESU pair, or is the sole payload of a
		 * standalone hideCursor call (from a no-change path).
		 */
		function assertCursorSequencesInsideSyncBlocks(writes: string[]): void {
			for (const write of writes) {
				if (write === "\x1b[?25l") {
					// Standalone hideCursor — allowed (no-change path)
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

					expect(depth).toBeGreaterThan(0);

					idx = matchIdx + match[0].length;
				}
			}
		}
	});
});

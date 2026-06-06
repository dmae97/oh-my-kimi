import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { performance } from "node:perf_hooks";
import {
	analyzeBgFillLine,
	applyBackgroundToLine,
	type Component,
	DECSACE_DEFAULT,
	DECSACE_RECT,
	detectRectangularSgrSupport,
	encodeDeccara,
	planDeccaraFills,
	setTerminalDeccara,
	TERMINAL,
	TUI,
} from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Truecolor background open token used throughout the integration tests.
const BG_OPEN = "\x1b[48;2;10;20;30m";
const BG_SGR = "48;2;10;20;30";

/**
 * Renders a fixed-height background panel: each entry is a content string ("" =
 * blank row), painted full-width with `BG_OPEN` via the real `applyBackgroundToLine`
 * primitive — the same one Box/Text/Markdown use.
 */
class BgPanelComponent implements Component {
	#rows: string[];
	#bgOpen: string;

	constructor(rows: string[], bgOpen = BG_OPEN) {
		this.#rows = [...rows];
		this.#bgOpen = bgOpen;
	}

	setRows(rows: string[]): void {
		this.#rows = [...rows];
	}

	invalidate(): void {}

	render(width: number): string[] {
		const bgFn = (text: string) => `${this.#bgOpen}${text}\x1b[49m`;
		return this.#rows.map(row => applyBackgroundToLine(row, width, bgFn));
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(1);
	await term.flush();
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return count;
		count++;
		from = at + needle.length;
	}
}

async function withEnvPatch<T>(patch: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const bunSnapshot: Record<string, string | undefined> = {};
	const processSnapshot: Record<string, string | undefined> = {};
	for (const key in patch) {
		bunSnapshot[key] = Bun.env[key];
		processSnapshot[key] = process.env[key];
		const value = patch[key];
		if (value === undefined) {
			delete Bun.env[key];
			delete process.env[key];
		} else {
			Bun.env[key] = value;
			process.env[key] = value;
		}
	}
	try {
		return await run();
	} finally {
		for (const key in patch) {
			const bunValue = bunSnapshot[key];
			if (bunValue === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = bunValue;
			}
			const processValue = processSnapshot[key];
			if (processValue === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = processValue;
			}
		}
	}
}

describe("detectRectangularSgrSupport", () => {
	it("enables only kitty, which implements the SGR-background extension", () => {
		expect(detectRectangularSgrSupport("kitty", {})).toBe(true);
		// Ghostty leaves CSI $r unimplemented (ghostty-org/ghostty#632) — excluded.
		expect(detectRectangularSgrSupport("ghostty", {})).toBe(false);
		expect(detectRectangularSgrSupport("wezterm", {})).toBe(false);
		expect(detectRectangularSgrSupport("iterm2", {})).toBe(false);
		expect(detectRectangularSgrSupport("alacritty", {})).toBe(false);
		expect(detectRectangularSgrSupport("base", {})).toBe(false);
		expect(detectRectangularSgrSupport("trueColor", {})).toBe(false);
	});

	it("honors the PI_NO_DECCARA kill switch (truthy values only)", () => {
		expect(detectRectangularSgrSupport("kitty", { PI_NO_DECCARA: "1" })).toBe(false);
		expect(detectRectangularSgrSupport("kitty", { PI_NO_DECCARA: "true" })).toBe(false);
		// A falsey assignment is not a kill: support stays on.
		expect(detectRectangularSgrSupport("kitty", { PI_NO_DECCARA: "0" })).toBe(true);
		expect(detectRectangularSgrSupport("kitty", { PI_NO_DECCARA: "false" })).toBe(true);
	});

	it("disables under tmux/screen/zellij multiplexers", () => {
		expect(detectRectangularSgrSupport("kitty", { TMUX: "/tmp/tmux-1000/default,123,0" })).toBe(false);
		expect(detectRectangularSgrSupport("kitty", { STY: "1234.pts-0" })).toBe(false);
		expect(detectRectangularSgrSupport("kitty", { ZELLIJ: "0" })).toBe(false);
		expect(detectRectangularSgrSupport("kitty", { TERM: "tmux-256color" })).toBe(false);
		expect(detectRectangularSgrSupport("kitty", { TERM: "screen.xterm" })).toBe(false);
	});
});

describe("encodeDeccara", () => {
	it("emits the 1-based inclusive DECCARA rectangle form", () => {
		expect(encodeDeccara(1, 1, 4, 40, BG_SGR)).toBe(`\x1b[1;1;4;40;${BG_SGR}$r`);
	});

	it("matches kitty's documented background-fill example", () => {
		// kitty docs/deccara.rst: blue (44) bg over rows 4..11, cols 3..10.
		expect(`${DECSACE_RECT}${encodeDeccara(4, 3, 11, 10, "44")}${DECSACE_DEFAULT}`).toBe(
			"\x1b[2*x\x1b[4;3;11;10;44$r\x1b[*x",
		);
	});
});

describe("analyzeBgFillLine", () => {
	const close = "\x1b[49m\x1b[0m";

	it("treats an all-space background row as a whole-row fill", () => {
		const line = `${BG_OPEN}${" ".repeat(10)}${close}`;
		expect(analyzeBgFillLine(line, 10)).toEqual({ cut: 0, leftCol: 0, bg: BG_SGR });
	});

	it("locates the trailing pad after content under a single background", () => {
		const line = `\x1b[48;5;4mHi${" ".repeat(8)}${close}`;
		const result = analyzeBgFillLine(line, 10);
		expect(result?.leftCol).toBe(2);
		expect(result?.bg).toBe("48;5;4");
		// Cut sits right after "Hi" so the prefix re-closes to a clean reset.
		expect(line.slice(0, result?.cut)).toBe("\x1b[48;5;4mHi");
	});

	it("recognizes 16-color and bright background params", () => {
		expect(analyzeBgFillLine(`\x1b[41m${" ".repeat(6)}${close}`, 6)?.bg).toBe("41");
		expect(analyzeBgFillLine(`\x1b[101m${" ".repeat(6)}${close}`, 6)?.bg).toBe("101");
	});

	it("rejects rows with no trailing padding", () => {
		const line = `${BG_OPEN}${"x".repeat(10)}${close}`;
		expect(analyzeBgFillLine(line, 10)).toBeNull();
	});

	it("rejects default-background trailing spaces (nothing to paint)", () => {
		expect(analyzeBgFillLine(`hello${" ".repeat(5)}`, 10)).toBeNull();
	});

	it("rejects colored trailing fills after default-background gap cells", () => {
		expect(analyzeBgFillLine(`${" ".repeat(2)}${BG_OPEN}${" ".repeat(8)}${close}`, 10)).toBeNull();
		expect(analyzeBgFillLine(`X ${BG_OPEN}${" ".repeat(8)}${close}`, 10)).toBeNull();
	});

	it("allows a colored trailing fill that starts immediately after default content", () => {
		expect(analyzeBgFillLine(`X${BG_OPEN}${" ".repeat(9)}${close}`, 10)).toEqual({
			cut: 1,
			leftCol: 1,
			bg: BG_SGR,
		});
	});

	it("rejects rows narrower than the full width", () => {
		const line = `\x1b[41mab${" ".repeat(3)}${close}`;
		expect(analyzeBgFillLine(line, 10)).toBeNull();
	});

	it("rejects colon-form extended background it cannot reason about", () => {
		const line = `\x1b[48:2:1:2:3m${" ".repeat(5)}${close}`;
		expect(analyzeBgFillLine(line, 5)).toBeNull();
	});

	it("rejects lines carrying OSC sequences (hyperlinks/images)", () => {
		const line = `\x1b[41m\x1b]8;;https://x\x07L\x1b]8;;\x07${" ".repeat(8)}${close}`;
		expect(analyzeBgFillLine(line, 10)).toBeNull();
	});

	it("rejects a background change inside the trailing region", () => {
		// "ab" then default-bg spaces then a different bg — not a single span.
		const line = `\x1b[41mab\x1b[49m   \x1b[42m   \x1b[49m\x1b[0m`;
		expect(analyzeBgFillLine(line, 8)).toBeNull();
	});
});

describe("planDeccaraFills", () => {
	const blank = (width: number, bgOpen = BG_OPEN) => `${bgOpen}${" ".repeat(width)}\x1b[49m\x1b[0m`;

	it("coalesces adjacent identical fills into one rectangle and blanks the rows", () => {
		const lines = [blank(10), blank(10), blank(10)];
		const plan = planDeccaraFills(lines, 10);
		expect(plan.texts).toEqual(["", "", ""]);
		expect(plan.sequence).toBe(`${DECSACE_RECT}${encodeDeccara(1, 1, 3, 10, BG_SGR)}${DECSACE_DEFAULT}`);
	});

	it("respects the screen-row offset for top/bottom coordinates", () => {
		const lines = [blank(10), blank(10)];
		const plan = planDeccaraFills(lines, 10, 3);
		expect(plan.sequence).toBe(`${DECSACE_RECT}${encodeDeccara(4, 1, 5, 10, BG_SGR)}${DECSACE_DEFAULT}`);
	});

	it("splits coalescing when the background differs", () => {
		const other = "\x1b[42m";
		const lines = [blank(8), blank(8), blank(8, other)];
		const plan = planDeccaraFills(lines, 8);
		expect(plan.sequence).toBe(
			`${DECSACE_RECT}${encodeDeccara(1, 1, 2, 8, BG_SGR)}${encodeDeccara(3, 1, 3, 8, "42")}${DECSACE_DEFAULT}`,
		);
	});

	it("does not coalesce non-adjacent fills separated by a non-fill row", () => {
		const lines = [blank(12), "plain text row padded out here", blank(12)];
		const plan = planDeccaraFills(lines, 12);
		// Two rectangles: one per blank row, the middle untouched.
		expect(countOccurrences(plan.sequence, "$r")).toBe(2);
		expect(plan.texts[1]).toBe(lines[1]);
	});

	it("keeps the original line when the rectangle would not save bytes", () => {
		// Width 20, content fills 18 cells, only 2 trailing pad spaces — not worth it.
		const line = `${BG_OPEN}${"x".repeat(18)}  \x1b[49m\x1b[0m`;
		const plan = planDeccaraFills([line], 20);
		expect(plan.texts).toEqual([line]);
		expect(plan.sequence).toBe("");
	});

	it("optimizes a content row with substantial trailing padding", () => {
		const line = `${BG_OPEN}Hi${" ".repeat(38)}\x1b[49m\x1b[0m`;
		const plan = planDeccaraFills([line], 40);
		expect(plan.texts[0]).toBe(`${BG_OPEN}Hi\x1b[0m`);
		expect(plan.sequence).toBe(`${DECSACE_RECT}${encodeDeccara(1, 3, 1, 40, BG_SGR)}${DECSACE_DEFAULT}`);
	});

	it("passes plain rows through untouched with no rectangles", () => {
		const lines = ["hello", "world"];
		const plan = planDeccaraFills(lines, 40);
		expect(plan.texts).toEqual(lines);
		expect(plan.sequence).toBe("");
	});
});

describe("TUI DECCARA integration", () => {
	const savedDeccara = TERMINAL.deccara;
	const savedForceSyncOutput = Bun.env.PI_FORCE_SYNC_OUTPUT;
	const savedNoSyncOutput = Bun.env.PI_NO_SYNC_OUTPUT;
	const savedTuiSyncOutput = Bun.env.PI_TUI_SYNC_OUTPUT;

	beforeEach(() => {
		Bun.env.PI_FORCE_SYNC_OUTPUT = "1";
		process.env.PI_FORCE_SYNC_OUTPUT = "1";
		delete Bun.env.PI_NO_SYNC_OUTPUT;
		delete process.env.PI_NO_SYNC_OUTPUT;
		delete Bun.env.PI_TUI_SYNC_OUTPUT;
		delete process.env.PI_TUI_SYNC_OUTPUT;
		let monotonic = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonic += 20;
			return monotonic;
		});
	});

	afterEach(() => {
		if (savedForceSyncOutput === undefined) {
			delete Bun.env.PI_FORCE_SYNC_OUTPUT;
			delete process.env.PI_FORCE_SYNC_OUTPUT;
		} else {
			Bun.env.PI_FORCE_SYNC_OUTPUT = savedForceSyncOutput;
			process.env.PI_FORCE_SYNC_OUTPUT = savedForceSyncOutput;
		}
		if (savedNoSyncOutput === undefined) {
			delete Bun.env.PI_NO_SYNC_OUTPUT;
			delete process.env.PI_NO_SYNC_OUTPUT;
		} else {
			Bun.env.PI_NO_SYNC_OUTPUT = savedNoSyncOutput;
			process.env.PI_NO_SYNC_OUTPUT = savedNoSyncOutput;
		}
		if (savedTuiSyncOutput === undefined) {
			delete Bun.env.PI_TUI_SYNC_OUTPUT;
			delete process.env.PI_TUI_SYNC_OUTPUT;
		} else {
			Bun.env.PI_TUI_SYNC_OUTPUT = savedTuiSyncOutput;
			process.env.PI_TUI_SYNC_OUTPUT = savedTuiSyncOutput;
		}
		setTerminalDeccara(savedDeccara);
		vi.restoreAllMocks();
	});

	it("emits one coalesced rectangle for a blank panel and drops the padded rows", async () => {
		setTerminalDeccara(true);
		const term = new VirtualTerminal(40, 8);
		const tui = new TUI(term);
		tui.addChild(new BgPanelComponent(["", "", "", ""]));
		const writes = captureWrites(term);

		try {
			tui.start();
			await settle(term);
			const out = writes.join("");

			expect(out).toContain(DECSACE_RECT);
			expect(out).toContain(DECSACE_DEFAULT);
			expect(countOccurrences(out, "$r")).toBe(1);
			expect(out).toContain(encodeDeccara(1, 1, 4, 40, BG_SGR));
			// Every blank row was optimized away — no inline background padding emitted.
			expect(out).not.toContain(BG_OPEN);
		} finally {
			tui.stop();
		}
	});

	it("keeps padded fallback bytes and visible background when DECCARA is disabled", async () => {
		setTerminalDeccara(false);
		const term = new VirtualTerminal(40, 8);
		const tui = new TUI(term);
		tui.addChild(new BgPanelComponent(["", "", "", ""]));
		const writes = captureWrites(term);

		try {
			tui.start();
			await settle(term);
			const out = writes.join("");

			expect(out).not.toContain("$r");
			expect(out).not.toContain(DECSACE_RECT);
			expect(out).toContain(`${BG_OPEN}${" ".repeat(40)}`);
			// xterm.js applied the real background padding across the full row.
			expect(term.getViewportRowBackgroundColumns(0)).toHaveLength(40);
		} finally {
			tui.stop();
		}
	});

	it("keeps padded fallback bytes when synchronized output is disabled", async () => {
		await withEnvPatch(
			{ PI_NO_SYNC_OUTPUT: "1", PI_FORCE_SYNC_OUTPUT: undefined, PI_TUI_SYNC_OUTPUT: undefined },
			async () => {
				setTerminalDeccara(true);
				const term = new VirtualTerminal(40, 8);
				const tui = new TUI(term);
				tui.addChild(new BgPanelComponent(["", "", "", ""]));
				const writes = captureWrites(term);

				try {
					tui.start();
					await settle(term);
					const out = writes.join("");

					expect(out).not.toContain("$r");
					expect(out).not.toContain(DECSACE_RECT);
					expect(out).toContain(`${BG_OPEN}${" ".repeat(40)}`);
					expect(term.getViewportRowBackgroundColumns(0)).toHaveLength(40);
				} finally {
					tui.stop();
				}
			},
		);
	});

	it("preserves viewport text identically whether DECCARA is on or off", async () => {
		const rowsContent = ["", "Hello", "", "World", ""];
		const trimmed = (term: VirtualTerminal) => term.getViewport().map(line => line.trimEnd());
		const reference = await (async () => {
			setTerminalDeccara(false);
			const term = new VirtualTerminal(40, 8);
			const tui = new TUI(term);
			tui.addChild(new BgPanelComponent(rowsContent));
			try {
				tui.start();
				await settle(term);
				return trimmed(term);
			} finally {
				tui.stop();
			}
		})();

		setTerminalDeccara(true);
		const term = new VirtualTerminal(40, 8);
		const tui = new TUI(term);
		tui.addChild(new BgPanelComponent(rowsContent));
		try {
			tui.start();
			await settle(term);
			// xterm.js ignores DECCARA, so trailing cells stay unpainted, but the
			// printed glyphs (and their columns) must match the padded fallback
			// exactly — only the invisible trailing background differs on xterm.
			expect(trimmed(term)).toEqual(reference);
		} finally {
			tui.stop();
		}
	});

	it("leaves scrollback-bound rows padded while optimizing the visible tail", async () => {
		setTerminalDeccara(true);
		// 12 blank bg rows in an 8-row viewport: 4 scroll into history, 8 stay visible.
		const term = new VirtualTerminal(40, 8);
		const tui = new TUI(term);
		tui.addChild(new BgPanelComponent(Array.from({ length: 12 }, () => "")));
		const writes = captureWrites(term);

		try {
			tui.start();
			await settle(term);
			const out = writes.join("");

			// Visible tail optimized into a rectangle...
			expect(out).toContain("$r");
			// ...while the 4 scrollback-bound rows kept their full padded background.
			const paddedRow = `${BG_OPEN}${" ".repeat(40)}`;
			expect(countOccurrences(out, paddedRow)).toBe(4);
		} finally {
			tui.stop();
		}
	});

	it("optimizes only the changed row on an in-place diff without disturbing cursor parity", async () => {
		// Drive the same edit with DECCARA off then on; the cursor must land in the
		// same place either way (the rectangle is absolute-positioned and must not
		// shift the diff's relative cursor math).
		async function runDiff(deccara: boolean): Promise<{ out: string; cursor: { row: number; col: number } }> {
			setTerminalDeccara(deccara);
			const term = new VirtualTerminal(40, 8);
			const tui = new TUI(term);
			const panel = new BgPanelComponent(["AAA", "BBB", "CCC", "DDD"]);
			tui.addChild(panel);
			try {
				tui.start();
				await settle(term);
				const writes = captureWrites(term);
				panel.setRows(["AAA", "BBB", "XXX", "DDD"]);
				tui.requestRender();
				await settle(term);
				expect(term.getViewport()[2]?.trimEnd()).toBe("XXX");
				return { out: writes.join(""), cursor: term.getCursor() };
			} finally {
				tui.stop();
			}
		}

		const off = await runDiff(false);
		const on = await runDiff(true);

		// Fallback emits no rectangles; the optimized run emits exactly one, for the
		// single changed visible row (screen row 2 -> DECCARA row 3), and rewrites no
		// neighbor.
		expect(off.out).not.toContain("$r");
		expect(countOccurrences(on.out, "$r")).toBe(1);
		expect(on.out).toContain(encodeDeccara(3, 4, 3, 40, BG_SGR));
		expect(on.out).not.toContain("AAA");
		expect(on.out).not.toContain("DDD");
		// The hardware cursor lands on the same row either way. The column is
		// don't-care for a hidden cursor (the next diff re-anchors with a leading
		// CR), so only the row — which drives the renderer's relative math — must
		// match: the rectangle must not shift it.
		expect(on.cursor.row).toBe(off.cursor.row);
	});

	it("optimizes the viewport-repaint path triggered by a height change", async () => {
		setTerminalDeccara(true);
		const term = new VirtualTerminal(40, 6);
		const tui = new TUI(term);
		tui.addChild(new BgPanelComponent(["", "", "", ""]));

		try {
			tui.start();
			await settle(term);

			const writes = captureWrites(term);
			term.resize(40, 10); // height change, content unchanged -> viewportRepaint
			await settle(term);
			const out = writes.join("");

			expect(out).toContain(DECSACE_RECT);
			expect(out).toContain("$r");
		} finally {
			tui.stop();
		}
	});
});

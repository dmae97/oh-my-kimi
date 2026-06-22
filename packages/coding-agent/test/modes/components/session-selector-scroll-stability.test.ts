import { beforeAll, describe, expect, it } from "bun:test";
import { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

beforeAll(() => {
	initTheme();
});

function makeSessions(count: number): SessionInfo[] {
	return Array.from({ length: count }, (_, i) => ({
		path: `/work/SESSION_${i}.jsonl`,
		id: `id-${i}`,
		cwd: "/work",
		title: `SESSION_${i}`,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 1024,
		firstMessage: `body content ${i}`,
		allMessagesText: `body content ${i}`,
	}));
}

describe("issue #3283: /resume picker scrolls down after deleting a session", () => {
	it("keeps the picker header pinned at the same viewport row before and after a delete", async () => {
		const term = new VirtualTerminal(80, 24, 4096);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const selector = new SessionSelectorComponent(
			makeSessions(20),
			() => {},
			() => {},
			() => {},
			{
				getTerminalRows: () => term.rows,
				onDelete: async () => true,
			},
		);
		selector.setOnRequestRender(() => tui.requestRender());
		tui.addChild(selector);
		tui.setFocus(selector);

		try {
			tui.start();
			await scheduler.drain(term);

			const headerRowBefore = term.getViewport().findIndex(row => Bun.stripANSI(row).includes("Resume Session"));
			expect(headerRowBefore).toBeGreaterThanOrEqual(0);

			// Press Delete (CSI 3 ~) to open the confirmation dialog, then
			// Enter to accept "Yes".
			selector.handleInput("\x1b[3~");
			tui.requestRender();
			await scheduler.drain(term);
			selector.handleInput("\n");
			// onDelete is async; let its microtasks flush before draining renders.
			for (let i = 0; i < 8; i++) await Promise.resolve();
			await scheduler.drain(term);
			const viewport = term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			const headerRowAfter = viewport.findIndex(row => row.includes("Resume Session"));

			// Regression: dialog growing the frame and then shrinking must
			// not push the picker header further down into the viewport
			// (committed scrollback rows from the dialog frame).
			expect(headerRowAfter).toBeGreaterThanOrEqual(0);
			expect(headerRowAfter).toBe(headerRowBefore);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
	it("keeps the picker header pinned even when the delete dialog is canceled", async () => {
		const term = new VirtualTerminal(80, 24, 4096);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const selector = new SessionSelectorComponent(
			makeSessions(20),
			() => {},
			() => {},
			() => {},
			{
				getTerminalRows: () => term.rows,
				onDelete: async () => true,
			},
		);
		selector.setOnRequestRender(() => tui.requestRender());
		tui.addChild(selector);
		tui.setFocus(selector);

		try {
			tui.start();
			await scheduler.drain(term);
			const headerRowBefore = term.getViewport().findIndex(row => Bun.stripANSI(row).includes("Resume Session"));
			expect(headerRowBefore).toBeGreaterThanOrEqual(0);

			// Open dialog, then Esc to cancel without deleting.
			selector.handleInput("\x1b[3~");
			tui.requestRender();
			await scheduler.drain(term);
			selector.handleInput("\x1b");
			await scheduler.drain(term);

			const viewport = term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			const headerRowAfter = viewport.findIndex(row => row.includes("Resume Session"));
			expect(headerRowAfter).toBe(headerRowBefore);
			// Dialog gone, no scroll-down artefact.
			expect(viewport.some(row => row.includes("Delete session?"))).toBe(false);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("derives the SessionList reserve from the dialog's actual rendered height", () => {
		// Direct contract: the picker's render() override must size the
		// SessionList's external reserve to the dialog's *actual* rendered
		// height at the live width — not a fixed constant — so a narrow
		// terminal or a long session title that wraps the dialog past the
		// constant never leaves the picker overflowing the viewport
		// (PR #3285 review feedback).
		const longName = "a-very-very-very-very-long-session-title-that-must-wrap-on-a-narrow-terminal";
		const sessions: SessionInfo[] = [
			{
				path: `/work/${longName}.jsonl`,
				id: "id-long",
				cwd: "/work",
				title: longName,
				created: new Date("2024-01-01T00:00:00Z"),
				modified: new Date("2024-01-02T00:00:00Z"),
				messageCount: 1,
				size: 1024,
				firstMessage: longName,
				allMessagesText: longName,
			},
			...makeSessions(10),
		];

		const NARROW_WIDTH = 30;
		const TERMINAL_ROWS = 50;
		const selector = new SessionSelectorComponent(
			sessions,
			() => {},
			() => {},
			() => {},
			{ getTerminalRows: () => TERMINAL_ROWS, onDelete: async () => true },
		);

		// Baseline: render the picker before the dialog opens.
		const beforeOpen = selector.render(NARROW_WIDTH).length;

		// Open the delete confirmation. The picker's render override
		// measures the dialog and pushes the reserve into the SessionList
		// before super.render() walks the children, so the very first
		// render after the dialog mounts already reflects the dynamic
		// reserve.
		selector.handleInput("\x1b[3~");
		const afterOpen = selector.render(NARROW_WIDTH);
		const dialog = selector.children.at(-1);
		expect(dialog).toBeDefined();
		const dialogHeight = dialog!.render(NARROW_WIDTH).length;

		// On a narrow width with a long title the dialog wraps past the
		// previous hard-coded 12-row reserve.
		expect(dialogHeight).toBeGreaterThan(12);

		// Contract: when the dialog wraps past the previous constant
		// reserve (12), the dynamic reserve correctly shrinks the
		// SessionList by the dialog's *actual* height, so the picker
		// frame growth is ≤ 0 (sessions freed ≥ dialog rows added). A
		// constant reserve only frees 12 rows regardless, so the picker
		// frame grows by `dialogHeight - 12` rows on every dialog open.
		// Allow a one-session rounding slack (4 rows) for the floor
		// inside `#visibleCount`.
		const growth = afterOpen.length - beforeOpen;
		expect(growth).toBeLessThanOrEqual(0);
	});
});

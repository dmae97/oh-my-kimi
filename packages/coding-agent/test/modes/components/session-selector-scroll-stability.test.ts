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
});

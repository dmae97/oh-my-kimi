import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type RenderStablePrefix, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// Behavioral tests for the RenderStablePrefix engine seam: a component that
// mutates its returned render array in place (instead of returning a fresh
// array per change) reports how many leading rows survived since the last
// read. The engine trusts that report — it skips marker extraction, line
// preparation, and the committed-prefix audit for those rows — so the report
// must be both honored (stable rows are not re-emitted into history) and
// consumed (re-ingestion repaints everything at/after the reported floor).

/**
 * In-place mutator implementing the consumable-floor contract: render()
 * always returns the SAME persistent array, `append` grows it at the bottom,
 * `mutate` rewrites an interior row and lowers the accumulated floor to it.
 * Reading the report re-bases the baseline to the current array state.
 */
class StableList implements Component, RenderStablePrefix {
	#lines: string[] = [];
	#stableFloor = 0;

	invalidate(): void {}

	append(...rows: string[]): void {
		this.#lines.push(...rows);
	}

	mutate(index: number, row: string): void {
		this.#lines[index] = row;
		this.#stableFloor = Math.min(this.#stableFloor, index);
	}

	render(_width: number): readonly string[] {
		return this.#lines;
	}

	getRenderStablePrefixRows(): number {
		const value = this.#stableFloor;
		this.#stableFloor = this.#lines.length;
		return value;
	}
}

/** Ref-stable bottom component: a fresh array per change, cached otherwise. */
class PromptLine implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	invalidate(): void {}

	set(lines: string[]): void {
		this.#lines = lines;
	}

	render(_width: number): readonly string[] {
		return this.#lines;
	}
}

function strip(rows: string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

describe("RenderStablePrefix engine contract", () => {
	it("emits appended rows exactly once and in order while the stable prefix is honored", async () => {
		const term = new VirtualTerminal(80, 8, 10_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const list = new StableList();
		tui.addChild(list);

		const markers = Array.from({ length: 36 }, (_unused, i) => `ROW-${String(i).padStart(3, "0")}`);

		try {
			tui.start();
			await scheduler.drain(term);

			// Grow the persistent array in place across several frames. Each
			// chunk overflows the 8-row viewport a bit more, so committed rows
			// must scroll into history exactly once while the live tail keeps
			// repainting.
			for (let chunk = 6; chunk <= markers.length; chunk += 6) {
				list.append(...markers.slice(chunk - 6, chunk));
				tui.requestRender();
				await scheduler.drain(term);
			}

			// History + active grid together must contain every appended row
			// exactly once: committed rows are not re-emitted, no row is lost.
			const buffer = strip(term.getScrollBuffer()).join("\n");
			const missing = markers.filter(mark => buffer.split(mark).length - 1 === 0);
			const duplicated = markers.filter(mark => buffer.split(mark).length - 1 > 1);
			expect(missing).toEqual([]);
			expect(duplicated).toEqual([]);

			// And in original append order.
			const observedMarkers = Array.from(buffer.matchAll(/ROW-\d{3}/g), match => match[0]);
			expect(observedMarkers).toEqual(markers);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("repaints an interior row mutated in place when the report lowers the floor", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const list = new StableList();
		list.append("alpha", "beta", "gamma", "delta");
		tui.addChild(list);

		try {
			tui.start();
			await scheduler.drain(term);
			// A second unchanged frame so the engine has consumed a full-length
			// report and trusts the prefix.
			tui.requestRender();
			await scheduler.drain(term);

			let viewport = strip(term.getViewport()).filter(row => row.length > 0);
			expect(viewport).toEqual(["alpha", "beta", "gamma", "delta"]);

			// Rewrite row 1 in place: same array reference, lowered floor.
			list.mutate(1, "beta-edited");
			tui.requestRender();
			await scheduler.drain(term);

			viewport = strip(term.getViewport()).filter(row => row.length > 0);
			expect(viewport).toEqual(["alpha", "beta-edited", "gamma", "delta"]);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("honors the cursor marker of a changing bottom component below a stable prefix", async () => {
		const term = new VirtualTerminal(40, 6, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const head = new StableList();
		head.append("head-0", "head-1", "head-2");
		const prompt = new PromptLine([`> abc${CURSOR_MARKER}`]);
		tui.addChild(head);
		tui.addChild(prompt);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(term.getCursor()).toEqual({ row: 3, col: 5 });

			// Only the bottom component changes; the head's rows ride the
			// stable prefix (their marker scan is skipped), yet the bottom's
			// marker must still be extracted and honored each frame.
			prompt.set([`> abcd${CURSOR_MARKER}`]);
			tui.requestRender();
			await scheduler.drain(term);

			expect(strip(term.getViewport()).filter(row => row.length > 0)).toEqual([
				"head-0",
				"head-1",
				"head-2",
				"> abcd",
			]);
			expect(term.getCursor()).toEqual({ row: 3, col: 6 });

			prompt.set([`> ab${CURSOR_MARKER}cd`]);
			tui.requestRender();
			await scheduler.drain(term);
			expect(term.getCursor()).toEqual({ row: 3, col: 4 });
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

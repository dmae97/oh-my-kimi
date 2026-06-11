import { describe, expect, it } from "bun:test";
import { type Component, Container, type NativeScrollbackLiveRegion, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// Behavioral tests for TUI.requestComponentRender: a component whose own
// content changed (spinner frame, blink) asks for a component-scoped frame.
// When every request since the last frame is component-scoped and the frame is
// otherwise quiet, the compose re-renders only the root subtrees containing
// the requesting components and reuses the previous segment — rows and seam
// report — of every other root child. Any concurrent full request or unsafe
// condition must downgrade to a normal full compose.

/** Ref-stable leaf: fresh array per change, counts render() calls. */
class CountingLines implements Component {
	renders = 0;
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	set(lines: string[]): void {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.renders++;
		return this.#lines;
	}
}

/** Transcript-shaped head: final rows committed, the last row stays live. */
class LiveHead extends CountingLines implements NativeScrollbackLiveRegion {
	#seam = 0;

	setSeam(seam: number): void {
		this.#seam = seam;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#seam;
	}
}

function strip(rows: string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

function visible(term: VirtualTerminal): string[] {
	return strip(term.getViewport()).filter(row => row.length > 0);
}

describe("TUI.requestComponentRender", () => {
	it("re-renders only the requesting subtree on a quiet frame", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0", "msg-1", "msg-2"]);
		const status = new Container();
		const spinner = new CountingLines(["spin-0"]);
		status.addChild(spinner);
		tui.addChild(transcript);
		tui.addChild(status);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["msg-0", "msg-1", "msg-2", "spin-0"]);
			const transcriptRenders = transcript.renders;

			// Spinner tick: component-scoped request, nested one level deep.
			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "msg-1", "msg-2", "spin-1"]);
			// The transcript subtree was reused, not re-rendered.
			expect(transcript.renders).toBe(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("downgrades to a full compose when a full request shares the frame", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			const transcriptRenders = transcript.renders;

			// Both a component-scoped and a full request coalesce into one
			// frame; the full request wins regardless of arrival order.
			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			transcript.set(["msg-0", "msg-edited"]);
			tui.requestRender();
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "msg-edited", "spin-1"]);
			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full compose while an overlay is up", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			tui.showOverlay(new CountingLines(["modal"]), { width: 10 });
			await scheduler.drain(term);
			const transcriptRenders = transcript.renders;

			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			// Unsafe condition: the frame rendered fully (and correctly).
			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full compose when the root child list changed", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);

			// Structural change with only a component-scoped request pending:
			// the segment ledger no longer matches the root list, so the frame
			// must compose fully and paint the new child.
			tui.addChild(new CountingLines(["banner"]));
			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "spin-1", "banner"]);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full compose when the component is not in the tree", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const status = new Container();
		const spinner = new CountingLines(["spin-0"]);
		status.addChild(spinner);
		tui.addChild(transcript);
		tui.addChild(status);

		try {
			tui.start();
			await scheduler.drain(term);
			const transcriptRenders = transcript.renders;

			// A detached component (cleared status container) can still fire a
			// trailing tick; the frame must not skip anything based on it.
			status.removeChild(spinner);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0"]);
			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("replays the seam report of a skipped root child across partial frames", async () => {
		const term = new VirtualTerminal(40, 4, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const markers = Array.from({ length: 8 }, (_unused, i) => `ROW-${String(i).padStart(3, "0")}`);
		// All but the last head row are final; the tail row stays live.
		const head = new LiveHead([...markers, "streaming"]);
		head.setSeam(markers.length);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(head);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			const headRenders = head.renders;

			// Several spinner-only frames while the head (and its commit seam)
			// ride the reused segment.
			for (let tick = 1; tick <= 3; tick++) {
				spinner.set([`spin-${tick}`]);
				tui.requestComponentRender(spinner);
				await scheduler.drain(term);
			}
			expect(head.renders).toBe(headRenders);
			expect(visible(term).at(-1)).toBe("spin-3");

			// A later full frame must still commit exactly once: every final
			// row appears exactly once across history + grid, in order.
			head.set([...markers, "streamed-final", "tail"]);
			head.setSeam(markers.length + 2);
			tui.requestRender();
			await scheduler.drain(term);

			const buffer = strip(term.getScrollBuffer()).join("\n");
			const missing = markers.filter(mark => buffer.split(mark).length - 1 === 0);
			const duplicated = markers.filter(mark => buffer.split(mark).length - 1 > 1);
			expect(missing).toEqual([]);
			expect(duplicated).toEqual([]);
			const observed = Array.from(buffer.matchAll(/ROW-\d{3}/g), match => match[0]);
			expect(observed).toEqual(markers);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { Image, ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import {
	encodeKittyVirtualPlacement,
	getKittyGraphics,
	KITTY_PLACEHOLDER,
	setKittyGraphics,
} from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	type CellDimensions,
	encodeKittyDeleteImage,
	encodeKittyPlacement,
	encodeKittyTransmit,
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { VirtualTerminal } from "./virtual-terminal";

type MutableTerminalInfo = { id: string; imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

/** Drive one render pass against the budget with `count` images (ids 1..count, stable across passes). */
function pass(budget: ImageBudget, count: number): { suppressed: boolean[]; reset: boolean; purge: readonly number[] } {
	budget.beginPass();
	const suppressed: boolean[] = [];
	for (let i = 0; i < count; i++) suppressed.push(budget.observe(i + 1));
	const reset = budget.endPass();
	const purge = [...budget.takePurgeIds()];
	return { suppressed, reset, purge };
}

describe("ImageBudget", () => {
	it("defaults to eight live images", () => {
		expect(new ImageBudget().cap).toBe(8);
	});

	it("keeps every image live while at or under the cap", () => {
		const budget = new ImageBudget(3, () => {});
		const first = pass(budget, 2);
		expect(first.suppressed).toEqual([false, false]);
		expect(first.reset).toBe(false);

		const second = pass(budget, 3);
		expect(second.suppressed).toEqual([false, false, false]);
		expect(second.reset).toBe(false);
		expect(second.purge).toEqual([]);
	});

	it("demotes the oldest image on the frame after the cap is exceeded, purging its graphics id", () => {
		let renders = 0;
		const budget = new ImageBudget(2, () => {
			renders += 1;
		});

		// At cap: nothing demoted.
		expect(pass(budget, 2).suppressed).toEqual([false, false]);

		// Over cap: the new image still shows this frame; a follow-up render is scheduled.
		const overflow = pass(budget, 3);
		expect(overflow.suppressed).toEqual([false, false, false]);
		expect(overflow.reset).toBe(false);
		expect(renders).toBe(1);

		// The scheduled frame demotes the oldest image and purges its id (1) with a full redraw.
		const demote = pass(budget, 3);
		expect(demote.suppressed).toEqual([true, false, false]);
		expect(demote.reset).toBe(true);
		expect(demote.purge).toEqual([1]);

		// Steady state: no further resets while the count is unchanged.
		const steady = pass(budget, 3);
		expect(steady.suppressed).toEqual([true, false, false]);
		expect(steady.reset).toBe(false);
		expect(steady.purge).toEqual([]);
	});

	it("keeps exactly `cap` images live as more arrive", () => {
		const budget = new ImageBudget(2, () => {});
		// Walk up to 5 images; each addition settles into a demotion frame.
		for (let count = 3; count <= 5; count++) {
			pass(budget, count); // overflow frame (schedules reset)
			pass(budget, count); // reset frame (applies demotion)
		}
		const settled = pass(budget, 5);
		// Newest 2 live, oldest 3 demoted.
		expect(settled.suppressed).toEqual([true, true, true, false, false]);
	});

	it("treats cap <= 0 as unlimited: never demotes, never schedules a redraw", () => {
		let renders = 0;
		const budget = new ImageBudget(0, () => {
			renders += 1;
		});
		expect(budget.enabled).toBe(false);
		const result = pass(budget, 6);
		expect(result.suppressed).toEqual([false, false, false, false, false, false]);
		expect(result.reset).toBe(false);
		expect(result.purge).toEqual([]);
		expect(renders).toBe(0);
	});

	it("restores demoted images once the count settles back within the cap", () => {
		const budget = new ImageBudget(2, () => {});
		pass(budget, 3); // overflow
		pass(budget, 3); // demote oldest
		expect(pass(budget, 3).suppressed).toEqual([true, false, false]);

		// Drop back to 2 images; after the threshold settles nothing is demoted.
		pass(budget, 2);
		const restored = pass(budget, 2);
		expect(restored.suppressed).toEqual([false, false]);
		expect(restored.reset).toBe(false);
		expect(restored.purge).toEqual([]);
	});

	it("hands back a stable graphics id per key and fresh ids without one", () => {
		const budget = new ImageBudget(3, () => {});
		const a1 = budget.acquireId("tool:0");
		const a2 = budget.acquireId("tool:0");
		const b = budget.acquireId("tool:1");
		expect(a1).toBe(a2);
		expect(b).not.toBe(a1);
		expect(budget.acquireId()).not.toBe(budget.acquireId());
	});

	it("setCap(0) clears a previously applied demotion threshold", () => {
		const budget = new ImageBudget(2, () => {});
		pass(budget, 3);
		pass(budget, 3);
		expect(pass(budget, 3).suppressed).toEqual([true, false, false]);

		budget.setCap(0);
		const result = pass(budget, 3);
		expect(result.suppressed).toEqual([false, false, false]);
	});
});

describe("encodeKittyDeleteImage", () => {
	it("emits an APC delete-by-id that frees the image and suppresses the reply", () => {
		expect(encodeKittyDeleteImage(42)).toBe("\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
	});
});

describe("Image budget integration", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalGraphics = { ...getKittyGraphics() };
	let originalCellDims: CellDimensions;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = ImageProtocol.Kitty;
		// These tests pin the direct `a=p` placement contract.
		setKittyGraphics({ unicodePlaceholders: false });
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
		setKittyGraphics(originalGraphics);
	});

	it("renders within-budget images as graphics carrying their stable id", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "k" },
		);

		budget.beginPass();
		const lines = image.render(20);
		budget.endPass();

		const last = lines.at(-1) ?? "";
		expect(last).toContain("\x1b_G");
		expect(last).toContain(`i=${id}`);
		expect(last).not.toContain("[Image:");
	});

	it("transmits the base64 once via the budget and renders only a placement line", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "k" },
		);

		budget.beginPass();
		const lines = image.render(20);
		budget.endPass();

		// One transmit, carrying the base64 data, keyed by the image id.
		const transmits = [...budget.takeTransmits()];
		expect(transmits).toHaveLength(1);
		expect(transmits[0]).toContain("\x1b_Ga=t");
		expect(transmits[0]).toContain(`i=${id}`);
		expect(transmits[0]).toContain(BASE64_ONE_PIXEL_PNG);
		// The render line is a placement (`a=p`) without the base64.
		const last = lines.at(-1) ?? "";
		expect(last).toContain("\x1b_Ga=p");
		expect(last).not.toContain(BASE64_ONE_PIXEL_PNG);

		// A second render (cache hit) does not re-enqueue the data.
		budget.beginPass();
		image.render(20);
		budget.endPass();
		expect([...budget.takeTransmits()]).toEqual([]);
	});

	it("renders an over-budget image as its text fallback instead of graphics", () => {
		const budget = new ImageBudget(1, () => {});
		const older = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "old" },
		);
		const newer = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "new" },
		);

		// First pass lets the budget notice the overflow; the second applies the
		// demotion (older image is observed first, so it is demoted first).
		let olderLines: string[] = [];
		let newerLines: string[] = [];
		for (let i = 0; i < 2; i++) {
			budget.beginPass();
			olderLines = older.render(20);
			newerLines = newer.render(20);
			budget.endPass();
		}

		expect(olderLines.join("")).toContain("[Image:");
		expect(olderLines.join("")).not.toContain("\x1b_G");
		expect(newerLines.at(-1) ?? "").toContain("\x1b_G");
	});
});

describe("Image budget + Unicode placeholders", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalGraphics = { ...getKittyGraphics() };
	let originalCellDims: CellDimensions;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: true });
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
		setKittyGraphics(originalGraphics);
	});

	it("renders a transmitted image as a virtual-placement placeholder grid", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "k" },
		);

		budget.beginPass();
		const lines = image.render(20);
		budget.endPass();

		// Line 0 carries the U=1 virtual placement keyed by the image id.
		expect(lines[0]).toContain(`\x1b_Ga=p,U=1,q=2,i=${id}`);
		// Every rendered line is a real placeholder-cell row (no empty/cursor-up trick).
		expect(lines.every(l => l.includes(KITTY_PLACEHOLDER))).toBe(true);
		expect(lines.join("")).not.toContain("\x1b[1A");
		// The image id is encoded in the cell foreground color (low 24 bits).
		expect(lines[0]).toContain(`38;2;0;0;${id}`);
		// Render lines never carry the base64 — data goes via the one-time transmit.
		expect(lines.join("")).not.toContain(BASE64_ONE_PIXEL_PNG);
		const transmits = [...budget.takeTransmits()];
		expect(transmits).toHaveLength(1);
		expect(transmits[0]).toContain("\x1b_Ga=t");
		expect(transmits[0]).toContain(`i=${id}`);
	});

	it("re-emits the virtual placement (not base64) on a fresh render after cache invalidation", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "k" },
		);
		budget.beginPass();
		image.render(20);
		budget.endPass();
		expect([...budget.takeTransmits()]).toHaveLength(1);

		// A repaint after invalidation re-emits the placement but never the data.
		image.invalidate();
		budget.beginPass();
		const lines = image.render(20);
		budget.endPass();
		expect(lines[0]).toContain(encodeKittyVirtualPlacement({ imageId: id, placementId: id, columns: 4, rows: 4 }));
		expect([...budget.takeTransmits()]).toEqual([]);
	});
});

describe("TUI inline-image budget", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	let originalCellDims: CellDimensions;
	let monotonicNow = 0;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = ImageProtocol.Kitty;
		monotonicNow = 0;
		// Advance one full 30fps frame (>1000/30ms) per tick so the render
		// throttle computes a zero delay and every requestRender flushes inline.
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 40;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
	});

	async function settle(term: VirtualTerminal): Promise<void> {
		for (let i = 0; i < 4; i++) {
			const tick = Promise.withResolvers<void>();
			process.nextTick(tick.resolve);
			await tick.promise;
			await Bun.sleep(40);
			await term.flush();
		}
	}

	function makeImage(budget: ImageBudget, key: string): Image {
		return new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: key },
		);
	}

	it("hides the oldest image via a full redraw + graphics purge once a new image exceeds the cap", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		const tui = new TUI(term);
		tui.setMaxInlineImages(1);
		const oldId = tui.imageBudget.acquireId("img-old");
		tui.addChild(makeImage(tui.imageBudget, "img-old"));

		try {
			tui.start();
			await settle(term);
			const redrawsBefore = tui.fullRedraws;
			writes.length = 0;

			// A second image arrives, exceeding the cap of 1.
			tui.addChild(makeImage(tui.imageBudget, "img-new"));
			tui.requestRender();
			await settle(term);

			// The demotion forces at least one extra full redraw...
			expect(tui.fullRedraws).toBeGreaterThan(redrawsBefore);
			// ...purges the now-hidden image's graphics by id...
			expect(writes.join("")).toContain(encodeKittyDeleteImage(oldId));
			// ...and the oldest image is now shown as text, with one image still live.
			const viewport = term.getViewport().map(l => l.trimEnd());
			const fallbackCount = viewport.filter(l => l.includes("[Image:")).length;
			expect(fallbackCount).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("transmits image data only once; a later full redraw re-emits just the placement", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		const tui = new TUI(term);
		tui.setMaxInlineImages(3); // high cap: no demotion in this test
		tui.addChild(makeImage(tui.imageBudget, "only"));

		try {
			tui.start();
			await settle(term);
			// First paint transmits the data (a=t carrying the base64) and places it.
			const initial = writes.join("");
			expect(initial).toContain("\x1b_Ga=t");
			expect(initial).toContain(BASE64_ONE_PIXEL_PNG);
			writes.length = 0;

			// Force a full redraw (clear scrollback + repaint the whole transcript).
			tui.requestRender(true, { clearScrollback: true });
			await settle(term);

			// The repaint re-emits the placement but never re-sends the base64.
			const repaint = writes.join("");
			expect(repaint).toContain("\x1b_Ga=p");
			expect(repaint).not.toContain(BASE64_ONE_PIXEL_PNG);
		} finally {
			tui.stop();
		}
	});

	it("holds the first Ghostty image paint until the startup settle window passes", () => {
		const originalId = terminal.id;
		const originalGraphics = { ...getKittyGraphics() };
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		let now = 0;
		const scheduled: Array<{ delayMs: number; callback: () => void; canceled: boolean }> = [];
		const renderScheduler = {
			now: () => now,
			scheduleImmediate: (callback: () => void) => callback(),
			scheduleRender: (callback: () => void, delayMs: number) => {
				const entry = { delayMs, callback, canceled: false };
				scheduled.push(entry);
				return {
					cancel: () => {
						entry.canceled = true;
					},
				};
			},
		};

		terminal.id = "ghostty";
		terminal.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: true });

		const tui = new TUI(term, undefined, { renderScheduler });
		tui.addChild(makeImage(tui.imageBudget, "only"));

		try {
			tui.start();
			expect(writes.join("")).not.toContain("\x1b_Ga=t");

			const delayed = scheduled.find(entry => !entry.canceled && entry.delayMs === 100);
			expect(delayed).toBeDefined();
			now = 100;
			delayed?.callback();

			const output = writes.join("");
			expect(output).toContain("\x1b_Ga=t");
			expect(output).toContain(BASE64_ONE_PIXEL_PNG);
		} finally {
			tui.stop();
			terminal.id = originalId;
			setKittyGraphics(originalGraphics);
		}
	});
});

describe("kitty transmit / placement encoding", () => {
	it("encodeKittyTransmit loads data by id without displaying it", () => {
		const seq = encodeKittyTransmit(BASE64_ONE_PIXEL_PNG, 9);
		expect(seq.startsWith("\x1b_Ga=t,f=100,q=2,i=9;")).toBe(true);
		expect(seq.endsWith("\x1b\\")).toBe(true);
		expect(seq).toContain(BASE64_ONE_PIXEL_PNG);
		expect(seq).not.toContain("a=p");
	});

	it("encodeKittyPlacement displays a transmitted image by id with a stable placement id", () => {
		const seq = encodeKittyPlacement({ imageId: 9, placementId: 9, columns: 3, rows: 2 });
		expect(seq).toBe("\x1b_Ga=p,q=2,i=9,p=9,c=3,r=2\x1b\\");
		expect(seq).not.toContain(BASE64_ONE_PIXEL_PNG);
	});
});

describe("ImageBudget transmit tracking", () => {
	it("transmits an id once and clears the queue when drained", () => {
		const budget = new ImageBudget(3, () => {});
		expect(budget.shouldTransmit(1)).toBe(true);
		budget.enqueueTransmit(1, "TX1");
		expect(budget.shouldTransmit(1)).toBe(false);
		budget.enqueueTransmit(1, "TX1-dup"); // already transmitted => no-op
		expect([...budget.takeTransmits()]).toEqual(["TX1"]);
		expect([...budget.takeTransmits()]).toEqual([]);
	});

	it("purges all transmitted ids for terminal-session cleanup", () => {
		const budget = new ImageBudget(3, () => {});
		budget.enqueueTransmit(1, "TX1");
		budget.enqueueTransmit(2, "TX2");
		expect(budget.shouldTransmit(1)).toBe(false);

		expect([...budget.takeAllTransmittedIds()]).toEqual([1, 2]);
		expect([...budget.takeTransmits()]).toEqual([]);
		expect(budget.shouldTransmit(1)).toBe(true);
		expect([...budget.takeAllTransmittedIds()]).toEqual([]);
	});

	it("re-transmits an image after a purge frees its data", () => {
		const budget = new ImageBudget(2, () => {});
		budget.enqueueTransmit(1, "TX1");
		expect(budget.shouldTransmit(1)).toBe(false);

		// Push past the cap so the oldest image (id 1) is demoted and purged.
		pass(budget, 3); // overflow frame schedules the demotion
		const demote = pass(budget, 3); // demotion frame purges id 1
		expect(demote.purge).toEqual([1]);

		// d=I freed the data, so the image must transmit again if it returns.
		expect(budget.shouldTransmit(1)).toBe(true);
	});
});

import { describe, expect, it } from "bun:test";
import { Image, isDirectKittyContinuation, unwrapDirectKittyPlacement } from "@oh-my-pi/pi-tui/components/image";
import { ScrollView } from "@oh-my-pi/pi-tui/components/scroll-view";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { Ellipsis, visibleWidth } from "@oh-my-pi/pi-tui/utils";

const theme = {
	track: () => "T",
	thumb: () => "B",
};

function directImageRows(rows: number): readonly string[] {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalGraphics = { ...getKittyGraphics() };
	const originalCellDimensions = { ...getCellDimensions() };
	try {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		setKittyGraphics({ unicodePlaceholders: false });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		return new Image(
			"AA==",
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: rows, maxHeightCells: rows },
			{ widthPx: rows * 10, heightPx: rows * 10 },
		).render(20);
	} finally {
		setTerminalImageProtocol(originalProtocol);
		setKittyGraphics(originalGraphics);
		setCellDimensions(originalCellDimensions);
	}
}

describe("ScrollView", () => {
	it("renders a fixed-height viewport and omits auto scrollbar when content fits", () => {
		const view = new ScrollView(["one", "two"], { height: 3, theme });

		expect(view.render(10)).toEqual(["one", "two", ""]);
	});

	it("renders a right-edge scrollbar when content overflows", () => {
		const view = new ScrollView(["alpha", "beta", "gamma", "delta", "omega"], { height: 3, theme });

		expect(view.render(6)).toEqual(["alphaB", "beta T", "gammaT"]);
	});

	it("scrolls and clamps offsets", () => {
		const view = new ScrollView(["one", "two", "three", "four", "five"], { height: 3, theme });

		view.scroll(10);

		expect(view.getScrollOffset()).toBe(2);
		expect(view.render(6)).toEqual(["threeT", "four T", "five B"]);

		view.scroll(-10);

		expect(view.getScrollOffset()).toBe(0);
	});

	it("reserves a scrollbar column in always mode", () => {
		const view = new ScrollView(["one"], { height: 2, scrollbar: "always", theme });

		expect(view.render(5)).toEqual(["one B", "    B"]);
	});

	it("does not reserve a scrollbar column in never mode", () => {
		const view = new ScrollView(["alpha", "beta", "gamma"], { height: 2, scrollbar: "never", theme });

		expect(view.render(6)).toEqual(["alpha", "beta"]);
	});

	it("renders scrollbar geometry for pre-windowed lines", () => {
		const view = new ScrollView(["gamma", "delta"], { height: 2, totalRows: 4, theme });
		view.setScrollOffset(2);

		expect(view.render(6)).toEqual(["gammaT", "deltaB"]);
	});

	it("does not render a scrollbar when width is zero", () => {
		const view = new ScrollView(["one", "two"], { height: 1, theme });

		expect(view.render(0)).toEqual([""]);
	});

	it("clamps scroll offset when content shrinks", () => {
		const view = new ScrollView(["one", "two", "three", "four"], { height: 2, theme });
		view.scrollToBottom();

		view.setLines(["one"]);

		expect(view.getScrollOffset()).toBe(0);
		expect(view.render(10)).toEqual(["one", ""]);
	});

	it("keeps rendered rows within requested width with ANSI input", () => {
		const view = new ScrollView(["\x1b[31malphabet\x1b[0m", "plain", "tail"], { height: 2, theme });
		const rendered = view.render(5);

		expect(rendered).toHaveLength(2);
		expect(rendered.every(line => visibleWidth(line) <= 5)).toBe(true);
		expect(rendered[0]).toContain("B");
	});

	it("appends an overflow ellipsis by default and omits it when configured", () => {
		const long = ["abcdefghij"];
		const def = new ScrollView(long, { height: 1, scrollbar: "never", theme });
		expect(def.render(5)[0]).toContain("…");

		const omit = new ScrollView(long, { height: 1, scrollbar: "never", ellipsis: Ellipsis.Omit, theme });
		expect(omit.render(5)[0]).toBe("abcde");
	});

	it("handles navigation keys, with Shift+Arrow scrolling by fastScrollLines", () => {
		const view = new ScrollView(
			Array.from({ length: 50 }, (_, i) => String(i)),
			{ height: 5, fastScrollLines: 7, theme },
		);

		expect(view.handleScrollKey("\x1b[B")).toBe(true); // down
		expect(view.getScrollOffset()).toBe(1);
		expect(view.handleScrollKey("\x1b[1;2B")).toBe(true); // shift+down
		expect(view.getScrollOffset()).toBe(8);
		expect(view.handleScrollKey("\x1b[1;2A")).toBe(true); // shift+up
		expect(view.getScrollOffset()).toBe(1);
		expect(view.handleScrollKey("x")).toBe(false);
	});
	it("keeps protected image markers recognizable with an always-visible scrollbar", () => {
		const imageRows = directImageRows(4);
		const view = new ScrollView([...imageRows, "tail"], { height: 4, scrollbar: "always", theme });

		const rendered = view.render(20);

		expect(unwrapDirectKittyPlacement(rendered[0] ?? "")).not.toBeNull();
		expect(rendered.slice(1).every(isDirectKittyContinuation)).toBe(true);
	});

	it("skips orphaned continuation rows when the viewport starts inside an image", () => {
		const imageRows = directImageRows(4);
		const view = new ScrollView(["before", ...imageRows, "after-a", "after-b"], {
			height: 3,
			scrollbar: "never",
			theme,
		});
		view.setScrollOffset(2);

		expect(view.render(20)).toEqual(["after-a", "after-b", ""]);
	});

	it("does not start an image block that cannot fit in the remaining viewport", () => {
		const imageRows = directImageRows(4);
		const view = new ScrollView(["top-a", "top-b", ...imageRows, "after"], {
			height: 4,
			scrollbar: "never",
			theme,
		});

		expect(view.render(20)).toEqual(["top-a", "top-b", "after", ""]);
	});

	it("omits a pre-windowed image truncated at the window end", () => {
		const imageRows = directImageRows(4);
		const view = new ScrollView(imageRows.slice(0, 2), {
			height: 2,
			scrollbar: "never",
			totalRows: 4,
			theme,
		});

		expect(view.render(20)).toEqual(["", ""]);
	});
});

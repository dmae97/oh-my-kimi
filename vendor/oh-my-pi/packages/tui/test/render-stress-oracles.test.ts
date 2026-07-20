import { describe, expect, it } from "bun:test";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui/tui";
import {
	compositeExpectedLineAt,
	cursorInsertionIndex,
	duplicateNonblankLines,
	expectedFrameFromLines,
	expectedScrollbackBuffer,
	resolveExpectedOverlayLayout,
	scrollbackProbePositions,
	stripPlainTerminalText,
} from "./render-stress-harness";

const ESC = "\x1b";
const BEL = "\x07";

describe("render stress oracle helpers", () => {
	it("models capped native scrollback buffers", () => {
		expect(expectedScrollbackBuffer(["a"], 3, 2)).toEqual(["a", "", ""]);
		expect(expectedScrollbackBuffer(["0", "1", "2", "3", "4", "5"], 2, 3)).toEqual(["1", "2", "3", "4", "5"]);
	});

	it("chooses bounded scrollback probe positions", () => {
		expect(scrollbackProbePositions(40, 100, 10)).toEqual([0, 20, 40]);
	});

	it("detects only repeated nonblank frame lines", () => {
		expect([...duplicateNonblankLines(["alpha", "", "alpha", "beta", "beta"])]).toEqual(["alpha", "beta"]);
	});

	it("strips OSC hyperlinks and terminal styling from plain text", () => {
		const linked = `${ESC}]8;;https://example.test${BEL}${ESC}[31mlink${ESC}[0m${ESC}]8;;${BEL}`;
		expect(stripPlainTerminalText(linked)).toBe("link");
	});

	it("computes cursor insertion columns by terminal cells", () => {
		expect(cursorInsertionIndex("abcd", "middle", 80)).toBe(2);
		expect(cursorInsertionIndex("a界b", "wideBoundary", 3)).toBe(1);
	});

	it("builds expected frames with cursor and background-column oracles", () => {
		const frame = expectedFrameFromLines([`${ESC}[41mred${ESC}[0m plain`, `ab${CURSOR_MARKER}cd`], 20, 2);
		expect(frame.frame).toEqual(["red plain", "abcd"]);
		expect(frame.cursor).toEqual({ row: 1, col: 2 });
		expect(frame.backgroundColumns[0]).toEqual([0, 1, 2]);
		expect(frame.backgroundColumns[1]).toEqual([]);
	});

	it("resolves overlay layout anchors with margins", () => {
		expect(resolveExpectedOverlayLayout({ anchor: "bottom-right", margin: 1, width: 10 }, 3, 40, 10)).toEqual({
			width: 10,
			row: 6,
			col: 29,
			maxHeight: 8,
		});
	});

	it("composites overlay text by terminal columns", () => {
		expect(stripPlainTerminalText(compositeExpectedLineAt("abcdef", "XY", 2, 2, 6))).toBe("abXYef");
	});
});

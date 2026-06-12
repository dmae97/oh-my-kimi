import { describe, expect, it } from "bun:test";
import { parseSgrMouse } from "@oh-my-pi/pi-tui/mouse";

describe("parseSgrMouse", () => {
	it("returns null for non-mouse input", () => {
		expect(parseSgrMouse("a")).toBeNull();
		expect(parseSgrMouse("\x1b[A")).toBeNull();
		expect(parseSgrMouse("\x1b[<bogus")).toBeNull();
	});

	it("decodes left clicks with 0-based coordinates", () => {
		const event = parseSgrMouse("\x1b[<0;5;9M");
		expect(event).toEqual({
			button: 0,
			col: 4,
			row: 8,
			release: false,
			wheel: null,
			motion: false,
			leftClick: true,
		});
	});

	it("decodes releases as non-clicks", () => {
		const event = parseSgrMouse("\x1b[<0;5;9m");
		expect(event?.release).toBe(true);
		expect(event?.leftClick).toBe(false);
	});

	it("decodes wheel direction from the low button bit", () => {
		expect(parseSgrMouse("\x1b[<64;1;1M")?.wheel).toBe(-1);
		expect(parseSgrMouse("\x1b[<65;1;1M")?.wheel).toBe(1);
		expect(parseSgrMouse("\x1b[<65;1;1M")?.leftClick).toBe(false);
	});

	it("decodes motion reports without treating them as clicks", () => {
		const event = parseSgrMouse("\x1b[<35;10;3M");
		expect(event?.motion).toBe(true);
		expect(event?.leftClick).toBe(false);
		expect(event?.wheel).toBeNull();
	});
});

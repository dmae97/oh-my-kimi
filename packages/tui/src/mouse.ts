/**
 * SGR mouse report parsing (`\x1b[<button;col;rowM` / `…m`).
 *
 * Mouse tracking is enabled only while a fullscreen overlay holds the
 * alternate screen (see tui.ts MOUSE_TRACKING_ON), so consumers are
 * fullscreen components hit-testing against their own rendered frame:
 * the frame paints from screen row 0, hence `row`/`col` are exposed
 * 0-based for direct indexing into rendered lines.
 */

/** A decoded SGR mouse report. */
export interface SgrMouseEvent {
	/** Raw button code (bit 32 = motion, bit 64 = wheel, low bits = button). */
	button: number;
	/** 0-based column of the event. */
	col: number;
	/** 0-based row of the event. */
	row: number;
	/** True for a release report (`m` suffix). */
	release: boolean;
	/** Wheel direction: -1 up, 1 down, null when not a wheel event. */
	wheel: -1 | 1 | null;
	/** True when the pointer moved (hover or drag) rather than clicked. */
	motion: boolean;
	/** True for a left-button press (not motion, not release, not wheel). */
	leftClick: boolean;
}

/**
 * Decode an SGR mouse report, or return null when `data` is not one.
 * Callers on hot keypress paths should pre-check `data.startsWith("\x1b[<")`
 * before paying for the regex.
 */
export function parseSgrMouse(data: string): SgrMouseEvent | null {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (!match) return null;
	const button = Number(match[1]);
	const col = Number(match[2]) - 1;
	const row = Number(match[3]) - 1;
	const release = match[4] === "m";
	const wheel = button & 64 ? ((button & 1 ? 1 : -1) as 1 | -1) : null;
	const motion = (button & 32) !== 0 && wheel === null;
	const leftClick = !release && wheel === null && !motion && (button & 3) === 0;
	return { button, col, row, release, wheel, motion, leftClick };
}

/**
 * Implemented by components that accept routed mouse events at frame-local
 * coordinates. Hosts translate screen coordinates to the component's own
 * rendered lines before forwarding.
 */
export interface MouseRoutable {
	/** `line`/`col` are 0-based within the component's rendered output. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void;
}

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Real POSIX terminals (ghostty/macOS, where the bug was filmed) cannot probe
// scrollback position, so isNativeViewportAtBottom is undefined.
class UnknownViewportTerminal extends VirtualTerminal {
	isNativeViewportAtBottom(): undefined {
		return undefined;
	}
}

class MutableLinesComponent implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = [...lines];
	}
	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}
	invalidate(): void {}
	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(1);
	await term.flush();
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

function expectedViewport(lines: string[], height: number): string[] {
	const top = Math.max(0, lines.length - height);
	const slice = lines.slice(top, top + height);
	while (slice.length < height) slice.push("");
	return slice.map(line => line.trimEnd());
}

class Rng {
	#state: number;
	constructor(seed: number) {
		this.#state = seed >>> 0;
	}
	next(): number {
		this.#state = (this.#state + 0x6d2b79f5) >>> 0;
		let t = this.#state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	}
	int(min: number, max: number): number {
		return Math.floor(this.next() * (max - min + 1)) + min;
	}
}

// Build the transcript the way the coding agent lays it out: a prefix that
// holds completed chat + the active tool render (header that ticks, body that
// streams) + injected TTSR chips, followed by a STABLE footer
// (loader/todos/editor) that simply shifts down as content above it grows.
interface ModelState {
	headerTick: number;
	loaderTick: number;
	body: number; // count of streamed code lines
	chips: number; // count of injected chip rows
	completed: number; // count of completed chat rows above the tool (scrollback)
}

function buildTranscript(s: ModelState): string[] {
	const lines: string[] = [];
	for (let i = 0; i < s.completed; i++) lines.push(`done-${i}`);
	lines.push(`Write sketch.ts ${s.headerTick}s`);
	lines.push("(148 earlier lines)");
	for (let i = 0; i < s.body; i++) lines.push(`${149 + i}| code ${s.headerTick}.${i}`);
	for (let i = 0; i < s.chips; i++) lines.push(`chip-${i}-row`);
	lines.push(`Writing sketch generator (esc) ${s.loaderTick}`);
	lines.push("Todos");
	lines.push("> ");
	return lines;
}

describe("TTSR injection over active tool render (ghostty fuzz)", () => {
	let savedRisk: boolean;
	beforeEach(() => {
		let monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
		// ghostty reports an ED3-clears-scrollback risk.
		savedRisk = TERMINAL.eagerEraseScrollbackRisk;
		(TERMINAL as unknown as { eagerEraseScrollbackRisk: boolean }).eagerEraseScrollbackRisk = true;
	});
	afterEach(() => {
		(TERMINAL as unknown as { eagerEraseScrollbackRisk: boolean }).eagerEraseScrollbackRisk = savedRisk;
		vi.restoreAllMocks();
	});

	it("fuzzes streaming + chip injection and checks the viewport stays consistent", async () => {
		const failures: string[] = [];
		const seeds = Array.from({ length: 16 }, (_v, i) => 0x1000 + i * 0x777);
		for (const height of [8, 12, 20]) {
			for (const seed of seeds) {
				const rng = new Rng(seed ^ (height << 16));
				const term = new UnknownViewportTerminal(64, height);
				const tui = new TUI(term);
				const state: ModelState = { headerTick: 0, loaderTick: 0, body: 3, chips: 0, completed: 6 };
				const component = new MutableLinesComponent(buildTranscript(state));
				tui.addChild(component);
				let stepLog = `seed=${seed.toString(16)} h=${height}`;
				try {
					tui.start();
					// Foreground tool active => eager rebuild requested.
					tui.setEagerNativeScrollbackRebuild(true);
					await settle(term);
					for (let step = 0; step < 60; step++) {
						const roll = rng.int(0, 99);
						if (roll < 30) {
							// tick header + loader (the common streaming heartbeat)
							state.headerTick++;
							state.loaderTick++;
						} else if (roll < 45) {
							// stream more body (preview window grows)
							state.body += rng.int(1, 3);
							state.headerTick++;
						} else if (roll < 55 && state.body > 1) {
							state.body -= 1; // preview window scrolls/caps
						} else if (roll < 70 && state.chips === 0) {
							// inject TTSR chips mid-stream (each chip ~4 rows)
							state.chips = rng.int(1, 4) * 4;
							state.headerTick++;
							state.loaderTick++;
						} else if (roll < 78 && state.chips > 0) {
							state.chips += 4; // another rule injected
						} else if (roll < 85) {
							state.completed += rng.int(1, 4); // a finished message lands above
						} else if (roll < 92) {
							term.scrollLines(-rng.int(1, height));
						} else {
							term.scrollLines(1_000_000); // back to bottom
						}
						component.setLines(buildTranscript(state));
						const forced = roll >= 92;
						tui.requestRender(forced);
						await settle(term);
						// Snap back to bottom for the viewport assertion (a scrolled
						// reader legitimately shows history; we only check the live tail).
						term.scrollLines(1_000_000);
						await settle(term);

						const got = visible(term);
						const want = expectedViewport(buildTranscript(state), height);
						stepLog += `\n  step ${step} roll=${roll} chips=${state.chips} body=${state.body} done=${state.completed}`;
						if (JSON.stringify(got) !== JSON.stringify(want)) {
							failures.push(
								`${stepLog}\n  GOT =${JSON.stringify(got)}\n  WANT=${JSON.stringify(want)}`,
							);
							break;
						}
					}
				} finally {
					tui.stop();
				}
				if (failures.length >= 5) break;
			}
			if (failures.length >= 5) break;
		}
		if (failures.length > 0) {
			console.log(`\n=== ${failures.length} FAILURES ===\n${failures.slice(0, 3).join("\n\n")}`);
		}
		expect(failures).toEqual([]);
	}, 60_000);
});

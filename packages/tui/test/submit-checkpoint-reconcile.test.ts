import { describe, expect, it } from "bun:test";
import { type Component, setTerminalSubmitPinsViewportToTail, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// The prompt-submit reconciliation checkpoint (`refreshNativeScrollbackIfDirty`)
// must ED3-rebuild deferred-dirty native scrollback on genuine local terminals,
// where the submit keystroke pins the host to its tail, even though their viewport
// position is unprobeable (ghostty/kitty/iTerm report `undefined`). Without this,
// every offscreen shrink/edit that defers during streaming leaves stale rows above
// the viewport that never clear until Ctrl+L or a resize. Hosts that cannot prove
// at-tail (Windows console/Terminal, SSH, multiplexers — modeled here by
// submitPinsViewportToTail=false) keep deferring so a scrolled reader is never
// yanked by ED3 (#1610/#1682/#1746).

class LineList implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = [...lines];
	}
	invalidate(): void {}
	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const tick = Promise.withResolvers<void>();
	process.nextTick(tick.resolve);
	await tick.promise;
	await Bun.sleep(20);
	await term.flush();
}

function capture(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	(term as unknown as { write: (s: string) => void }).write = (data: string) => {
		writes.push(data);
		realWrite(data);
	};
	return writes;
}

function overrideProbe(term: VirtualTerminal, answer: boolean | undefined): void {
	(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () => answer;
}

const eraseScrollbackCount = (writes: string[]): number => (writes.join("").match(/\x1b\[3J/g) ?? []).length;

interface CheckpointResult {
	deferredErases: number;
	reconciled: boolean;
	checkpointErases: number;
	viewport: string[];
}

// Drive an ED3-risk terminal with an unprobeable viewport through an eager-stream
// offscreen shrink (which defers, marking native scrollback dirty without erasing)
// and then the prompt-submit checkpoint, returning what each step emitted.
async function deferThenCheckpoint(submitPinsViewportToTail: boolean): Promise<CheckpointResult> {
	const savedRisk = TERMINAL.eagerEraseScrollbackRisk;
	const savedPins = TERMINAL.submitPinsViewportToTail;
	// RuntimeTerminal exposes these as writable — no cast needed.
	TERMINAL.eagerEraseScrollbackRisk = true;
	setTerminalSubmitPinsViewportToTail(submitPinsViewportToTail);
	const term = new VirtualTerminal(80, 12);
	overrideProbe(term, undefined);
	const tui = new TUI(term);
	const component = new LineList(Array.from({ length: 60 }, (_value, index) => `init-${index}`));
	tui.addChild(component);
	try {
		tui.start();
		await settle(term);
		const writes = capture(term);
		tui.setEagerNativeScrollbackRebuild(true);

		// Offscreen shrink: repaints the visible window in place and marks native
		// scrollback dirty instead of erasing (the deferral that strands stale rows).
		component.setLines(Array.from({ length: 4 }, (_value, index) => `done-${index}`));
		tui.requestRender();
		await settle(term);
		const deferredErases = eraseScrollbackCount(writes);

		const reconciled = tui.refreshNativeScrollbackIfDirty();
		await settle(term);
		return {
			deferredErases,
			reconciled,
			checkpointErases: eraseScrollbackCount(writes),
			viewport: term.getViewport().map(line => line.trim()),
		};
	} finally {
		tui.stop();
		TERMINAL.eagerEraseScrollbackRisk = savedRisk;
		setTerminalSubmitPinsViewportToTail(savedPins);
	}
}

describe("submit-checkpoint native scrollback reconciliation", () => {
	it("reconciles deferred scrollback at the checkpoint when submit pins the host to its tail", async () => {
		const result = await deferThenCheckpoint(true);
		expect(result.deferredErases).toBe(0);
		expect(result.reconciled).toBe(true);
		expect(result.checkpointErases).toBeGreaterThan(0);
		expect(result.viewport).toContain("done-3");
	});

	it("keeps deferring at the checkpoint when the host cannot prove at-tail", async () => {
		const result = await deferThenCheckpoint(false);
		expect(result.deferredErases).toBe(0);
		expect(result.reconciled).toBe(false);
		expect(result.checkpointErases).toBe(0);
	});
});

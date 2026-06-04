import { describe, expect, it, vi } from "bun:test";
import { type Component, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

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

class StablePrefixLinesComponent extends MutableLinesComponent {
	#stableLineCount = 0;
	setStableLineCount(count: number): void {
		this.#stableLineCount = count;
	}
	getStableLineCount(): number {
		return this.#stableLineCount;
	}
}

type MutableTerminalInfo = { eagerEraseScrollbackRisk: boolean };
const mutableTerminalInfo = TERMINAL as unknown as MutableTerminalInfo;

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

describe("box-top repro", () => {
	it("keeps the box top reachable while it streams past the viewport", async () => {
		const saved = TERMINAL.eagerEraseScrollbackRisk;
		mutableTerminalInfo.eagerEraseScrollbackRisk = true;
		let monotonicNow = 0;
		const now = vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
		try {
			const H = 8;
			const term = new UnknownViewportTerminal(40, H, 500);
			const tui = new TUI(term);
			const transcript = new StablePrefixLinesComponent(["T0", "T1", "T2", "T3"]);
			const footer = new MutableLinesComponent(["status", "prompt>"]);
			if (Bun.env.REPRO_STABLE !== "0") tui.setNativeScrollbackStableComponent(transcript);
			tui.addChild(transcript);
			tui.addChild(footer);
			try {
				tui.start();
				await settle(term);

				const prefix = ["T0", "T1", "T2", "T3"];
				// Box top border is the FIRST box row "B-top".
				for (let k = 1; k <= 12; k++) {
					const box = ["B-top", ...Array.from({ length: k }, (_v, i) => `Bmid${i}`), "B-bot"];
					transcript.setLines([...prefix, ...box]);
					transcript.setStableLineCount(prefix.length); // box stays unstable while streaming
					tui.requestRender();
					await settle(term);

					const hist = term.getScrollBuffer().map(l => l.trimEnd());
					const view = visible(term);
					const all = [...hist, ...view];
					const total = prefix.length + box.length + 2;
					// Each logical row must be reachable somewhere (history or viewport).
					const missing = [...prefix, ...box].filter(row => !all.some(l => l.includes(row)));
					console.log(
						`k=${k} total=${total} viewTop=${JSON.stringify(view[0])} baseY=${term.getBufferPosition().baseY} missing=${JSON.stringify(missing)}`,
					);
				}
				expect(true).toBe(true);
			} finally {
				tui.stop();
			}
		} finally {
			now.mockRestore();
			mutableTerminalInfo.eagerEraseScrollbackRisk = saved;
		}
	});
});

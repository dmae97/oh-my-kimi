import { describe, expect, it, spyOn } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { Loader } from "@oh-my-pi/pi-tui/components/loader";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { VirtualTerminal } from "./virtual-terminal";

describe("Loader component", () => {
	it("clamps rendered lines to terminal width", async () => {
		const term = new VirtualTerminal(1, 4);
		const tui = new TUI(term);
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Checking",
			["⠸"],
		);
		tui.addChild(loader);

		tui.start();
		await Bun.sleep(0);
		await term.flush();

		for (const line of term.getViewport()) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(1);
		}

		loader.stop();
		tui.stop();
	});

	it("dispose() stops the animation so no further renders are scheduled", async () => {
		const term = new VirtualTerminal(20, 4);
		const tui = new TUI(term);
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Checking",
			["a", "b", "c"],
		);
		const spy = spyOn(tui, "requestRender");
		loader.dispose();
		const after = spy.mock.calls.length;
		await Bun.sleep(40); // longer than the spinner interval
		expect(spy.mock.calls.length).toBe(after);
		expect(() => loader.dispose()).not.toThrow(); // idempotent
		tui.stop();
	});
});

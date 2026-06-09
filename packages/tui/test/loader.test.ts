import { afterEach, describe, expect, it, setSystemTime, spyOn, vi } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { Loader, type LoaderMessageColorFn } from "@oh-my-pi/pi-tui/components/loader";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { VirtualTerminal } from "./virtual-terminal";

describe("Loader component", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

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

	it("keeps spinner cadence when animated messages repaint at 30fps", () => {
		vi.useFakeTimers();
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const colorMessage = ((text: string) => text) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui, text => text, colorMessage, "Checking", ["0", "1", "2", "3"]);

		vi.advanceTimersByTime(170);

		expect(loader.render(20).join("\n")).toContain("2 Checking");
		loader.stop();
	});

	it("skips animated render requests when composed text is unchanged before the spinner advances", () => {
		vi.useFakeTimers();
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const colorMessage = ((text: string) => text) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui, text => text, colorMessage, "Checking", ["0", "1"]);

		expect(ui.requestRender).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(34);
		expect(ui.requestRender).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(67);
		expect(ui.requestRender).toHaveBeenCalledTimes(2);
		expect(loader.render(20).join("\n")).toContain("1 Checking");

		loader.stop();
	});

	it("requests render for message changes but not repeated identical messages", () => {
		vi.useFakeTimers();
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const loader = new Loader(
			ui,
			text => text,
			text => text,
			"Checking",
			["0"],
		);

		expect(ui.requestRender).toHaveBeenCalledTimes(1);

		loader.setMessage("Still checking");
		expect(ui.requestRender).toHaveBeenCalledTimes(2);
		expect(loader.render(30).join("\n")).toContain("0 Still checking");

		loader.setMessage("Still checking");
		expect(ui.requestRender).toHaveBeenCalledTimes(2);

		loader.stop();
	});

	it("requests render when animated message bytes change between spinner frames", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const colorMessage = ((text: string) => `${text}-${Date.now()}`) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui, text => text, colorMessage, "Checking", ["0"]);

		expect(ui.requestRender).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(34);
		expect(ui.requestRender).toHaveBeenCalledTimes(2);
		expect(loader.render(40).join("\n")).toContain("0 Checking-");

		loader.stop();
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

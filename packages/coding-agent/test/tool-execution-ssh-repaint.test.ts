import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

function sshResult(text: string) {
	return { content: [{ type: "text", text }] };
}

class Footer implements Component {
	constructor(readonly rows: number) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return Array.from({ length: this.rows }, (_, i) => `editor-${i}`);
	}
}

function plainBuffer(term: VirtualTerminal): string[] {
	return term
		.getScrollBuffer()
		.map(row => Bun.stripANSI(row).trimEnd())
		.filter(Boolean);
}

async function drain(scheduler: StressRenderScheduler, term: VirtualTerminal): Promise<void> {
	await scheduler.drain(term);
}

describe("ToolExecutionComponent SSH repaint seams", () => {
	const components: ToolExecutionComponent[] = [];

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		for (const component of components) component.stopAnimation();
		components.length = 0;
		vi.restoreAllMocks();
	});

	function makeComponent(args: unknown) {
		const resetDisplay = vi.fn();
		const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay } as unknown as TUI;
		const component = new ToolExecutionComponent("ssh", args, {}, undefined, ui);
		components.push(component);
		resetDisplay.mockClear();
		return { component, resetDisplay };
	}

	it("forces a viewport repaint when a painted streamed SSH placeholder receives its first result", () => {
		const { component, resetDisplay } = makeComponent({ __partialJson: '{"host"' });
		// A paint has to land for the placeholder to actually reach the terminal.
		component.render(80);

		component.updateResult(sshResult("partial output"), true);

		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not repaint when the streamed placeholder never reaches the terminal", () => {
		const { component, resetDisplay } = makeComponent({ __partialJson: '{"host"' });
		// The placeholder shape was built in memory but never painted — a
		// resetDisplay here would wipe scrollback for a shape the user never saw.

		component.updateResult(sshResult("partial output"), true);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("does not repaint complete SSH args on the first result", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.render(80);

		component.updateResult(sshResult("partial output"), true);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("forces a viewport repaint when a painted provisional SSH partial result settles", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(sshResult("partial output"), true);
		component.render(80);
		resetDisplay.mockClear();

		component.updateResult(sshResult("final output"), false);

		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not repaint when the provisional partial result never reaches the terminal", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(sshResult("partial output"), true);
		// No render() between the partial and the final update — the provisional
		// frame never reached the terminal, so no reset should fire.

		component.updateResult(sshResult("final output"), false);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("removes streamed SSH placeholder rows from the terminal buffer when the first result arrives", async () => {
		const term = new VirtualTerminal(90, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const component = new ToolExecutionComponent("ssh", { __partialJson: '{"host"' }, {}, undefined, tui);
		components.push(component);
		tui.addChild(component);
		tui.addChild(new Footer(5));

		try {
			tui.start();
			await drain(scheduler, term);
			expect(plainBuffer(term).some(row => row.includes("SSH: […]"))).toBe(true);
			expect(plainBuffer(term).some(row => row.includes("$ …"))).toBe(true);

			component.updateArgs({
				host: "router",
				command: "uptime",
				__partialJson: '{"host":"router","command":"uptime"}',
			});
			component.setArgsComplete();
			tui.requestRender();
			await drain(scheduler, term);

			component.updateResult(sshResult("partial output"), true);
			tui.requestRender();
			await drain(scheduler, term);

			const rows = plainBuffer(term);
			expect(rows.some(row => row.includes("SSH: […]"))).toBe(false);
			expect(rows.some(row => row.includes("$ …"))).toBe(false);
			expect(rows.some(row => row.includes("⏳ SSH: [router]"))).toBe(true);
			expect(rows.some(row => row.includes("Output"))).toBe(true);
			expect(rows.some(row => row.includes("partial output"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("removes provisional SSH partial chrome from the terminal buffer when the result settles", async () => {
		const term = new VirtualTerminal(90, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const component = new ToolExecutionComponent("ssh", { host: "router", command: "uptime" }, {}, undefined, tui);
		components.push(component);
		tui.addChild(component);
		tui.addChild(new Footer(5));

		try {
			tui.start();
			await drain(scheduler, term);
			component.updateResult(sshResult("partial output"), true);
			tui.requestRender();
			await drain(scheduler, term);
			const partialRows = plainBuffer(term);
			expect(partialRows.some(row => row.includes("SSH: [router]"))).toBe(true);
			expect(partialRows.some(row => row.includes("partial output"))).toBe(true);

			component.updateResult(sshResult("final output"), false);
			tui.requestRender();
			await drain(scheduler, term);

			const rows = plainBuffer(term);
			expect(rows.some(row => row.includes("partial output"))).toBe(false);
			expect(rows.filter(row => row.includes("SSH: [router]"))).toHaveLength(1);
			expect(rows.some(row => row.includes("Output"))).toBe(true);
			expect(rows.some(row => row.includes("final output"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

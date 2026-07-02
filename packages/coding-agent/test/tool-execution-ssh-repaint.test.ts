import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

function sshResult(text: string) {
	return { content: [{ type: "text", text }] };
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
		const ui = { requestRender() {}, resetDisplay } as unknown as TUI;
		const component = new ToolExecutionComponent("ssh", args, {}, undefined, ui);
		components.push(component);
		resetDisplay.mockClear();
		return { component, resetDisplay };
	}

	it("forces a viewport repaint when a streamed SSH placeholder receives its first result", () => {
		const { component, resetDisplay } = makeComponent({ __partialJson: '{"host"' });

		component.updateResult(sshResult("partial output"), true);

		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not repaint complete SSH args on the first result", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });

		component.updateResult(sshResult("partial output"), true);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("forces a viewport repaint when a provisional SSH partial result settles", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(sshResult("partial output"), true);
		resetDisplay.mockClear();

		component.updateResult(sshResult("final output"), false);

		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});
});

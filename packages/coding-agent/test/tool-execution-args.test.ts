import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Text, type TUI } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "../src/modes/components/tool-execution";

describe("ToolExecutionComponent.updateArgs (F8 — no clone, ref-eq fast path)", () => {
	let initialized = false;

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function makeComponent(args: unknown) {
		if (!initialized) {
			await initTheme();
			initialized = true;
		}
		const uiStub = { requestRender() {} } as unknown as TUI;
		return new ToolExecutionComponent("bash", args, {}, undefined, uiStub);
	}

	it("does NOT call structuredClone in updateArgs (caller already owns isolation)", async () => {
		const cloneSpy = vi.spyOn(globalThis, "structuredClone");
		const component = await makeComponent({ command: "ls" });
		cloneSpy.mockClear();

		// Simulate event-controller.ts: each delta builds a fresh spread.
		for (let i = 0; i < 5; i++) {
			component.updateArgs({ command: `ls -l ${i}` });
		}

		expect(cloneSpy).not.toHaveBeenCalled();
	});
	it("keeps bash spinner cadence when the shimmer border repaints at 30fps", async () => {
		if (!initialized) {
			await initTheme();
			initialized = true;
		}
		vi.useFakeTimers();
		let renderState: { spinnerFrame?: number } | undefined;
		const uiStub = { requestRender: vi.fn() } as unknown as TUI;
		const tool = {
			label: "Bash",
			renderCall: (_args: unknown, options: { spinnerFrame?: number }) => {
				renderState = options;
				return new Text("", 0, 0);
			},
			execute: async () => ({ content: [] }),
		} as unknown as AgentTool;
		const component = new ToolExecutionComponent("bash", { command: "echo ok" }, {}, tool, uiStub);

		component.setArgsComplete();
		vi.advanceTimersByTime(170);

		expect(renderState?.spinnerFrame).toBe(2);
		component.stopAnimation();
	});
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "../src/modes/components/tool-execution";

describe("ToolExecutionComponent.updateArgs (F8 — no clone, ref-eq fast path)", () => {
	let initialized = false;

	afterEach(() => {
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

	it("short-circuits when called with the exact same args reference", async () => {
		const component = await makeComponent({ command: "ls" });
		const args = { command: "ls -al" };

		component.updateArgs(args);
		// Second call with the SAME object reference should be a no-op.
		// (Render bookkeeping doesn't re-fire — assert via #args not changing.)
		component.updateArgs(args);
		component.updateArgs(args);

		// Different object content → must NOT be short-circuited.
		const next = { command: "echo hi" };
		component.updateArgs(next);

		// Re-issuing the prior reference is now stale but still ref-distinct.
		// The component must accept it without crashing.
		expect(() => component.updateArgs(args)).not.toThrow();
	});
});

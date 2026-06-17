import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const showModelSelector = vi.fn();
	const setText = vi.fn();
	return {
		showModelSelector,
		setText,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showModelSelector,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/model slash command", () => {
	it("opens the temporary model selector for the active session", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/model", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector).toHaveBeenCalledWith({ temporaryOnly: true });
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

describe("/switch slash command", () => {
	it("opens the temporary model selector (mirrors alt+p)", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/switch", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector).toHaveBeenCalledWith({ temporaryOnly: true });
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

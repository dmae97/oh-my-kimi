import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime(didRetry: boolean) {
	const retry = vi.fn(async () => didRetry);
	const showStatus = vi.fn();
	const setText = vi.fn();
	return {
		retry,
		showStatus,
		setText,
		runtime: {
			ctx: {
				session: { retry } as unknown as InteractiveModeContext["session"],
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showStatus,
			} as unknown as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		},
	};
}

describe("/retry slash command", () => {
	it("clears the editor after starting a retry", async () => {
		const harness = createRuntime(true);

		const handled = await executeBuiltinSlashCommand("/retry", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.retry).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("reports when there is no failed turn to retry", async () => {
		const harness = createRuntime(false);

		const handled = await executeBuiltinSlashCommand("/retry", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.retry).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).toHaveBeenCalledWith("Nothing to retry");
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleTanCommand = vi.fn(async () => {});
	const setText = vi.fn();
	return {
		handleTanCommand,
		setText,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				handleTanCommand,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/tan slash command", () => {
	it("routes the full work item through the tan handler", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/tan add a changelog note", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleTanCommand).toHaveBeenCalledWith("add a changelog note");
	});

	it("preserves the raw multi-word suffix after /tan", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand(
			"/tan    investigate why prompt cache reuse matters here",
			harness.runtime,
		);

		expect(handled).toBe(true);
		expect(harness.handleTanCommand).toHaveBeenCalledWith("investigate why prompt cache reuse matters here");
	});
});

import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleBtwCommand = vi.fn(async () => {});
	const setText = vi.fn();
	const addToHistory = vi.fn();
	return {
		handleBtwCommand,
		setText,
		addToHistory,
		runtime: {
			ctx: {
				editor: { setText, addToHistory } as unknown as InteractiveModeContext["editor"],
				handleBtwCommand,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/btw slash command", () => {
	it("routes the full question through the interactive btw handler", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/btw why is it doing that?", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.addToHistory).toHaveBeenCalledWith("/btw why is it doing that?");
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleBtwCommand).toHaveBeenCalledWith("why is it doing that?");
	});

	it("preserves the raw multi-word suffix after /btw", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand(
			"/btw    explain why the cache reuse matters here",
			harness.runtime,
		);

		expect(handled).toBe(true);
		expect(harness.addToHistory).toHaveBeenCalledWith("/btw    explain why the cache reuse matters here");
		expect(harness.handleBtwCommand).toHaveBeenCalledWith("explain why the cache reuse matters here");
	});

	it("does not add a blank /btw invocation to history", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/btw   ", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.addToHistory).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleBtwCommand).toHaveBeenCalledWith("");
	});
});

import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntimeHarness(overrides?: { setForcedToolChoice?: (toolName: string) => void }) {
	const setForcedToolChoice = vi.fn(overrides?.setForcedToolChoice ?? ((_toolName: string) => {}));
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();

	const ctx = {
		editor: { setText } as unknown as InteractiveModeContext["editor"],
		session: { setForcedToolChoice } as unknown as InteractiveModeContext["session"],
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;

	return {
		runtime: {
			ctx,
			handleBackgroundCommand: () => {},
		},
		setForcedToolChoice,
		setText,
		showStatus,
		showError,
	};
}

describe("/force slash command", () => {
	it("forces the next round tool with colon syntax", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/force:write", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setForcedToolChoice).toHaveBeenCalledWith("write");
		expect(harness.showStatus).toHaveBeenCalledWith("Next turn forced to use write.");
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("shows usage when tool name is missing", async () => {
		const harness = createRuntimeHarness();

		const handled = await executeBuiltinSlashCommand("/force", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setForcedToolChoice).not.toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalledWith("Usage: /force:<tool-name> [prompt]");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("returns remaining prompt text when provided after tool name", async () => {
		const harness = createRuntimeHarness();

		const result = await executeBuiltinSlashCommand("/force:write fix the tests", harness.runtime);

		expect(result).toBe("fix the tests");
		expect(harness.setForcedToolChoice).toHaveBeenCalledWith("write");
		expect(harness.showStatus).toHaveBeenCalledWith("Next turn forced to use write.");
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("forces tool with space syntax", async () => {
		const harness = createRuntimeHarness();

		const result = await executeBuiltinSlashCommand("/force write", harness.runtime);

		expect(result).toBe(true);
		expect(harness.setForcedToolChoice).toHaveBeenCalledWith("write");
	});

	it("returns remaining prompt with space syntax", async () => {
		const harness = createRuntimeHarness();

		const result = await executeBuiltinSlashCommand("/force write fix the tests", harness.runtime);

		expect(result).toBe("fix the tests");
		expect(harness.setForcedToolChoice).toHaveBeenCalledWith("write");
	});

	it("surfaces session validation errors", async () => {
		const harness = createRuntimeHarness({
			setForcedToolChoice: () => {
				throw new Error('Tool "write" is not currently active.');
			},
		});

		const handled = await executeBuiltinSlashCommand("/force:write", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showError).toHaveBeenCalledWith('Tool "write" is not currently active.');
		expect(harness.showStatus).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("does not pass through prompt when tool validation fails", async () => {
		const harness = createRuntimeHarness({
			setForcedToolChoice: () => {
				throw new Error('Tool "write" is not currently active.');
			},
		});

		const result = await executeBuiltinSlashCommand("/force:write fix stuff", harness.runtime);

		expect(result).toBe(true);
		expect(harness.showError).toHaveBeenCalledWith('Tool "write" is not currently active.');
	});
});

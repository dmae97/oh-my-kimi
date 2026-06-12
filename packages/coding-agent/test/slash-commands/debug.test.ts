import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { clearNextRequestDebugPath, getNextRequestDebugPath } from "@oh-my-pi/pi-ai/utils/request-debug";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntimeHarness(cwd: string) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showDebugSelector = vi.fn();
	return {
		setText,
		showStatus,
		showDebugSelector,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				sessionManager: { getCwd: () => cwd } as unknown as InteractiveModeContext["sessionManager"],
				showStatus,
				showDebugSelector,
			} as unknown as InteractiveModeContext,
		},
	};
}

afterEach(() => {
	clearNextRequestDebugPath();
});

describe("/debug slash command", () => {
	it("opens the debug selector without arguments", async () => {
		const harness = createRuntimeHarness(path.join(os.tmpdir(), "omp-debug-cwd"));

		expect(await executeBuiltinSlashCommand("/debug", harness.runtime)).toBe(true);

		expect(harness.showDebugSelector).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(getNextRequestDebugPath()).toBeUndefined();
	});

	it("arms a one-shot provider request dump path", async () => {
		const cwd = path.join(os.tmpdir(), "omp-debug-cwd");
		const harness = createRuntimeHarness(cwd);
		const expectedPath = path.resolve(cwd, "request.json");

		expect(await executeBuiltinSlashCommand("/debug dump-next-request request.json", harness.runtime)).toBe(true);

		expect(harness.showDebugSelector).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith(`Next AI provider request will be dumped to ${expectedPath}`);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(getNextRequestDebugPath()).toBe(expectedPath);
	});
});

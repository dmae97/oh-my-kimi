import { afterEach, describe, expect, it, vi } from "bun:test";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function createContext() {
	const setEagerNativeScrollbackRebuild = vi.fn();
	const pendingTools = new Map<string, unknown>();
	const ctx = {
		isInitialized: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		pendingTools,
		ui: { setEagerNativeScrollbackRebuild, requestRender: vi.fn() },
	} as unknown as InteractiveModeContext;
	return { ctx, pendingTools, setEagerNativeScrollbackRebuild };
}

// A tool_execution_update for an id that is not pending is a no-op in its handler,
// so dispatching it exercises only the gated post-dispatch refresh in handleEvent —
// which is what syncs the TUI eager-rebuild flag to foreground-tool activity.
const REFRESH_TRIGGER = {
	type: "tool_execution_update",
	toolCallId: "not-pending",
	partialResult: { content: [], details: {} },
} as unknown as AgentSessionEvent;

describe("EventController tool render mode", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("enables eager native scrollback rebuild while a foreground tool is pending", async () => {
		const { ctx, pendingTools, setEagerNativeScrollbackRebuild } = createContext();
		const controller = new EventController(ctx);

		pendingTools.set("call-1", {});
		await controller.handleEvent(REFRESH_TRIGGER);
		expect(setEagerNativeScrollbackRebuild).toHaveBeenLastCalledWith(true);

		pendingTools.clear();
		await controller.handleEvent(REFRESH_TRIGGER);
		expect(setEagerNativeScrollbackRebuild).toHaveBeenLastCalledWith(false);
	});
});

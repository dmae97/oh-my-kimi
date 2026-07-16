/**
 * Regression test for the abort-guard on `EventController.sendCompletionNotification`.
 *
 * Bug: a user Ctrl+C on the `ask` tool selector throws `ToolAbortError`,
 * the turn ends with `stopReason === "aborted"`, and `#handleAgentEnd`
 * fires `sendCompletionNotification()`. Without a guard this produced a
 * misleading "Task complete" desktop toast for a turn that never actually
 * completed. The fix mirrors the `stopReason !== "aborted"` pattern already
 * used by `#currentContextTokens`, `#handleMessageEnd`, and the
 * retry / TTSR / compaction skip paths in `agent-session.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { TERMINAL } from "@oh-my-pi/pi-tui";

const originalWarpProtocolVersion = process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;

function restoreWarpProtocolEnvironment(): void {
	if (originalWarpProtocolVersion === undefined) {
		delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
	} else {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = originalWarpProtocolVersion;
	}
}

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	// Neutral baseline for notification gates; afterEach restores the suite's inherited value.
	delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-abortguard-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	restoreWarpProtocolEnvironment();
});

type StopReason = "stop" | "aborted" | "error";

function makeAssistantMessage(stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		stopReason,
		usage: { inputTokens: 0, outputTokens: 0 },
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function makeContext(lastMessage: AssistantMessage | undefined): InteractiveModeContext {
	const sessionMock = {
		getLastAssistantMessage: () => lastMessage,
	};
	return {
		sessionManager: {
			getSessionName: () => "test-session",
		},
		session: sessionMock,
		viewSession: sessionMock,
	} as unknown as InteractiveModeContext;
}

describe("EventController.sendCompletionNotification — abort guard", () => {
	it("skips notification when the last assistant message stopReason === 'aborted'", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		const controller = new EventController(makeContext(makeAssistantMessage("aborted")));
		controller.sendCompletionNotification();
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("skips notification when the last assistant message stopReason === 'error'", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		const controller = new EventController(makeContext(makeAssistantMessage("error")));
		controller.sendCompletionNotification();
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("fires notification when stopReason === 'stop' (normal completion)", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		const controller = new EventController(makeContext(makeAssistantMessage("stop")));
		controller.sendCompletionNotification();
		expect(spy).toHaveBeenCalledTimes(1);
		// Completion now sends a structured notification (title=session, body="Complete").
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ body: "Complete", type: "completion" }));
	});

	it("fires notification when getLastAssistantMessage is absent (e.g. brand-new session)", () => {
		// Defensive: optional-chain `?.()` returns undefined; treat as 'no abort flag', proceed.
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		const controller = new EventController(makeContext(undefined));
		controller.sendCompletionNotification();
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("honors the existing completion.notify=off gate", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "off");
		const controller = new EventController(makeContext(makeAssistantMessage("stop")));
		controller.sendCompletionNotification();
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("skips legacy completion notify when Warp CLI-agent protocol is active", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
		const controller = new EventController(makeContext(makeAssistantMessage("stop")));
		controller.sendCompletionNotification();
		expect(spy).toHaveBeenCalledTimes(0);
	});
});

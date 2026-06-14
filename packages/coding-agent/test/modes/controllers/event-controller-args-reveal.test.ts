/**
 * Contract: while a tool call's arguments stream (`partialJson` still open),
 * the pending tool preview is paced by ToolArgsRevealController — frames carry
 * growing prefixes of the raw stream re-parsed into display args — and once
 * the JSON closes the final parsed arguments render as-is (snap), mirroring
 * how assistant text snaps at message_end.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { STREAMING_REVEAL_FRAME_MS } from "@oh-my-pi/pi-coding-agent/modes/controllers/streaming-reveal";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

beforeAll(async () => {
	await initTheme();
});

function makeStreamingMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function createFixture(streamingMessage: AssistantMessage) {
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn() },
		settings,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		streamingComponent: { updateContent: vi.fn(), markTranscriptBlockFinalized: vi.fn() },
		streamingMessage,
		pendingTools,
		chatContainer: { addChild: vi.fn() },
		toolOutputExpanded: false,
		session: { getToolByName: () => undefined },
		viewSession: { getToolByName: () => undefined },
		sessionManager: { getCwd: () => process.cwd() },
	} as unknown as InteractiveModeContext;

	return { controller: new EventController(ctx), pendingTools };
}

async function dispatch(controller: EventController, message: AssistantMessage) {
	const event = {
		type: "message_update",
		message,
		assistantMessageEvent: undefined as never,
	} as Extract<AgentSessionEvent, { type: "message_update" }>;
	await controller.handleEvent(event);
}

describe("EventController paces streamed tool args", () => {
	afterEach(() => {
		vi.useRealTimers();
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("reveals partialJson prefixes per frame, then snaps to final args when the JSON closes", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		vi.useFakeTimers();
		const updateArgsSpy = vi.spyOn(ToolExecutionComponent.prototype, "updateArgs");
		const content = "x".repeat(400);
		const target = `{"path":"/tmp/a.ts","content":"${content}"}`;
		const streaming = makeStreamingMessage([
			{ type: "toolCall", id: "tc-1", name: "write", arguments: {}, partialJson: target } as never,
		]);
		const { controller, pendingTools } = createFixture(streaming);

		await dispatch(controller, streaming);
		expect(pendingTools.size).toBe(1);

		for (let i = 0; i < 3; i++) {
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}
		const pacedFrames = updateArgsSpy.mock.calls.map(call => call[0] as Record<string, unknown>);
		expect(pacedFrames.length).toBeGreaterThan(0);
		let previousLength = 0;
		for (const frame of pacedFrames) {
			const prefix = frame.__partialJson;
			if (typeof prefix !== "string") throw new Error("Expected __partialJson string on paced frame");
			expect(target.startsWith(prefix)).toBe(true);
			expect(prefix.length).toBeLessThan(target.length);
			expect(prefix.length).toBeGreaterThanOrEqual(previousLength);
			previousLength = prefix.length;
		}

		// The JSON closed: providers drop `partialJson` and deliver final args.
		const finalArgs = { path: "/tmp/a.ts", content };
		await dispatch(
			controller,
			makeStreamingMessage([{ type: "toolCall", id: "tc-1", name: "write", arguments: finalArgs }]),
		);
		expect(updateArgsSpy.mock.calls.at(-1)?.[0]).toBe(finalArgs);

		// The reveal entry is gone: no further paced frames tick in.
		const calls = updateArgsSpy.mock.calls.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 5);
		expect(updateArgsSpy.mock.calls.length).toBe(calls);
	});

	it("streams the full target through unpaced when smoothing is disabled", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		settings.set("display.smoothStreaming", false);
		vi.useFakeTimers();
		const updateArgsSpy = vi.spyOn(ToolExecutionComponent.prototype, "updateArgs");
		const target = `{"path":"/tmp/a.ts","content":"abc"}`;
		const streaming = makeStreamingMessage([
			{
				type: "toolCall",
				id: "tc-1",
				name: "write",
				arguments: { path: "/tmp/a.ts" },
				partialJson: target,
			} as never,
		]);
		const { controller } = createFixture(streaming);

		await dispatch(controller, streaming);
		await dispatch(controller, streaming);

		const frame = updateArgsSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(frame.__partialJson).toBe(target);
		const calls = updateArgsSpy.mock.calls.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 5);
		expect(updateArgsSpy.mock.calls.length).toBe(calls);
	});
});

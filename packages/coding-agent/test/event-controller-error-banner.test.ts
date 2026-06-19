/**
 * EventController error-banner wiring.
 *
 * A turn that ends on a provider error (e.g. Anthropic's "Output blocked by
 * content filtering policy") must pin a persistent banner above the editor via
 * `ctx.showPinnedError`, and the banner must be cleared at the next turn's
 * `agent_start` via `ctx.clearPinnedError`. Aborts and normal stops must NOT
 * pin a banner.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { THINKING_LOOP_ERROR_MARKER } from "@oh-my-pi/pi-ai/utils/thinking-loop";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { ErrorBannerComponent } from "@oh-my-pi/pi-coding-agent/modes/components/error-banner";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "draft" }],
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
		...overrides,
	};
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

function createFixture(streamingMessage?: AssistantMessage) {
	const streamingComponent = {
		updateContent: vi.fn(),
		setComplete: vi.fn(),
		markTranscriptBlockFinalized: vi.fn(),
		setErrorPinned: vi.fn(),
	};
	const showPinnedError = vi.fn();
	const clearPinnedError = vi.fn();
	const statusContainer = {
		clear: vi.fn(),
		addChild: vi.fn(),
	};

	const session = { isTtsrAbortPending: false, retryAttempt: 0 };
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
		statusContainer,
		loadingAnimation: undefined,
		retryLoader: undefined,
		editor: {},
		streamingComponent: streamingMessage ? streamingComponent : undefined,
		streamingMessage,
		pendingTools: new Map(),
		showPinnedError,
		clearPinnedError,
		session,
		get viewSession() {
			return session;
		},
		clearTransientSessionUi: () => {},
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return { controller, ctx, showPinnedError, clearPinnedError, streamingComponent };
}

describe("EventController error banner", () => {
	it("pins the provider error above the editor when an assistant turn ends on stopReason error", async () => {
		const errorMessage = "Output blocked by content filtering policy";
		const message = makeAssistantMessage({ stopReason: "error", errorMessage });
		const { controller, showPinnedError, streamingComponent } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect(showPinnedError).toHaveBeenCalledTimes(1);
		expect(showPinnedError).toHaveBeenCalledWith(errorMessage);
		// The same error is mirrored in the banner, so the transcript's inline
		// `Error: …` line is suppressed to avoid a duplicate render.
		expect(streamingComponent.setErrorPinned).toHaveBeenCalledWith(true);
	});

	it("restores the transcript inline error when the next turn starts", async () => {
		const errorMessage = "Output blocked by content filtering policy";
		const message = makeAssistantMessage({ stopReason: "error", errorMessage });
		const { controller, clearPinnedError, streamingComponent } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		streamingComponent.setErrorPinned.mockClear();

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		expect(clearPinnedError).toHaveBeenCalledTimes(1);
		expect(streamingComponent.setErrorPinned).toHaveBeenCalledWith(false);
	});

	it("clears retryable thinking-loop banners without restoring the dropped inline error", async () => {
		const errorMessage = `${THINKING_LOOP_ERROR_MARKER}: the model repeated near-identical content. Treating as a stream stall and retrying.`;
		const message = makeAssistantMessage({ stopReason: "error", errorMessage });
		const { controller, clearPinnedError, streamingComponent } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		clearPinnedError.mockClear();
		streamingComponent.setErrorPinned.mockClear();

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 2,
			delayMs: 0,
			errorMessage,
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);

		expect(clearPinnedError).toHaveBeenCalledTimes(1);
		expect(streamingComponent.setErrorPinned).not.toHaveBeenCalledWith(false);
		await controller.handleEvent({
			type: "auto_retry_end",
			success: true,
			attempt: 1,
		} as Extract<AgentSessionEvent, { type: "auto_retry_end" }>);
	});

	it("does not pin a banner for a normal assistant stop", async () => {
		const message = makeAssistantMessage({ stopReason: "stop" });
		const { controller, showPinnedError } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect(showPinnedError).not.toHaveBeenCalled();
	});

	it("does not pin a banner for an aborted assistant turn", async () => {
		const message = makeAssistantMessage({ stopReason: "aborted", errorMessage: "Operation aborted" });
		const { controller, showPinnedError } = createFixture(message);

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect(showPinnedError).not.toHaveBeenCalled();
	});

	it("clears the pinned banner when the next turn starts", async () => {
		const { controller, clearPinnedError } = createFixture();

		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		expect(clearPinnedError).toHaveBeenCalledTimes(1);
	});
});

describe("ErrorBannerComponent", () => {
	it("renders the provider error message", () => {
		const banner = new ErrorBannerComponent("Output blocked by content filtering policy");
		const rendered = Bun.stripANSI(banner.render(120).join("\n"));
		expect(rendered).toContain("Output blocked by content filtering policy");
		expect(rendered).toContain("Dismissed when you send your next message.");
	});

	it("caps an oversized multi-line error to a few lines", () => {
		const huge = Array.from({ length: 50 }, (_, i) => `error detail line ${i}`).join("\n");
		const banner = new ErrorBannerComponent(huge);
		const lines = Bun.stripANSI(banner.render(120).join("\n")).split("\n");
		const detailLines = lines.filter(line => line.includes("error detail line"));
		expect(detailLines.length).toBeLessThanOrEqual(3);
		expect(detailLines.length).toBeGreaterThan(0);
	});
});

describe("AssistantMessageComponent error pinning", () => {
	it("hides the inline error while pinned and restores it afterwards", () => {
		const message = makeAssistantMessage({
			content: [],
			stopReason: "error",
			errorMessage: "400 invalid reasoning value",
		});
		const component = new AssistantMessageComponent(message);

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("Error: 400 invalid reasoning value");

		component.setErrorPinned(true);
		expect(Bun.stripANSI(component.render(120).join("\n"))).not.toContain("Error: 400 invalid reasoning value");

		component.setErrorPinned(false);
		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("Error: 400 invalid reasoning value");
	});
});

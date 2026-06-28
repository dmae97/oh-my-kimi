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
import * as AIError from "@oh-my-pi/pi-ai/error";
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
	const componentCalls: string[] = [];
	const streamingComponent = {
		updateContent: vi.fn(() => componentCalls.push("update")),
		setComplete: vi.fn(),
		markTranscriptBlockFinalized: vi.fn(),
		setErrorPinned: vi.fn(),
		setHideThinkingBlock: vi.fn((hide: boolean) => componentCalls.push(`hide:${hide}`)),
	};
	const showPinnedError = vi.fn();
	const clearPinnedError = vi.fn();
	const statusContainer = {
		clear: vi.fn(),
		addChild: vi.fn(),
	};

	const session = { isStreaming: false };
	const viewSession = { isStreaming: false, isTtsrAbortPending: false, retryAttempt: 0 };
	let hasDisplayableThinkingContent = false;
	const noteDisplayableThinkingContent = vi.fn((message: AssistantMessage) => {
		const hasThinking = message.content.some(
			content => content.type === "thinking" && content.thinking.trim() !== "",
		);
		if (!hasThinking || hasDisplayableThinkingContent) return false;
		hasDisplayableThinkingContent = true;
		return true;
	});
	const chatChildren: unknown[] = [];
	const chatContainer = {
		children: chatChildren,
		addChild: vi.fn((child: unknown) => {
			chatChildren.push(child);
		}),
		clear: vi.fn(() => {
			chatChildren.length = 0;
		}),
	};
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		settings: { get: vi.fn(() => false) },
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
		statusContainer,
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		editor: {},
		streamingComponent: streamingMessage ? streamingComponent : undefined,
		streamingMessage,
		chatContainer,
		proseOnlyThinking: true,
		pendingTools: new Map(),
		flushCompactionQueue: vi.fn(async () => {}),
		showPinnedError,
		clearPinnedError,
		showError: vi.fn(),
		showStatus: vi.fn(),
		noteDisplayableThinkingContent,
		get hasDisplayableThinkingContent() {
			return hasDisplayableThinkingContent;
		},
		get effectiveHideThinkingBlock() {
			return !hasDisplayableThinkingContent;
		},
		showWarning: vi.fn(),
		session,
		get viewSession() {
			return viewSession;
		},
		clearTransientSessionUi: () => {},
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return { controller, ctx, showPinnedError, clearPinnedError, streamingComponent, componentCalls };
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
		const errorMessage = "loop guard stopped repeated reasoning";
		const message = makeAssistantMessage({
			stopReason: "error",
			errorMessage,
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
		});
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
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
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

describe("EventController thinking visibility", () => {
	it("shows the first observed thinking delta on the active streaming component", async () => {
		const initial = makeAssistantMessage({ content: [] });
		const message = makeAssistantMessage({
			content: [{ type: "thinking", thinking: "server-side reasoning" }],
		});
		const { controller, ctx } = createFixture();

		await controller.handleEvent({
			type: "message_start",
			message: initial,
		} as Extract<AgentSessionEvent, { type: "message_start" }>);
		const component = ctx.streamingComponent;
		if (!(component instanceof AssistantMessageComponent)) {
			throw new Error("Expected streaming assistant component");
		}

		await controller.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "thinking_delta",
				delta: "server-side reasoning",
				contentIndex: 0,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);

		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("server-side reasoning");
	});
});

describe("EventController working loader reconciliation", () => {
	it("restores the working loader after compaction clears status while the focused session streams", async () => {
		const { controller, ctx } = createFixture();
		const loader = { stop: vi.fn() } as unknown as InteractiveModeContext["autoCompactionLoader"];
		ctx.autoCompactionLoader = loader;
		(ctx.viewSession as unknown as { isStreaming: boolean }).isStreaming = true;

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
		} as Extract<AgentSessionEvent, { type: "auto_compaction_end" }>);

		expect(loader?.stop).toHaveBeenCalledTimes(1);
		expect(ctx.statusContainer.clear).toHaveBeenCalledTimes(1);
		expect(ctx.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
		expect(ctx.ensureLoadingAnimation).toHaveBeenCalledTimes(1);
	});

	it("self-heals missing working loader on live tool updates", async () => {
		const { controller, ctx } = createFixture();
		(ctx.viewSession as unknown as { isStreaming: boolean }).isStreaming = true;

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "missing",
			partialResult: {},
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);

		expect(ctx.ensureLoadingAnimation).toHaveBeenCalledTimes(1);
	});

	it("keeps transient retry status exclusive while a retry loader is visible", async () => {
		const { controller, ctx } = createFixture();
		ctx.retryLoader = { stop: vi.fn() } as unknown as InteractiveModeContext["retryLoader"];
		(ctx.viewSession as unknown as { isStreaming: boolean }).isStreaming = true;

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "missing",
			partialResult: {},
		} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);

		expect(ctx.ensureLoadingAnimation).not.toHaveBeenCalled();
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

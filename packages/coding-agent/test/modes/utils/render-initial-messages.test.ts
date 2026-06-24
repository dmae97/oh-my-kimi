/**
 * Contract: renderInitialMessages renders the collapsed live DISPLAY TRANSCRIPT,
 * not the LLM context. The transcript comes from
 * `session.buildTranscriptSessionContext({ collapseCompactedHistory: true })`;
 * `sessionManager.buildSessionContext()` — the LLM-context builder — must not be
 * consulted for display.
 *
 * Also guards the cold-launch terminal cleanup: `omp` / `omp -c` leave the
 * previous run's transcript in native scrollback because the TUI's initial
 * paint preserves it, so the cold-launch render must request a
 * scrollback-clearing repaint (`clearTerminalHistory`).
 */

import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type Component, Container, Image, ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

beforeAll(() => {
	initTheme();
});

const originalImageProtocol = TERMINAL.imageProtocol;

afterEach(() => {
	resetSettingsForTest();
	setTerminalImageProtocol(originalImageProtocol);
	vi.restoreAllMocks();
});

function makeEmptyContext(): SessionContext {
	return {
		messages: [],
		thinkingLevel: "off",
		serviceTier: undefined,
		models: {},
		injectedTtsrRules: [],
		selectedMCPToolNames: [],
		hasPersistedMCPToolSelection: false,
		mode: "none",
	};
}

/** Build a minimal InteractiveModeContext mock, returning spies for assertions. */
function makeCtx(): {
	ctx: InteractiveModeContext;
	transcriptSpy: Mock<(options?: { collapseCompactedHistory?: boolean }) => SessionContext>;
	llmContextSpy: Mock<() => SessionContext>;
	renderSessionContextSpy: Mock<(...args: unknown[]) => void>;
} {
	const transcriptSpy = vi.fn(() => makeEmptyContext());
	const llmContextSpy = vi.fn(() => makeEmptyContext());
	const renderSessionContextSpy = vi.fn();

	const ctx = {
		chatContainer: { clear: vi.fn(), addChild: vi.fn() },
		pendingMessagesContainer: { clear: vi.fn() },
		pendingBashComponents: [],
		pendingPythonComponents: [],
		session: { buildTranscriptSessionContext: transcriptSpy },
		viewSession: {
			buildTranscriptSessionContext: transcriptSpy,
			sessionManager: {
				buildSessionContext: llmContextSpy,
				getEntries: vi.fn(() => []),
				getCwd: vi.fn(() => "/tmp"),
			},
		},
		sessionManager: {
			buildSessionContext: llmContextSpy,
			getEntries: vi.fn(() => []),
			getCwd: vi.fn(() => "/tmp"),
		},
		renderSessionContext: renderSessionContextSpy,
		showStatus: vi.fn(),
		ui: { requestRender: vi.fn() },
		resetTranscript: () => ctx.chatContainer.clear(),
	} as unknown as InteractiveModeContext;

	return { ctx, transcriptSpy, llmContextSpy, renderSessionContextSpy };
}

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const pngImage: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	mimeType: "image/png",
};

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function transcriptWith(messages: AgentMessage[]): SessionContext {
	return { ...makeEmptyContext(), messages };
}

function countImageComponents(component: Component): number {
	const own = component instanceof Image ? 1 : 0;
	const children = (component as { children?: unknown }).children;
	if (!Array.isArray(children)) return own;
	return own + children.reduce((count, child) => count + countImageComponents(child as Component), 0);
}

function hasImageComponent(component: Component): boolean {
	return countImageComponents(component) > 0;
}

function makeRenderCtx(transcript: SessionContext): { ctx: InteractiveModeContext; chatContainer: Container } {
	const chatContainer = new Container();
	let helpers: UiHelpers;
	const ctx = {
		chatContainer,
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		pendingTools: new Map(),
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender: vi.fn(), imageBudget: undefined },
		resetTranscript: () => chatContainer.clear(),
		settings: { get: () => false },
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		focusedAgentId: undefined,
		editor: { addToHistory: vi.fn() },
		viewSession: {
			buildTranscriptSessionContext: () => transcript,
			getToolByName: () => undefined,
			extensionRunner: undefined,
			sessionManager: {
				getEntries: vi.fn(() => []),
				getCwd: vi.fn(() => "/tmp"),
			},
		},
		sessionManager: {
			getEntries: vi.fn(() => []),
			getCwd: vi.fn(() => "/tmp"),
			putBlobSync: vi.fn(() => ({
				hash: "hash",
				path: "/tmp/hash",
				displayPath: "/tmp/hash.png",
				ref: "blob:sha256:hash",
			})),
		},
		addMessageToChat: (message: AgentMessage, options?: { populateHistory?: boolean }) =>
			helpers.addMessageToChat(message, options),
		renderSessionContext: (
			context: SessionContext,
			options?: { updateFooter?: boolean; populateHistory?: boolean },
		) => helpers.renderSessionContext(context, options),
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;
	helpers = new UiHelpers(ctx);
	return { ctx, chatContainer };
}

describe("UiHelpers.renderInitialMessages — transcript source", () => {
	it("renders the collapsed live display transcript, never the LLM context", () => {
		const { ctx, transcriptSpy, llmContextSpy, renderSessionContextSpy } = makeCtx();
		const transcript = makeEmptyContext();
		transcriptSpy.mockReturnValue(transcript);

		new UiHelpers(ctx).renderInitialMessages();

		expect(transcriptSpy).toHaveBeenCalledWith({ collapseCompactedHistory: true });
		expect(llmContextSpy).not.toHaveBeenCalled();
		expect(renderSessionContextSpy).toHaveBeenCalledWith(transcript, {
			updateFooter: true,
			populateHistory: true,
		});
	});
});

describe("UiHelpers.renderInitialMessages — clearTerminalHistory", () => {
	it("requests a scrollback-clearing repaint when clearTerminalHistory is set", () => {
		const { ctx } = makeCtx();
		new UiHelpers(ctx).renderInitialMessages({ clearTerminalHistory: true });
		expect(ctx.ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});

	it("never clears scrollback when clearTerminalHistory is unset", () => {
		const { ctx } = makeCtx();
		new UiHelpers(ctx).renderInitialMessages();
		const clearedCall = (ctx.ui.requestRender as Mock<(...a: unknown[]) => void>).mock.calls.find(
			([force, opts]) => force === true && (opts as { clearScrollback?: boolean } | undefined)?.clearScrollback,
		);
		expect(clearedCall).toBeUndefined();
	});
});

describe("UiHelpers.renderInitialMessages — image replay", () => {
	it("restores read tool image blocks onto the rebuilt assistant transcript", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			assistantToolCall("read-image", "read", { path: "sample.png" }),
			{
				role: "toolResult",
				toolCallId: "read-image",
				toolName: "read",
				content: [{ type: "text", text: "Read image: sample.png" }, pngImage],
				isError: false,
				timestamp: 2,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		new UiHelpers(ctx).renderInitialMessages();

		expect(hasImageComponent(chatContainer)).toBe(true);
		expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("Read sample.png");
	});

	it("restores eval display image blocks onto rebuilt tool output", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			assistantToolCall("eval-image", "eval", { language: "py", code: "display(image)" }),
			{
				role: "toolResult",
				toolCallId: "eval-image",
				toolName: "eval",
				content: [{ type: "text", text: "(displayed 1 image; no text output)" }, pngImage],
				details: {
					language: "python",
					cells: [{ index: 0, code: "display(image)", output: "display image 1: 1x1", status: "complete" }],
				},
				isError: false,
				timestamp: 2,
			},
		]);

		const { ctx, chatContainer } = makeRenderCtx(transcript);

		new UiHelpers(ctx).renderInitialMessages();

		expect(hasImageComponent(chatContainer)).toBe(true);
		expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("display image 1: 1x1");
	});

	it("replays reopened session image blocks through the cold-start rebuild path", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		using tempDir = TempDir.createSync("@pi-render-initial-image-replay-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage(assistantToolCall("read-reopened", "read", { path: "reopened.png" }));
		session.appendMessage({
			role: "toolResult",
			toolCallId: "read-reopened",
			toolName: "read",
			content: [{ type: "text", text: "Read image: reopened.png" }, pngImage],
			isError: false,
			timestamp: 2,
		});
		session.appendMessage(assistantToolCall("eval-reopened", "eval", { language: "py", code: "display(image)" }));
		session.appendMessage({
			role: "toolResult",
			toolCallId: "eval-reopened",
			toolName: "eval",
			content: [{ type: "text", text: "(displayed 1 image; no text output)" }, pngImage],
			details: {
				language: "python",
				cells: [{ index: 0, code: "display(image)", output: "display image 1: 1x1", status: "complete" }],
			},
			isError: false,
			timestamp: 4,
		});
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const reloaded = await SessionManager.open(sessionFile);
		const transcript = reloaded.buildSessionContext({ transcript: true });
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		new UiHelpers(ctx).renderInitialMessages({ clearTerminalHistory: true });

		expect(countImageComponents(chatContainer)).toBe(2);
		expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("Read reopened.png");
		expect(ctx.ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});
});

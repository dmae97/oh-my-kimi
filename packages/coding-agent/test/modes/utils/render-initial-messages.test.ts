/**
 * Contract: renderInitialMessages renders the DISPLAY TRANSCRIPT, not the LLM
 * context. The transcript comes from `session.buildTranscriptSessionContext()`
 * (full history, compactions inline); `sessionManager.buildSessionContext()`
 * — the LLM-context builder — must not be consulted for display. Feeding the
 * compacted LLM context to the chat is exactly the old "session starts over
 * after compaction" bug.
 *
 * Also guards the cold-launch terminal cleanup: `omp` / `omp -c` leave the
 * previous run's transcript in native scrollback because the TUI's initial
 * paint preserves it, so the cold-launch render must request a
 * scrollback-clearing repaint (`clearTerminalHistory`).
 */

import { beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-manager";

beforeAll(() => {
	initTheme();
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
	transcriptSpy: Mock<() => SessionContext>;
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

describe("UiHelpers.renderInitialMessages — transcript source", () => {
	it("renders the display transcript, never the LLM context", () => {
		const { ctx, transcriptSpy, llmContextSpy, renderSessionContextSpy } = makeCtx();
		const transcript = makeEmptyContext();
		transcriptSpy.mockReturnValue(transcript);

		new UiHelpers(ctx).renderInitialMessages();

		expect(transcriptSpy).toHaveBeenCalledTimes(1);
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

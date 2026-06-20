import { describe, expect, it, vi } from "bun:test";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

describe("InputController thinking visibility", () => {
	it("keeps pre-stream pending transcript content mounted when Ctrl+T toggles thinking blocks", () => {
		const pendingUserMessage = { kind: "pending-user" };
		const loadingIndicator = { kind: "loading" };
		const assistant = new AssistantMessageComponent();
		const setHideThinkingBlock = vi.spyOn(assistant, "setHideThinkingBlock");
		const resetDisplay = vi.fn();
		const clear = vi.fn();
		const addChild = vi.fn();
		const rebuildChatFromMessages = vi.fn();
		const set = vi.fn();
		const showStatus = vi.fn();
		const children = [pendingUserMessage, assistant, loadingIndicator];
		const chatContainer = { children, clear, addChild };
		const ctx = {
			hideThinkingBlock: false,
			settings: { set },
			session: { agent: { hideThinkingSummary: false } },
			chatContainer,
			streamingComponent: undefined,
			streamingMessage: undefined,
			rebuildChatFromMessages,
			showStatus,
			ui: { resetDisplay },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleThinkingBlockVisibility();

		expect(ctx.hideThinkingBlock).toBe(true);
		expect(set).toHaveBeenCalledWith("hideThinkingBlock", true);
		expect(ctx.session.agent.hideThinkingSummary).toBe(true);
		expect(chatContainer.children).toEqual([pendingUserMessage, assistant, loadingIndicator]);
		expect(clear).not.toHaveBeenCalled();
		expect(addChild).not.toHaveBeenCalled();
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(resetDisplay).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Thinking blocks: hidden");
	});
});

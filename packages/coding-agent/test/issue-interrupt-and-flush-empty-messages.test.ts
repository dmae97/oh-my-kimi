import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";

function createContext() {
	let editorText = "";
	const abort = vi.fn(async () => {});
	const prompt = vi.fn(async () => {});
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();
	const ctx = {
		editor: {
			setText(text: string) {
				editorText = text;
			},
			getText() {
				return editorText;
			},
			addToHistory: vi.fn(),
			pendingImages: [] as ImageContent[],
			pendingImageLinks: [] as (string | undefined)[],
		},
		ui: { requestRender },
		session: {
			isStreaming: true,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 1,
			extensionRunner: undefined,
			abort,
			prompt,
		},
		get viewSession() {
			return (this as typeof ctx).session;
		},
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		isBashMode: false,
		isPythonMode: false,
		loopModeEnabled: false,
		updatePendingMessagesDisplay,
		showError,
		hasActiveBtw: () => false,
		hasActiveOmfg: () => false,
	} as unknown as InteractiveModeContext;
	return { ctx, abort, prompt, updatePendingMessagesDisplay, requestRender, showError };
}

describe("empty submit with queued messages", () => {
	it("aborts the active stream instead of eagerly prompting a drained queue", async () => {
		const { ctx, abort, prompt, updatePendingMessagesDisplay, requestRender, showError } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("");

		expect(abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expect(prompt).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});

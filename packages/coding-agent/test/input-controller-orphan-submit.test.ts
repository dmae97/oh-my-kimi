import { describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

/**
 * Regression: a submission arriving while the main loop has no input waiter
 * (`onInputCallback === undefined` — post-turn epilogue, retry backoff, or a
 * scheduled continue) and the session is neither streaming nor compacting used
 * to fall through every branch of the submit ladder. The editor clears itself
 * on Enter, so the message vanished without a trace (no queue entry, no error,
 * no transcript message).
 *
 * Contract: such a submission must be queued as a steer (the session's idle
 * drain / next run start delivers it) and recorded as a local submission so
 * its eventual delivery does not clobber the editor.
 */

type FakeEditor = {
	onSubmit?: (text: string) => Promise<void>;
	imageLinks?: readonly (string | undefined)[];
	setText(text: string): void;
	getText(): string;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
};

function createContext() {
	let editorText = "";
	const steer = vi.fn(async (_text: string, _images?: unknown) => {});
	const prompt = vi.fn(async () => {});
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();
	const addToHistory = vi.fn();
	const flushPendingBashComponents = vi.fn();

	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory,
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
	};

	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender } as unknown as InteractiveModeContext["ui"],
		session: {
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			steer,
			prompt,
			queuedMessageCount: 0,
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
		} as unknown as InteractiveModeContext["session"],
		sessionManager: { getSessionName: () => "named-session" } as InteractiveModeContext["sessionManager"],
		pendingImages: [] as InteractiveModeContext["pendingImages"],
		pendingImageLinks: [] as InteractiveModeContext["pendingImageLinks"],
		fileSlashCommands: new Set<string>(),
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: () => false,
		recordLocalSubmission(this: InteractiveModeContext, text: string, imageCount = 0) {
			const sig = `${text}\u0000${imageCount}`;
			this.locallySubmittedUserSignatures.add(sig);
			return () => {
				this.locallySubmittedUserSignatures.delete(sig);
			};
		},
		async withLocalSubmission<T>(
			this: InteractiveModeContext,
			text: string,
			fn: () => Promise<T>,
			options?: { imageCount?: number },
		): Promise<T> {
			const dispose = this.recordLocalSubmission(text, options?.imageCount ?? 0);
			try {
				return await fn();
			} catch (err) {
				dispose();
				throw err;
			}
		},
		// No input waiter: the state under test.
		onInputCallback: undefined,
		updatePendingMessagesDisplay,
		flushPendingBashComponents,
		showError,
		isBashMode: false,
		isPythonMode: false,
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		spies: { steer, prompt, updatePendingMessagesDisplay, requestRender, showError, addToHistory },
	};
}

describe("InputController orphaned submit", () => {
	it("queues an idle submit with no input waiter as a steer instead of dropping it", async () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("do not lose me");

		expect(spies.steer).toHaveBeenCalledWith("do not lose me", undefined);
		expect(spies.prompt).not.toHaveBeenCalled();
		// Delivery protection: the queued message is marked as locally submitted.
		expect(ctx.locallySubmittedUserSignatures.has("do not lose me\u00000")).toBe(true);
		// The queue chip becomes visible right away.
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalled();
		expect(spies.requestRender).toHaveBeenCalled();
		expect(spies.addToHistory).toHaveBeenCalledWith("do not lose me");
	});

	it("forwards pending images and counts them in the local-submission signature", async () => {
		const { ctx, editor, spies } = createContext();
		const image = { type: "image", data: "abc", mimeType: "image/png" };
		(ctx.pendingImages as unknown[]).push(image);
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("look at this");

		expect(spies.steer).toHaveBeenCalledWith("look at this", [image]);
		expect(ctx.locallySubmittedUserSignatures.has("look at this\u00001")).toBe(true);
		expect(ctx.pendingImages.length).toBe(0);
	});

	it("restores text and images to the editor when the steer rejects", async () => {
		const { ctx, editor, spies } = createContext();
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		(ctx.pendingImages as unknown[]).push(image);
		spies.steer.mockImplementationOnce(async () => {
			throw new Error("queue exploded");
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("doomed message");

		expect(spies.showError).toHaveBeenCalledWith("queue exploded");
		// The message survives the failure: text and images return to the editor.
		expect(editor.getText()).toBe("doomed message");
		expect(ctx.pendingImages).toEqual([image]);
		// The signature must not leak for a message that never queued.
		expect(ctx.locallySubmittedUserSignatures.has("doomed message\u00001")).toBe(false);
	});

	it("returns queued images to the pending-image buffer on queue restore", async () => {
		const { ctx, editor } = createContext();
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		const session = ctx.session as unknown as { clearQueue: () => unknown };
		session.clearQueue = () => ({
			steering: [{ text: "queued with image", images: [image] }],
			followUp: [],
		});
		const controller = new InputController(ctx);

		const restored = controller.restoreQueuedMessagesToEditor();

		expect(restored).toBe(1);
		expect(editor.getText()).toBe("queued with image");
		expect(ctx.pendingImages).toEqual([image]);
		expect(ctx.pendingImageLinks).toEqual([undefined]);
	});
});

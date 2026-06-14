/**
 * Images attached during compaction must survive the compaction queue.
 *
 * Previously, typing a steer/follow-up message with a pending clipboard image
 * while the session was compacting was rejected outright ("Retry after it
 * completes to send images"). Now `queueCompactionMessage` carries the images,
 * and `flushCompactionQueue` forwards them to the session on delivery.
 *
 * Contracts defended here:
 *   - `queueCompactionMessage(text, mode, images)` stores the images on the
 *     queued entry and consumes the pending-image state (so the next message
 *     does not resend them).
 *   - On flush, the first queued prompt forwards its images via `session.prompt`.
 *   - On a `willRetry` flush, a queued follow-up forwards its images via
 *     `session.followUp` (the `#deliverQueuedMessage` path).
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { RestoredQueuedMessage } from "@oh-my-pi/pi-coding-agent/session/agent-session";

beforeAll(() => {
	initTheme();
});

type PromptOpts = { streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] } | undefined;

function makeCtx(initialQueue: CompactionQueuedMessage[] = []) {
	const promptCalls: Array<{ text: string; opts: PromptOpts }> = [];
	const steerCalls: Array<{ text: string; images?: ImageContent[] }> = [];
	const followUpCalls: Array<{ text: string; images?: ImageContent[] }> = [];

	const session = {
		isStreaming: false,
		isCompacting: false,
		extensionRunner: undefined,
		customCommands: [] as Array<{ command: { name: string } }>,
		getQueuedMessages: () => ({ steering: [] as string[], followUp: [] as string[] }),
		clearQueue: () => ({ steering: [] as RestoredQueuedMessage[], followUp: [] as RestoredQueuedMessage[] }),
		prompt: mock(async (text: string, opts?: PromptOpts): Promise<void> => {
			promptCalls.push({ text, opts });
		}),
		steer: mock(async (text: string, images?: ImageContent[]): Promise<void> => {
			steerCalls.push({ text, images });
		}),
		followUp: mock(async (text: string, images?: ImageContent[]): Promise<void> => {
			followUpCalls.push({ text, images });
		}),
	};

	let editorText = "";

	const ctx = {
		session,
		compactionQueuedMessages: [...initialQueue],
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		pendingMessagesContainer: { clear: () => {}, addChild: () => {}, removeChild: () => {} },
		editor: {
			addToHistory: () => {},
			setText: (text: string) => {
				editorText = text;
			},
			getText: () => editorText,
			imageLinks: undefined as (string | undefined)[] | undefined,
		},
		keybindings: { getDisplayString: () => "Alt+Up" },
		fileSlashCommands: new Set<string>(),
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: (text: string) => text.startsWith("/"),
		recordLocalSubmission: () => () => {},
		async withLocalSubmission<T>(_text: string, fn: () => Promise<T>): Promise<T> {
			return await fn();
		},
		updatePendingMessagesDisplay: () => {},
		showError: () => {},
		showStatus: () => {},
	} as unknown as InteractiveModeContext;

	return { ctx, session, promptCalls, steerCalls, followUpCalls };
}

const img = (data: string): ImageContent => ({ type: "image", mimeType: "image/png", data });

describe("compaction queue image forwarding", () => {
	test("queueCompactionMessage stores images and consumes pending-image state", () => {
		const image = img("aGVsbG8=");
		const { ctx } = makeCtx();
		ctx.pendingImages = [image];
		ctx.pendingImageLinks = ["clipboard"];
		ctx.editor.imageLinks = ["clipboard"];

		new UiHelpers(ctx).queueCompactionMessage("look at this screenshot", "steer", [image]);

		expect(ctx.compactionQueuedMessages).toEqual([
			{ text: "look at this screenshot", mode: "steer", images: [image] },
		]);
		// Pending state is consumed so the next message does not resend the image.
		expect(ctx.pendingImages).toEqual([]);
		expect(ctx.pendingImageLinks).toEqual([]);
		expect(ctx.editor.imageLinks).toBeUndefined();
	});

	test("empty image list is normalized to undefined on the queued entry", () => {
		const { ctx } = makeCtx();
		new UiHelpers(ctx).queueCompactionMessage("no images here", "followUp", []);
		expect(ctx.compactionQueuedMessages).toEqual([{ text: "no images here", mode: "followUp", images: undefined }]);
	});

	test("flush forwards the first queued prompt's images via session.prompt", async () => {
		const image = img("d29ybGQ=");
		const { ctx, promptCalls } = makeCtx([{ text: "describe this", mode: "steer", images: [image] }]);

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		await Promise.resolve();
		await Promise.resolve();

		expect(promptCalls).toHaveLength(1);
		expect(promptCalls[0].text).toBe("describe this");
		expect(promptCalls[0].opts?.images).toEqual([image]);
	});

	test("willRetry flush forwards a follow-up's images via session.followUp", async () => {
		const image = img("Zm9v");
		const { ctx, followUpCalls } = makeCtx([{ text: "and this one", mode: "followUp", images: [image] }]);

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: true });

		expect(followUpCalls).toEqual([{ text: "and this one", images: [image] }]);
	});
});

describe("compaction queue Alt+Up restore", () => {
	test("restoreQueuedMessagesToEditor drains a compaction-queued skill", () => {
		const { ctx } = makeCtx([{ text: "/skill:foo bar", mode: "followUp", images: undefined }]);
		const restored = new InputController(ctx).restoreQueuedMessagesToEditor();
		expect(restored).toBe(1);
		expect(ctx.editor.getText()).toBe("/skill:foo bar");
		expect(ctx.compactionQueuedMessages).toEqual([]);
	});

	test("restored compaction images return to the pending-image buffer", () => {
		const image = img("YmF6");
		const { ctx } = makeCtx([{ text: "look", mode: "steer", images: [image] }]);
		const restored = new InputController(ctx).restoreQueuedMessagesToEditor();
		expect(restored).toBe(1);
		expect(ctx.pendingImages).toEqual([image]);
	});

	test("session and compaction queues restore in pending-bar order", () => {
		const { ctx, session } = makeCtx([
			{ text: "compaction steer", mode: "steer", images: undefined },
			{ text: "compaction followup", mode: "followUp", images: undefined },
		]);
		session.clearQueue = () => ({
			steering: [{ text: "session steer" }],
			followUp: [{ text: "session followup" }],
		});
		const restored = new InputController(ctx).restoreQueuedMessagesToEditor();
		expect(restored).toBe(4);
		expect(ctx.editor.getText()).toBe("session steer\n\ncompaction steer\n\nsession followup\n\ncompaction followup");
	});
});

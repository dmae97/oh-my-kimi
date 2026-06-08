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
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";

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
		clearQueue: () => ({ steering: [] as string[], followUp: [] as string[] }),
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

	const ctx = {
		session,
		compactionQueuedMessages: [...initialQueue],
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		pendingMessagesContainer: { clear: () => {}, addChild: () => {}, removeChild: () => {} },
		editor: {
			addToHistory: () => {},
			setText: () => {},
			getText: () => "",
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

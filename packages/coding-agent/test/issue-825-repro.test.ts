/**
 * Regression test for issue #825: steer preview stuck after compaction.
 *
 * Scenario: user types a steer message during compaction; it is queued to
 * `compactionQueuedMessages`. When compaction ends, `flushCompactionQueue`
 * fires `session.prompt(text)` (no streamingBehavior). If the session is
 * still streaming at that moment, `prompt()` throws `AgentBusyError`.
 * Currently the catch handler dumps the message back into
 * `compactionQueuedMessages`. Nothing drains that array except a future
 * compaction-end event, so the preview shows the message but the user has no
 * way to actually deliver it (Alt+Up restores from the session queue, not
 * from compactionQueuedMessages; normal submit doesn't pick them up either).
 *
 * The contract this test defends:
 *   - After a busy-flush, the queued message must be findable in the session
 *     steer/follow-up queues — the queues every other code path drains. That
 *     keeps the preview honest (it reflects what is actually queued) AND
 *     makes the message deliverable on the next user turn.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";

beforeAll(() => {
	initTheme();
});

type PromptOpts = { streamingBehavior?: "steer" | "followUp" } | undefined;

function makeFakeSession() {
	const steering: string[] = [];
	const followUp: string[] = [];
	const promptCalls: Array<{ text: string; opts: PromptOpts }> = [];

	const prompt = mock(async (text: string, opts?: PromptOpts): Promise<void> => {
		promptCalls.push({ text, opts });
		// Mirror real agent-session behaviour: when the session is busy and the
		// caller did not supply streamingBehavior, throw AgentBusyError.
		if (!opts?.streamingBehavior) {
			throw new AgentBusyError();
		}
		if (opts.streamingBehavior === "followUp") {
			followUp.push(text);
		} else {
			steering.push(text);
		}
	});

	const steer = mock(async (text: string): Promise<void> => {
		steering.push(text);
	});

	const followUpFn = mock(async (text: string): Promise<void> => {
		followUp.push(text);
	});

	const session = {
		isStreaming: true,
		isCompacting: false,
		extensionRunner: undefined,
		customCommands: [] as Array<{ command: { name: string } }>,
		getQueuedMessages: () => ({ steering, followUp }),
		clearQueue: () => {
			const s = [...steering];
			const f = [...followUp];
			steering.length = 0;
			followUp.length = 0;
			return { steering: s, followUp: f };
		},
		prompt,
		steer,
		followUp: followUpFn,
	};

	return { session, steering, followUp, promptCalls };
}

function makeCtx(initialQueue: CompactionQueuedMessage[]) {
	const fake = makeFakeSession();
	const showError = mock((_msg: string) => {});
	const showStatus = mock((_msg: string) => {});
	const updatePendingMessagesDisplay = mock(() => {});

	const ctx = {
		session: fake.session,
		compactionQueuedMessages: [...initialQueue],
		pendingMessagesContainer: { clear: () => {}, addChild: () => {}, removeChild: () => {} },
		editor: { addToHistory: () => {}, setText: () => {}, getText: () => "" },
		keybindings: { getDisplayString: () => "Alt+Up" },
		fileSlashCommands: new Set<string>(),
		isKnownSlashCommand: (text: string) => text.startsWith("/"),
		updatePendingMessagesDisplay,
		showError,
		showStatus,
	} as unknown as InteractiveModeContext;

	return { ctx, fake, showError, showStatus, updatePendingMessagesDisplay };
}

describe("issue #825: steer preview stuck after compaction", () => {
	test("AgentBusyError on flush leaves the steer message in the session queue (submittable on next turn)", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "address review feedback", mode: "steer" }];
		const { ctx, fake } = makeCtx(queued);

		const helpers = new UiHelpers(ctx);
		await helpers.flushCompactionQueue({ willRetry: false });
		// Drain microtasks so the .catch on the fire-and-forget prompt resolves.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// Contract: the message must end up in the session steering queue —
		// that is what `restoreQueuedMessagesToEditor` (Alt+Up) and the
		// post-stream drain consult. Otherwise it is stranded in
		// compactionQueuedMessages with no consumer.
		expect(fake.steering).toContain("address review feedback");

		// And it must not also remain duplicated in compactionQueuedMessages.
		const remaining = (ctx as unknown as { compactionQueuedMessages: CompactionQueuedMessage[] })
			.compactionQueuedMessages;
		expect(remaining.find(m => m.text === "address review feedback")).toBeUndefined();
	});

	test("when the agent is genuinely idle, flush issues a fresh prompt as before", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "ship it", mode: "steer" }];
		const { ctx, fake } = makeCtx(queued);
		// Agent is idle now: prompt must succeed (real agent-session ignores
		// streamingBehavior when not streaming, so passing it must not break
		// the happy path).
		fake.session.isStreaming = false;
		// Override prompt to record + succeed regardless of streamingBehavior.
		const promptCalls: Array<{ text: string; opts: PromptOpts }> = [];
		fake.session.prompt = mock(async (text: string, opts?: PromptOpts): Promise<void> => {
			promptCalls.push({ text, opts });
		});

		const helpers = new UiHelpers(ctx);
		await helpers.flushCompactionQueue({ willRetry: false });
		await Promise.resolve();
		await Promise.resolve();

		expect(promptCalls.length).toBe(1);
		expect(promptCalls[0].text).toBe("ship it");
	});
});

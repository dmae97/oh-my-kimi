/**
 * Global, debounced batch queue for tool-initiated `retain` calls.
 *
 * The `retain` tool used to block on a single-item HTTP round trip per
 * invocation. Now it pushes onto a per-session queue and returns immediately;
 * a flush fires when:
 *   1. the queue reaches `FLUSH_BATCH_SIZE`, or
 *   2. `FLUSH_INTERVAL_MS` elapses since the queue first became non-empty.
 *
 * On batch failure we surface a UI-only notice via `session.emitNotice` —
 * a single yellow "Hindsight: memory retention failed …" line in the TUI.
 * The LLM is NOT told; the agent already received "Memory queued" and has
 * moved on. This is purely so the user knows their facts didn't persist.
 *
 * Auto-retain (`retainSession` in backend.ts) is intentionally NOT routed
 * through this queue — it submits a full transcript as one large item and
 * already runs `async: true` server-side.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { getHindsightSessionState, type HindsightSessionState } from "./backend";
import { ensureBankMission } from "./bank";
import type { MemoryItemInput } from "./client";

const FLUSH_BATCH_SIZE = 16;
const FLUSH_INTERVAL_MS = 5_000;

interface PendingItem {
	content: string;
	context?: string;
}

interface SessionQueue {
	items: PendingItem[];
	timer?: NodeJS.Timeout;
	/** Currently in-flight flush; subsequent flushes await it before running. */
	flushing?: Promise<void>;
}

const QUEUES = new Map<string, SessionQueue>();

/** Push a memory item onto the session's retain queue. Returns immediately. */
export function enqueueRetain(sessionId: string, content: string, context?: string): void {
	const queue = QUEUES.get(sessionId) ?? createQueue(sessionId);
	queue.items.push({ content, context });

	if (queue.items.length >= FLUSH_BATCH_SIZE) {
		void flushSessionQueue(sessionId);
		return;
	}
	if (!queue.timer) {
		queue.timer = setTimeout(() => {
			void flushSessionQueue(sessionId);
		}, FLUSH_INTERVAL_MS);
		// Don't pin the event loop alive just for a pending retain flush.
		queue.timer.unref?.();
	}
}

/** Flush a single session's queue. Safe to call when empty or already in flight. */
export async function flushSessionQueue(sessionId: string): Promise<void> {
	const queue = QUEUES.get(sessionId);
	if (!queue) return;

	if (queue.timer) {
		clearTimeout(queue.timer);
		queue.timer = undefined;
	}

	if (queue.flushing) {
		// Coalesce: wait for the in-flight flush, then drain anything that
		// landed after it started so we don't strand items.
		await queue.flushing;
		if (queue.items.length > 0) {
			await flushSessionQueue(sessionId);
		}
		return;
	}

	if (queue.items.length === 0) {
		QUEUES.delete(sessionId);
		return;
	}

	const items = queue.items.splice(0);
	const flushPromise = doFlush(sessionId, items);
	queue.flushing = flushPromise;
	try {
		await flushPromise;
	} finally {
		queue.flushing = undefined;
		if (queue.items.length === 0 && !queue.timer) {
			QUEUES.delete(sessionId);
		}
	}
}

/** Flush every pending session queue. Called from `clear`/`enqueue` backend hooks. */
export async function flushAllRetainQueues(): Promise<void> {
	const ids = [...QUEUES.keys()];
	await Promise.all(ids.map(id => flushSessionQueue(id)));
}

/** Test helper: clear timers and pending items without triggering flushes. */
export function clearRetainQueueForTest(): void {
	for (const queue of QUEUES.values()) {
		if (queue.timer) clearTimeout(queue.timer);
	}
	QUEUES.clear();
}

/** Test helper: peek at queued count for a session. */
export function getRetainQueueDepthForTest(sessionId: string): number {
	return QUEUES.get(sessionId)?.items.length ?? 0;
}

async function doFlush(sessionId: string, items: PendingItem[]): Promise<void> {
	const state = getHindsightSessionState(sessionId);
	if (!state) {
		// Session went away before we could flush. We can't notify anyone, so
		// log and drop — these are best-effort facts, not transactional writes.
		logger.warn("Hindsight retain queue: session vanished, dropping batch", {
			sessionId,
			items: items.length,
		});
		return;
	}

	try {
		await ensureBankMission(state.client, state.bankId, state.config, state.missionsSet);
		const batch: MemoryItemInput[] = items.map(item => ({
			content: item.content,
			context: item.context ?? state.config.retainContext,
			metadata: { session_id: sessionId },
			tags: state.retainTags,
		}));
		await state.client.retainBatch(state.bankId, batch, { async: true });
		if (state.config.debug) {
			logger.debug("Hindsight retain queue: batch flushed", {
				sessionId,
				bankId: state.bankId,
				items: items.length,
			});
		}
	} catch (err) {
		const errorText = err instanceof Error ? err.message : String(err);
		logger.warn("Hindsight retain queue: batch flush failed", {
			sessionId,
			bankId: state.bankId,
			items: items.length,
			error: errorText,
		});
		notifyRetainFailure(state, items.length, errorText);
	}
}

function notifyRetainFailure(state: HindsightSessionState, count: number, errorText: string): void {
	const noun = count === 1 ? "memory" : "memories";
	state.session.emitNotice("warning", `Memory retention failed for ${count} ${noun}: ${errorText}`, "Hindsight");
}

function createQueue(sessionId: string): SessionQueue {
	const queue: SessionQueue = { items: [] };
	QUEUES.set(sessionId, queue);
	return queue;
}

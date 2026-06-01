/**
 * Keepalive for in-flight host-side eval bridge calls.
 *
 * The eval watchdog ({@link ../tools/eval IdleTimeout}) caps a cell's `timeout`
 * as a wall-clock budget on the cell's *own* work, but pauses that budget while
 * a host-side `agent()`/`parallel()` (via `runSubprocess`) or `llm()` (a single
 * completion) call is in flight. Those calls are the only thing that re-arms the
 * watchdog — and they can run for long stretches with **no** status of their own
 * (a subagent's time-to-first-token on a reasoning model, a long quiet nested
 * tool, or the entire body of a oneshot `llm()` call). Without a keepalive the
 * watchdog would mistake that delegated work for the cell stalling and abort it
 * mid-flight, killing the subagent.
 *
 * {@link withBridgeHeartbeat} bridges that gap by emitting a synthetic
 * {@link EVAL_HEARTBEAT_OP} status event immediately when the call begins and
 * then on a fixed cadence until it settles. The event rides the same
 * `emitStatus → onStatus` channel both runtimes already forward, so it re-arms
 * the watchdog without any new plumbing. The heartbeat is the *sole* signal that
 * extends the budget: consumers MUST treat it as a pure keepalive — bump the
 * watchdog and drop it (never persist or render it) — see the executor display
 * sinks and the eval tool's `onStatus` handler. Every other status event
 * (compute helpers, `log()`/`phase()`, tool results) counts against the budget.
 */
import type { JsStatusEvent } from "./js/shared/types";

/**
 * Synthetic status op emitted purely to keep the eval idle watchdog alive while
 * a host-side bridge call is in flight. Carries no payload.
 */
export const EVAL_HEARTBEAT_OP = "heartbeat";

/**
 * Heartbeat cadence. Comfortably below the default 30s idle budget (and the
 * larger budgets long fanouts run under), so a working bridge call always bumps
 * the watchdog before it expires, while a genuine stall is still bounded once
 * the call settles and the heartbeat stops.
 */
const HEARTBEAT_INTERVAL_MS = 5_000;

let heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;

/**
 * Test seam: override the heartbeat cadence so integration tests can exercise
 * the keepalive within a sub-second idle budget. Pass no value to restore the
 * production default.
 */
export function setBridgeHeartbeatIntervalMs(ms?: number): void {
	heartbeatIntervalMs = ms === undefined ? HEARTBEAT_INTERVAL_MS : Math.max(1, Math.floor(ms));
}

/**
 * Run {@link operation}, pumping {@link EVAL_HEARTBEAT_OP} status events through
 * {@link emitStatus} — one immediately, then on a fixed cadence — until it
 * settles. The immediate beat pauses the watchdog the instant the call begins,
 * so a bridge call that starts close to the budget edge (after the cell already
 * spent most of it computing) is not aborted before the first interval tick. A
 * no-op wrapper when no `emitStatus` sink is wired (the heartbeat would reach
 * nobody).
 */
export async function withBridgeHeartbeat<T>(
	emitStatus: ((event: JsStatusEvent) => void) | undefined,
	operation: () => Promise<T>,
): Promise<T> {
	if (!emitStatus) return operation();
	emitStatus({ op: EVAL_HEARTBEAT_OP });
	const timer = setInterval(() => emitStatus({ op: EVAL_HEARTBEAT_OP }), heartbeatIntervalMs);
	// Never keep the event loop alive for the heartbeat alone.
	timer.unref?.();
	try {
		return await operation();
	} finally {
		clearInterval(timer);
	}
}

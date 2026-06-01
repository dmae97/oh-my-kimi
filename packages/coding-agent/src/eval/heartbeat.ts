/**
 * Keepalive for in-flight host-side eval bridge calls.
 *
 * The eval idle watchdog ({@link ../tools/eval IdleTimeout}) treats a cell's
 * `timeout` as an *inactivity* budget and only re-arms when a status event
 * reaches it. Host-side bridge helpers — `agent()`/`parallel()` (via
 * `runSubprocess`) and `llm()` (a single completion) — can legitimately run for
 * long stretches with **no** intermediate status: a subagent's time-to-first
 * token on a reasoning model, a long quiet nested tool, or the entire body of a
 * oneshot `llm()` call. Without a keepalive the watchdog mistakes that work for
 * a stall and aborts the cell mid-flight, killing the subagent.
 *
 * {@link withBridgeHeartbeat} fixes that by pumping a synthetic
 * {@link EVAL_HEARTBEAT_OP} status event on a fixed cadence while the wrapped
 * operation is pending. The event rides the same `emitStatus → onStatus` channel
 * both runtimes already forward, so it re-arms the watchdog without any new
 * plumbing. Consumers MUST treat the heartbeat as a pure keepalive: bump the
 * watchdog and drop it (never persist or render it) — see the executor display
 * sinks and the eval tool's `onStatus` handler.
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
 * {@link emitStatus} on a fixed cadence until it settles. A no-op wrapper when
 * no `emitStatus` sink is wired (the heartbeat would reach nobody).
 */
export async function withBridgeHeartbeat<T>(
	emitStatus: ((event: JsStatusEvent) => void) | undefined,
	operation: () => Promise<T>,
): Promise<T> {
	if (!emitStatus) return operation();
	const timer = setInterval(() => emitStatus({ op: EVAL_HEARTBEAT_OP }), heartbeatIntervalMs);
	// Never keep the event loop alive for the heartbeat alone.
	timer.unref?.();
	try {
		return await operation();
	} finally {
		clearInterval(timer);
	}
}

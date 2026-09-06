/**
 * Observational listener delivery for `Agent`.
 *
 * Kept as a leaf module (no agent state, no loop imports) so the delivery
 * contract stays readable next to the harness' own `SubscriberFanout`.
 */

import { createImmutableSnapshot } from "./tool-execution-boundary.ts";
import type { AgentEvent } from "./types.ts";

export type AgentListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

/**
 * Deliver `event` to every listener in subscription order, then raise the
 * failures together.
 *
 * Observation listeners must not starve each other: a throwing extension cannot
 * hide `agent_start`, `turn_end`, or `agent_end` from the listeners registered
 * after it. A single failure surfaces untouched so its own classification
 * survives; several become one `AggregateError`.
 *
 * Each listener receives its own immutable snapshot, so one observer's view can
 * never be rewritten into another's.
 */
export async function deliverToListeners(
	listeners: Iterable<AgentListener>,
	event: AgentEvent,
	signal: AbortSignal,
): Promise<void> {
	const failures: unknown[] = [];
	for (const listener of listeners) {
		try {
			await listener(createImmutableSnapshot(event), signal);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) {
		throw new AggregateError(failures, `${failures.length} agent listeners failed for ${event.type}`);
	}
}

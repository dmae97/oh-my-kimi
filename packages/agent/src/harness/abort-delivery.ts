/**
 * Pure abort-delivery vocabulary, extracted from `AgentHarness`.
 *
 * Aborting has two halves that callers need separately: delivering the signal
 * (safe from anywhere, including an operation's own callbacks, because it never
 * waits) and waiting for the target's settlement (which a callback of that same
 * operation must never do — settlement awaits the callback). Keeping the refusal
 * table and the delivery description here means the oversized harness module only
 * gains thin delegation, and the rules stay testable without a harness instance.
 */

import { AgentHarnessError } from "./errors.ts";
import type { HarnessAbortCapture } from "./operation-lifecycle-controller.ts";
import type { HarnessLifecycleState, HarnessOperationKind } from "./operation-lifecycle-types.ts";

/** What one abort-signal delivery did, without waiting for anything. */
export interface AbortSignalDeliveryResult {
	/** The operation the signal targeted, when one was active or settling. */
	readonly operationId?: string;
	/** True only when the abort signal was newly delivered to that operation. */
	readonly signalDelivered: boolean;
	/** True when the target was already settling, so no signal could be delivered. */
	readonly alreadySettling: boolean;
}

/**
 * Operations that refuse an abort: cancelling them mid-flight would leave their
 * work half-applied, so the caller gets an explicit `invalid_state` instead.
 */
const ABORT_REFUSED_OPERATIONS: ReadonlyMap<HarnessOperationKind, string> = new Map([
	["manual_compaction", "Cannot abort during compaction"],
	["tree_navigation", "Cannot abort during branch_summary"],
]);

/** Throw when the active operation is one that refuses an abort. */
export function assertAbortAllowed(snapshot: Readonly<HarnessLifecycleState>): void {
	if (snapshot.tag !== "active") return;
	const refused = ABORT_REFUSED_OPERATIONS.get(snapshot.operation.kind);
	if (refused !== undefined) throw new AgentHarnessError("invalid_state", refused);
}

/** Describe one captured abort delivery for a public, wait-free result. */
export function describeAbortDelivery(capture: HarnessAbortCapture): AbortSignalDeliveryResult {
	return {
		...(capture.target === undefined ? {} : { operationId: capture.target.operation.operationId }),
		signalDelivered: capture.signalDelivered,
		alreadySettling: capture.target !== undefined && !capture.signalDelivered,
	};
}

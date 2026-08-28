import type { FinalizedToolCallOutcome } from "./tool-execution-boundary.ts";

/** Bounded OS/event-loop teardown window paid only after a tool timeout. */
export const DEFAULT_TOOL_TEARDOWN_GRACE_MS = 250;

/** Return true when a timed-out tool is still active after the teardown window. */
export async function hasUnsettledTimeout(finalizedCalls: readonly FinalizedToolCallOutcome[]): Promise<boolean> {
	const stillRunning = () =>
		finalizedCalls.some(
			(finalized) => finalized.envelope.disposition === "timeout" && finalized.isRealPromiseSettled?.() === false,
		);
	const deadline = Date.now() + DEFAULT_TOOL_TEARDOWN_GRACE_MS;
	while (Date.now() < deadline && stillRunning()) await new Promise((resolve) => setTimeout(resolve, 5));
	return stillRunning();
}

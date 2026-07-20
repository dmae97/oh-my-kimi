/**
 * Host-side handler for the eval `parallel()` / `pipeline()` worker pool.
 *
 * The pool ceiling is not a kernel-side knob: it tracks the `task.maxConcurrency`
 * setting so an eval fan-out runs as wide as a `task` tool batch would. `0` means
 * unbounded — run every item at once, exactly like `task.maxConcurrency = 0`.
 */
import type { ToolSession } from "../tools";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic bridge name reserved for the parallel-pool ceiling across both runtimes. */
export const EVAL_CONCURRENCY_BRIDGE_NAME = "__concurrency__";

export interface EvalConcurrencyBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalConcurrencyResult {
	/** Worker-pool ceiling; `0` means unbounded (run every item at once). */
	limit: number;
}

/**
 * Resolve the worker-pool ceiling for an eval cell's `parallel()`/`pipeline()`
 * helpers from the live `task.maxConcurrency` setting. Negative/non-finite
 * values collapse to `0` (unbounded), matching the `task` tool's own handling.
 */
export function runEvalConcurrency(_args: unknown, options: EvalConcurrencyBridgeOptions): EvalConcurrencyResult {
	const raw = options.session.settings.get("task.maxConcurrency");
	const limit = Number.isFinite(raw) ? Math.trunc(raw) : 0;
	return { limit: limit > 0 ? limit : 0 };
}

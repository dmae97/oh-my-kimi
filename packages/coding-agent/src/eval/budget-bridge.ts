/**
 * Host-side handler for the eval `budget` helper.
 *
 * Reports the active token ceiling and amount spent so kernel helpers can
 * compute remaining budget. When Goal Mode is active the figures come from the
 * goal's `tokenBudget`/`tokensUsed`; otherwise there is no ceiling and `spent`
 * falls back to cumulative session output tokens.
 */
import type { ToolSession } from "../tools";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic bridge name reserved for the `budget` helper across both runtimes. */
export const EVAL_BUDGET_BRIDGE_NAME = "__budget__";

export interface EvalBudgetBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalBudgetResult {
	total: number | null;
	spent: number;
}

/**
 * Resolve the current token budget snapshot for an eval cell's `budget` helper.
 * The returned object is JSON-passed verbatim by the bridge transport; kernel
 * helpers read `.total`/`.spent` directly.
 */
export async function runEvalBudget(_args: unknown, options: EvalBudgetBridgeOptions): Promise<EvalBudgetResult> {
	const goal = options.session.getGoalModeState?.();
	if (goal?.enabled && goal.goal) {
		return { total: goal.goal.tokenBudget ?? null, spent: goal.goal.tokensUsed ?? 0 };
	}
	const usage = options.session.getUsageStatistics?.();
	return { total: null, spent: usage?.output ?? 0 };
}

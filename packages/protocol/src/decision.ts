import { PROTOCOL_VERSION, type RuntimeAction, type RuntimeDecision, type RuntimeDecisionInput } from "./types.ts";
import { parseEvaluationResult, parseRuntimeDecision } from "./validation.ts";

function policyAction(input: RuntimeDecisionInput): RuntimeAction {
	if (input.evaluation.semanticVerdict === "pass") return "stop";
	return input.evaluation.semanticVerdict === "fail" ? input.policy.onFail : input.policy.onInconclusive;
}

/** Pure EvaluationResult -> RuntimeDecision reduction. */
export function reduceRuntimeDecision(input: RuntimeDecisionInput): RuntimeDecision {
	parseEvaluationResult(input.evaluation);
	return parseRuntimeDecision(
		Object.freeze({
			schemaVersion: PROTOCOL_VERSION,
			decisionId: input.decisionId,
			taskId: input.evaluation.taskId,
			attemptId: input.evaluation.attemptId,
			evaluationId: input.evaluation.evaluationId,
			decidedAt: input.decidedAt,
			action: policyAction(input),
			reasonCode: `evaluation.${input.evaluation.semanticVerdict}`,
		}),
	);
}

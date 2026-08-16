export const PROTOCOL_VERSION = "omk.run.v1" as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
	readonly [key: string]: JsonValue;
}

export type RequirementLevel = "required" | "advisory";
export type SemanticVerdict = "pass" | "fail" | "inconclusive";
export type ClaimResult = "satisfied" | "violated" | "inconclusive";
export type RuntimeAction = "continue" | "retry" | "failover" | "stop";

export interface ObservationCondition {
	readonly kind: "observation";
	readonly observationKind: string;
	readonly scope: "attempt" | "task";
	readonly facts: JsonObject;
}

export interface AllCondition {
	readonly kind: "all";
	readonly conditions: readonly ClaimCondition[];
}

export interface AnyCondition {
	readonly kind: "any";
	readonly conditions: readonly ClaimCondition[];
}

export interface NotCondition {
	readonly kind: "not";
	readonly condition: ClaimCondition;
}

export type ClaimCondition = ObservationCondition | AllCondition | AnyCondition | NotCondition;

export interface ClaimPredicate {
	readonly claimId: string;
	readonly statement: string;
	readonly requirement: RequirementLevel;
	readonly condition: ClaimCondition;
}

export interface TaskSpec {
	readonly schemaVersion: ProtocolVersion;
	readonly taskId: string;
	readonly goal: string;
	readonly createdAt: string;
	readonly claims: readonly ClaimPredicate[];
}

export type AttemptTrigger = "initial" | "retry" | "failover" | "resume";

export interface AttemptExecutor {
	readonly kind: string;
	readonly provider?: string;
	readonly model?: string;
}

export type AttemptOutcome =
	| { readonly kind: "completed" }
	| { readonly kind: "failed"; readonly code: string; readonly message?: string }
	| { readonly kind: "cancelled"; readonly code: string };

/** One completed execution. Retry and failover counts are derived from these records. */
export interface ExecutionAttempt {
	readonly schemaVersion: ProtocolVersion;
	readonly attemptId: string;
	readonly taskId: string;
	readonly sequence: number;
	readonly trigger: AttemptTrigger;
	readonly previousAttemptId?: string;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly executor: AttemptExecutor;
	readonly outcome: AttemptOutcome;
}

/** Immutable execution facts. Semantic pass/fail belongs only in ClaimEvaluation. */
export interface Observation {
	readonly schemaVersion: ProtocolVersion;
	readonly observationId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly observedAt: string;
	readonly kind: string;
	readonly source: {
		readonly kind: string;
		readonly id: string;
	};
	readonly facts: JsonObject;
	readonly evidenceRefs: readonly string[];
}

export interface WaiverRecord {
	readonly schemaVersion: ProtocolVersion;
	readonly waiverId: string;
	readonly scope: {
		readonly taskId: string;
		readonly claimId: string;
		readonly attemptId?: string;
	};
	readonly approvedBy: string;
	readonly approvedAt: string;
	readonly expiresAt?: string;
	readonly rationale: string;
	readonly evidenceRefs: readonly string[];
}

export type ClaimReasonCode = "claim.satisfied" | "claim.violated" | "claim.observation_missing";

export interface ClaimEvaluation {
	readonly claimId: string;
	readonly requirement: RequirementLevel;
	readonly result: ClaimResult;
	readonly reasonCode: ClaimReasonCode;
	readonly observationIds: readonly string[];
	readonly waiverId?: string;
}

export interface EvaluationResult {
	readonly schemaVersion: ProtocolVersion;
	readonly evaluationId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly evaluatedAt: string;
	readonly claims: readonly ClaimEvaluation[];
	readonly semanticVerdict: SemanticVerdict;
}

export interface EvaluationInput {
	readonly evaluationId: string;
	readonly evaluatedAt: string;
	readonly taskSpec: TaskSpec;
	readonly attempt: ExecutionAttempt;
	readonly observations: readonly Observation[];
	readonly waivers?: readonly WaiverRecord[];
}

export interface RuntimeDecisionPolicy {
	readonly onFail: RuntimeAction;
	readonly onInconclusive: RuntimeAction;
}

export type RuntimeDecisionReason = "evaluation.pass" | "evaluation.fail" | "evaluation.inconclusive";

export interface RuntimeDecision {
	readonly schemaVersion: ProtocolVersion;
	readonly decisionId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly evaluationId: string;
	readonly decidedAt: string;
	readonly action: RuntimeAction;
	readonly reasonCode: RuntimeDecisionReason;
}

export interface RuntimeDecisionInput {
	readonly decisionId: string;
	readonly decidedAt: string;
	readonly evaluation: EvaluationResult;
	readonly policy: RuntimeDecisionPolicy;
}

/**
 * Reasoning-router v4 — frozen types and calibratable weight schema.
 *
 * Pure, side-effect-free, erasable TypeScript. No runtime imports. This file
 * owns the closed task/lane unions, named scorer weights, and calibrated default
 * preset used by `/think auto`.
 *
 * `keywordFamily` is the class -> weight table for whole-prompt keyword-family
 * patterns (see reasoning-router-v4.ts). `trivial` carries weight 0 because it
 * is reached only via the zero-score fallback cascade.
 *
 * `secondClauseIntent` applies a bounded bonus when a second, distinct leading
 * verb is found after a short-range conjunction split. `negationWindowChars`
 * bounds negation gating so a nearby "don't/skip/without/no need" cue can
 * suppress a whole-prompt signal without crossing a clause boundary.
 *
 * `lowConfidenceThreshold` / `highConfidenceThreshold` bound the confidence
 * bands (`ClassifierVerdictV4.confidenceBand`) computed from score separation
 * plus absolute evidence strength in reasoning-router-v4.ts. They are
 * metadata-only: they never change `taskClass`, only how
 * `resolveThinkingLevelV4WithUncertainty` treats an already-decided class.
 */

/** Closed set of v4 task classes. */
export type TaskClassV4 = "trivial" | "simple-edit" | "code-gen" | "debug" | "refactor" | "review" | "plan";

/** Subagent lane types recognized by the v4 classifier and resolvers. */
export type ReasoningLaneTypeV4 = "planner" | "security" | "explorer" | "coder" | "reviewer" | "tester";

/** Fixed iteration order over TaskClassV4 (matches the type-declaration order; also v4's argmax tie-break precedence, highest first). */
export const TASK_CLASSES_V4: readonly TaskClassV4[] = [
	"debug",
	"refactor",
	"review",
	"plan",
	"simple-edit",
	"code-gen",
	"trivial",
];

/**
 * Named weight schema for the v4 scorer (reasoning-router-v4.ts). Every field
 * is a plain, deterministic integer/ratio; there is no clock, randomness, or
 * I/O anywhere in this file or its consumer.
 */
export interface RouterWeightsV4 {
	/** Bump to "code-gen" when a code fence or diff hunk is present. */
	readonly codeFenceOrDiff: number;
	/** Bump to the primary leading-clause intent class, if any. */
	readonly leadingIntent: number;
	/** Bump to a distinct second-clause intent class in a detected compound prompt (v4-new; default half of `leadingIntent`). */
	readonly secondClauseIntent: number;
	/** Bump to "simple-edit" when the composite local-edit feature fires. */
	readonly localEdit: number;
	/** Bump to "debug" when the composite diagnostic-evidence feature fires. */
	readonly diagnosticEvidence: number;
	/** Bump to "review" when the composite review-scope feature fires. */
	readonly reviewScope: number;
	/** Bump to "plan" when the composite plan-brief feature fires. */
	readonly planBrief: number;
	/** Bump to "plan" for release-bound operational runbooks (commit/push/tag/publish/changelog/CI bundles). */
	readonly operationalRunbook: number;
	/** Bump to "refactor" when the refactor-cue pattern matches anywhere in the prompt. */
	readonly refactorCue: number;
	/** Bump to "code-gen" when an implementation-object noun is present. */
	readonly implementationObject: number;
	/** Bump to "code-gen" when a first-person request names a code artifact (for example, "I need a script"). */
	readonly codeGenArtifactRequest: number;
	/** Bump to "review" when a leading review request names an evaluative object such as holes/regressions/issues. */
	readonly evaluativeReviewObject: number;
	/** Per-class whole-prompt keyword-family bump; trivial has no family, 0. */
	readonly keywordFamily: Readonly<Record<TaskClassV4, number>>;
	/** Bump to a class when normalized seed->cluster anchors match (medium generalized evidence). */
	readonly normalizedIntentCluster: number;
	/** Bump to a class when the bounded intent-skeleton extractor matches (medium generalized evidence). */
	readonly intentSkeleton: number;
	/** Bump to "code-gen" for a bare "add" keyword, gated by !localEdit. */
	readonly addKeyword: number;
	/** Bump to the class matching `history[0]`, if supplied (v4-new; 0 under DEFAULT_WEIGHTS_V4, inert until calibrated). */
	readonly multiTurnPrior: number;
	/** Linear per-bucket bump applied to debug/review/plan under context pressure (v4-new; 0 under DEFAULT_WEIGHTS_V4, inert until calibrated). */
	readonly pressureBucket: number;
	/** Bump to the class matching an externally supplied judge vote, if any (v4-new; 0 under DEFAULT_WEIGHTS_V4, inert until calibrated). */
	readonly judgeVote: number;
	/** Bounded look-back window (characters) for negation-cue gating, never crossing a .,;!? boundary. */
	readonly negationWindowChars: number;
	/** confidence <= this value bands as "low" (confidence combines score separation and evidence strength). */
	readonly lowConfidenceThreshold: number;
	/** confidence >= this value bands as "high". */
	readonly highConfidenceThreshold: number;
}

/**
 * Calibrated default preset. The named weights below are the production v4
 * scorer configuration covered by
 * test/suite/regressions/013-reasoning-router-v4-accuracy.test.ts. Extension
 * fields (`multiTurnPrior`, `pressureBucket`, `judgeVote`) are wired but inert
 * until a future calibration changes them.
 */
export const DEFAULT_WEIGHTS_V4: RouterWeightsV4 = {
	codeFenceOrDiff: 4,
	leadingIntent: 8,
	secondClauseIntent: 4,
	localEdit: 7,
	diagnosticEvidence: 7,
	reviewScope: 3,
	planBrief: 8,
	operationalRunbook: 8,
	refactorCue: 6,
	implementationObject: 3,
	codeGenArtifactRequest: 5,
	evaluativeReviewObject: 3,
	keywordFamily: {
		trivial: 0,
		"simple-edit": 4,
		"code-gen": 4,
		debug: 4,
		refactor: 4,
		review: 4,
		plan: 4,
	},
	normalizedIntentCluster: 4,
	intentSkeleton: 5,
	addKeyword: 1,
	// Goal 016/L2 calibration (scripts/reasoning-router/calibrate-inert-weights.ts):
	// adversarial bounds on the frozen gold set after the topScore>0 vote gate —
	// multiTurnPrior/judgeVote flip at 4 (gold-0066), pressureBucket at 2.
	// multiTurnPrior=2 / judgeVote=2 sit one step below the bound; pressureBucket=1
	// is provably safe because the runtime bucket is hard-clamped to <= 3, so the
	// max possible bump (+3) stays under the flip threshold (+6).
	multiTurnPrior: 2,
	pressureBucket: 1,
	judgeVote: 2,
	negationWindowChars: 24,
	lowConfidenceThreshold: 0.35,
	highConfidenceThreshold: 0.7,
};

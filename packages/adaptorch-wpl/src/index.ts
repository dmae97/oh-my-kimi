/**
 * Public entry point for `omk-adaptorch-wpl` (stable since 0.91.0).
 *
 * See README.md and `.omk/runs/adaptorch-native-loop-algorithm-20260701/final-part{1,2,3}-*.md`
 * for the design this package implements. Ships as a runtime dependency of the
 * `open-multi-agent-kit` CLI.
 */

export type { AdaptOrchTransport } from "./adaptorch-client.ts";
export { AdaptOrchClient } from "./adaptorch-client.ts";
export type { AdjudicationRequest, AdjudicationResult, PerRunVerdict } from "./adjudicator.ts";
export { adjudicate } from "./adjudicator.ts";
export type {
	AdjudicationReasonCode,
	CheckResult,
	VerdictState,
	VerifierRegistryEntry,
} from "./adjudicator-registry.ts";
export {
	ADJUDICATION_REASON_CODES,
	createVerifierRegistry,
	DEFAULT_VERIFIER,
	reduceReasonCodes,
} from "./adjudicator-registry.ts";
export type { MapToB2CInput, MapToB2COutput } from "./b2c-mapper.ts";
export { BATCH1_NO_DOCKER_RUNNER, mapToB2C } from "./b2c-mapper.ts";
export type {
	UserRiskLevel,
	UserVerdict,
	VerdictCard,
	VerdictLimits,
	VerdictNextAction,
	VerificationReceipt,
} from "./b2c-verdict.ts";
export { B2C_VERDICT_SCHEMA_VERSION } from "./b2c-verdict.ts";
export type {
	DeepWallPhase,
	DeepWallResult,
	DeepWallRunnerEvidence,
	DeepWallRunnerFn,
	DeepWallRunnerResult,
	DeepWallStatus,
	DeepWallStubResult,
	RunDeepWallStubParams,
} from "./deep-wall.ts";
export {
	DEEP_RUNNER_ERROR,
	DEEP_RUNNER_EVIDENCE_MISSING,
	DEEP_RUNNER_NOT_WIRED,
	DEEP_WALL_UNAVAILABLE,
	isDeepRunnerCompletionAllowed,
	resolveDeepWallPhaseFromEnv,
	runDeepWall,
	runDeepWallStub,
} from "./deep-wall.ts";
export type {
	EvaluateCorrectnessWallParams,
	EvaluateCorrectnessWallResult,
} from "./evaluate-correctness-wall.ts";
export { evaluateCorrectnessWall } from "./evaluate-correctness-wall.ts";
export type { InMemoryAdaptOrchFixture } from "./in-memory-adaptorch.ts";
export { createInMemoryAdaptOrchClient } from "./in-memory-adaptorch.ts";
export type { AdaptOrchCallToolFn, OaTransportMode } from "./live-adaptorch-transport.ts";
export { createLiveAdaptOrchClient, parseOaTransportModeFromEnv } from "./live-adaptorch-transport.ts";
export type { NextActionKind, VerdictDisposition } from "./loop.ts";
export {
	decideNextTransition,
	handleAdjudicationFailure,
	projectVerdictToDisposition,
	runAdjudicationWithTimeout,
} from "./loop.ts";
export type {
	CreateMcpIntrospectionTransportOptions,
	McpIntrospectionMode,
} from "./mcp-introspection-transport.ts";
export { createMcpIntrospectionClient } from "./mcp-introspection-transport.ts";
export type { PolicyFlag } from "./policy-wall.ts";
export {
	POLICY_FLAG,
	parseDiffPaths,
	pathMatchesApprovedScope,
	runFastWall,
	scanDiffLinesForSecrets,
} from "./policy-wall.ts";
export type { SignedWallReceipt, SignWallReceiptInput, VerifyWallReceiptInput } from "./receipt-signature.ts";
export { signWallReceipt, verifyWallReceipt } from "./receipt-signature.ts";
export type { BuildRegeneratePacketInput, RegeneratePacket } from "./regenerate-packet.ts";
export { buildRegeneratePacket } from "./regenerate-packet.ts";
export type { RepairBudgetState } from "./repair-budget.ts";
export { capRepairHints, parseRepairBudget, shouldOfferRepair } from "./repair-budget.ts";
export type { RepairHintInput } from "./repair-loop.ts";
export { deriveRepairHints } from "./repair-loop.ts";
export type {
	VerificationDigest,
	VerificationDigestInput,
	WallReceiptMeta,
} from "./signed-receipt.ts";
export { buildVerificationDigest } from "./signed-receipt.ts";
export { applyTransition, canTransition, isTerminalState, requiresHumanApproval } from "./state-machine.ts";
export type {
	CardinalityMode,
	DispatchRecord,
	LoopConfig,
	LoopTerminationCondition,
	TopologyClassification,
	TransitionLogEntry,
	WorkPacket,
	WorkPacketState,
} from "./types.ts";
export { ADJUDICATIONS_DIR, LOOP_STATE_FILE, PACKET_INDEX_FILE, PACKETS_DIR, RUN_MAP_FILE } from "./types.ts";
export { CORRECTNESS_WALL_VERSION } from "./wall-meta.ts";

export type LoopLevel = "L1" | "L2" | "L3";

export type LoopStatus = "ready" | "active" | "paused" | "retired";

export type LoopRunCause = "schedule" | "manual" | "event";

export type LoopScheduleMode = "manual" | "interval" | "event";

export type LoopWorktreeIsolationMode = "none" | "per-run" | "per-item";

export type LoopWorktreeCleanupPolicy = "after-run" | "after-merge" | "manual";

export type LoopCapabilityAccess = "required" | "optional";

export type LoopConnectorKind = "mcp" | "connector";

export type LoopSubagentRoleKind = "maker" | "checker" | "scout" | "planner";

export type LoopRunOutcome =
	| "report-only"
	| "fix-proposed"
	| "no-op"
	| "escalated"
	| "budget-blocked"
	| "collision-skipped"
	| "verifier-failed"
	| "killed";

export type LoopWorkItemStatus =
	| "new"
	| "watch"
	| "reported"
	| "claimed"
	| "executing"
	| "verifying"
	| "accepted"
	| "escalated"
	| "closed";

export type LoopWorkItemRisk = "low" | "medium" | "high";

export type LoopWorkItemSource = "ci" | "pr" | "issue" | "state" | "manual" | "docs";

export interface LoopWatchedScope {
	readonly repos: readonly string[];
	readonly branches?: readonly string[];
	readonly paths?: readonly string[];
	readonly tickets?: readonly string[];
}

export interface LoopBudgetPolicy {
	readonly maxRunsPerDay: number;
	readonly maxTokensPerDay: number;
	readonly maxSubagentsPerRun: number;
	readonly maxAttemptsPerItem: number;
	readonly maxAutoPrsPerDay?: number;
	readonly slowDownAtRatio?: number;
}

export interface LoopSafetyPolicy {
	readonly requireIndependentVerifier: boolean;
	readonly requireHumanGateForHighRisk: boolean;
	readonly allowedWriteScopes: readonly string[];
	readonly deniedWriteScopes?: readonly string[];
	readonly maxWriteScopeCount?: number;
}

export interface LoopSchedulePolicy {
	readonly mode: LoopScheduleMode;
	readonly cadence: string;
	readonly shortestIntervalMinutes: number;
	readonly runOn: readonly LoopRunCause[];
	readonly jitterMinutes?: number;
}

export interface LoopWorktreeIsolationPolicy {
	readonly mode: LoopWorktreeIsolationMode;
	readonly branchPrefix?: string;
	readonly baseRef?: string;
	readonly cleanup: LoopWorktreeCleanupPolicy;
	readonly requireCleanCheckout: boolean;
	readonly maxConcurrentWorktrees?: number;
}

export interface LoopSkillBinding {
	readonly id: string;
	readonly purpose: string;
	readonly access: LoopCapabilityAccess;
	readonly triggerKeywords?: readonly string[];
}

export interface LoopConnectorBinding {
	readonly id: string;
	readonly kind: LoopConnectorKind;
	readonly purpose: string;
	readonly access: LoopCapabilityAccess;
	readonly tools?: readonly string[];
}

export interface LoopSubagentRole {
	readonly id: string;
	readonly role: LoopSubagentRoleKind;
	readonly skills: readonly string[];
	readonly connectors: readonly string[];
	readonly independentFrom?: readonly string[];
}

export interface LoopSubagentPolicy {
	readonly maxParallel: number;
	readonly requireMakerChecker: boolean;
	readonly makerRole: string;
	readonly checkerRole?: string;
	readonly roles: readonly LoopSubagentRole[];
}

export interface LoopDurableStatePolicy {
	readonly statePath: string;
	readonly runLogPath: string;
	readonly budgetLedgerPath: string;
	readonly checkpointPath?: string;
	readonly retentionDays: number;
	readonly requireReplayableEvidence: boolean;
}

export interface LoopHumanGatePolicy {
	readonly gates: readonly string[];
	readonly requiredForRisks: readonly LoopWorkItemRisk[];
	readonly approvalRefsRequired: boolean;
	readonly escalationTargets?: readonly string[];
}

export interface LoopDefinition {
	readonly id: string;
	readonly pattern: string;
	readonly objective: string;
	readonly nonGoals: readonly string[];
	readonly level: LoopLevel;
	readonly watchedScope: LoopWatchedScope;
	readonly budget: LoopBudgetPolicy;
	readonly safety: LoopSafetyPolicy;
	readonly statePath: string;
	readonly runLogPath: string;
	readonly schedule?: LoopSchedulePolicy;
	readonly worktree?: LoopWorktreeIsolationPolicy;
	readonly skills?: readonly LoopSkillBinding[];
	readonly connectors?: readonly LoopConnectorBinding[];
	readonly subagents?: LoopSubagentPolicy;
	readonly durableState?: LoopDurableStatePolicy;
	readonly humanGates?: LoopHumanGatePolicy;
}

export interface LoopBudgetUsage {
	readonly runs: number;
	readonly tokensEstimate: number;
	readonly subagentSpawns: number;
	readonly autoPrs: number;
}

export interface LoopWorkItem {
	readonly id: string;
	readonly source: LoopWorkItemSource;
	readonly sourceRef: string;
	readonly title: string;
	readonly status: LoopWorkItemStatus;
	readonly risk: LoopWorkItemRisk;
	readonly actingOn: string;
	readonly firstSeenAt: string;
	readonly lastSeenAt: string;
	readonly attemptCount: number;
	readonly evidenceRefs: readonly string[];
	readonly lastFailureFingerprint?: string;
}

export interface LoopLease {
	readonly workItemId: string;
	readonly actingOn: string;
	readonly ownerRunId: string;
	readonly leaseExpiresAt: string;
}

export interface LoopState {
	readonly loopId: string;
	readonly status: LoopStatus;
	readonly lastRunAt?: string;
	readonly killSwitch?: boolean;
	readonly highPriority: readonly LoopWorkItem[];
	readonly watchList: readonly LoopWorkItem[];
	readonly humanInbox: readonly LoopWorkItem[];
	readonly recentNoise: readonly string[];
	readonly leases: readonly LoopLease[];
	readonly budgetUsedToday: LoopBudgetUsage;
}

export interface LoopBudgetEstimate {
	readonly runs: number;
	readonly tokensEstimate: number;
	readonly subagentSpawns: number;
	readonly autoPrs?: number;
}

export interface LoopBudgetReservation {
	readonly loopId: string;
	readonly reservationId: string;
	readonly estimate: LoopBudgetEstimate;
	readonly reservedAt: string;
}

export interface LoopRunLogEntry {
	readonly runId: string;
	readonly loopId: string;
	readonly pattern: string;
	readonly level: LoopLevel;
	readonly startedAt: string;
	readonly durationMs: number;
	readonly itemsFound: number;
	readonly actionsTaken: number;
	readonly escalations: number;
	readonly tokensEstimate: number;
	readonly budgetDelta: LoopBudgetUsage;
	readonly outcome: LoopRunOutcome;
	readonly stateRevision: string;
	readonly evidenceRefs: readonly string[];
	readonly inputSnapshotHash: string;
	readonly promptHash: string;
	readonly toolVersions: Readonly<Record<string, string>>;
}

export interface LoopStatePatch {
	readonly highPriority?: readonly LoopWorkItem[];
	readonly watchList?: readonly LoopWorkItem[];
	readonly humanInbox?: readonly LoopWorkItem[];
	readonly recentNoise?: readonly string[];
	readonly leases?: readonly LoopLease[];
	readonly budgetUsedToday?: LoopBudgetUsage;
	readonly lastRunAt?: string;
	readonly status?: LoopStatus;
}

export interface LoopValidationDiagnostic {
	readonly code: string;
	readonly message: string;
	readonly path?: string;
}

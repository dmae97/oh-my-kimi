/**
 * Evidence and verification types for OMK v0.80.3+
 *
 * Defines contracts for agent completion evidence, replay persistence,
 * merge gating, and artifact validation.
 */

// ============================================================================
// Evidence Contract
// ============================================================================

export type EvidenceCategory =
	| "feature"
	| "bugfix"
	| "refactor"
	| "research"
	| "release"
	| "security"
	| "docs"
	| "orchestration";

export type EvidenceStatus = "pending" | "gathering" | "satisfied" | "failed" | "waived";

export interface EvidenceItem {
	/** What this evidence proves. */
	claim: string;
	/** Category of the task. */
	category: EvidenceCategory;
	/** Path to artifact or command that produced it. */
	artifactPath?: string;
	/** Command that can reproduce the evidence. */
	verificationCommand?: string;
	/** SHA-256 of the artifact for integrity. */
	hash?: string;
	/** When the evidence was gathered. */
	timestamp: string;
	/** Whether the evidence is available. */
	status: EvidenceStatus;
	/** Receipt v3 metadata consumed by receipt-aware evidence gates. */
	receiptId?: string;
	receiptSchemaVersion?: 3;
	/** Domain-separated digest of the exact structured command descriptor. */
	receiptCommandSha256?: Sha256Hex;
	/** Lane that executed the verification command, when lane-scoped. */
	receiptLaneId?: string;
	/** Reason if evidence is missing or waived. */
	gapReason?: string;
}

export interface TaskContract {
	/** Unique task / goal identifier. */
	goalId: string;
	/** One-sentence completion claim. */
	completionClaim: string;
	/** Required evidence items. */
	requiredEvidence: EvidenceItem[];
	/** Remaining risk note. */
	finalRisk: string;
	/** Verdict: can the task be considered done? */
	verdict: "pass" | "fail" | "conditional";
	/** ISO-8601 timestamp of contract creation. */
	createdAt: string;
	/** ISO-8601 timestamp of last update. */
	updatedAt: string;
}

// ============================================================================
// Replay Ledger
// ============================================================================

export type ReplayEventType =
	| "session_start"
	| "tool_call"
	| "tool_result"
	| "message"
	| "guardrail_decision"
	| "lane_grant"
	| "merge_attempt"
	| "merge_blocked"
	| "evidence_gathered"
	| "evidence_receipt"
	| "contract_created"
	| "contract_updated"
	| "checkpoint"
	| "error"
	| "transcript_repaired"
	| "tool_timeout"
	| "tool_late_settlement"
	| "workspace_mutation";

/**
 * Payload contract for `workspace_mutation` replay events. Emitters live in the
 * agent runtime; evidence gates consume these fail-closed: an event whose payload
 * does not provably target other paths in the same workspace root is treated as
 * relevant to every scope.
 */
export interface WorkspaceMutationReplayPayload {
	/** Absolute workspace root the mutation applies to. */
	readonly root: string;
	/** Root-relative normalized paths that were mutated; empty means unknown/whole workspace. */
	readonly paths: readonly string[];
}

// ============================================================================
// Execution-bound evidence receipts (v3)
// ============================================================================

declare const SHA256_HEX_BRAND: unique symbol;

/** A validated lowercase SHA-256 digest encoded as exactly 64 hexadecimal characters. */
export type Sha256Hex = string & { readonly [SHA256_HEX_BRAND]: "sha256-hex" };

export interface ArgvCommandDescriptor {
	readonly kind: "argv";
	/** Exact executable identity supplied by the caller. */
	readonly executable: string;
	/** Exact argument boundaries; values are never joined or whitespace-normalized. */
	readonly argv: readonly string[];
}

export interface ShellCommandDescriptor {
	readonly kind: "shell";
	/** Exact shell identity supplied by the caller. */
	readonly shell: string;
	/** Exact script bytes decoded as a string; whitespace is significant. */
	readonly script: string;
}

export type EvidenceCommandDescriptor = ArgvCommandDescriptor | ShellCommandDescriptor;

export interface MissingArtifactState {
	readonly path: string;
	readonly state: "missing";
}

export interface FileArtifactState {
	readonly path: string;
	readonly state: "file";
	readonly sha256: Sha256Hex;
	readonly size: number;
}

export type ArtifactState = MissingArtifactState | FileArtifactState;

/** Trusted caller-selected workspace root and root-relative artifact set. */
export interface WorkspaceScope {
	readonly root: string;
	readonly artifactPaths: readonly string[];
}

/** A point-in-time digest of only the selected artifact set; not an immutable-workspace proof. */
export interface ArtifactSetWorkspaceFingerprint {
	readonly kind: "artifact-set";
	readonly scope: WorkspaceScope;
	readonly artifacts: readonly ArtifactState[];
	readonly manifestSha256: Sha256Hex;
}

/** Scope-limited Git workspace facts committed by a git-kind fingerprint. */
export interface GitWorkspaceState {
	/** Full hex object name of HEAD, or null while HEAD is unborn. */
	readonly headCommit: string | null;
	/** Sorted root-relative paths git reports changed (staged, unstaged, or untracked) within scope. */
	readonly changedPaths: readonly string[];
	/** SHA-256 of the scope-limited staged diff bytes (index vs HEAD). */
	readonly stagedDiffSha256: Sha256Hex;
	/** SHA-256 of the scope-limited unstaged diff bytes (work tree vs index). */
	readonly unstagedDiffSha256: Sha256Hex;
	/** Canonical digest committing changed paths, both diff digests, and every selected artifact state. */
	readonly dirtySha256: Sha256Hex;
}

/**
 * A point-in-time digest of a Git work-tree root: HEAD, scope-limited staged and
 * unstaged diffs, and direct states for every selected path. Direct states keep
 * ignored and index-flagged work-tree bytes content-bound independently of Git.
 */
export interface GitWorkspaceFingerprint {
	readonly kind: "git";
	readonly scope: WorkspaceScope;
	readonly artifacts: readonly ArtifactState[];
	readonly git: GitWorkspaceState;
	readonly manifestSha256: Sha256Hex;
}

export type WorkspaceFingerprint = ArtifactSetWorkspaceFingerprint | GitWorkspaceFingerprint;

export interface EvidenceOutputDigest {
	readonly sha256: Sha256Hex;
	readonly byteCount: number;
}

/** Digests only; receipt v3 never carries raw output or excerpts. */
export interface EvidenceOutputCapture {
	readonly redactionPolicyId: string;
	readonly stdout: EvidenceOutputDigest;
	readonly stderr: EvidenceOutputDigest;
}

/** CLI form that produced one or more `[REDACTED]` placeholders in a persisted command. */
export type CommandRedactionPlaceholderType =
	| "api-key-header"
	| "authorization-header"
	| "basic-auth"
	| "bearer-token"
	| "cli-option-inline"
	| "cli-option-value"
	| "cookie-header"
	| "env-assignment"
	| "known-token"
	| "url-credential"
	| "url-query";

export interface CommandRedactionPlaceholder {
	readonly type: CommandRedactionPlaceholderType;
	readonly count: number;
}

/** Bounded description of the placeholders applied to a persisted redacted command. */
export interface CommandRedactionSummary {
	readonly policyId: string;
	/** Unique types in ascending order; empty when nothing was redacted. */
	readonly placeholders: readonly CommandRedactionPlaceholder[];
}

/**
 * Keyed commitment to the original (pre-redaction) command. The HMAC key is
 * process-internal and never persisted or exported, so this value is not
 * verifiable (and not brute-forceable) outside the executing trust boundary.
 */
export interface CommandHmacBinding {
	readonly algorithm: "hmac-sha256";
	/** Identifies the ephemeral process key generation, not the key itself. */
	readonly keyId: string;
	/** Per-binding random nonce; makes persisted MACs non-comparable. */
	readonly nonce: string;
	readonly mac: Sha256Hex;
}

export type EvidenceReceiptStatus = "passed" | "failed" | "timeout" | "aborted";

export type EvidenceReceiptDisposition =
	| { readonly status: "passed"; readonly exitCode: 0 }
	| { readonly status: "failed"; readonly exitCode: number }
	| { readonly status: "timeout"; readonly exitCode: null }
	| { readonly status: "aborted"; readonly exitCode: null };

export type EvidenceExecutor = "bash-tool" | "ci-runner" | "mcp" | "internal";

export interface EvidenceReceiptCoreFields {
	readonly schemaVersion: 3;
	readonly receiptId: string;
	readonly goalId: string;
	readonly laneId?: string;
	readonly claim: string;
	readonly command: EvidenceCommandDescriptor;
	readonly cwd: string;
	readonly timeoutMs: number | null;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly durationMs: number;
	readonly workspaceBefore: WorkspaceFingerprint;
	readonly workspaceAfter: WorkspaceFingerprint;
	readonly output: EvidenceOutputCapture;
	readonly executor: EvidenceExecutor;
	readonly toolCallId?: string;
	/** Redaction metadata for the persisted `command` representation. */
	readonly commandRedaction?: CommandRedactionSummary;
	/** Keyed binding of the ORIGINAL command; required when placeholders were applied. */
	readonly commandBinding?: CommandHmacBinding;
}

/** Immutable execution facts. Envelope metadata is deliberately excluded from this core. */
export type EvidenceReceiptCore = EvidenceReceiptCoreFields & EvidenceReceiptDisposition;

export interface EvidenceReceiptLedgerBinding {
	readonly seq: number;
	readonly eventHash: Sha256Hex;
}

/**
 * Opaque metadata for an attestation verified by a separately configured trust anchor.
 * Its presence alone does not make a receipt trusted proof.
 */
export interface TrustedEvidenceAttestation {
	readonly attesterId: string;
	readonly keyId: string;
	readonly algorithm: "ed25519";
	readonly signature: string;
	readonly issuedAt: string;
}

export interface EvidenceReceiptEnvelope {
	readonly coreSha256: Sha256Hex;
	readonly ledgerBinding?: EvidenceReceiptLedgerBinding;
	readonly trustedAttestation?: TrustedEvidenceAttestation;
}

export interface EvidenceReceipt {
	readonly core: EvidenceReceiptCore;
	readonly envelope: EvidenceReceiptEnvelope;
}

/** Replay payload intentionally commits only the immutable core, avoiding a ledger/hash cycle. */
export interface EvidenceReceiptReplayPayload {
	readonly receiptId: string;
	readonly coreSha256: Sha256Hex;
}

export interface ReplayEvent {
	/** Monotonic sequence number within a session. */
	seq: number;
	/** Event type. */
	type: ReplayEventType;
	/** ISO-8601 timestamp. */
	timestamp: string;
	/** Goal or session identifier. */
	goalId: string;
	/** Optional lane identifier. */
	laneId?: string;
	/** Event-specific payload. */
	payload: unknown;
	/** SHA-256 of the serialized payload for integrity. */
	payloadHash: string;
	/** eventHash of the previous event in the chain ("genesis" for the first event). */
	prevHash: string;
	/** SHA-256 over [seq, type, timestamp, goalId, laneId, payloadHash, prevHash]. */
	eventHash: string;
}

export interface ReplayLedgerFileIdentity {
	readonly dev: string;
	readonly ino: string;
}

/** Durable CAS tuple published atomically beside the replay JSONL. */
export interface ReplayLedgerHead {
	readonly fileIdentity: ReplayLedgerFileIdentity | null;
	readonly size: number;
	readonly lastSeq: number;
	readonly lastHash: string;
}

/** One chain- and committed-head-verified point-in-time ledger source. */
export interface VerifiedReplayLedgerSnapshot {
	readonly events: readonly ReplayEvent[];
	readonly head: ReplayLedgerHead;
}

export interface ReplayLedger {
	/** Session / goal this ledger belongs to. */
	goalId: string;
	/** Ordered event log. */
	events: ReplayEvent[];
	/** Path where the ledger is persisted. */
	ledgerPath: string;
	/** Last persisted sequence number. */
	lastPersistedSeq: number;
}

// ============================================================================
// Merge Gates
// ============================================================================

export type MergeGateStatus = "open" | "blocked" | "conditional";

/** Compatibility policy for execution-bound evidence receipts. */
export type EvidenceReceiptMode = "strict" | "prefer" | "legacy";

export interface MergeGateResult {
	/** Gate identifier. */
	gateId: string;
	/** Current status. */
	status: MergeGateStatus;
	/** Human-readable reason. */
	reason: string;
	/** Suggested remediation. */
	suggestion?: string;
	/** Evidence that was checked. */
	evidenceChecked: EvidenceItem[];
}

export interface EvidenceGateCheck {
	/** Which evidence item was checked. */
	evidenceClaim: string;
	/** Whether it is satisfied. */
	satisfied: boolean;
	/** Reason if not satisfied. */
	reason?: string;
}

// ============================================================================
// Verify Reporter v2
// ============================================================================

export interface OmkVerifyResultV2 {
	goalId: string;
	status: "completed" | "failed" | "blocked" | "partial";
	summary: string;
	changedFiles: string[];
	evidence: EvidenceItem[];
	risks: string[];
	nextAction: string;
	/** Associated task contract. */
	contract?: TaskContract;
	/** Replay ledger path. */
	replayLedgerPath?: string;
	/** Merge gate results. */
	mergeGates: MergeGateResult[];
}

export interface CiReportV2 {
	goalId: string;
	status: string;
	summary: string;
	changedFilesCount: number;
	evidenceCount: number;
	risks: string[];
	markdown: string;
	contractVerdict?: string;
	mergeGateStatus?: string;
}

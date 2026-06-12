import { join, posix } from "path";
import type { DagNode } from "./dag.js";
import { validateWorktreeId } from "../util/worktree.js";

export type LaneAuthority = "read-only" | "advisory" | "review-only" | "execute-tests" | "write-scoped" | "memory-write";

export interface LaneGrant {
  laneId: string;
  role: string;
  goal: string;
  authority: LaneAuthority;
  scope: string;
  allowedPaths?: readonly string[];
  blockedPaths?: readonly string[];
  forbiddenActions?: readonly string[];
  skills: readonly string[];
  hooks: readonly string[];
  mcp: readonly string[];
  acceptance: readonly string[];
  evidenceOutput: string;
}

export interface LaneGrantValidationOptions {
  requireBlockedPaths?: boolean;
}

export interface LaneIsolationPlan {
  laneId: string;
  branchName: string;
  worktreePath: string;
  evidenceOutput: string;
  readOnly: boolean;
  authority: LaneAuthority;
}

export interface LaneIsolationPlanOptions {
  runId: string;
  worktreeRoot?: string;
}

export interface LaneWriterConflict {
  leftLaneId: string;
  rightLaneId: string;
  path: string;
  conflictingPath: string;
}

const READ_ONLY_AUTHORITIES = new Set<LaneAuthority>(["read-only", "advisory", "review-only"]);
const WRITE_AUTHORITIES = new Set<LaneAuthority>(["execute-tests", "write-scoped", "memory-write"]);

export function isReadOnlyLane(grant: LaneGrant): boolean {
  return READ_ONLY_AUTHORITIES.has(grant.authority);
}

export function isWriteLane(grant: LaneGrant): boolean {
  return WRITE_AUTHORITIES.has(grant.authority) && (grant.allowedPaths?.length ?? 0) > 0;
}

export function validateLaneGrant(grant: LaneGrant, options: LaneGrantValidationOptions = {}): LaneGrant {
  validateWorktreeId(grant.laneId, "laneId");
  assertNonEmptyText(grant.role, "role");
  assertNonEmptyText(grant.goal, "goal");
  assertNonEmptyText(grant.scope, "scope");
  assertNonEmptyArray(grant.skills, "skills");
  assertNonEmptyArray(grant.hooks, "hooks");
  assertNonEmptyArray(grant.mcp, "mcp");
  assertNonEmptyArray(grant.acceptance, "acceptance");
  validateEvidenceOutput(grant.evidenceOutput);

  if (options.requireBlockedPaths && (grant.blockedPaths?.length ?? 0) === 0) {
    throw new Error(`Lane ${grant.laneId} must declare blockedPaths`);
  }

  if (isReadOnlyLane(grant) && (grant.allowedPaths?.length ?? 0) > 0) {
    throw new Error(`Read-only lane ${grant.laneId} must not declare product write paths`);
  }

  if (grant.authority === "write-scoped" && (grant.allowedPaths?.length ?? 0) === 0) {
    throw new Error(`Write-scoped lane ${grant.laneId} must declare allowedPaths`);
  }

  for (const path of grant.allowedPaths ?? []) {
    normalizeRepoPath(path, "allowedPaths");
  }
  for (const path of grant.blockedPaths ?? []) {
    normalizeRepoPath(path, "blockedPaths");
  }

  return grant;
}

export function createLaneGrantFromDagNode(node: DagNode, overrides: Partial<LaneGrant> = {}): LaneGrant {
  const routing = node.routing ?? {};
  const authority = overrides.authority ?? inferLaneAuthority(node);
  return validateLaneGrant({
    laneId: overrides.laneId ?? node.id,
    role: overrides.role ?? node.role,
    goal: overrides.goal ?? node.name,
    authority,
    scope: overrides.scope ?? (routing.readOnly ? "read-only DAG lane" : "bounded DAG lane"),
    allowedPaths: overrides.allowedPaths,
    blockedPaths: overrides.blockedPaths ?? ["**/.env*", "**/*secret*", "**/*key*"],
    forbiddenActions: overrides.forbiddenActions ?? ["secret disclosure", "out-of-scope edits", "destructive git operations"],
    skills: overrides.skills ?? routing.skills ?? routing.assignedCapabilities?.skills ?? ["omk-context-broker"],
    hooks: overrides.hooks ?? routing.hooks ?? routing.assignedCapabilities?.hooks ?? ["subagent-stop-audit.sh"],
    mcp: overrides.mcp ?? routing.mcpServers ?? routing.assignedCapabilities?.mcpServers ?? ["omk-project"],
    acceptance: overrides.acceptance ?? node.outputs?.map((output) => output.name) ?? ["lane completes with evidence"],
    evidenceOutput: overrides.evidenceOutput ?? join(".omk", "runs", "lanes", `${node.id}.md`),
  });
}

export function createLaneIsolationPlan(grant: LaneGrant, options: LaneIsolationPlanOptions): LaneIsolationPlan {
  validateLaneGrant(grant);
  const runId = validateWorktreeId(options.runId, "runId");
  const laneId = validateWorktreeId(grant.laneId, "laneId");
  const root = options.worktreeRoot ?? join(".omk", "worktrees");

  return {
    laneId,
    branchName: `work/${runId}/${laneId}`,
    worktreePath: join(root, runId, laneId),
    evidenceOutput: grant.evidenceOutput,
    readOnly: isReadOnlyLane(grant),
    authority: grant.authority,
  };
}

export function findParallelWriterConflicts(grants: readonly LaneGrant[]): LaneWriterConflict[] {
  const conflicts: LaneWriterConflict[] = [];
  const validated = grants.map((grant) => validateLaneGrant(grant));

  assertUniqueEvidenceOutputs(validated);

  for (let i = 0; i < validated.length; i++) {
    const left = validated[i];
    if (!isWriteLane(left)) continue;
    const leftPaths = (left.allowedPaths ?? []).map((path) => normalizeRepoPath(path, "allowedPaths"));

    for (let j = i + 1; j < validated.length; j++) {
      const right = validated[j];
      if (!isWriteLane(right)) continue;
      const rightPaths = (right.allowedPaths ?? []).map((path) => normalizeRepoPath(path, "allowedPaths"));

      for (const leftPath of leftPaths) {
        for (const rightPath of rightPaths) {
          if (pathsOverlap(leftPath, rightPath)) {
            conflicts.push({
              leftLaneId: left.laneId,
              rightLaneId: right.laneId,
              path: leftPath,
              conflictingPath: rightPath,
            });
          }
        }
      }
    }
  }

  return conflicts;
}

export function assertNoParallelWriterConflicts(grants: readonly LaneGrant[]): void {
  const conflicts = findParallelWriterConflicts(grants);
  if (conflicts.length > 0) {
    const summary = conflicts
      .map((conflict) => `${conflict.leftLaneId}:${conflict.path} conflicts with ${conflict.rightLaneId}:${conflict.conflictingPath}`)
      .join("; ");
    throw new Error(`Parallel writer conflict: ${summary}`);
  }
}

function inferLaneAuthority(node: DagNode): LaneAuthority {
  if (node.routing?.readOnly) return "read-only";
  if (["explorer", "researcher", "reviewer", "security", "qa"].includes(node.role)) return "review-only";
  if (node.role === "tester") return "execute-tests";
  return "write-scoped";
}

function assertNonEmptyText(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Lane grant requires ${label}`);
  }
}

function assertNonEmptyArray(values: readonly string[], label: string): void {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error(`Lane grant requires non-empty ${label}`);
  }
}

function validateEvidenceOutput(path: string): string {
  const normalized = normalizeRepoPath(path, "evidenceOutput");
  if (!normalized.startsWith(".omk/runs/")) {
    throw new Error(`Lane evidenceOutput must stay under .omk/runs`);
  }
  return normalized;
}

function normalizeRepoPath(path: string, label: string): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error(`Invalid ${label}`);
  }
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    posix.isAbsolute(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    throw new Error(`Invalid ${label}: path escapes repository scope`);
  }
  return normalized;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function assertUniqueEvidenceOutputs(grants: readonly LaneGrant[]): void {
  const seen = new Map<string, string>();
  for (const grant of grants) {
    const output = validateEvidenceOutput(grant.evidenceOutput);
    const previousLane = seen.get(output);
    if (previousLane) {
      throw new Error(`Lane evidenceOutput conflict: ${previousLane} and ${grant.laneId} both write ${output}`);
    }
    seen.set(output, grant.laneId);
  }
}

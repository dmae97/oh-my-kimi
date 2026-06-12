/**
 * Shared RunViewModel — unified state interpretation for HUD and Parallel UI.
 */

import type { RunCapabilityAssignment, RunGoalState, RunRouteDecision, RunState } from "../contracts/orchestration.js";
import type { TelemetryEvent } from "./events-logger.js";
import { sanitizeTerminalText } from "./theme.js";

export type RunHealth = "ok" | "warn" | "blocked" | "failed";

export interface RunViewModelWorker {
  id: string;
  label: string;
  state: "idle" | "running" | "done" | "failed" | "blocked" | "skipped";
  liveStatus?: "running-active" | "running-silent" | "waiting-input" | "stalled" | "orphaned" | "done" | "failed" | "blocked" | "skipped" | "idle";
  elapsedMs: number;
  retryCount: number;
  currentNode?: string;
  lastEvidence?: { gate: string; passed: boolean; message?: string };
  /** Latest thinking text from the worker (live activity). */
  thinking?: string;
  /** Scoped skills/MCP/hooks assigned to this worker lane. Names only; no config/env values. */
  assignment?: RunCapabilityAssignment;
  /** High-level phase description (e.g. "reading src/foo.ts"). */
  phase?: string;
  /** Milliseconds since last meaningful activity (thinking/node event). */
  lastActivityAgeMs?: number;
  /** Milliseconds since latest heartbeat event/state update. */
  lastHeartbeatAgeMs?: number;
}

export interface RunViewModelBlocker {
  nodeId: string;
  reason: string;
  nextAction: string;
  evidenceMessage?: string;
  recoverable: boolean;
  retryCount: number;
  maxRetries: number;
  logHint?: string;
}

export interface RunViewModelActiveNode {
  id: string;
  name: string;
  role: string;
  thinking?: string;
}

export interface RunViewModelProgress {
  percent: number;
  done: number;
  total: number;
  running: number;
  failed: number;
  blocked: number;
  skipped: number;
  /** Number of nodes that are terminal (done + skipped + failed + blocked). */
  settled: number;
}

export interface RunViewModelProviderRouting {
  attempts: number;
  fallbackCount: number;
  byProvider: Record<string, number>;
}

export interface RunViewModelBlockerItem {
  nodeId: string;
  reason: string;
  status: "blocked" | "failed" | "skipped";
}

export interface RunViewModel {
  health: RunHealth;
  goal: RunGoalState | null;
  routeDecision: RunRouteDecision | null;
  goalTitle: string | null;
  goalScore: number | null;
  activeNode: RunViewModelActiveNode | null;
  blocker: RunViewModelBlocker | null;
  blockers?: RunViewModelBlockerItem[];
  nextAction: string | null;
  progress: RunViewModelProgress;
  eta: string | null;
  changedFiles: string[];
  stateError: "ok" | "missing" | "invalid" | "corrupt" | "oldSchema";
  runId: string | null;
  workers: RunViewModelWorker[];
  /** Lifecycle nodes (bootstrap, root-coordinator, review-merge) exposed separately from workers. */
  lifecycleNodes?: RunViewModelWorker[];
  /** ISO timestamp when the run started. */
  startedAt?: string;
  /** ISO timestamp of last meaningful activity. */
  lastActivityAt?: string;
  iterationCount?: number;
  maxIterations?: number;
  /** Confidence level of the ETA estimate. */
  etaConfidence?: "low" | "medium" | "high";
  /** Provider route/fallback metrics collected from node attempts. */
  providerRouting: RunViewModelProviderRouting;
  /** Team/tmux runtime snapshot when the run was created by `omk team`. */
  teamRuntime?: RunState["teamRuntime"];
}

export interface BuildRunViewModelOptions {
  goalTitle?: string | null;
  changedFiles?: string[];
  workerLabels?: Record<string, string>;
  telemetry?: TelemetryEvent[];
}

const SECRET_KEY_NAMES =
  "apiKey|api_key|api-key|token|auth_token|auth-token|access_token|access-token|refresh_token|refresh-token|password|secret|client_secret|client-secret|authorization|bearer|private_key|private-key|key";

const SECRET_PATTERN = new RegExp(
  [
    // Explicit key=value / key:"value" patterns
    `\\b(?:${SECRET_KEY_NAMES})\\s*[:=]\\s*["']?[^\\s"']{8,}["']?`,
    // Hex keys (32+ hex chars)
    `\\b[a-f0-9]{32,}\\b`,
    // Base64 keys (40+ base64 chars with optional padding)
    `\\b[A-Za-z0-9+/]{40,}=?\\b`,
    // GitHub personal access tokens
    `\\bghp_[A-Za-z0-9]{36}\\b`,
    // Railway tokens
    `\\brw_[A-Za-z0-9]+\\b`,
  ].join("|"),
  "gi"
);

interface NodeTelemetryIndex {
  activityAt?: string;
  heartbeatAt?: string;
  terminalAt?: string;
  status?: string;
  phase?: string;
}

export function sanitizeForDisplay(text: string): string {
  return text.replace(SECRET_PATTERN, (match) => {
    const keyMatch = match.match(
      new RegExp(`\\b(?:${SECRET_KEY_NAMES})\\b`, "i")
    );
    const key = keyMatch?.[0] ?? "secret";
    return `${key}: ***REDACTED***`;
  });
}

export function parseRunStateResult(content: string): { state: RunState | null; error: RunViewModel["stateError"] } {
  try {
    const value = JSON.parse(content) as Partial<RunState>;
    if (!value || typeof value !== "object") {
      return { state: null, error: "invalid" };
    }
    if (typeof value.runId !== "string") {
      return { state: null, error: "invalid" };
    }
    if (!Array.isArray(value.nodes)) {
      return { state: null, error: "invalid" };
    }
    if (value.schemaVersion !== 1) {
      return { state: null, error: "oldSchema" };
    }
    return { state: value as RunState, error: "ok" };
  } catch {
    return { state: null, error: "corrupt" };
  }
}

export function getRunStateRecoveryHint(error: RunViewModel["stateError"], runId?: string): string {
  switch (error) {
    case "ok":
      return "";
    case "missing":
      return `No run state found. Start a new run with: omk run --run-id ${runId ?? "<run-id>"}`;
    case "invalid":
      return `Run state is invalid. Verify with: omk verify --run ${runId ?? "<run-id>"}`;
    case "corrupt":
      return `Run state file is corrupt. Check the state file or start a new run with: omk run --run-id ${runId ?? "<run-id>"}`;
    case "oldSchema":
      return `Run state schema is outdated or missing. Migrate or restart with: omk verify --run ${runId ?? "<run-id>"}`;
    default:
      return "";
  }
}

export function formatEtaMs(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "--";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function renderRunSummary(vm: RunViewModel): string {
  const goal = vm.goalTitle ?? "--";
  const progress = `${vm.progress.settled}/${vm.progress.total}`;
  const health = vm.health.toUpperCase();
  const next = vm.nextAction ?? "--";
  const blocker = vm.blocker ? `${vm.blocker.reason} (${vm.blocker.nodeId})` : "none";
  return `Goal: ${goal} | Progress: ${progress} | Health: ${health} | Next: ${next} | Blocker: ${blocker}`;
}

export function buildRunViewModel(
  state: RunState | null,
  options: BuildRunViewModelOptions = {}
): RunViewModel {
  if (!state) {
    return {
      health: "warn",
      goal: null,
      routeDecision: null,
      goalTitle: options.goalTitle ?? null,
      goalScore: null,
      activeNode: null,
      blocker: null,
      nextAction: null,
      progress: { percent: 0, done: 0, total: 0, running: 0, failed: 0, blocked: 0, skipped: 0, settled: 0 },
      eta: null,
      changedFiles: options.changedFiles ?? [],
      stateError: "missing",
      runId: null,
      workers: [],
      providerRouting: { attempts: 0, fallbackCount: 0, byProvider: {} },
    };
  }

  const nodes = state.nodes;
  const running = nodes.filter((n) => n.status === "running");
  const done = nodes.filter((n) => n.status === "done");
  const failed = nodes.filter((n) => n.status === "failed");
  const blocked = nodes.filter((n) => n.status === "blocked");
  const skipped = nodes.filter((n) => n.status === "skipped");

  const total = nodes.length;
  const settled = done.length + skipped.length + failed.length + blocked.length;
  const percent = total > 0 ? Math.round((settled / total) * 100) : 0;
  const providerRouting = computeProviderRouting(nodes);
  const goal = deriveGoalState(state);
  const goalTitle = goal?.title ?? options.goalTitle ?? null;

  let health: RunHealth = "ok";
  if (failed.length > 0) health = "failed";
  else if (blocked.length > 0) health = "blocked";
  // Note: running with no pending is normal progress, not a warning.
  // Stale-worker detection is handled in the cockpit renderer via lastActivityAgeMs.

  const activeNode = running[0]
    ? {
        id: running[0].id,
        name: running[0].name || running[0].id,
        role: running[0].role || "unknown",
        thinking: running[0].thinking,
      }
    : null;

  const blockerNode = failed[0] ?? blocked[0];
  let blocker: RunViewModelBlocker | null = null;
  if (blockerNode) {
    const lastEvidence = blockerNode.evidence?.length
      ? blockerNode.evidence[blockerNode.evidence.length - 1]
      : undefined;
    const isBlocked = blockerNode.status === "blocked";
    const retryCount = blockerNode.attempts?.length ?? blockerNode.retries ?? 0;
    const maxRetries = blockerNode.maxRetries;
    const recoverable = retryCount < maxRetries;
    const rawReason = isBlocked
      ? (blockerNode.blockedReason ?? "Node blocked")
      : (lastEvidence?.message ?? "Node failed");
    const reason = sanitizeForDisplay(rawReason);
    const nextAction = recoverable
      ? "Retrying..."
      : `omk goal continue ${state.goalId ?? state.runId}`;
    blocker = {
      nodeId: blockerNode.id,
      reason,
      nextAction,
      evidenceMessage: lastEvidence?.message ? sanitizeForDisplay(lastEvidence.message) : undefined,
      recoverable,
      retryCount,
      maxRetries,
      logHint: `Check .omk/runs/${state.runId}/logs/${blockerNode.id}.log`,
    };
  }

  const blockers: RunViewModelBlockerItem[] = [
    ...failed.map((n) => {
      const lastEvidence = n.evidence?.length ? n.evidence[n.evidence.length - 1] : undefined;
      return {
        nodeId: n.id,
        reason: sanitizeForDisplay(lastEvidence?.message ?? "Node failed"),
        status: "failed" as const,
      };
    }),
    ...blocked.map((n) => ({
      nodeId: n.id,
      reason: sanitizeForDisplay(n.blockedReason ?? "Node blocked"),
      status: "blocked" as const,
    })),
  ];

  const nextAction =
    blocker?.nextAction ??
    (activeNode ? `Waiting for ${activeNode.name}` : settled === total ? "Run complete" : "Ready");

  const isLifecycleNode = (n: (typeof nodes)[0]) =>
    n.id === "bootstrap" || n.id === "root-coordinator" || n.id === "review-merge";

  const now = Date.now();
  const lastActivityMs = state.lastActivityAt ? Date.parse(state.lastActivityAt) : 0;
  const nodeTelemetry = buildNodeTelemetryIndex(options.telemetry ?? []);

  const mapNodeToWorker = (n: (typeof nodes)[0]): RunViewModelWorker => {
    const elapsed = n.durationMs ?? (n.startedAt ? now - new Date(n.startedAt).getTime() : 0);
    const lastEvidence = n.evidence?.length ? n.evidence[n.evidence.length - 1] : undefined;
    const assignment = normalizeRunCapabilityAssignment(state.capabilityAssignments?.[n.id], n.routing);
    const stateValue: RunViewModelWorker["state"] =
      n.status === "pending" ? "idle" :
      n.status === "skipped" ? "skipped" :
      n.status ?? "idle";
    const telemetry = nodeTelemetry.get(n.id);
    const telemetryActivityMs = telemetry?.activityAt ? Date.parse(telemetry.activityAt) : 0;
    const telemetryHeartbeatMs = telemetry?.heartbeatAt ? Date.parse(telemetry.heartbeatAt) : 0;
    const stateHeartbeatMs = state.lastHeartbeatAt ? Date.parse(state.lastHeartbeatAt) : 0;
    const nodeStartedMs = n.startedAt ? Date.parse(n.startedAt) : 0;
    const nodeLastActivityMs = Math.max(lastActivityMs, telemetryActivityMs, nodeStartedMs);
    const nodeLastHeartbeatMs = Math.max(telemetryHeartbeatMs, stateHeartbeatMs, nodeStartedMs);
    const isChatIdle = n.id === "chat" && !n.thinking;
    const lastActivityAgeMs = n.status === "running" && nodeLastActivityMs > 0 && !isChatIdle
      ? now - nodeLastActivityMs
      : undefined;
    const lastHeartbeatAgeMs = n.status === "running" && nodeLastHeartbeatMs > 0 ? now - nodeLastHeartbeatMs : undefined;
    const thinking = n.status === "running" ? n.thinking : undefined;
    const phase = thinking ? sanitizeForDisplay(thinking) : telemetry?.phase ? sanitizeForDisplay(telemetry.phase) : undefined;
    const liveStatus = computeLiveStatus({
      state: stateValue,
      nodeId: n.id,
      hasPhase: Boolean(phase || thinking),
      lastActivityAgeMs,
      lastHeartbeatAgeMs,
      telemetryStatus: telemetry?.status,
    });
    return {
      id: n.id,
      label: options.workerLabels?.[n.id] ?? n.name ?? n.id,
      state: stateValue,
      liveStatus,
      elapsedMs: Math.max(0, elapsed),
      retryCount: n.attempts?.length ?? 0,
      currentNode: n.status === "running" ? (n.name || n.id) : undefined,
      lastEvidence: lastEvidence
        ? { gate: lastEvidence.gate, passed: lastEvidence.passed, message: lastEvidence.message ? sanitizeForDisplay(lastEvidence.message) : undefined }
        : undefined,
      thinking,
      assignment,
      phase,
      lastActivityAgeMs,
      lastHeartbeatAgeMs,
    };
  };

  const workers = nodes.filter((n) => !isLifecycleNode(n)).map(mapNodeToWorker);
  const lifecycleNodes = nodes.filter(isLifecycleNode).map(mapNodeToWorker);

  return {
    health,
    goal,
    routeDecision: state.routeDecision ?? null,
    goalTitle,
    goalScore: total > 0 ? Math.round((settled / total) * 100) : null,
    activeNode,
    blocker,
    nextAction,
    progress: {
      percent,
      done: done.length,
      total,
      running: running.length,
      failed: failed.length,
      blocked: blocked.length,
      skipped: skipped.length,
      settled,
    },
    eta: state.estimate?.estimatedRemainingMs != null ? formatEtaMs(state.estimate.estimatedRemainingMs) : null,
    etaConfidence: state.estimate?.confidence,
    changedFiles: options.changedFiles ?? [],
    stateError: "ok",
    runId: state.runId,
    workers,
    lifecycleNodes,
    blockers,
    startedAt: state.startedAt,
    lastActivityAt: state.lastActivityAt,
    iterationCount: state.iterationCount,
    maxIterations: state.maxIterations,
    providerRouting,
    teamRuntime: state.teamRuntime,
  };
}

function buildNodeTelemetryIndex(events: TelemetryEvent[]): Map<string, NodeTelemetryIndex> {
  const index = new Map<string, NodeTelemetryIndex>();
  for (const event of events) {
    const nodeId = event.nodeId ?? event.laneId;
    if (!nodeId) continue;
    const current = index.get(nodeId) ?? {};
    if (event.type === "lane.activity" || event.type === "tool.started" || event.type === "tool.completed" || event.type === "provider.route") {
      current.activityAt = event.timestamp;
      const phase = event.data?.summary ?? event.data?.phase ?? event.data?.message;
      if (typeof phase === "string") current.phase = sanitizeTerminalText(phase);
    }
    if (event.type === "lane.started") {
      current.activityAt = event.timestamp;
      current.heartbeatAt = event.timestamp;
      current.status = "running-active";
    }
    if (event.type === "lane.heartbeat") {
      current.heartbeatAt = event.timestamp;
    }
    if (event.type === "lane.completed" || event.type === "lane.failed" || event.type === "lane.stalled") {
      current.terminalAt = event.timestamp;
      current.status =
        event.type === "lane.completed" ? "done" :
        event.type === "lane.failed" ? "failed" :
        "stalled";
    }
    index.set(nodeId, current);
  }
  return index;
}

function computeLiveStatus(input: {
  state: RunViewModelWorker["state"];
  nodeId: string;
  hasPhase: boolean;
  lastActivityAgeMs?: number;
  lastHeartbeatAgeMs?: number;
  telemetryStatus?: string;
}): NonNullable<RunViewModelWorker["liveStatus"]> {
  if (input.state !== "running") return input.state;
  if (input.telemetryStatus === "stalled") return "stalled";
  if (input.nodeId === "chat" && !input.hasPhase) return "waiting-input";
  const heartbeatFresh = input.lastHeartbeatAgeMs == null || input.lastHeartbeatAgeMs <= 90_000;
  if (!heartbeatFresh) return "stalled";
  if (input.lastActivityAgeMs != null && input.lastActivityAgeMs <= 30_000) return "running-active";
  return "running-silent";
}

function deriveGoalState(state: RunState): RunGoalState | null {
  if (state.goal) return state.goal;
  if (!state.goalSnapshot) return null;
  return {
    id: state.goalId,
    title: state.goalSnapshot.title,
    objective: state.goalSnapshot.objective,
    successCriteria: state.goalSnapshot.successCriteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      requirement: criterion.requirement,
    })),
    status: "planned",
  };
}

function normalizeRunCapabilityAssignment(
  assignment: RunCapabilityAssignment | undefined,
  routing: RunState["nodes"][number]["routing"] | undefined
): RunCapabilityAssignment | undefined {
  const assigned = routing?.assignedCapabilities;
  const skills = uniqueCapabilityNames(assignment?.skills ?? assigned?.skills ?? routing?.skills ?? []);
  const mcpServers = uniqueCapabilityNames(assignment?.mcpServers ?? assigned?.mcpServers ?? routing?.mcpServers ?? []);
  const hooks = uniqueCapabilityNames(assignment?.hooks ?? assigned?.hooks ?? routing?.hooks ?? []);
  const tools = uniqueCapabilityNames(assignment?.tools ?? assigned?.tools ?? routing?.tools ?? []);
  if (skills.length === 0 && mcpServers.length === 0 && hooks.length === 0 && tools.length === 0) {
    return undefined;
  }
  return {
    skills,
    mcpServers,
    hooks,
    ...(tools.length > 0 ? { tools } : {}),
    source: assignment?.source ?? (routing?.autoSpawned ? "capability-router" : "routing"),
    rationale: assignment?.rationale ? sanitizeForDisplay(assignment.rationale) : routing?.rationale ? sanitizeForDisplay(routing.rationale) : undefined,
  };
}

function uniqueCapabilityNames(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => sanitizeForDisplay(value.trim())).filter(Boolean))];
}

function computeProviderRouting(nodes: RunState["nodes"]): RunViewModelProviderRouting {
  const byProvider: Record<string, number> = {};
  let attempts = 0;
  let fallbackCount = 0;

  for (const node of nodes) {
    for (const attempt of node.attempts ?? []) {
      if (!attempt.provider && !attempt.requestedProvider && !attempt.fallbackFrom) continue;
      attempts += 1;
      const provider = attempt.provider ?? attempt.requestedProvider ?? "unknown";
      byProvider[provider] = (byProvider[provider] ?? 0) + 1;
      if (attempt.fallbackFrom) fallbackCount += 1;

      if (attempt.providerAssist && attempt.providerAssist.provider !== attempt.provider) {
        byProvider[attempt.providerAssist.provider] = (byProvider[attempt.providerAssist.provider] ?? 0) + 1;
        attempts += 1;
      }
    }
  }

  return { attempts, fallbackCount, byProvider };
}

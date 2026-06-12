/**
 * RuntimeRouter — intent-aware runtime selection with evidence pass history.
 *
 * Routes capsules based on:
 * 1. NodeIntent (research, planning, coding, debugging, etc.)
 * 2. RuntimeScore (quality, cost, latency, evidence pass rate)
 * 3. Historical evidence pass rates from graph-state memory
 * 4. Fallback chain with runtime.supports() check
 */

import { readFile } from "fs/promises";
import { join } from "path";
import type { AgentRuntime, AgentRunResult, AgentTask, AgentResult } from "./agent-runtime.js";
import type { ContextCapsule } from "./context-capsule.js";
import { createDecisionTraceStore } from "../evidence/decision-trace.js";

export type NodeIntent =
  | "research"
  | "planning"
  | "coding"
  | "debugging"
  | "refactor"
  | "review"
  | "test-generation"
  | "documentation"
  | "shell-operation";

export interface RuntimeScore {
  readonly runtime: string;
  readonly qualityScore: number;
  readonly costScore: number;
  readonly latencyScore: number;
  readonly evidencePassRate: number;
  readonly recentFailurePenalty: number;
}

export interface RuntimeRouterOptions {
  readonly runtimes?: AgentRuntime[];
  readonly fallbackChain?: string[];
  readonly memoryPath?: string;
}

export interface RuntimeRouteDecision {
  readonly runtime: AgentRuntime;
  readonly reason: string;
  readonly fallbacks: AgentRuntime[];
  readonly intent: NodeIntent;
  readonly scores: RuntimeScore[];
}

interface EvidenceHistoryEntry {
  readonly runtime: string;
  readonly intent: string;
  readonly passed: boolean;
  readonly timestamp: string;
  readonly nodeId: string;
}

const INTENT_RUNTIME_PREFERENCES: Record<NodeIntent, string[]> = {
  research: ["mimo-api", "deepseek-api", "openrouter-api", "gemini-cli", "codex-cli", "kimi-api", "kimi-wire"],
  planning: ["mimo-api", "kimi-api", "kimi-wire", "codex-cli", "openrouter-api", "claude-code"],
  coding: ["mimo-api", "kimi-api", "kimi-wire", "codex-cli", "claude-code"],
  debugging: ["mimo-api", "kimi-api", "kimi-wire", "codex-cli"],
  refactor: ["mimo-api", "kimi-api", "kimi-wire", "codex-cli", "claude-code"],
  review: ["mimo-api", "deepseek-api", "openrouter-api", "claude-code", "codex-cli", "kimi-api"],
  "test-generation": ["mimo-api", "kimi-api", "kimi-wire", "codex-cli"],
  documentation: ["mimo-api", "gemini-cli", "openrouter-api", "codex-cli", "kimi-api"],
  "shell-operation": ["mimo-api", "kimi-api", "kimi-wire", "codex-cli"],
};

export function createRuntimeRouter(options: RuntimeRouterOptions = {}) {
  let runtimes = [...(options.runtimes ?? [])];
  const memoryPath = options.memoryPath;
  const fallbackChain = options.fallbackChain;
  let evidenceCache: EvidenceHistoryEntry[] | undefined;

  function classifyIntent(capsule: ContextCapsule): NodeIntent {
    const text = `${capsule.nodeId} ${capsule.goal} ${capsule.task} ${capsule.system}`.toLowerCase();
    const role = capsule.node?.role?.toLowerCase() ?? "";

    if (/debug|fix|error|failure|bug|trace/.test(text) || role === "debugger") return "debugging";
    if (/review|audit|check|validate|verify/.test(text) || role === "reviewer") return "review";
    if (/test|spec|coverage|assertion/.test(text) || role === "tester") return "test-generation";
    if (/refactor|optimize|clean|improve|simplify/.test(text) || role === "refactor") return "refactor";
    if (/research|investigate|explore|search|discover|analyze/.test(text) || role === "researcher") return "research";
    if (/plan|design|architect|strategy|roadmap/.test(text) || role === "planner") return "planning";
    if (/doc|readme|changelog|comment/.test(text) || role === "documenter") return "documentation";
    if (/shell|command|run|exec|script/.test(text) || role === "shell") return "shell-operation";
    return "coding";
  }

  function classifyIntentFromTask(task: AgentTask): NodeIntent {
    const text = `${task.context.nodeId} ${task.context.goal ?? ""} ${task.prompt} ${task.context.system ?? ""}`.toLowerCase();
    const role = task.context.role?.toLowerCase() ?? "";

    if (/debug|fix|error|failure|bug|trace/.test(text) || role === "debugger") return "debugging";
    if (/review|audit|check|validate|verify/.test(text) || role === "reviewer") return "review";
    if (/test|spec|coverage|assertion/.test(text) || role === "tester") return "test-generation";
    if (/refactor|optimize|clean|improve|simplify/.test(text) || role === "refactor") return "refactor";
    if (/research|investigate|explore|search|discover|analyze/.test(text) || role === "researcher") return "research";
    if (/plan|design|architect|strategy|roadmap/.test(text) || role === "planner") return "planning";
    if (/doc|readme|changelog|comment/.test(text) || role === "documenter") return "documentation";
    if (/shell|command|run|exec|script/.test(text) || role === "shell") return "shell-operation";
    return "coding";
  }

  async function loadEvidenceHistory(): Promise<EvidenceHistoryEntry[]> {
    if (evidenceCache) return evidenceCache;
    const filePath = memoryPath ?? join(process.cwd(), ".omk", "memory", "graph-state.json");
    try {
      const raw = await readFile(filePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      const nodes = (data.nodes ?? []) as Array<Record<string, unknown>>;
      const entries: EvidenceHistoryEntry[] = [];
      for (const n of nodes) {
        if (n.type !== "Evidence") continue;
        const props = (n.properties ?? {}) as Record<string, unknown>;
        const kind = String(props.kind ?? "");
        if (kind !== "failure_pattern" && kind !== "successful_fix") continue;
        entries.push({
          runtime: String(props.runtime ?? "unknown"),
          intent: String(props.intent ?? "coding"),
          passed: kind === "successful_fix",
          timestamp: String(n.createdAt ?? ""),
          nodeId: String(props.sourceNodeId ?? ""),
        });
      }
      evidenceCache = entries;
      return entries;
    } catch {
      return [];
    }
  }

  function computeScores(
    runtime: AgentRuntime,
    intent: NodeIntent,
    history: EvidenceHistoryEntry[],
  ): RuntimeScore {
    const runtimeHistory = history.filter((e) => e.runtime === runtime.id);
    const intentHistory = runtimeHistory.filter((e) => e.intent === intent);

    const totalAttempts = runtimeHistory.length;
    const passedAttempts = runtimeHistory.filter((e) => e.passed).length;
    const evidencePassRate = totalAttempts > 0 ? passedAttempts / totalAttempts : 0.5;

    const recentFailures = runtimeHistory
      .filter((e) => !e.passed)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 5);
    const recentFailurePenalty = Math.min(0.3, recentFailures.length * 0.06);

    const intentPassRate = intentHistory.length > 0
      ? intentHistory.filter((e) => e.passed).length / intentHistory.length
      : 0.5;

    const qualityScore = 0.4 * evidencePassRate + 0.4 * intentPassRate + 0.2 * (1 - recentFailurePenalty);
    const costScore = runtime.priority > 50 ? 0.7 : 0.9;
    const latencyScore = runtime.priority > 50 ? 0.8 : 0.6;

    return {
      runtime: runtime.id,
      qualityScore,
      costScore,
      latencyScore,
      evidencePassRate,
      recentFailurePenalty,
    };
  }

  function selectByIntent(
    capsule: ContextCapsule,
    history: EvidenceHistoryEntry[],
  ): RuntimeRouteDecision {
    const intent = classifyIntent(capsule);
    const sorted = [...runtimes].sort((a, b) => b.priority - a.priority);
    const supporting = sorted.filter((r) => r.supports(capsule));

    if (supporting.length === 0) {
      throw new Error(formatUnsupportedCapsuleMessage(capsule, sorted));
    }

    const scores = supporting.map((r) => computeScores(r, intent, history));

    const preferred = fallbackChain ?? INTENT_RUNTIME_PREFERENCES[intent];
    const scored = supporting.map((r, i) => ({
      runtime: r,
      score: scores[i],
      composite: computeComposite(scores[i], preferred, r.id),
    }));

    scored.sort((a, b) => b.composite - a.composite);

    const primary = scored[0].runtime;
    const fallbacks = scored.slice(1).map((s) => s.runtime);

    const bestScore = scored[0].score;
    const reason = [
      `intent=${intent}`,
      `quality=${bestScore.qualityScore.toFixed(2)}`,
      `evidencePassRate=${bestScore.evidencePassRate.toFixed(2)}`,
      `recentPenalty=${bestScore.recentFailurePenalty.toFixed(2)}`,
    ].join("; ");

    return { runtime: primary, reason, fallbacks, intent, scores };
  }

  function selectByIntentForTask(
    task: AgentTask,
    history: EvidenceHistoryEntry[],
  ): RuntimeRouteDecision {
    const intent = classifyIntentFromTask(task);
    const taskRuntimePreferences = runtimePreferencesFromTask(task);
    const sorted = [...runtimes].sort((a, b) => b.priority - a.priority);
    const candidateRuntimes = taskRuntimePreferences.length > 0
      ? sorted.filter((r) => taskRuntimePreferences.includes(r.id))
      : sorted;
    const supporting = candidateRuntimes.filter((r) => typeof r.execute === "function" && runtimeSupportsTask(r, task));

    if (supporting.length === 0) {
      throw new Error(formatUnsupportedTaskMessage(task, candidateRuntimes));
    }

    const scores = supporting.map((r) => computeScores(r, intent, history));

    const preferred = taskRuntimePreferences.length > 0
      ? taskRuntimePreferences
      : fallbackChain ?? INTENT_RUNTIME_PREFERENCES[intent];
    const scored = supporting.map((r, i) => ({
      runtime: r,
      score: scores[i],
      composite: computeComposite(scores[i], preferred, r.id),
    }));

    scored.sort((a, b) => b.composite - a.composite);

    const primary = scored[0].runtime;
    const fallbacks = scored.slice(1).map((s) => s.runtime);

    const bestScore = scored[0].score;
    const reason = [
      `intent=${intent}`,
      `quality=${bestScore.qualityScore.toFixed(2)}`,
      `evidencePassRate=${bestScore.evidencePassRate.toFixed(2)}`,
      `recentPenalty=${bestScore.recentFailurePenalty.toFixed(2)}`,
    ].join("; ");

    return { runtime: primary, reason, fallbacks, intent, scores };
  }

  function select(capsule: ContextCapsule): RuntimeRouteDecision {
    const intent = classifyIntent(capsule);
    const sorted = [...runtimes].sort((a, b) => b.priority - a.priority);
    const supporting = sorted.filter((r) => r.supports(capsule));

    if (supporting.length === 0) {
      throw new Error(formatUnsupportedCapsuleMessage(capsule, sorted));
    }

    const preferred = fallbackChain ?? INTENT_RUNTIME_PREFERENCES[intent];
    const scored = supporting.map((r) => ({
      runtime: r,
      composite: r.priority + preferenceRankBonus(preferred, r.id) * 100,
    }));
    scored.sort((a, b) => b.composite - a.composite);

    const primary = scored[0].runtime;
    const fallbacks = scored.slice(1).map((s) => s.runtime);

    return {
      runtime: primary,
      reason: `intent=${intent}; priority-based (async history not loaded)`,
      fallbacks,
      intent,
      scores: [],
    };
  }

  async function runNode(capsule: ContextCapsule, signal: AbortSignal): Promise<AgentRunResult> {
    const history = await loadEvidenceHistory();
    const decision = selectByIntent(capsule, history);
    const allCandidates = [decision.runtime, ...decision.fallbacks];

    // Record runtime-router decision trace
    const runId = capsule.runId;
    const attemptNumber = (capsule.node?.attempts?.length ?? 0) + 1;
    const attemptId = `${capsule.nodeId}__${attemptNumber}`;
    if (runId && !runId.startsWith("local-")) {
      const traceStore = createDecisionTraceStore();
      traceStore.record(runId, {
        component: "runtime-router",
        inputSummary: `node=${capsule.nodeId} intent=${decision.intent}`,
        outputDecision: `runtime=${decision.runtime.id} fallbacks=${decision.fallbacks.map((r) => r.id).join(",")}`,
        reason: decision.reason,
        scores: decision.scores.reduce((acc, s) => {
          acc[s.runtime] = s.qualityScore;
          return acc;
        }, {} as Record<string, number>),
        nodeId: capsule.nodeId,
        attemptId,
      });
    }

    let lastError: AgentRunResult | undefined;
    for (const runtime of allCandidates) {
      if (signal.aborted) {
        return {
          success: false,
          exitCode: 130,
          stdout: "",
          stderr: "Aborted before execution",
          metadata: { runtime: runtime.id, aborted: true },
        };
      }

      try {
        const result = await runtime.runNode(capsule, signal);
        if (result.success) {
          return {
            ...result,
            metadata: {
              ...result.metadata,
              selectedRuntime: runtime.id,
              intent: decision.intent,
              fallbackChain: allCandidates.map((r) => r.id),
              scores: decision.scores,
            },
          };
        }
        lastError = result;
      } catch (err) {
        lastError = {
          success: false,
          exitCode: 1,
          stdout: "",
          stderr: String(err),
          metadata: { runtime: runtime.id, error: String(err) },
        };
      }
    }

    return (
      lastError ?? {
        success: false,
        exitCode: 1,
        stdout: "",
        stderr: "No runtime available",
        metadata: { attempted: allCandidates.map((r) => r.id) },
      }
    );
  }

  async function execute(task: AgentTask): Promise<AgentResult> {
    const history = await loadEvidenceHistory();
    const decision = selectByIntentForTask(task, history);
    const allCandidates = [decision.runtime, ...decision.fallbacks];

    // Record runtime-router decision trace
    const runId = task.context.runId;
    const attemptId = `${task.context.nodeId}__1`;
    if (runId && !runId.startsWith("local-")) {
      const traceStore = createDecisionTraceStore();
      traceStore.record(runId, {
        component: "runtime-router",
        inputSummary: `node=${task.context.nodeId} intent=${decision.intent}`,
        outputDecision: `runtime=${decision.runtime.id} fallbacks=${decision.fallbacks.map((r) => r.id).join(",")}`,
        reason: decision.reason,
        scores: decision.scores.reduce((acc, s) => {
          acc[s.runtime] = s.qualityScore;
          return acc;
        }, {} as Record<string, number>),
        nodeId: task.context.nodeId,
        attemptId,
      });
    }

    let lastError: AgentResult | undefined;
    for (const runtime of allCandidates) {
      if (task.context.abortSignal?.aborted) {
        return {
          output: "",
          exitCode: 130,
          metadata: { runtime: runtime.id, aborted: true },
        };
      }

      if (typeof runtime.execute !== "function") {
        continue;
      }

      try {
        const result = await runtime.execute(task);
        if (result.exitCode === 0) {
          return {
            ...result,
            metadata: {
              ...result.metadata,
              selectedRuntime: runtime.id,
              intent: decision.intent,
              fallbackChain: allCandidates.map((r) => r.id),
              scores: decision.scores,
            },
          };
        }
        lastError = result;
      } catch (err) {
        lastError = {
          output: "",
          exitCode: 1,
          metadata: { runtime: runtime.id, error: String(err) },
        };
      }
    }

    return (
      lastError ?? {
        output: "No runtime available",
        exitCode: 1,
        metadata: { attempted: allCandidates.map((r) => r.id) },
      }
    );
  }

  function invalidateCache(): void {
    evidenceCache = undefined;
  }

  return {
    setRuntimes(nextRuntimes: readonly AgentRuntime[]): void {
      runtimes = [...nextRuntimes];
      invalidateCache();
    },
    select,
    selectByIntent,
    runNode,
    execute,
    classifyIntent,
    listRuntimes(): AgentRuntime[] {
      return [...runtimes];
    },
    invalidateCache,
  };
}

function computeComposite(
  score: RuntimeScore,
  preferred: string[],
  runtimeId: string,
): number {
  const preferenceBonus = preferenceRankBonus(preferred, runtimeId);
  return (
    0.35 * score.qualityScore +
    0.25 * score.evidencePassRate +
    0.15 * score.costScore +
    0.1 * score.latencyScore +
    0.15 * (1 - score.recentFailurePenalty) +
    preferenceBonus
  );
}

function formatUnsupportedCapsuleMessage(
  capsule: ContextCapsule,
  candidates: readonly AgentRuntime[]
): string {
  return formatUnsupportedRuntimeMessage(
    `No runtime supports node ${capsule.nodeId}`,
    capsuleRoutingRequirements(capsule),
    candidates
  );
}

function formatUnsupportedTaskMessage(
  task: AgentTask,
  candidates: readonly AgentRuntime[]
): string {
  return formatUnsupportedRuntimeMessage(
    `No runtime supports task for node ${task.context.nodeId}`,
    taskCapabilityRequirements(task),
    candidates
  );
}

function formatUnsupportedRuntimeMessage(
  base: string,
  requirements: readonly string[],
  candidates: readonly AgentRuntime[]
): string {
  const details = [
    ...requirements,
    ...candidateSecurityDetails(requirements, candidates),
  ];
  return uniqueStrings([base, ...details]).join("; ");
}

function capsuleRoutingRequirements(capsule: ContextCapsule): string[] {
  const routing = capsule.node.routing;
  const requirements: string[] = [];
  const assignedCapabilities = new Set(routing?.assignedProviderCapabilities ?? []);
  if (routing?.requiresMcp === true || assignedCapabilities.has("mcp")) {
    requirements.push("Node requires MCP authority");
  }
  if (routing?.requiresToolCalling === true || assignedCapabilities.has("toolCalling")) {
    requirements.push("Node requires live tool authority");
  }
  for (const capability of assignedCapabilities) {
    if (capability === "mcp" || capability === "toolCalling") continue;
    requirements.push(`Node requires provider capability ${capability}`);
  }
  return requirements;
}

function taskCapabilityRequirements(task: AgentTask): string[] {
  const requirements: string[] = [];
  if (task.capabilities.mcp) requirements.push("Node requires MCP authority");
  if (task.capabilities.toolCalling) requirements.push("Node requires live tool authority");
  const capabilityKeys = ["read", "write", "shell", "patch", "review", "merge", "vision"] as const;
  for (const key of capabilityKeys) {
    if (task.capabilities[key]) requirements.push(`Node requires provider capability ${key}`);
  }
  return requirements;
}

function candidateSecurityDetails(
  requirements: readonly string[],
  candidates: readonly AgentRuntime[]
): string[] {
  const details: string[] = [];
  const requiresMcp = requirements.some((requirement) => requirement.includes("MCP authority"));
  const requiresToolAuthority = requirements.some((requirement) => requirement.includes("tool authority"));
  for (const runtime of candidates) {
    if (runtime.id === "codex-cli" && requiresMcp) {
      details.push("Codex CLI runtime does not receive OMK MCP authority");
      continue;
    }
    if (runtime.id === "codex-cli" && requiresToolAuthority && runtime.capabilities?.supportsToolCalling !== true) {
      details.push("Codex CLI runtime does not receive OMK tool authority");
    }
  }
  return details;
}

function preferenceRankBonus(preferred: string[], runtimeId: string): number {
  const preferredIndex = preferred.indexOf(runtimeId);
  if (preferredIndex < 0) return 0;
  return 0.15 * ((preferred.length - preferredIndex) / preferred.length);
}

function runtimeSupportsTask(runtime: AgentRuntime, task: AgentTask): boolean {
  const capabilities = runtime.capabilities;
  if (!capabilities) return true;
  const requested = task.capabilities;
  const capabilityKeys = ["read", "write", "shell", "mcp", "patch", "review", "merge", "vision"] as const;
  for (const key of capabilityKeys) {
    if (requested[key] && !capabilities[key]) return false;
  }
  if (requested.streaming && !capabilities.supportsStreaming) return false;
  if (requested.structuredOutput && !capabilities.supportsStructuredOutput) return false;
  if (requested.toolCalling && !capabilities.supportsToolCalling) return false;
  return true;
}

function runtimePreferencesFromTask(task: AgentTask): string[] {
  return uniqueStrings([
    ...task.providerPolicy.preferredProviders,
    ...task.providerPolicy.fallbackChain,
  ].flatMap(runtimeIdsForProviderRef));
}

function runtimeIdsForProviderRef(value: string): string[] {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "auto" || normalized === "authority") return [];
  if (normalized.endsWith("-cli") || normalized.endsWith("-api") || normalized === "kimi-wire" || normalized === "kimi-print") {
    return [normalized];
  }
  if (normalized === "codex" || normalized === "openai-codex") return ["codex-cli"];
  if (normalized === "deepseek" || normalized === "deepseek-v4" || normalized === "ds") return ["deepseek-api"];
  if (normalized === "openrouter" || normalized === "openrouter-ai") return ["openrouter-api"];
  if (normalized === "qwen" || normalized === "dashscope" || normalized === "qwen3" || normalized === "qwen-max") return ["qwen-api", "qwen-cli"];
  if (normalized === "kimi" || normalized === "moonshot") return ["kimi-api", "kimi-wire"];
  if (normalized === "mimo" || normalized === "mimo-v2" || normalized === "mimo-v2.5-pro") return ["mimo-api", "kimi-api"];
  if (normalized === "opencode") return ["opencode-cli"];
  if (normalized === "commandcode") return ["commandcode-cli"];
  return [normalized];
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

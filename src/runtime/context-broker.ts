/**
 * ContextBroker — builds ContextCapsule from DAG state.
 *
 * Collects dependency outputs, graph memory, prior attempts,
 * evidence requirements into a bounded capsule.
 *
 * Integrates ContextBudgetOptimizer for priority-based trimming.
 */
import type { DagNode } from "../orchestration/dag.js";
import type { RunState } from "../contracts/orchestration.js";
import {
  type ContextCapsule,
  type ContextBudget,
  type FileSlice,
  type MemoryFact,
  type MemoryFactKind,
  type AttemptDigest,
  type EvidenceSpec,
  CONTEXT_BUDGET_PRESETS,
  DEFAULT_CONTEXT_BUDGET,
} from './context-capsule.js';
import { getProjectRoot } from "../util/fs.js";
import { join } from "path";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import type { ContextAdjustment } from "../evidence/attempt-record.js";
import { createContextBudgetOptimizer, type ContextBudgetReport } from "./context-budget-optimizer.js";
import { createDecisionTraceStore } from "../evidence/decision-trace.js";
export interface ContextBrokerOptions {
  readonly projectRoot?: string;
  readonly graphMemoryPath?: string;
  readonly goal?: string;
  readonly system?: string;
}

function resolveBudget(node: DagNode): ContextBudget {
  const preset = node.routing?.contextBudget ?? "small";
  return CONTEXT_BUDGET_PRESETS[preset] ?? DEFAULT_CONTEXT_BUDGET;
}

function collectDependencySummaries(node: DagNode, state?: RunState): string[] {
  if (!state || !node.dependsOn.length) return [];
  const summaries: string[] = [];
  for (const depId of node.dependsOn) {
    const depNode = state.nodes.find((n) => n.id === depId);
    if (!depNode) continue;
    const lastAttempt = depNode.attempts?.[depNode.attempts.length - 1];
    if (lastAttempt) {
      summaries.push(`[${depId}] provider=${lastAttempt.provider ?? "?"} status=${lastAttempt.status ?? "?"} duration=${lastAttempt.durationMs ?? "?"}ms`);
    } else {
      summaries.push(`[${depId}] status=${depNode.status}`);
    }
  }
  return summaries;
}

function collectPriorAttempts(node: DagNode): AttemptDigest[] {
  if (!node.attempts?.length) return [];
  return node.attempts.map((a) => ({
    attempt: a.attempt,
    provider: a.provider ?? "unknown",
    status: (a.status ?? "failed") as "done" | "failed",
    durationMs: a.durationMs,
    failureSummary: a.fallbackReason,
  }));
}

function collectEvidenceRequirements(node: DagNode): EvidenceSpec[] {
  if (!node.outputs?.length) return [];
  return node.outputs
    .filter((o) => o.gate && o.gate !== "none")
    .map((o) => ({
      gate: o.gate!,
      ref: o.ref,
      required: o.required !== false,
    }));
}

const GRAPH_MEMORY_PARSE_TIMEOUT_MS = 750;
const GRAPH_MEMORY_PARSE_MAX_BYTES = 2 * 1024 * 1024;
const GRAPH_MEMORY_CACHE_FACT_LIMIT = 250;

interface GraphMemoryParseCacheEntry {
  mtimeMs: number;
  size: number;
  facts: MemoryFact[];
}

const graphMemoryParseCache = new Map<string, GraphMemoryParseCacheEntry>();

async function loadGraphMemory(maxFacts: number, memoryPath?: string): Promise<MemoryFact[]> {
  const filePath = memoryPath ?? join(getProjectRoot(), '.omk', 'memory', 'graph-state.json');
  const safeMaxFacts = Math.max(1, Math.floor(maxFacts) || 1);
  try {
    const graphStat = await stat(filePath);
    if (!graphStat.isFile()) return [];
    const cached = graphMemoryParseCache.get(filePath);
    if (cached && cached.mtimeMs === graphStat.mtimeMs && cached.size === graphStat.size) {
      return cached.facts.slice(0, safeMaxFacts);
    }
    if (graphStat.size > GRAPH_MEMORY_PARSE_MAX_BYTES) {
      if (cached) return cached.facts.slice(0, safeMaxFacts);
      return [
        createGraphMemorySummaryFact(
          `Graph memory state is ${formatBytes(graphStat.size)}, above the ${formatBytes(GRAPH_MEMORY_PARSE_MAX_BYTES)} context-broker parse limit; using fail-soft summary.`
        ),
      ];
    }
    const facts = await withTimeout(
      readGraphMemoryFacts(filePath, Math.max(safeMaxFacts, GRAPH_MEMORY_CACHE_FACT_LIMIT)),
      GRAPH_MEMORY_PARSE_TIMEOUT_MS,
      `ContextBroker graph memory parse timed out after ${GRAPH_MEMORY_PARSE_TIMEOUT_MS}ms`
    );
    graphMemoryParseCache.set(filePath, { mtimeMs: graphStat.mtimeMs, size: graphStat.size, facts });
    return facts.slice(0, safeMaxFacts);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return [];
    const cached = graphMemoryParseCache.get(filePath);
    if (cached) return cached.facts.slice(0, safeMaxFacts);
    return [createGraphMemorySummaryFact(`Graph memory unavailable: ${redactMemoryText(errorMessage(err))}`)];
  }
}

async function readGraphMemoryFacts(filePath: string, maxFacts: number): Promise<MemoryFact[]> {
  const raw = await readFile(filePath, 'utf-8');
  const data = JSON.parse(raw) as Record<string, unknown>;
  const rawNodes = data.nodes;
  const nodes = Array.isArray(rawNodes) ? rawNodes.filter(isRecord) : [];
  const facts: MemoryFact[] = [];
  for (const n of nodes) {
    if (facts.length >= maxFacts) break;
    const type = typeof n.type === "string" ? n.type : undefined;
    const kind = mapGraphTypeToKind(type);
    if (!kind) continue;
    const label = String(n.label ?? n.id ?? '');
    const summary = String(n.summary ?? n.content ?? '');
    if (!summary) continue;
    facts.push({
      kind,
      subject: label,
      predicate: summarizePredicate(kind),
      object: summary,
      confidence: 0.8,
      key: label,
      value: summary,
      category: kind,
    });
  }
  return facts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createGraphMemorySummaryFact(message: string): MemoryFact {
  return {
    kind: "project_constraint",
    subject: "graph-memory",
    predicate: "summarized_as",
    object: message,
    confidence: 0.5,
    key: "graph-memory",
    value: message,
    category: "project_constraint",
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function writeContextBrokerMemoryRecallArtifact(input: {
  projectRoot: string;
  runId: string | undefined;
  nodeId: string;
  graphMemory: readonly MemoryFact[];
}): Promise<void> {
  if (!input.runId || input.runId.startsWith("local-")) return;
  const runDir = join(input.projectRoot, ".omk", "runs", input.runId);
  await mkdir(runDir, { recursive: true });
  const summary = [
    "# Context Broker Memory Recall",
    "",
    `Run ID: ${input.runId}`,
    `Node ID: ${input.nodeId}`,
    `Facts: ${input.graphMemory.length}`,
    "",
    ...input.graphMemory.slice(0, 12).map((fact) => `- ${fact.kind}: ${redactMemoryText(fact.key)} -> ${redactMemoryText(fact.value).slice(0, 180)}`),
    "",
  ].join("\n");
  await writeFile(join(runDir, `context-broker-memory-recall-${input.nodeId}.md`), summary, "utf-8");
}

function redactMemoryText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer ***")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=***");
}

function mapGraphTypeToKind(type: string | undefined): MemoryFactKind | undefined {
  switch (type) {
    case 'Memory': return 'file_responsibility';
    case 'Decision': return 'architecture_decision';
    case 'Goal': return 'project_constraint';
    case 'Constraint': return 'project_constraint';
    case 'Evidence': return 'failure_pattern';
    case 'Provider': return 'provider_behavior';
    case 'ProviderRoute': return 'provider_behavior';
    case 'Risk': return 'failure_pattern';
    default: return undefined;
  }
}

function summarizePredicate(kind: MemoryFactKind): string {
  switch (kind) {
    case 'project_constraint': return 'requires';
    case 'architecture_decision': return 'decided_that';
    case 'file_responsibility': return 'responsible_for';
    case 'api_contract': return 'defines';
    case 'failure_pattern': return 'fails_when';
    case 'successful_fix': return 'fixed_by';
    case 'user_preference': return 'prefers';
    case 'provider_behavior': return 'behaves_as';
  }
}

export function createContextBroker(options: ContextBrokerOptions = {}) {
  const projectRoot = options.projectRoot ?? getProjectRoot();
  const optimizer = createContextBudgetOptimizer();

  async function loadFileContent(paths: readonly string[]): Promise<FileSlice[]> {
    const slices: FileSlice[] = [];
    for (const p of paths) {
      try {
        const fullPath = p.startsWith("/") ? p : join(projectRoot, p);
        const content = await readFile(fullPath, "utf-8");
        const lineCount = content.split("\n").length;
        slices.push({ path: p, startLine: 1, endLine: lineCount, content });
      } catch {
        // File not found or unreadable — skip
      }
    }
    return slices;
  }

  async function buildCapsule(
    node: DagNode,
    state?: RunState,
    adjustment?: ContextAdjustment,
  ): Promise<{ capsule: ContextCapsule; report: ContextBudgetReport }> {
    const goal = options.goal ?? state?.goalId ?? "unknown";
    const system = options.system ?? "You are a coding agent executing a DAG node.";

    const dependencySummaries = collectDependencySummaries(node, state);
    const priorAttempts = collectPriorAttempts(node);
    const evidenceRequirements = collectEvidenceRequirements(node);
    const graphMemory = await loadGraphMemory(resolveBudget(node).maxMemoryFacts, options.graphMemoryPath);
    await writeContextBrokerMemoryRecallArtifact({
      projectRoot,
      runId: state?.runId,
      nodeId: node.id,
      graphMemory,
    }).catch(() => {});

    // When promptMode is "dnc-nlp", the NLP compiler already produced a minimal
    // modelPrompt stored in node.name. Use it directly — do NOT wrap in orchestration
    // contract. This prevents prompt bloat (I-001: available ≠ required).
    const isDncNlp = node.routing?.promptMode === "dnc-nlp";
    const task = isDncNlp
      ? node.name
      : [
          `Execute DAG node: ${node.id}`,
          `Name: ${node.name}`,
          `Role: ${node.role}`,
          node.routing?.actionAtom ? `ActionAtom: ${node.routing.actionAtom.id} | ${node.routing.actionAtom.label} | ${node.routing.actionAtom.verb} ${node.routing.actionAtom.object ?? "assigned scope"} | evidence=${node.routing.actionAtom.evidenceTarget} | done=${node.routing.actionAtom.doneCondition}` : undefined,
          node.routing?.skills?.length ? `Skills: ${node.routing.skills.join(", ")}` : undefined,
          node.routing?.mcpServers?.length ? `MCP: ${node.routing.mcpServers.join(", ")}` : undefined,
          node.routing?.tools?.length ? `Tools: ${node.routing.tools.join(", ")}` : undefined,
          node.routing?.hooks?.length ? `Hooks: ${node.routing.hooks.join(", ")}` : undefined,
          node.routing?.rationale ? `Rationale: ${node.routing.rationale}` : undefined,
        ]
          .filter(Boolean)
          .join("\n");

    // Guard against empty task content
    if (!task || task.trim().length === 0) {
      throw new Error(`ContextBroker: unable to build non-empty task for node ${node.id}`);
    }

    // Load actual file content for adjustment.addFiles
    let relevantFiles: readonly FileSlice[] = [];
    if (adjustment?.addFiles?.length) {
      relevantFiles = await loadFileContent(adjustment.addFiles);
    }

    let budget = resolveBudget(node);
    if (adjustment?.budgetChange) {
      budget = { ...budget, ...adjustment.budgetChange };
    }

    let finalTask = task;
    if (adjustment?.promptPatch) {
      finalTask = `${task}\n\n--- Adjustment ---\n${adjustment.promptPatch}`;
    }

    const rawCapsule: ContextCapsule = {
      runId: state?.runId ?? `local-${Date.now()}`,
      nodeId: node.id,
      goal,
      system,
      task: finalTask,
      dependencySummaries,
      relevantFiles,
      graphMemory,
      priorAttempts,
      evidenceRequirements,
      budget,
      node,
    };

    // Optimize: priority-based trimming + token accounting
    const attemptId = node.attempts?.length
      ? String(node.attempts[node.attempts.length - 1].attempt)
      : "0";
    const optimized = optimizer.optimize(rawCapsule, attemptId);

    // Record context-broker decision trace
    const runId = state?.runId;
    if (runId && !runId.startsWith("local-")) {
      const traceStore = createDecisionTraceStore();
      traceStore.record(runId, {
        component: "context-broker",
        inputSummary: `node=${node.id} budgetPreset=${node.routing?.contextBudget ?? "small"} adjustment=${adjustment ? "yes" : "no"}`,
        outputDecision: `budget=${JSON.stringify(budget)} files=${relevantFiles.length} memoryFacts=${graphMemory.length}`,
        reason: `Context capsule built with ${optimized.report.totalTokensEstimated} total tokens, ${optimized.report.toolResultTokens} tool tokens`,
        scores: {
          totalTokens: optimized.report.totalTokensEstimated,
          toolResultTokens: optimized.report.toolResultTokens,
          droppedItems: optimized.report.droppedItems.length,
        },
        nodeId: node.id,
        attemptId: `${node.id}__${attemptId}`,
      });
    }

    return { capsule: optimized.capsule, report: optimized.report };
  }

  return { buildCapsule };
}

import type {
  ExecutionSelectionDecision,
  ExecutionStrategy,
} from "../contracts/orchestration.js";
import { buildInputEnvelope, normalizeMcpScope } from "../input/input-envelope.js";
import { persistInputEnvelope } from "../input/input-artifacts.js";
import { compileInputEnvelopeToDag } from "../orchestration/dag-compiler.js";
import { persistDagCompileArtifacts } from "../orchestration/dag-artifacts.js";
import { executeCompiledDag } from "../orchestration/compiled-dag-executor.js";
import type { ExecuteCompiledDagResult } from "../orchestration/compiled-dag-executor.js";
import type { ProviderPolicy } from "../providers/types.js";
import { resolveProjectRoot, sanitizeRunId } from "../util/fs.js";
import { explainLoopDecision } from "../ux/explain-loop-decision.js";
import { routeNaturalPrompt } from "../ux/intent-router.js";
import type { OmkUxIntent, RoutedPrompt } from "../ux/intent-router.js";
import type { NaturalPromptOptions, OmkUxMode } from "../ux/natural-entrypoint.js";

export interface DoCommandOptions extends NaturalPromptOptions {
  root?: string;
  cwd?: string;
  now?: () => Date;
  emit?: boolean;
  signal?: AbortSignal;
}

export interface DoCommandResult {
  success: boolean;
  runId: string;
  inputId: string;
  intent: OmkUxIntent;
  mode: OmkUxMode;
  safety: RoutedPrompt["safety"];
  execution: RoutedPrompt["execution"];
  dryRun: boolean;
  paths: {
    inputEnvelope: string;
    inputHistory: string;
    runDir: string;
    dag: string;
    dagReport: string;
  };
  loop?: Pick<ExecuteCompiledDagResult, "loopDecision" | "loopState" | "loopArtifacts">;
}

export async function doCommand(
  prompt: string,
  options: DoCommandOptions = {},
): Promise<DoCommandResult> {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) throw new Error("omk do requires a prompt");

  const now = options.now ?? (() => new Date());
  const createdAt = now();
  const cwd = options.cwd ?? process.cwd();
  const rootResolution = options.root
    ? { root: options.root, source: "env" as const }
    : resolveProjectRoot({ cwd });
  const root = rootResolution.root;
  const runId = sanitizeRunId(
    options.runId ?? `do-${createdAt.toISOString().replace(/[:.]/gu, "-")}`,
    "do",
  );
  const provider = normalizeProviderPolicy(options.provider);
  const mcpScope = normalizeMcpScope(options.mcpScope) ?? "project";
  const route = routeNaturalPrompt(trimmedPrompt, {}, options.mode);

  const envelope = buildInputEnvelope({
    runId,
    kind: "plain-prompt",
    raw: trimmedPrompt,
    source: "run",
    cwd,
    root,
    rootSource: rootResolution.source,
    provider,
    model: options.model,
    mcpScope,
    constraints: [
      `ux-mode:${route.mode}`,
      `ux-intent:${route.intent}`,
      `safety:${route.safety}`,
    ],
    requestedArtifacts: [
      { name: "friendly task progress" },
      { name: "dag compile report", path: ".omk/runs/<runId>/dag-compile-report.json" },
    ],
    now,
  });
  const inputPaths = await persistInputEnvelope(envelope, { root });

  const executionDecision = executionDecisionForRoute(route);
  const compiled = await compileInputEnvelopeToDag({
    input: envelope,
    executionDecision,
    workerCount: parseWorkerCount(options.workers),
  });
  const dagPaths = await persistDagCompileArtifacts(compiled, { root });

  if (options.json && options.emit !== false) {
    writeJson({
      runId,
      inputId: envelope.inputId,
      intent: route.intent,
      mode: route.mode,
      safety: route.safety,
      execution: compiled.executionStrategy,
      dryRun: Boolean(options.dryRun || compiled.executionStrategy === "plan-only"),
      artifacts: {
        inputEnvelope: inputPaths.latestPath,
        dag: dagPaths.dagPath,
        dagReport: dagPaths.reportPath,
      },
    });
  } else if (options.emit !== false) {
    writeLines(renderDoSummary(trimmedPrompt, route, compiled.executionStrategy, dagPaths.reportPath));
  }

  const shouldExecute = !options.dryRun && compiled.executionStrategy !== "plan-only";
  if (!shouldExecute) {
    return {
      success: true,
      runId,
      inputId: envelope.inputId,
      intent: route.intent,
      mode: route.mode,
      safety: route.safety,
      execution: route.execution,
      dryRun: true,
      paths: {
        inputEnvelope: inputPaths.latestPath,
        inputHistory: inputPaths.historyPath,
        runDir: dagPaths.runDir,
        dag: dagPaths.dagPath,
        dagReport: dagPaths.reportPath,
      },
    };
  }

  const executed = await executeCompiledDag({
    root,
    compiled,
    providerPolicy: provider,
    model: options.model,
    mcpScope,
    approvalPolicy: approvalPolicyForMode(route.mode),
    signal: options.signal,
  });

  if (!options.json && options.emit !== false) {
    writeLines(["", "Result", `  ${executed.run.success ? "Done" : "Needs attention"}`, "", "Why", ...explainLoopDecision(executed.loopDecision).map((line) => `  ${line}`)]);
  }

  return {
    success: executed.run.success,
    runId,
    inputId: envelope.inputId,
    intent: route.intent,
    mode: route.mode,
    safety: route.safety,
    execution: route.execution,
    dryRun: false,
    paths: {
      inputEnvelope: inputPaths.latestPath,
      inputHistory: inputPaths.historyPath,
      runDir: dagPaths.runDir,
      dag: dagPaths.dagPath,
      dagReport: dagPaths.reportPath,
    },
    loop: {
      loopDecision: executed.loopDecision,
      loopState: executed.loopState,
      loopArtifacts: executed.loopArtifacts,
    },
  };
}

function executionDecisionForRoute(route: RoutedPrompt): ExecutionSelectionDecision | undefined {
  if (route.execution !== "plan-only") return undefined;
  return {
    policy: "ask",
    source: "cli",
    strategy: "plan-only",
    reason: `UX ${route.mode} mode keeps this task read-only`,
    isTTY: Boolean(process.stdout.isTTY),
    isNonTrivial: route.intent !== "chat" && route.intent !== "explain",
  };
}

function parseWorkerCount(value: string | undefined): number | undefined {
  if (!value || value === "auto") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.min(parsed, 12);
}

function approvalPolicyForMode(mode: OmkUxMode): "interactive" | "auto" | "block" {
  if (mode === "autopilot") return "auto";
  if (mode === "plan" || mode === "safe" || mode === "review") return "block";
  return "interactive";
}

function normalizeProviderPolicy(value: string | undefined): ProviderPolicy {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "authority":
    case "auto":
    case "codex":
    case "commandcode":
    case "deepseek":
    case "kimi":
    case "local-llm":
    case "mimo":
    case "opencode":
    case "openrouter":
    case "qwen":
      return normalized;
    default:
      return "auto";
  }
}

function renderDoSummary(
  prompt: string,
  route: RoutedPrompt,
  strategy: ExecutionStrategy,
  dagReportPath: string,
): string[] {
  return [
    "Goal",
    `  ${prompt}`,
    "",
    "Detected",
    `  Task: ${route.intent}`,
    `  Mode: ${route.mode}`,
    `  Safety: ${route.safety}`,
    `  Execution: ${strategy}`,
    `  Reason: ${route.reason}`,
    "",
    "Artifacts",
    `  ${dagReportPath}`,
  ];
}

function writeLines(lines: readonly string[]): void {
  for (const line of lines) console.log(line);
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

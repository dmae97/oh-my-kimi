import type { IntentFrame } from "../contracts/goal.js";
import type {
  ExecutionStrategy,
  UserIntentV2,
} from "../contracts/orchestration.js";
import { analyzeUserIntentV2 } from "../goal/intent-analyzer.js";
import { buildIntentFrame } from "../goal/intent-frame.js";
import type { ProviderPolicy } from "../providers/types.js";
import type { DagNodeDefinition } from "./dag.js";
import { createDag } from "./dag.js";
import {
  buildRoleSpecificDagNodes,
  shouldCompileRoleSpecificDag,
} from "./dag-compiler-presets.js";
import type {
  BuildDagCompileResultInput,
  DagCompileInput,
  DagCompileResult,
} from "./dag-compiler-types.js";

export async function compileInputEnvelopeToDag(
  input: DagCompileInput,
): Promise<DagCompileResult> {
  const intent =
    input.intent ??
    (await analyzeUserIntentV2({
      rawPrompt: input.input.normalized,
      root: input.input.root,
    }));
  const intentFrame =
    input.intentFrame ??
    buildIntentFrame(input.input.normalized, {
      constraints: input.input.constraints,
      expectedArtifacts: input.input.requestedArtifacts,
    });
  const executionStrategy = selectExecutionStrategy(
    input.executionDecision?.strategy,
    intent,
  );
  const workerCount = Math.max(
    1,
    input.workerCount ?? intent.estimatedWorkers ?? 1,
  );
  const providerPolicy = normalizeProviderPolicy(input.input.provider);
  const nodes = shouldCompileRoleSpecificDag({ input: input.input })
    ? buildRoleSpecificDagNodes({
        input: input.input,
        intent,
        intentFrame,
        workerCount,
        executionStrategy,
        providerPolicy,
      })
    : [buildInputEnvelopeNode({ input: input.input, intent, intentFrame })];
  const dag = createDag({ nodes });

  return buildDagCompileResult({
    input: input.input,
    dag,
    workerCount,
    executionStrategy,
    intent,
    intentFrame,
    explanation: `Compiled ${input.input.kind} input through InputEnvelope v${input.input.schemaVersion}`,
  });
}

export function buildDagCompileResult(
  input: BuildDagCompileResultInput,
): DagCompileResult {
  return {
    schemaVersion: 1,
    inputId: input.input.inputId,
    runId: input.input.runId,
    dag: input.dag,
    workerCount: input.workerCount,
    executionStrategy: input.executionStrategy,
    intent: input.intent,
    intentFrame: input.intentFrame,
    artifacts: {
      capabilityRouting: input.capabilityRouting,
      explanation: input.explanation,
    },
    compiledAt: input.compiledAt ?? new Date().toISOString(),
  };
}

function selectExecutionStrategy(
  requested: ExecutionStrategy | undefined,
  intent: UserIntentV2,
): ExecutionStrategy {
  return (
    requested ??
    intent.routingHints.preferredExecutionStrategy ??
    (intent.parallelizable ? "parallel" : "sequential")
  );
}

function buildInputEnvelopeNode(input: {
  input: import("../input/input-envelope.js").InputEnvelope;
  intent: UserIntentV2;
  intentFrame: IntentFrame;
}): DagNodeDefinition {
  const readOnly =
    input.intent.isReadOnly || input.input.kind === "slash-command";
  const name =
    input.input.kind === "slash-command"
      ? `Operator command ${input.input.slashCommand?.command ?? input.input.normalized}`
      : input.input.normalized;
  return {
    id: `${input.input.inputId}-compile`,
    name,
    role: input.input.kind === "slash-command" ? "operator" : "coordinator",
    dependsOn: [],
    maxRetries: 1,
    outputs: [
      {
        name: "input DAG compile",
        gate: "summary",
        ref: "dag-compile-report.json",
      },
    ],
    routing: {
      provider: normalizeProviderPolicy(input.input.provider),
      providerModel: input.input.model,
      assignedProviderCapabilities: readOnly
        ? ["read", "review", "advisory"]
        : ["write", "patch"],
      contextBudget: input.intent.complexity === "complex" ? "normal" : "small",
      readOnly,
      risk: readOnly ? "read" : "write",
      evidenceRequired: input.intent.routingHints.requireEvidence ?? false,
      actionAtom: input.intentFrame.actionAtoms[0]
        ? {
            id: input.intentFrame.actionAtoms[0].id,
            label: input.intentFrame.actionAtoms[0].label,
            verb: input.intentFrame.actionAtoms[0].verb,
            object: input.intentFrame.actionAtoms[0].object,
            evidenceTarget: input.intentFrame.actionAtoms[0].evidenceTarget,
            doneCondition: input.intentFrame.actionAtoms[0].doneCondition,
          }
        : undefined,
      rationale: `DAG compiler skeleton for InputEnvelope ${input.input.inputId}`,
    },
  };
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

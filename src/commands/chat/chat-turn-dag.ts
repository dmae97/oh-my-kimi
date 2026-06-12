import type { IntentFrame } from "../../contracts/goal.js";
import type { ExecutionStrategy, UserIntentV2 } from "../../contracts/orchestration.js";
import type { ProviderPolicy } from "../../providers/types.js";
import { analyzeUserIntentV2 } from "../../goal/intent-analyzer.js";
import { buildIntentFrame } from "../../goal/intent-frame.js";
import { createDag, type Dag, type DagNodeDefinition } from "../../orchestration/dag.js";
import { buildDynamicNodes } from "../parallel/orchestrator.js";

export interface BuildChatTurnDagInput {
  prompt: string;
  runId: string;
  providerPolicy: ProviderPolicy;
  providerModel?: string;
  workerCount?: number;
  allowRuntimeRefine?: boolean;
  executionStrategy?: ExecutionStrategy;
  mcpAllowlist?: readonly string[];
  skillNames?: readonly string[];
  hookNames?: readonly string[];
  toolNames?: readonly string[];
  intent?: UserIntentV2;
  intentFrame?: IntentFrame;
  now?: () => Date;
}

export async function buildChatTurnDag(input: BuildChatTurnDagInput): Promise<Dag> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new TypeError("chat turn prompt must not be empty");
  }

  const intent = input.intent ?? await analyzeUserIntentV2({
    rawPrompt: prompt,
    allowRuntimeRefine: input.allowRuntimeRefine ?? true,
  });
  const intentFrame = input.intentFrame ?? buildIntentFrame(prompt);

  if (isSingleNodeChatTurn(intent)) {
    return createDag({
      nodes: [buildSingleChatTurnNode({
        prompt,
        providerPolicy: input.providerPolicy,
        providerModel: input.providerModel,
        mcpAllowlist: input.mcpAllowlist,
        skillNames: input.skillNames,
        hookNames: input.hookNames,
        toolNames: input.toolNames,
      })],
    });
  }

  return createDag({
    nodes: buildDynamicNodes({
      flow: "chat-turn",
      goal: prompt,
      intentFrame,
      startedAt: (input.now ?? (() => new Date()))().toISOString(),
      workerCount: Math.max(1, input.workerCount ?? intent.estimatedWorkers ?? 1),
      intent,
      providerPolicy: input.providerPolicy,
      executionStrategy: selectChatExecutionStrategy(input.executionStrategy, intent),
    }),
  });
}

function isSingleNodeChatTurn(intent: UserIntentV2): boolean {
  return intent.complexity === "simple" && intent.isReadOnly && intent.parallelizable === false;
}

function selectChatExecutionStrategy(
  requested: ExecutionStrategy | undefined,
  intent: UserIntentV2
): ExecutionStrategy {
  return requested
    ?? intent.routingHints.preferredExecutionStrategy
    ?? (intent.parallelizable ? "parallel" : "sequential");
}

function buildSingleChatTurnNode(input: {
  prompt: string;
  providerPolicy: ProviderPolicy;
  providerModel?: string;
  mcpAllowlist?: readonly string[];
  skillNames?: readonly string[];
  hookNames?: readonly string[];
  toolNames?: readonly string[];
}): DagNodeDefinition {
  const routing: NonNullable<DagNodeDefinition["routing"]> = {
    provider: input.providerPolicy,
    providerModel: input.providerModel,
    assignedProviderCapabilities: ["read", "review", "advisory"],
    contextBudget: "normal",
    readOnly: true,
    evidenceRequired: false,
    mcpServers: [...(input.mcpAllowlist ?? [])],
    skills: [...(input.skillNames ?? [])],
    hooks: [...(input.hookNames ?? [])],
    tools: [...(input.toolNames ?? [])],
    rationale: "simple read-only chat turn routed through the shared DAG harness",
  };

  return {
    id: "chat-turn",
    name: input.prompt,
    role: "coordinator",
    dependsOn: [],
    maxRetries: 1,
    outputs: [{ name: "chat response", gate: "none" }],
    routing,
  };
}

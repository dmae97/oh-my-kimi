import { join } from "node:path";

import type {
  ApprovalPolicy,
  RunResult,
  RunState,
  TaskResult,
  TaskRunner,
} from "../contracts/orchestration.js";
import type { OmkRuntimeScope } from "../contracts/worker-context.js";
import {
  createHarnessTaskRunner,
  type HarnessTaskRunnerMode,
  type HarnessTaskRunnerOptions,
  type HarnessTaskRunnerProviderOptions,
} from "../harness/create-harness-task-runner.js";
import {
  executeHarnessRun,
  type ExecuteHarnessRunInput,
} from "../harness/execute-harness-run.js";
import type { InputEnvelope } from "../input/input-envelope.js";
import type { ProviderPolicy } from "../providers/types.js";
import type { EnsemblePolicy } from "./ensemble.js";
import type { DagNode } from "./dag.js";
import type { DagCompileResult } from "./dag-compiler-types.js";
import {
  createLoopState,
  evaluateLoopDecision,
} from "./loop-controller.js";
import {
  persistLoopArtifacts,
  type PersistLoopArtifactsResult,
} from "./loop-artifacts.js";
import type {
  LoopDecision,
  OrchestrationLoopState,
} from "./loop-state.js";

export interface ExecuteCompiledDagLoopOptions {
  persist?: boolean;
  requestedAction?: "continue" | "replan" | "verify";
  iteration?: number;
  maxIterations?: number;
  parentRunId?: string;
  nextInputEnvelope?: InputEnvelope;
  now?: () => Date;
}

export interface ExecuteCompiledDagInput {
  root: string;
  compiled: DagCompileResult;
  runId?: string;
  providerPolicy?: ProviderPolicy;
  model?: string;
  mcpScope?: OmkRuntimeScope;
  skillsScope?: OmkRuntimeScope;
  hooksScope?: OmkRuntimeScope;
  env?: Record<string, string>;
  mode?: HarnessTaskRunnerMode;
  approvalPolicy?: ApprovalPolicy;
  timeoutPreset?: string;
  nodeTimeoutMs?: number;
  runTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  signal?: AbortSignal;
  eventRunDir?: string;
  ensemble?: false | EnsemblePolicy;
  resumeFromState?: RunState;
  useRuntimeBacked?: boolean;
  runner?: TaskRunner;
  providerOptions?: HarnessTaskRunnerProviderOptions;
  runtimeOptions?: HarnessTaskRunnerOptions["runtimeOptions"];
  factories?: HarnessTaskRunnerOptions["factories"];
  loop?: ExecuteCompiledDagLoopOptions;
  onStateChange?: (state: RunState) => void;
  onNodeStart?: (node: DagNode) => void;
  onNodeComplete?: (node: DagNode, result: TaskResult) => void;
}

export interface ExecuteCompiledDagResult {
  run: RunResult;
  loopDecision: LoopDecision;
  loopState: OrchestrationLoopState;
  loopArtifacts?: PersistLoopArtifactsResult;
}

export async function executeCompiledDag(
  input: ExecuteCompiledDagInput,
): Promise<ExecuteCompiledDagResult> {
  const runId = input.runId ?? input.compiled.runId;
  const eventRunDir = input.eventRunDir ?? join(input.root, ".omk", "runs", runId);
  const env = buildCompiledDagEnv(input, runId);
  const runner =
    input.runner ??
    (await createHarnessTaskRunner({
      root: input.root,
      runId,
      mode: input.mode ?? "parallel",
      providerPolicy: input.providerPolicy ?? "auto",
      env,
      useRuntimeBacked: input.useRuntimeBacked,
      runtimeOptions: input.runtimeOptions,
      providerOptions: {
        ...(input.providerOptions ?? {}),
        model: input.model ?? input.providerOptions?.model,
        mcpScope:
          input.mcpScope ?? input.providerOptions?.mcpScope ?? "project",
        skillsScope:
          input.skillsScope ?? input.providerOptions?.skillsScope ?? "project",
        hooksScope:
          input.hooksScope ?? input.providerOptions?.hooksScope ?? "project",
        eventRunDir,
      },
      factories: input.factories,
    }));

  const run = await executeHarnessRun({
    root: input.root,
    runId,
    dag: input.compiled.dag,
    runner,
    env,
    workers: input.compiled.workerCount,
    approvalPolicy: input.approvalPolicy ?? "block",
    timeoutPreset: input.timeoutPreset,
    nodeTimeoutMs: input.nodeTimeoutMs,
    runTimeoutMs: input.runTimeoutMs,
    heartbeatIntervalMs: input.heartbeatIntervalMs,
    resumeFromState: input.resumeFromState,
    eventRunDir,
    ensemble: input.ensemble,
    signal: input.signal,
    onStateChange: input.onStateChange,
    onNodeStart: input.onNodeStart,
    onNodeComplete: input.onNodeComplete,
  } satisfies ExecuteHarnessRunInput);

  const loopDecision = evaluateLoopDecision({
    runId,
    inputId: input.compiled.inputId,
    runState: run.state,
    requestedAction: input.loop?.requestedAction,
    iteration: input.loop?.iteration,
    maxIterations: input.loop?.maxIterations,
    now: input.loop?.now,
  });
  const loopState = createLoopState({
    runId,
    inputId: input.compiled.inputId,
    runState: run.state,
    decision: loopDecision,
    parentRunId: input.loop?.parentRunId,
    maxIterations: input.loop?.maxIterations,
    now: input.loop?.now,
  });
  const shouldPersistLoop = input.loop?.persist ?? true;
  const loopArtifacts = shouldPersistLoop
    ? await persistLoopArtifacts(loopState, loopDecision, {
        root: input.root,
        nextInputEnvelope: input.loop?.nextInputEnvelope,
      })
    : undefined;

  return { run, loopDecision, loopState, loopArtifacts };
}

function buildCompiledDagEnv(
  input: ExecuteCompiledDagInput,
  runId: string,
): Record<string, string> {
  return {
    ...(input.env ?? {}),
    OMK_RUN_ID: runId,
    OMK_INPUT_ID: input.compiled.inputId,
    OMK_FLOW: input.env?.OMK_FLOW ?? "compiled-dag",
    OMK_DAG_EXECUTION_STRATEGY: input.compiled.executionStrategy,
    OMK_DAG_COMPILED_AT: input.compiled.compiledAt,
    OMK_WORKERS: String(input.compiled.workerCount),
    ...(input.model ? { OMK_PROVIDER_MODEL: input.model } : {}),
    ...(input.mcpScope ? { OMK_MCP_SCOPE: input.mcpScope } : {}),
  };
}

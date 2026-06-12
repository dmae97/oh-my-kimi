import { join } from "node:path";

import type { ApprovalPolicy, RunOptions, RunResult, RunState, TaskRunner, TaskResult } from "../contracts/orchestration.js";
import type {
  EnvMergeTraceEntry,
  EnvMergeTraceSource,
  TaskRunContext,
} from "../contracts/worker-context.js";
import type { Dag, DagNode } from "../orchestration/dag.js";
import type { EnsemblePolicy } from "../orchestration/ensemble.js";
import { createExecutor } from "../orchestration/executor.js";
import { createStatePersister, type StatePersister } from "../orchestration/state-persister.js";
import { envFromWorkerManifest } from "../runtime/worker-manifest.js";

export interface ExecuteHarnessRunInput {
  root: string;
  runId: string;
  dag: Dag;
  runner: TaskRunner;
  env?: Record<string, string>;
  workers: number;
  approvalPolicy: ApprovalPolicy;
  timeoutPreset?: string;
  nodeTimeoutMs?: number;
  runTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  signal?: AbortSignal;
  persister?: StatePersister;
  eventRunDir?: string;
  ensemble?: false | EnsemblePolicy;
  resumeFromState?: RunState;
  onStateChange?: (state: RunState) => void;
  onNodeStart?: (node: DagNode) => void;
  onNodeComplete?: (node: DagNode, result: TaskResult) => void;
}

function contextWithBaseEnv(context: TaskRunContext | undefined, env: Record<string, string>): TaskRunContext | undefined {
  const mcpConfigFile = env.OMK_MCP_CONFIG_FILE;
  if (!context || !mcpConfigFile || context.worker.toolPlane.mcpConfigFile) return context;
  return {
    ...context,
    worker: {
      ...context.worker,
      toolPlane: {
        ...context.worker.toolPlane,
        mcpConfigFile,
      },
    },
  };
}

function withHarnessEnv(runner: TaskRunner, env: Record<string, string> | undefined): TaskRunner {
  if (!env || Object.keys(env).length === 0) return runner;
  return {
    ...(runner.onThinking ? { onThinking: runner.onThinking } : {}),
    run(node, nodeEnv, signal, context) {
      const nextContext = contextWithBaseEnv(context, env);
      const merged = mergeEnvWithTrace([
        { source: "base", env },
        { source: "node", env: nodeEnv },
        { source: "worker-manifest", env: nextContext ? envFromWorkerManifest(nextContext.worker) : {} },
      ]);
      return runner.run(
        node,
        merged.env,
        signal,
        appendEnvMergeTrace(nextContext, merged.trace),
      );
    },
    ...(runner.fork
      ? {
          fork(onThinking?: (thinking: string) => void): TaskRunner {
            return withHarnessEnv(runner.fork?.(onThinking) ?? runner, env);
          },
        }
      : {}),
  };
}

export function mergeEnvWithTrace(
  sources: Array<{ source: EnvMergeTraceSource; env: Record<string, string> }>,
): { env: Record<string, string>; trace: EnvMergeTraceEntry[] } {
  const env: Record<string, string> = {};
  const trace: EnvMergeTraceEntry[] = [];

  for (const { source, env: sourceEnv } of sources) {
    for (const [key, next] of Object.entries(sourceEnv)) {
      const previous = env[key];
      if (next === "" && previous) {
        trace.push({ key, previous, next, source, action: "preserve-non-empty" });
        continue;
      }
      if (next === "" && previous === undefined) {
        trace.push({ key, next, source, action: "drop-empty" });
        continue;
      }
      env[key] = next;
      trace.push({
        key,
        previous,
        next,
        source,
        action: previous === undefined ? "set" : "overwrite",
      });
    }
  }

  return { env, trace };
}

function appendEnvMergeTrace(
  context: TaskRunContext | undefined,
  envMergeTrace: EnvMergeTraceEntry[],
): TaskRunContext | undefined {
  if (!context) return context;
  return {
    ...context,
    diagnostics: {
      ...context.diagnostics,
      envMergeTrace,
    },
  };
}

export async function executeHarnessRun(input: ExecuteHarnessRunInput): Promise<RunResult> {
  const executor = createExecutor({
    persister: input.persister ?? createStatePersister(join(input.root, ".omk", "runs")),
    ensemble: input.ensemble ?? false,
    signal: input.signal,
    resumeFromState: input.resumeFromState,
    eventRunDir: input.eventRunDir,
  });

  if (input.onStateChange) executor.onStateChange(input.onStateChange);
  if (input.onNodeStart && executor.onNodeStart) executor.onNodeStart(input.onNodeStart);
  if (input.onNodeComplete && executor.onNodeComplete) executor.onNodeComplete(input.onNodeComplete);

  const runOptions: RunOptions = {
    runId: input.runId,
    workers: input.workers,
    approvalPolicy: input.approvalPolicy,
    worktreeRoot: input.root,
  };

  if (input.timeoutPreset !== undefined) runOptions.timeoutPreset = input.timeoutPreset;
  if (input.nodeTimeoutMs !== undefined) runOptions.nodeTimeoutMs = input.nodeTimeoutMs;
  if (input.runTimeoutMs !== undefined) runOptions.runTimeoutMs = input.runTimeoutMs;
  if (input.heartbeatIntervalMs !== undefined) runOptions.heartbeatIntervalMs = input.heartbeatIntervalMs;

  return executor.execute(input.dag, withHarnessEnv(input.runner, input.env), runOptions);
}

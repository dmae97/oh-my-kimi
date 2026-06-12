import type { TaskRunner } from "../contracts/orchestration.js";
import type { OmkRuntimeScope } from "../contracts/worker-context.js";
import {
  createProviderBackedTaskRunner,
  type ProviderBackedTaskRunnerOptions,
} from "../providers/provider-runtime.js";
import type { ProviderPolicy } from "../providers/types.js";
import {
  createRuntimeBackedTaskRunner,
  type RuntimeBackedTaskRunnerOptions,
} from "../runtime/runtime-backed-task-runner.js";

export type HarnessTaskRunnerMode = "chat" | "run" | "parallel";

type RuntimeBackedFactory = (options: RuntimeBackedTaskRunnerOptions) => Promise<TaskRunner>;
type ProviderBackedFactory = (options: ProviderBackedTaskRunnerOptions) => Promise<TaskRunner>;

export interface HarnessTaskRunnerProviderOptions {
  agentFile?: string;
  promptPrefix?: string;
  mcpScope?: OmkRuntimeScope;
  skillsScope?: OmkRuntimeScope;
  hooksScope?: OmkRuntimeScope;
  mcpNames?: string[];
  skillNames?: string[];
  hookNames?: string[];
  toolNames?: string[];
  model?: string;
  eventRunDir?: string;
  deepseekPromptPrefix?: string;
  allowDeepSeekAdvisoryFileNodes?: boolean;
  fallbackChain?: string[];
  providerBackedOptions?: Omit<ProviderBackedTaskRunnerOptions, "cwd" | "providerPolicy" | "kimi"> & {
    kimi?: ProviderBackedTaskRunnerOptions["kimi"];
  };
}

export interface HarnessTaskRunnerOptions {
  root: string;
  runId: string;
  mode: HarnessTaskRunnerMode;
  providerPolicy: ProviderPolicy;
  env?: Record<string, string>;
  useRuntimeBacked?: boolean;
  runtimeOptions?: Partial<Pick<
    RuntimeBackedTaskRunnerOptions,
    "runtimePolicy" | "defaultRuntime" | "fallbackChain" | "goal" | "onOutput"
  >>;
  providerOptions?: HarnessTaskRunnerProviderOptions;
  factories?: {
    runtimeBacked?: RuntimeBackedFactory;
    providerBacked?: ProviderBackedFactory;
  };
}

export async function createHarnessTaskRunner(options: HarnessTaskRunnerOptions): Promise<TaskRunner> {
  const env = {
    ...(options.env ?? {}),
    OMK_RUN_ID: options.runId,
  };

  if (options.useRuntimeBacked === true || options.mode === "chat") {
    const factory = options.factories?.runtimeBacked ?? createRuntimeBackedTaskRunner;
    return factory({
      cwd: options.root,
      env,
      runId: options.runId,
      runtimePolicy: options.runtimeOptions?.runtimePolicy ?? options.providerPolicy,
      defaultRuntime: options.runtimeOptions?.defaultRuntime,
      fallbackChain: options.runtimeOptions?.fallbackChain,
      goal: options.runtimeOptions?.goal,
      onOutput: options.runtimeOptions?.onOutput,
    });
  }

  const providerOptions = options.providerOptions ?? {};
  const providerEnv = {
    ...env,
    ...(providerOptions.model ? { OMK_PROVIDER_MODEL: providerOptions.model } : {}),
  };
  const factory = options.factories?.providerBacked ?? createProviderBackedTaskRunner;

  return factory({
    ...(providerOptions.providerBackedOptions ?? {}),
    cwd: options.root,
    providerPolicy: options.providerPolicy,
    eventRunDir: providerOptions.eventRunDir ?? providerOptions.providerBackedOptions?.eventRunDir,
    deepseekPromptPrefix: providerOptions.deepseekPromptPrefix ?? providerOptions.providerBackedOptions?.deepseekPromptPrefix,
    allowDeepSeekAdvisoryFileNodes: providerOptions.allowDeepSeekAdvisoryFileNodes
      ?? providerOptions.providerBackedOptions?.allowDeepSeekAdvisoryFileNodes,
    fallbackChain: providerOptions.fallbackChain ?? providerOptions.providerBackedOptions?.fallbackChain,
    kimi: {
      ...(providerOptions.providerBackedOptions?.kimi ?? {}),
      cwd: providerOptions.providerBackedOptions?.kimi?.cwd ?? options.root,
      timeout: providerOptions.providerBackedOptions?.kimi?.timeout ?? 0,
      agentFile: providerOptions.agentFile ?? providerOptions.providerBackedOptions?.kimi?.agentFile,
      promptPrefix: providerOptions.promptPrefix ?? providerOptions.providerBackedOptions?.kimi?.promptPrefix,
      mcpScope: providerOptions.mcpScope ?? providerOptions.providerBackedOptions?.kimi?.mcpScope ?? "project",
      skillsScope: providerOptions.skillsScope ?? providerOptions.providerBackedOptions?.kimi?.skillsScope ?? "project",
      hooksScope: providerOptions.hooksScope ?? providerOptions.providerBackedOptions?.kimi?.hooksScope ?? "project",
      roleAgentFiles: providerOptions.providerBackedOptions?.kimi?.roleAgentFiles ?? true,
      mcpNames: providerOptions.mcpNames ?? providerOptions.providerBackedOptions?.kimi?.mcpNames ?? [],
      skillNames: providerOptions.skillNames ?? providerOptions.providerBackedOptions?.kimi?.skillNames ?? [],
      hookNames: providerOptions.hookNames ?? providerOptions.providerBackedOptions?.kimi?.hookNames ?? [],
      toolNames: providerOptions.toolNames ?? providerOptions.providerBackedOptions?.kimi?.toolNames ?? [],
      env: {
        ...(providerOptions.providerBackedOptions?.kimi?.env ?? {}),
        ...providerEnv,
      },
    },
  });
}

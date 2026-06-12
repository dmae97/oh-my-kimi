import type { TaskRunner } from "../contracts/orchestration.js";
import type { TaskRunContext } from "../contracts/worker-context.js";
import { createKimiTaskRunner, type KimiTaskRunnerOptions } from "../kimi/runner.js";
import { style, status } from "../util/theme.js";
import { getProjectRoot } from "../util/fs.js";
import { checkCommand, resolveKimiBin } from "../util/shell.js";
import { checkDeepSeekBalance } from "./deepseek/deepseek-balance.js";
import { createDeepSeekReadOnlyTaskRunner } from "./deepseek/deepseek-provider.js";
import {
  forceDisableDeepSeek,
  getDeepSeekProviderStatus,
  resolveDeepSeekApiKey,
} from "./deepseek/deepseek-config.js";
import { ProviderHealthRegistry } from "./health.js";
import { createProviderTaskRunner } from "./provider-task-runner.js";
import { loadProviderModelStats } from "./provider-stats.js";
import type { ProviderId, ProviderModelDefault, ProviderPolicy } from "./types.js";
import { resolveAuthorityProvider } from "./types.js";
import { createKimiProvider } from "./kimi-provider.js";
import { createDeepSeekProvider } from "./deepseek-provider.js";
import { createProviderRouter } from "./provider-router.js";
import { toTaskResult, type AgentProvider } from "./provider.js";
import { createOpenAICompatibleReadOnlyTaskRunner } from "./openai-compatible-runner.js";
import { createCodexCliAdvisoryTaskRunner } from "./codex-cli-runner.js";
import { normalizeProviderId, providerDoctorStatus, readProviderRegistry, type ProviderRegistryEntry } from "./model-registry.js";
import { createContextBroker } from "../runtime/context-broker.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import { createKimiPrintRuntime } from "../runtime/kimi-print-runtime.js";
import { createKimiApiRuntime } from "../runtime/kimi-api-runtime.js";
import { createMimoApiRuntime } from "../runtime/mimo-api-runtime.js";
import { createRuntimeRouter } from "../runtime/runtime-router.js";

export interface RuntimeRegistryOptions {
  /** Explicitly injected runtimes. If provided, auto-discovery is skipped. */
  runtimes?: AgentRuntime[];
  /** Explicitly injected providers. If provided, auto-discovery is skipped for those IDs. */
  providers?: AgentProvider[];
  /** Kimi runner options (kept for backward compatibility). Used for auto-discovery when runtimes not injected. */
  kimi?: KimiTaskRunnerOptions;
  /** Explicit working directory. Defaults to getProjectRoot() or kimi.cwd for backward compatibility. */
  cwd?: string;
  providerPolicy?: ProviderPolicy;
  deepseekPromptPrefix?: string;
  allowDeepSeekAdvisoryFileNodes?: boolean;
  /** Runtime fallback chain. Defaults to dynamically derived from available runtimes. */
  fallbackChain?: string[];
  /** Directory to write telemetry events (e.g. runDir for events.jsonl). */
  eventRunDir?: string;
}

export { RuntimeRegistryOptions as ProviderBackedTaskRunnerOptions };

async function discoverKimiRuntime(
  options: RuntimeRegistryOptions
): Promise<{ runner?: TaskRunner; provider?: AgentProvider; runtimes: AgentRuntime[] }> {
  const kimiEnabled = process.env.OMK_KIMI_ENABLED !== "0";
  if (!kimiEnabled || !options.kimi) return { runtimes: [] };

  // kimi-api uses direct Moonshot HTTP API — no binary needed
  const apiRuntime = createKimiApiRuntime({
    cwd: options.kimi.cwd,
    env: options.kimi.env as NodeJS.ProcessEnv | undefined,
  });

  // kimi-print and kimi runner require the kimi CLI binary
  const kimiBin = resolveKimiBin({ ...process.env, ...(options.kimi.env ?? {}) });
  const kimiBinAvailable = await checkCommand(kimiBin).catch(() => false);
  if (!kimiBinAvailable) {
    // kimi-api works standalone without kimi binary
    return { runtimes: [apiRuntime] };
  }

  const runner = createKimiTaskRunner(options.kimi);
  const provider = createKimiProvider({ runner });
  const printRuntime = createKimiPrintRuntime(options.kimi);
  return { runner, provider, runtimes: [apiRuntime, printRuntime] };
}

export async function createProviderBackedTaskRunner(
  options: RuntimeRegistryOptions
): Promise<TaskRunner> {
  const providerPolicy = options.providerPolicy ?? "auto";
  const providerHealth = new ProviderHealthRegistry();
  const projectRoot = options.cwd ?? options.kimi?.cwd ?? getProjectRoot();

  let kimiRunner: TaskRunner | undefined;
  let deepseekRunnerRef: TaskRunner | undefined;
  const providerRunners: Partial<Record<ProviderId, TaskRunner>> = {};
  const providerModels: Partial<Record<ProviderId, ProviderModelDefault>> = {};
  const providers: AgentProvider[] = [];
  const runtimes: AgentRuntime[] = [];

  // Collect explicitly injected provider IDs to skip auto-discovery
  const explicitProviderIds = new Set(options.providers?.map((p) => p.id) ?? []);
  if (options.providers) {
    providers.push(...options.providers);
    for (const provider of options.providers) {
      const runner = taskRunnerFromAgentProvider(provider);
      if (provider.id === "kimi") {
        kimiRunner = runner;
        providerHealth.setAvailable("kimi");
      } else if (provider.id === "deepseek") {
        deepseekRunnerRef = runner;
        providerHealth.setAvailable("deepseek");
      } else {
        providerRunners[provider.id as ProviderId] = runner;
        providerHealth.setAvailable(provider.id as ProviderId);
      }
    }
  }

  if (options.runtimes) {
    // Explicit runtimes injected — skip runtime auto-discovery entirely
    runtimes.push(...options.runtimes);
  } else {
    // Auto-discovery: Kimi
    const kimiDiscovery = await discoverKimiRuntime(options);
    if (kimiDiscovery.runner) kimiRunner = kimiDiscovery.runner;
    if (kimiDiscovery.provider && !explicitProviderIds.has("kimi")) {
      providers.push(kimiDiscovery.provider);
      providerHealth.setAvailable("kimi");
    } else if (!kimiDiscovery.provider) {
      providerHealth.setUnavailable("kimi", "Kimi not discovered");
    }
    runtimes.push(...kimiDiscovery.runtimes);
  }

  // Auto-discovery: MiMo (Xiaomi MiMo API — OpenAI-compatible)
  if (!explicitProviderIds.has("mimo")) {
    providerHealth.register("mimo");
    const mimoEnabled = process.env.OMK_MIMO_ENABLED !== "0";
    if (mimoEnabled) {
      // Read API key from env or config.toml
      let mimoApiKey = process.env.MIMO_API_KEY;
      if (!mimoApiKey) {
        try {
          const { readFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          const { getUserHome } = await import("../util/fs.js");
          const configPath = join(getUserHome(), ".kimi", "config.toml");
          const configContent = readFileSync(configPath, "utf-8");
          const mimoMatch = configContent.match(/\[providers\.mimo\][\s\S]*?api_key\s*=\s*"([^"]+)"/);
          if (mimoMatch) mimoApiKey = mimoMatch[1];
        } catch { /* config not found */ }
      }
      if (mimoApiKey) {
        const mimoRuntime = createMimoApiRuntime({ apiKey: mimoApiKey });
        runtimes.push(mimoRuntime);
        providerHealth.setAvailable("mimo");
      } else {
        providerHealth.setUnavailable("mimo", "MIMO_API_KEY not set");
      }
    }
  }

  // DeepSeek discovery (skip if explicitly injected)
  if (!explicitProviderIds.has("deepseek")) {
    providerHealth.register("deepseek");
    const allowDeepSeek = providerPolicy === "auto" || providerPolicy === "deepseek";
    const deepseekStatus = allowDeepSeek ? await getDeepSeekProviderStatus() : undefined;
    const deepseekKey =
      allowDeepSeek && deepseekStatus?.enabled ? await resolveDeepSeekApiKey() : undefined;
    const deepseekCheck =
      allowDeepSeek && deepseekStatus?.enabled && deepseekKey?.apiKey
        ? await checkDeepSeekBalance({ apiKey: deepseekKey.apiKey })
        : undefined;

    if (deepseekCheck?.available) {
      const deepseekRunner = createDeepSeekReadOnlyTaskRunner({
        apiKey: deepseekKey?.apiKey,
        allowAdvisoryFileNodes: options.allowDeepSeekAdvisoryFileNodes ?? true,
        promptPrefix: options.deepseekPromptPrefix,
      });
      deepseekRunnerRef = deepseekRunner;
      const deepseekProvider = createDeepSeekProvider({ runner: deepseekRunner });
      providers.push(deepseekProvider);
      providerHealth.setAvailable("deepseek");
    } else if (deepseekCheck) {
      providerHealth.setUnavailable("deepseek", deepseekCheck.reason ?? "DeepSeek unavailable");
      if (deepseekCheck.reason?.includes("402")) {
        await forceDisableDeepSeek(deepseekCheck.reason, { disabledBy: "provider-402" });
        console.error(status.warn(`DeepSeek forced disabled: ${deepseekCheck.reason}`));
        console.error(style.gray("Primary fallback is active. Run /deepseek-enable after topping up."));
      }
    } else if (allowDeepSeek && deepseekStatus?.enabled === false) {
      providerHealth.setUnavailable("deepseek", deepseekStatus.disabledReason ?? "DeepSeek disabled");
      console.error(
        status.warn(`DeepSeek disabled: ${deepseekStatus.disabledReason ?? "disabled by user"}`)
      );
      console.error(style.gray("Primary fallback is active. Run /deepseek-enable to re-enable."));
    }
  }

  // Registry discovery (skip if provider ID explicitly injected)
  const registry = await readProviderRegistry();
  for (const entry of registry) {
    if (explicitProviderIds.has(entry.id)) continue;
    if (!shouldUseOpenAICompatibleProvider(entry, providerPolicy)) continue;
    providerHealth.register(entry.id);
    const apiKey = entry.apiKeyEnv ? process.env[entry.apiKeyEnv] : undefined;
    if (apiKey && entry.baseUrl) {
      providerRunners[entry.id] = createOpenAICompatibleReadOnlyTaskRunner({
        provider: entry.id,
        baseUrl: entry.baseUrl,
        apiKey,
        apiKeyEnv: entry.apiKeyEnv,
        model: entry.defaultModel,
        promptPrefix: options.deepseekPromptPrefix,
        headers: openAICompatibleHeaders(entry, process.env),
      });
      providerModels[entry.id] = providerModelDefault(entry);
      providerHealth.setAvailable(entry.id);
    } else {
      providerHealth.setUnavailable(entry.id, `missing ${entry.apiKeyEnv ?? "API key env"} or base URL`);
      if (providerPolicy === entry.id) {
        console.error(
          status.warn(
            `${providerDisplayName(entry.id)} unavailable: missing ${entry.apiKeyEnv ?? "API key env"} or base URL. Primary fallback is active.`
          )
        );
      }
    }
  }

  // Codex discovery (skip if explicitly injected)
  if (!explicitProviderIds.has("codex")) {
    const codex = registry.find((entry) => entry.id === "codex");
    if (codex && codex.enabled && (providerPolicy === "auto" || providerPolicy === "codex")) {
      providerHealth.register("codex");
      const codexStatus = await providerDoctorStatus("codex");
      if (codexStatus.available) {
        providerRunners.codex = createCodexCliAdvisoryTaskRunner({
          cwd: projectRoot,
          model: codex.defaultModel,
        });
        providerModels.codex = providerModelDefault(codex);
        providerHealth.setAvailable("codex");
      } else {
        providerHealth.setUnavailable("codex", "Codex unavailable or unauthenticated");
        if (providerPolicy === "codex") {
          console.error(status.warn("Codex unavailable or unauthenticated; Primary fallback is active."));
        }
      }
    }
  }

  const router = createProviderRouter({
    providers,
    defaultStrategy: providerPolicy === "kimi" ? "priority-first" : "cost-aware",
  });

  // Build fallback chain dynamically from available runtimes
  const fallbackChain = options.fallbackChain ?? runtimes.map((r) => r.id);

  const runtimeRouter = createRuntimeRouter({
    runtimes,
    fallbackChain,
  });

  const providerModelStats = loadProviderModelStats();

  // Determine authority provider from available providers. OMK policy/env owns authority;
  // Kimi remains a compatibility provider only when explicitly selected or discovered.
  const authorityPreference = resolveAuthorityPreference(providerPolicy, process.env);
  const availableProviderIds = uniqueProviderIds([
    ...providers.map((p) => p.id),
    ...Object.keys(providerRunners) as ProviderId[],
    ...(kimiRunner ? ["kimi" as ProviderId] : []),
  ]);
  const authorityProvider = resolveAuthorityProvider(availableProviderIds, authorityPreference);
  const authorityRunner = authorityProvider === "kimi"
    ? kimiRunner
    : providerRunners[authorityProvider];

  // Create the base task runner (provider routing with a configurable OMK authority lane)
  const baseRunner = createProviderTaskRunner({
    authorityRunner,
    kimiRunner,
    deepseekRunner: deepseekRunnerRef,
    providerRunners,
    providerModels,
    providerPolicy,
    providerHealth,
    eventRunDir: options.eventRunDir,
    providerModelStats,
    authorityProvider,
    onDeepSeekDisabled: async (event) => {
      await forceDisableDeepSeek(event.reason, {
        disabledBy: event.reason.includes("402") ? "provider-402" : "provider-availability",
      });
      console.error(status.warn(`DeepSeek forced disabled: ${event.reason}`));
      console.error(
        style.gray(
          `Node ${event.nodeId} fell back to primary runtime. Run /deepseek-enable after fixing balance/auth.`
        )
      );
    },
  });

  // Wrap provider routing with ContextBroker budget metadata. Provider routing
  // remains authoritative: RuntimeRouter failures are result values, not always
  // thrown exceptions, so running it first can bypass provider fallback metadata.
  const contextBroker = createContextBroker({ projectRoot });

  const wrappedRunner: TaskRunner = {
    onThinking: baseRunner.onThinking,
    fork: baseRunner.fork,
    async run(node, env, signal, context) {
      let budgetReport: unknown;
      try {
        budgetReport = (await contextBroker.buildCapsule(node)).report;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[omk] ContextBroker failed for node ${node.id}: ${errorMsg}\n`);
      }
      const taskResult = await baseRunner.run(node, env, signal, context);
      taskResult.metadata = {
        ...(taskResult.metadata ?? {}),
        ...(budgetReport ? { _budgetReport: budgetReport } : {}),
      };
      return taskResult;
    },
  };

  // Attach metadata for executor introspection
  (wrappedRunner as unknown as Record<string, unknown>)._runtimeRouter = runtimeRouter;
  (wrappedRunner as unknown as Record<string, unknown>)._providers = providers;
  (wrappedRunner as unknown as Record<string, unknown>)._router = router;
  (wrappedRunner as unknown as Record<string, unknown>)._contextBroker = contextBroker;

  return wrappedRunner;
}

function shouldUseOpenAICompatibleProvider(
  entry: ProviderRegistryEntry,
  providerPolicy: ProviderPolicy
): boolean {
  if (entry.id === "deepseek") return false;
  if (entry.kind !== "openai-compatible") return false;
  if (!entry.enabled) return false;
  return providerPolicy === "auto" || providerPolicy === entry.id;
}

function providerModelDefault(entry: ProviderRegistryEntry): ProviderModelDefault {
  return {
    model: entry.defaultModel,
    capabilities: entry.capabilities,
  };
}

function openAICompatibleHeaders(
  entry: ProviderRegistryEntry,
  env: NodeJS.ProcessEnv
): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...(entry.headers ?? {}) };
  if (entry.id === "openrouter") {
    setHeaderFromEnv(headers, "HTTP-Referer", env.OPENROUTER_HTTP_REFERER ?? env.OPENROUTER_REFERER);
    setHeaderFromEnv(
      headers,
      "X-OpenRouter-Title",
      env.OPENROUTER_X_TITLE ?? env.OPENROUTER_APP_TITLE
    );
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function setHeaderFromEnv(
  headers: Record<string, string>,
  name: string,
  value: string | undefined
): void {
  const trimmed = value?.trim();
  if (trimmed) headers[name] = trimmed;
}

function providerDisplayName(provider: ProviderId): string {
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "qwen") return "Qwen";
  if (provider === "codex") return "Codex";
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "kimi") return "Kimi";
  return provider;
}

function resolveAuthorityPreference(
  providerPolicy: ProviderPolicy,
  env: NodeJS.ProcessEnv
): ProviderId | undefined {
  const envAuthority = normalizeProviderId(env.OMK_AUTHORITY_PROVIDER);
  if (envAuthority !== "auto") return envAuthority;
  if (providerPolicy === "codex" || providerPolicy === "kimi") {
    return providerPolicy;
  }
  return undefined;
}

function uniqueProviderIds(providers: ProviderId[]): ProviderId[] {
  const seen = new Set<ProviderId>();
  const out: ProviderId[] = [];
  for (const provider of providers) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    out.push(provider);
  }
  return out;
}

function taskRunnerFromAgentProvider(provider: AgentProvider): TaskRunner {
  return {
    async run(node, env, signal, context?: TaskRunContext) {
      const fallbackSignal = new AbortController().signal;
      const attempt = Number(env.OMK_PROVIDER_ATTEMPT ?? "1");
      const result = await provider.run({
        node,
        env,
        signal: signal ?? fallbackSignal,
        attempt: Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1,
        ...(context ? { runContext: context } : {}),
      });
      return toTaskResult(result);
    },
  };
}

export { createRuntimeBackedTaskRunner } from "../runtime/runtime-backed-task-runner.js";

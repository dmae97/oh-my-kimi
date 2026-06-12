import { providerDisplayName, isExternalProvider, genericAdvisoryProviderForDecision, requestedProviderForAuthorityDecision } from "./runner/helpers.js";
import { runGenericProviderAdvisory } from "./runner/execution.js";
import { providerTraceEnv, buildProviderInvocationKey, deepseekRouteEnv, deepseekMetadata, providerModelEnv, providerModelMetadata } from "./runner/env.js";
import { providerLaneSkipResult, providerExceptionResult, summarizeFailures, authorityUnavailableResult } from "./runner/results.js";
import { sleepWithAbort, runDeepSeekAdvisory, deepseekPlanFromNode } from "./runner/deepseek-helpers.js";
import type { TaskResult, TaskRunner } from "../contracts/orchestration.js";
import type { TaskRunContext } from "../contracts/worker-context.js";
import type { DagNode } from "../orchestration/dag.js";
import { ProviderHealthRegistry } from "./health.js";
import {
  DEEPSEEK_V4_FLASH_MODEL,
  DEEPSEEK_V4_PRO_MODEL,
  inferNodeRisk,
  normalizeProviderComplexity,
  routeProvider,
  selectDeepSeekModelTier,
  recordModelOutcome,
} from "./router.js";
import type {
  DeepSeekRoutePlan,
  ProviderId,
  ProviderModelDefault,
  ProviderModelRef,
  ProviderPolicy,
  ProviderRouteDecision,
  ProviderRouteInput,
  ProviderTaskMetadata,
} from "./types.js";
import { DEFAULT_AUTHORITY_PROVIDER, withProviderMetadata } from "./types.js";
import {
  classifyDeepSeekFailure,
  isDeepSeekPaymentOrAvailabilityFailure,
  isDeepSeekTransientFailure,
} from "./deepseek/deepseek-errors.js";
import { createDecisionTraceStore } from "../evidence/decision-trace.js";
import {
  classifyKimiProviderFailure,
  formatKimiProviderFailureHint,
  type KimiProviderFailureDiagnosis,
} from "../kimi/runner.js";
import { appendEvent } from "../util/events-logger.js";
import {
  buildProviderStatsKey,
  updateProviderModelStats,
  saveProviderModelStats,
  type ProviderModelStats,
} from "./provider-stats.js";

export interface ProviderTaskRunnerOptions {
  /** Provider-neutral authority runner for write/shell/merge lanes. */
  authorityRunner?: TaskRunner;
  /** Kimi runner. Backward-compatible alias for authorityRunner when authorityProvider is "kimi". */
  kimiRunner?: TaskRunner;
  deepseekRunner?: TaskRunner;
  providerRunners?: Partial<Record<ProviderId, TaskRunner>>;
  providerModels?: Partial<Record<ProviderId, ProviderModelDefault>>;
  providerHealth?: ProviderHealthRegistry;
  providerPolicy?: ProviderPolicy;
  deepseekMaxRetries?: number;
  onDeepSeekDisabled?: (event: DeepSeekDisableEvent) => void | Promise<void>;
  /** Directory to write telemetry events (e.g. runDir for events.jsonl). */
  eventRunDir?: string;
  /** In-memory provider model stats for outcome recording. */
  providerModelStats?: ProviderModelStats;
  /** Configurable authority provider. Defaults to OMK's provider-neutral authority. */
  authorityProvider?: ProviderId;
}

export interface DeepSeekDisableEvent {
  nodeId: string;
  nodeRole: string;
  reason: string;
  failureKind: "availability";
  forced: true;
}

export function createProviderTaskRunner(options: ProviderTaskRunnerOptions): TaskRunner {
  const providerHealth = options.providerHealth ?? new ProviderHealthRegistry();
  const authorityProvider = options.authorityProvider ?? DEFAULT_AUTHORITY_PROVIDER;
  const authorityRunner = options.authorityRunner ?? (authorityProvider === "kimi" ? options.kimiRunner : undefined);
  let deepSeekDisabledCalled = false;

  const runWith = async (
    provider: ProviderId,
    runner: TaskRunner,
    node: DagNode,
    env: Record<string, string>,
    routeReason: string,
    requestedProvider: ProviderId = provider,
    metadata: Partial<ProviderTaskMetadata> = {},
    signal?: AbortSignal,
    context?: TaskRunContext
  ): Promise<TaskResult> => {
    const startTime = Date.now();
    if (options.eventRunDir) {
      appendEvent(options.eventRunDir, {
        type: "provider.request.started",
        runId: env.OMK_RUN_ID ?? "",
        nodeId: node.id,
        seq: 0,
        provider,
        data: { role: node.role },
      }).catch(() => {});
    }
    const providerAuthority = provider === authorityProvider
      ? authorityProvider
      : String(metadata.providerAuthority ?? env.OMK_PROVIDER_AUTHORITY ?? authorityProvider);
    const result = await runner.run(node, {
      ...env,
      OMK_PROVIDER: provider,
      OMK_PROVIDER_REQUESTED: requestedProvider,
      OMK_PROVIDER_FALLBACK: authorityProvider,
      OMK_PROVIDER_AUTHORITY: providerAuthority,
      OMK_PROVIDER_ROUTE_REASON: routeReason,
    }, signal, context);
    const durationMs = Date.now() - startTime;
    if (options.eventRunDir) {
      appendEvent(options.eventRunDir, {
        type: result.success ? "provider.request.completed" : "provider.request.failed",
        runId: env.OMK_RUN_ID ?? "",
        nodeId: node.id,
        seq: 0,
        provider,
        data: { role: node.role, durationMs },
      }).catch(() => {});
    }
    const tier = metadata.providerModelTier ?? provider;
    const role = node.role ?? "unknown";
    const taskType = env.OMK_TASK_TYPE ?? "unknown";
    const complexity = normalizeProviderComplexity(env.OMK_COMPLEXITY) ?? "moderate";
    const statsKey = buildProviderStatsKey(String(tier), role, taskType, complexity);
    const stats = options.providerModelStats ?? { version: 2, entries: {}, updatedAt: Date.now() };
    const existing = stats.entries[statsKey];
    const updatedStats = updateProviderModelStats(
      stats,
      statsKey,
      {
        attempts: (existing?.attempts ?? 0) + 1,
        passes: (existing?.passes ?? 0) + (result.success ? 1 : 0),
        failures: (existing?.failures ?? 0) + (result.success ? 0 : 1),
        meanLatencyMs:
          existing && existing.attempts > 0
            ? Math.round((existing.meanLatencyMs * existing.attempts + durationMs) / (existing.attempts + 1))
            : durationMs,
        lastAttemptAt: Date.now(),
      }
    );
    saveProviderModelStats(updatedStats);
    recordModelOutcome(provider, String(tier), role, taskType, complexity, { success: result.success, latencyMs: durationMs });
    return withProviderMetadata(result, {
      provider,
      requestedProvider,
      providerRouteReason: routeReason,
      ...metadata,
    });
  };

  const recoverFromKimiProviderFailure = async (
    kimiResult: TaskResult,
    node: DagNode,
    env: Record<string, string>,
    decision: ProviderRouteDecision,
    traceEnv: Record<string, string>,
    traceMetadata: Partial<ProviderTaskMetadata>,
    signal?: AbortSignal,
    context?: TaskRunContext
  ): Promise<TaskResult> => {
    const diagnosis = diagnoseKimiProviderFailure(kimiResult);
    if (!diagnosis) return kimiResult;

    const annotatedKimiResult = withKimiProviderFailure(kimiResult, diagnosis);
    if (diagnosis.kind !== "monthly-quota") return annotatedKimiResult;

    providerHealth.markKimiUnavailable(diagnosis.title);
    if (!canFallbackKimiQuotaToDeepSeek(node, options.providerPolicy, options.deepseekRunner, providerHealth, authorityProvider)) {
      return annotatedKimiResult;
    }

    const fallbackPlan = buildKimiQuotaDeepSeekFallbackPlan(node, env);
    const fallbackReason = `${diagnosis.title}; using read-only DeepSeek fallback`;
    const fallback = await runWith(
      "deepseek",
      options.deepseekRunner!,
      node,
      {
        ...env,
        ...traceEnv,
        ...deepseekRouteEnv(fallbackPlan),
        OMK_PROVIDER_FALLBACK_FROM: authorityProvider,
        OMK_PROVIDER_FALLBACK_REASON: fallbackReason,
        OMK_KIMI_FAILURE_KIND: diagnosis.kind,
      },
      fallbackReason,
      authorityProvider,
      {
        ...traceMetadata,
        ...deepseekMetadata(fallbackPlan),
      },
      signal,
      context
    );

    return withProviderMetadata(fallback, {
      provider: "deepseek",
      requestedProvider: authorityProvider,
      providerRouteReason: decision.reason,
      ...traceMetadata,
      providerAttemptCount: 1,
      ...deepseekMetadata(fallbackPlan),
      providerFallback: {
        from: authorityProvider,
        to: "deepseek",
        reason: fallbackReason,
        attempts: 1,
        failureKind: "quota",
      },
    });
  };

  const providerRunner: TaskRunner = {
    get onThinking() {
      return authorityRunner?.onThinking;
    },
    set onThinking(fn) {
      if (authorityRunner) authorityRunner.onThinking = fn;
      if (options.kimiRunner) options.kimiRunner.onThinking = fn;
      if (options.deepseekRunner) options.deepseekRunner.onThinking = fn;
      for (const runner of Object.values(options.providerRunners ?? {})) {
        if (runner) runner.onThinking = fn;
      }
    },

    fork(onThinking) {
      const providerRunners = Object.fromEntries(
        Object.entries(options.providerRunners ?? {}).map(([provider, runner]) => [
          provider,
          runner?.fork?.(onThinking) ?? runner,
        ])
      ) as Partial<Record<ProviderId, TaskRunner>>;
      return createProviderTaskRunner({
        ...options,
        authorityRunner: authorityRunner?.fork?.(onThinking) ?? authorityRunner,
        kimiRunner: options.kimiRunner?.fork?.(onThinking) ?? options.kimiRunner,
        deepseekRunner: options.deepseekRunner?.fork?.(onThinking) ?? options.deepseekRunner,
        providerRunners,
        providerHealth,
      });
    },

    async run(node: DagNode, env: Record<string, string>, signal?: AbortSignal, context?: TaskRunContext): Promise<TaskResult> {
      const runId = env.OMK_RUN_ID;
      const attemptNumber = (node.attempts?.length ?? 0) + 1;
      const attemptId = `${node.id}__${attemptNumber}`;
      const traceStore = runId ? createDecisionTraceStore() : undefined;

      const deepseekAvailable =
        Boolean(options.deepseekRunner) &&
        providerHealth.isDeepSeekAvailable();
      const requiresToolCalling = node.routing?.requiresToolCalling === true;
      const requiresMcp = node.routing?.requiresMcp === true;
      const providerAvailability = providerAvailabilityForNode(
        node,
        options.providerPolicy ?? "auto",
        deepseekAvailable,
        options.providerRunners,
        authorityProvider,
        Boolean(authorityRunner)
      );
      const routeInput: ProviderRouteInput = {
        role: node.role,
        taskType: env.OMK_TASK_TYPE ?? "general",
        risk: inferNodeRisk(node),
        complexity: normalizeProviderComplexity(env.OMK_COMPLEXITY),
        needsToolCalling: requiresToolCalling,
        needsMcp: requiresMcp,
        readOnly: node.routing?.readOnly,
        estimatedTokens: Number(env.OMK_ESTIMATED_TOKENS ?? 0),
        deepseekAvailable,
        providerAvailability,
        providerModels: options.providerModels,
        nodeId: node.id,
        providerHint: node.routing?.provider,
        providerPolicy: options.providerPolicy ?? "auto",
        preferredModel: node.routing?.providerModel ?? env.OMK_PROVIDER_MODEL ?? node.routing?.assignedModel,
        preferredDeepSeekTier: node.routing?.providerModelTier,
        providerModelStats: options.providerModelStats?.entries,
        authorityProvider,
      };
      const decision = routeProvider(routeInput);

      // Record provider-router decision trace
      if (traceStore && runId) {
        traceStore.record(runId, {
          component: "provider-router",
          inputSummary: `node=${node.id} role=${node.role} risk=${inferNodeRisk(node)} complexity=${normalizeProviderComplexity(env.OMK_COMPLEXITY)} deepseekAvailable=${deepseekAvailable}`,
          outputDecision: `provider=${decision.provider} confidence=${decision.confidence.toFixed(2)}`,
          reason: decision.reason,
          scores: {
            confidence: decision.confidence,
            quorum: decision.routeEnsemble.quorum,
            candidates: decision.routeEnsemble.candidates.length,
          },
          nodeId: node.id,
          attemptId,
        });
      }

      const invocationKey = buildProviderInvocationKey(node, decision);
      const traceEnv = providerTraceEnv(decision, invocationKey);
      const traceMetadata: Partial<ProviderTaskMetadata> = {
        providerRouteConfidence: decision.confidence,
        providerRouteEnsemble: decision.routeEnsemble,
        providerInvocationKey: invocationKey,
      };

      const unavailableProviderSkip = resolveUnavailableSkippableProviderLane({
        node,
        routeInput,
        decision,
        providerPolicy: options.providerPolicy ?? "auto",
        providerAvailability,
        authorityProvider,
      });
      if (unavailableProviderSkip) {
        return providerLaneSkipResult({
          node,
          provider: unavailableProviderSkip.provider,
          requestedProvider: unavailableProviderSkip.provider,
          decision,
          reason: unavailableProviderSkip.reason,
          failureKind: "availability",
          attempts: 0,
          traceMetadata,
          providerModel: unavailableProviderSkip.providerModel ?? decision.providerModel,
          deepseekPlan: unavailableProviderSkip.deepseekPlan ?? decision.deepseek,
          baseResult: {
            success: false,
            exitCode: 1,
            stdout: "",
            stderr: unavailableProviderSkip.reason,
          },
        });
      }

      if (decision.provider === "deepseek" && options.deepseekRunner) {
        const rawMaxRetries = Number(options.deepseekMaxRetries ?? 1);
        const shouldSkipDeepSeekFallback = shouldSkipProviderFallback(node, "deepseek", authorityProvider);
        const maxRetries = shouldSkipDeepSeekFallback ? 0 : Math.max(0, Math.floor(Number.isFinite(rawMaxRetries) ? rawMaxRetries : 1));
        const failures: TaskResult[] = [];
        let result: TaskResult | undefined;

        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          try {
            result = await runWith(
              "deepseek",
              options.deepseekRunner,
              node,
              {
                ...env,
                OMK_PROVIDER_ATTEMPT: String(attempt + 1),
                OMK_PROVIDER_MAX_RETRIES: String(maxRetries),
                ...traceEnv,
                ...deepseekRouteEnv(decision.deepseek),
              },
              decision.reason,
              "deepseek",
              {
                ...traceMetadata,
                ...deepseekMetadata(decision.deepseek),
              },
              signal,
              context
            );
          } catch (error: unknown) {
            if (!shouldSkipDeepSeekFallback) throw error;
            result = providerExceptionResult(error);
          }

          if (result.success) {
            return withProviderMetadata(result, {
              provider: "deepseek",
              requestedProvider: "deepseek",
              providerRouteReason: decision.reason,
              ...traceMetadata,
              providerAttemptCount: attempt + 1,
              ...deepseekMetadata(decision.deepseek),
            });
          }

          failures.push(result);
          if (signal?.aborted) break;
          if (!isDeepSeekTransientFailure(result)) break;

          // Abort-aware sleep with exponential backoff and full jitter
          if (attempt < maxRetries) {
            const baseMs = Math.min(1000 * Math.pow(2, attempt), 30000);
            const jitterMs = baseMs * Math.random();
            const delayMs = baseMs + jitterMs;
            await sleepWithAbort(delayMs, signal);
          }
          if (!isDeepSeekTransientFailure(result)) break;
        }

        const lastFailure = result ?? failures[failures.length - 1];
        const fallbackReason = summarizeFailures(failures);
        const failureKind = lastFailure ? classifyDeepSeekFailure(lastFailure) : "unknown";
        if (lastFailure && isDeepSeekPaymentOrAvailabilityFailure(lastFailure)) {
          providerHealth.markDeepSeekUnavailable(fallbackReason || "DeepSeek provider availability failure");
          if (!deepSeekDisabledCalled) {
            deepSeekDisabledCalled = true;
            await options.onDeepSeekDisabled?.({
              nodeId: node.id,
              nodeRole: node.role,
              reason: fallbackReason || "DeepSeek provider availability failure",
              failureKind: "availability",
              forced: true,
            });
          }
        } else if (lastFailure && isDeepSeekTransientFailure(lastFailure)) {
          providerHealth.markDeepSeekUnavailable(fallbackReason || "DeepSeek transient provider failure");
        }

        if (lastFailure && shouldSkipDeepSeekFallback) {
          return providerLaneSkipResult({
            node,
            provider: "deepseek",
            requestedProvider: "deepseek",
            decision,
            reason: fallbackReason || `${providerDisplayName("deepseek")} provider failed`,
            failureKind,
            attempts: failures.length,
            traceMetadata,
            deepseekPlan: decision.deepseek,
            baseResult: lastFailure,
          });
        }

        if (!authorityRunner) {
          return withProviderMetadata(lastFailure ?? providerExceptionResult(new Error("DeepSeek failed and primary fallback unavailable")), {
            provider: "deepseek",
            requestedProvider: "deepseek",
            providerRouteReason: decision.reason,
            ...traceMetadata,
            providerAttemptCount: failures.length,
            ...deepseekMetadata(decision.deepseek),
            providerSkip: {
              provider: "deepseek",
              reason: `${fallbackReason || "DeepSeek failed"}; primary fallback unavailable`,
              skippable: true,
              attempts: failures.length,
              failureKind,
            },
          });
        }
        const fallback = await runWith(
          authorityProvider,
          authorityRunner,
          node,
          {
            ...env,
            ...traceEnv,
            OMK_PROVIDER_FALLBACK_FROM: "deepseek",
            OMK_PROVIDER_FALLBACK_REASON: fallbackReason,
          },
          `Fallback from DeepSeek: ${fallbackReason || "unknown failure"}`,
          "deepseek",
          traceMetadata,
          signal,
          context
        );

        const annotatedFallback = authorityProvider === "kimi" ? withKimiProviderFailureIfNeeded(fallback, providerHealth) : fallback;
        return withProviderMetadata(annotatedFallback, {
          provider: authorityProvider,
          requestedProvider: "deepseek",
          providerRouteReason: decision.reason,
          ...traceMetadata,
          providerAttemptCount: failures.length,
          ...deepseekMetadata(decision.deepseek),
          providerFallback: {
            from: "deepseek",
            to: authorityProvider,
            reason: fallbackReason,
            attempts: failures.length,
            failureKind,
          },
        });
      }

      if (isExternalProvider(decision.provider, authorityProvider)) {
        const externalRunner = options.providerRunners?.[decision.provider];
        if (externalRunner) {
          let result: TaskResult;
          try {
            result = await runWith(
              decision.provider,
              externalRunner,
              node,
              { ...env, ...traceEnv, ...providerModelEnv(decision.providerModel) },
              decision.reason,
              decision.provider,
              { ...traceMetadata, ...providerModelMetadata(decision.providerModel) },
              signal,
              context
            );
          } catch (error: unknown) {
            if (!shouldSkipProviderFallback(node, decision.provider, authorityProvider)) throw error;
            result = providerExceptionResult(error);
          }
          if (result.success) {
            return withProviderMetadata(result, {
              provider: decision.provider,
              requestedProvider: decision.provider,
              providerRouteReason: decision.reason,
              ...traceMetadata,
              ...providerModelMetadata(decision.providerModel),
              providerAttemptCount: 1,
            });
          }

          const fallbackReason = summarizeFailures([result]) || `${decision.provider} provider failed`;
          if (shouldSkipProviderFallback(node, decision.provider, authorityProvider)) {
            return providerLaneSkipResult({
              node,
              provider: decision.provider,
              requestedProvider: decision.provider,
              decision,
              reason: fallbackReason,
              failureKind: "availability",
              attempts: 1,
              traceMetadata,
              providerModel: decision.providerModel,
              baseResult: result,
            });
          }

          if (!authorityRunner) {
            return providerLaneSkipResult({
              node,
              provider: decision.provider,
              requestedProvider: decision.provider,
              decision,
              reason: `${fallbackReason}; primary fallback unavailable`,
              failureKind: "availability",
              attempts: 1,
              traceMetadata,
              providerModel: decision.providerModel,
              baseResult: result,
            });
          }
          const fallback = await runWith(
            authorityProvider,
            authorityRunner,
            node,
            {
              ...env,
              ...traceEnv,
              OMK_PROVIDER_FALLBACK_FROM: decision.provider,
              OMK_PROVIDER_FALLBACK_REASON: fallbackReason,
            },
            `Fallback from ${decision.provider}: ${fallbackReason}`,
            decision.provider,
            traceMetadata,
            signal,
            context
          );
          return withProviderMetadata(fallback, {
            provider: authorityProvider,
            requestedProvider: decision.provider,
            providerRouteReason: decision.reason,
            ...traceMetadata,
            ...providerModelMetadata(decision.providerModel),
            providerAttemptCount: 1,
            providerFallback: {
              from: decision.provider,
              to: authorityProvider,
              reason: fallbackReason,
              attempts: 1,
              failureKind: "availability",
            },
          });
        }
      }

      if (decision.deepseek?.participation === "advisory" && options.deepseekRunner) {
        const advisory = await runDeepSeekAdvisory({
          node,
          env,
          runner: options.deepseekRunner,
          routeReason: decision.reason,
          plan: decision.deepseek,
          invocationKey,
          traceEnv,
          signal,
          context,
        });

        if (!advisory.success && isDeepSeekPaymentOrAvailabilityFailure(advisory.result)) {
          providerHealth.markDeepSeekUnavailable(advisory.failureReason || "DeepSeek provider availability failure");
          if (!deepSeekDisabledCalled) {
            deepSeekDisabledCalled = true;
            await options.onDeepSeekDisabled?.({
              nodeId: node.id,
              nodeRole: node.role,
              reason: advisory.failureReason || "DeepSeek provider availability failure",
              failureKind: "availability",
              forced: true,
            });
          }
        } else if (!advisory.success && isDeepSeekTransientFailure(advisory.result)) {
          providerHealth.markDeepSeekUnavailable(advisory.failureReason || "DeepSeek transient provider failure");
        }

        if (!advisory.success && shouldSkipProviderFallback(node, "deepseek", authorityProvider)) {
          return providerLaneSkipResult({
            node,
            provider: "deepseek",
            requestedProvider: "deepseek",
            decision,
            reason: advisory.failureReason || `${providerDisplayName("deepseek")} advisory failed`,
            failureKind: classifyDeepSeekFailure(advisory.result),
            attempts: 1,
            traceMetadata,
            deepseekPlan: decision.deepseek,
            providerAssist: advisory.metadata,
            baseResult: advisory.result,
          });
        }

        if (!authorityRunner) {
          return authorityUnavailableResult(node, decision, traceMetadata, `${authorityProvider} runner not configured; cannot apply DeepSeek advisory`, authorityProvider);
        }
        const authorityResult = await runWith(
          authorityProvider,
          authorityRunner,
          node,
          {
            ...env,
            ...traceEnv,
            OMK_DEEPSEEK_ADVISORY_STATUS: advisory.success ? "success" : "failed",
            OMK_DEEPSEEK_ADVISORY_MODEL: decision.deepseek.model,
            OMK_DEEPSEEK_ADVISORY: advisory.structured?.summary ?? advisory.summary,
            OMK_DEEPSEEK_ADVISORY_JSON: JSON.stringify(advisory.structured ?? { summary: advisory.summary, findings: [], risks: [], questionsForAuthorityProvider: [], confidence: 0 }),
            OMK_DEEPSEEK_ADVISORY_FINDINGS_COUNT: String(advisory.structured?.findings?.length ?? 0),
          },
          decision.reason,
          authorityProvider,
          {
            ...traceMetadata,
            providerAssist: advisory.metadata,
          },
          signal,
          context
        );
        const recoveredAuthorityResult = authorityProvider === "kimi"
          ? await recoverFromKimiProviderFailure(
              authorityResult,
              node,
              env,
              decision,
              traceEnv,
              traceMetadata,
              signal,
              context
            )
          : authorityResult;
        if (recoveredAuthorityResult.metadata?.provider === "deepseek") return recoveredAuthorityResult;

        return withProviderMetadata(recoveredAuthorityResult, {
          provider: authorityProvider,
          requestedProvider: authorityProvider,
          providerRouteReason: decision.reason,
          ...traceMetadata,
          providerAssist: advisory.metadata,
        });
      }

      const genericAdvisoryProvider = genericAdvisoryProviderForDecision(decision, authorityProvider);
      if (genericAdvisoryProvider) {
        const genericRunner = options.providerRunners?.[genericAdvisoryProvider];
        if (genericRunner) {
          const advisory = await runGenericProviderAdvisory({
            node,
            env,
            runner: genericRunner,
            routeReason: decision.reason,
            modelRef: decision.providerModel,
            invocationKey,
            traceEnv,
            signal,
            context,
            authorityProvider,
          });
          if (!advisory.success && shouldSkipProviderFallback(node, genericAdvisoryProvider, authorityProvider)) {
            return providerLaneSkipResult({
              node,
              provider: genericAdvisoryProvider,
              requestedProvider: genericAdvisoryProvider,
              decision,
              reason: advisory.failureReason || `${providerDisplayName(genericAdvisoryProvider)} advisory failed`,
              failureKind: "availability",
              attempts: 1,
              traceMetadata,
              providerModel: decision.providerModel,
              providerAssist: advisory.metadata,
              baseResult: advisory.result,
            });
          }
          if (!authorityRunner) {
            return authorityUnavailableResult(node, decision, traceMetadata, `${authorityProvider} runner not configured; cannot apply ${genericAdvisoryProvider} advisory`, authorityProvider);
          }
          const authorityResult = await runWith(
            authorityProvider,
            authorityRunner,
            node,
            {
              ...env,
              ...traceEnv,
              OMK_PROVIDER_ADVISORY_STATUS: advisory.success ? "success" : "failed",
              OMK_PROVIDER_ADVISORY_PROVIDER: genericAdvisoryProvider,
              OMK_PROVIDER_ADVISORY_MODEL: decision.providerModel?.model ?? "",
              OMK_PROVIDER_ADVISORY: advisory.summary,
            },
            decision.reason,
            authorityProvider,
            {
              ...traceMetadata,
              providerAssist: advisory.metadata,
              ...providerModelMetadata(decision.providerModel),
            },
            signal,
            context
          );
          return withProviderMetadata(authorityResult, {
            provider: authorityProvider,
            requestedProvider: authorityProvider,
            providerRouteReason: decision.reason,
            ...traceMetadata,
            providerAssist: advisory.metadata,
            ...providerModelMetadata(decision.providerModel),
          });
        }
      }

      if (!authorityRunner) {
        return authorityUnavailableResult(node, decision, traceMetadata, `${authorityProvider} runner not configured`, authorityProvider);
      }
      const authorityResult = await runWith(
        authorityProvider,
        authorityRunner,
        node,
        { ...env, ...traceEnv },
        decision.reason,
        requestedProviderForAuthorityDecision(decision, authorityProvider),
        {
          ...traceMetadata,
          ...providerModelMetadata(decision.providerModel),
        },
        signal,
        context
      );
      return authorityProvider === "kimi"
        ? recoverFromKimiProviderFailure(authorityResult, node, env, decision, traceEnv, traceMetadata, signal, context)
        : authorityResult;
    },
  };

  return providerRunner;
}

function diagnoseKimiProviderFailure(result: TaskResult): KimiProviderFailureDiagnosis | null {
  if (result.success) return null;
  return classifyKimiProviderFailure(`${result.stderr}\n${result.stdout}`);
}

function withKimiProviderFailureIfNeeded(
  result: TaskResult,
  providerHealth: ProviderHealthRegistry
): TaskResult {
  const diagnosis = diagnoseKimiProviderFailure(result);
  if (!diagnosis) return result;
  if (diagnosis.kind === "monthly-quota") {
    providerHealth.markKimiUnavailable(diagnosis.title);
  }
  return withKimiProviderFailure(result, diagnosis);
}

function withKimiProviderFailure(
  result: TaskResult,
  diagnosis: KimiProviderFailureDiagnosis
): TaskResult {
  const providerHint = formatKimiProviderFailureHint(`${result.stderr}\n${result.stdout}`);
  const stderr = providerHint && !result.stderr.includes(`[omk] ${diagnosis.title}.`)
    ? result.stderr
      ? `${result.stderr}\n${providerHint}`
      : providerHint
    : result.stderr;
  return {
    ...result,
    stderr,
    metadata: {
      ...(result.metadata ?? {}),
      providerFailure: {
        provider: "kimi",
        kind: diagnosis.kind,
        title: diagnosis.title,
      },
    },
  };
}

function canFallbackKimiQuotaToDeepSeek(
  node: DagNode,
  providerPolicy: ProviderPolicy | undefined,
  deepseekRunner: TaskRunner | undefined,
  providerHealth: ProviderHealthRegistry,
  authorityProvider: ProviderId
): boolean {
  if (!deepseekRunner || !providerHealth.isDeepSeekAvailable()) return false;
  if (providerPolicy === authorityProvider || node.routing?.provider === authorityProvider) return false;
  if (inferNodeRisk(node) !== "read") return false;
  if (node.routing?.readOnly !== true) return false;
  if (node.routing?.requiresMcp === true || node.routing?.requiresToolCalling === true) return false;
  return true;
}

function buildKimiQuotaDeepSeekFallbackPlan(
  node: DagNode,
  env: Record<string, string>
): DeepSeekRoutePlan {
  const selected = selectDeepSeekModelTier([
    "kimi-quota-fallback",
    env.OMK_RUN_ID ?? "",
    node.id,
    node.role,
    env.OMK_TASK_TYPE ?? "general",
  ].join(":"));
  return {
    provider: "deepseek",
    model: selected.tier === "flash" ? DEEPSEEK_V4_FLASH_MODEL : DEEPSEEK_V4_PRO_MODEL,
    tier: selected.tier,
    participation: "direct",
    reasoningEffort: "max",
    ratioBucket: selected.ratioBucket,
  };
}

function providerAvailabilityForNode(
  node: DagNode,
  providerPolicy: ProviderPolicy,
  deepseekAvailable: boolean,
  providerRunners: Partial<Record<ProviderId, TaskRunner>> | undefined,
  authorityProvider: ProviderId,
  authorityRunnerAvailable: boolean
): Partial<Record<ProviderId, boolean>> {
  const availability: Partial<Record<ProviderId, boolean>> = {
    ...Object.fromEntries(
      Object.keys(providerRunners ?? {}).map((provider) => [provider, true])
    ),
    deepseek: deepseekAvailable,
    [authorityProvider]: authorityRunnerAvailable,
  };
  for (const provider of [node.routing?.provider, providerPolicy]) {
    if (!provider || provider === "auto" || provider === "authority" || provider === authorityProvider) continue;
    if (availability[provider] !== undefined) continue;
    availability[provider] = provider === "deepseek" ? deepseekAvailable : Boolean(providerRunners?.[provider]);
  }
  return availability;
}

function resolveUnavailableSkippableProviderLane(options: {
  node: DagNode;
  routeInput: ProviderRouteInput;
  decision: ProviderRouteDecision;
  providerPolicy: ProviderPolicy;
  providerAvailability: Partial<Record<ProviderId, boolean>>;
  authorityProvider: ProviderId;
}): { provider: ProviderId; reason: string; providerModel?: ProviderModelRef; deepseekPlan?: DeepSeekRoutePlan } | undefined {
  const explicitProvider = requestedProviderFromNodeOrPolicy(options.node, options.providerPolicy, options.authorityProvider);
  if (
    explicitProvider &&
    shouldSkipProviderFallback(options.node, explicitProvider, options.authorityProvider) &&
    !isProviderAvailableForSkip(explicitProvider, options.providerAvailability)
  ) {
    return {
      provider: explicitProvider,
      reason: `${providerDisplayName(explicitProvider)} unavailable; optional provider lane is skippable`,
      providerModel: options.decision.providerModel,
      deepseekPlan: explicitProvider === "deepseek"
        ? options.decision.deepseek ?? deepseekPlanFromNode(options.node)
        : undefined,
    };
  }

  if (
    options.providerPolicy === "auto" &&
    !options.providerAvailability.deepseek &&
    shouldSkipProviderFallback(options.node, "deepseek", options.authorityProvider)
  ) {
    const optimisticDeepSeekDecision = routeProvider({
      ...options.routeInput,
      deepseekAvailable: true,
      providerAvailability: {
        ...(options.routeInput.providerAvailability ?? {}),
        deepseek: true,
      },
    });
    if (optimisticDeepSeekDecision.provider === "deepseek" || optimisticDeepSeekDecision.deepseek) {
      return {
        provider: "deepseek",
        reason: "DeepSeek unavailable; optional provider lane is skippable",
        providerModel: optimisticDeepSeekDecision.providerModel,
        deepseekPlan: optimisticDeepSeekDecision.deepseek,
      };
    }
  }

  return undefined;
}

function requestedProviderFromNodeOrPolicy(
  node: DagNode,
  providerPolicy: ProviderPolicy,
  authorityProvider: ProviderId
): ProviderId | undefined {
  const routingProvider = node.routing?.provider;
  if (routingProvider && routingProvider !== "auto" && routingProvider !== authorityProvider) return routingProvider;
  if (providerPolicy !== "auto" && providerPolicy !== "authority" && providerPolicy !== authorityProvider) return providerPolicy;
  return undefined;
}

function isProviderAvailableForSkip(
  provider: ProviderId,
  providerAvailability: Partial<Record<ProviderId, boolean>>
): boolean {
  if (provider === "deepseek") return providerAvailability.deepseek === true;
  const explicit = providerAvailability[provider];
  return explicit === undefined ? true : explicit;
}

function shouldSkipProviderFallback(node: DagNode, provider: ProviderId, authorityProvider: ProviderId): boolean {
  if (provider === authorityProvider) return false;
  if (provider === "deepseek" && isDeepSeekLaneNode(node)) return true;
  if (node.failurePolicy?.skipOnFailure === true) return true;
  if (hasOnlyOptionalOutputs(node)) return true;
  return false;
}

function isDeepSeekLaneNode(node: DagNode): boolean {
  return node.id.toLowerCase().startsWith("deepseek-") || node.routing?.provider === "deepseek";
}

function hasOnlyOptionalOutputs(node: DagNode): boolean {
  return Boolean(node.outputs?.length) && node.outputs!.every((output) => output.required === false);
}

import type { ChatLayout, ChatBrand, ChatUi } from "./utils.js";
import {
  appendRecentChatOutput,
  getActiveHookNames,
  getActiveSkillNames,
  isKimiPromptReadyLine,
  mergeTodos,
} from "./utils.js";
import { writeChatStartupFailureArtifact, printChatExitBanner } from "./startup.js";
import {
  queueChatStatePatch,
  updateChatHeartbeat as enqueueChatHeartbeat,
  updateChatActivity,
  finalizeChatState,
} from "../../util/chat-state.js";
import { parseSetTodoListFromOutput, readTodos, writeTodos, type TodoItem } from "../../util/todo-sync.js";
import { readSessionMeta, writeSessionMeta, createOmkSessionEnv } from "../../util/session.js";
import { runShell } from "../../util/shell.js";
import { injectKimiGlobals } from "../../util/fs.js";
import { runKimiInteractive } from "../../kimi/runner.js";
import { createRuntimeBackedTaskRunner } from "../../runtime/runtime-backed-task-runner.js";
import { resolveRuntimeBootstrap } from "../../runtime/runtime-bootstrap.js";
import { buildOmkToolPlaneManifest } from "../../runtime/tool-plane.js";
import { runNativeOmkRootLoop } from "./native-root-loop.js";
import { isCockpitChild } from "../../util/chat-cockpit.js";
import { style } from "../../util/theme.js";
import { normalizeReasoningChunk, extractThinkingSummary, appendReasoningFrames, resolveReasoningVisibility, resolveReasoningSummaryMode, type ReasoningFrame } from "../../util/reasoning-nlp.js";
import { PlainModernRenderer } from "../../cli/ui/plain-renderer.js";
import { RichRenderer } from "../../cli/ui/rich-renderer.js";
import { System24Renderer } from "../../cli/ui/system24-renderer.js";
import { GreenRainRenderer } from "../../cli/ui/green-rain-renderer.js";
import { NeonGridRenderer } from "../../cli/ui/neon-grid-renderer.js";
import { sanitizeUserVisibleOutput } from "../../util/user-visible-output.js";

export interface ChatRuntimeInput {
  root: string;
  rootSource?: string;
  activeCwd?: string;
  effectiveRunId: string;
  effectiveAgentFile: string;
  sessionId: string;
  layout: ChatLayout;
  brand: ChatBrand;
  currentMode: import("../../util/mode-preset.js").OmkMode;
  providerPolicy: string;
  modelArg: ReturnType<typeof import("../../providers/model-registry.js").parseProviderModelArg>;
  mcpScope: "all" | "project" | "none";
  effectiveResources: Awaited<ReturnType<typeof import("../../util/resource-profile.js").getOmkResourceSettings>>;
  effectiveWorkers: string;
  executionPrompt: string;
  ui: ChatUi;
  chatRuntimeMcpAllowlist: string[] | undefined;
  chatRuntimeSkillAllowlist: string[] | undefined;
}

export function shouldUseDirectKimiFallback(
  providerPolicy: string | undefined,
  env: { OMK_LEGACY_CHAT?: string } = process.env
): boolean {
  const normalizedProviderPolicy = providerPolicy?.trim().toLowerCase() || "auto";
  return env.OMK_LEGACY_CHAT === "1" && (normalizedProviderPolicy === "kimi" || normalizedProviderPolicy === "auto");
}


function buildBaseChatRuntimeEnv(root: string, sessionId: string): Record<string, string> {
  const safeNames = new Set([
    "CI",
    "COLORTERM",
    "FORCE_COLOR",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "NO_COLOR",
    "OMK_ORIGINAL_HOME",
    "PATH",
    "SHELL",
    "TERM",
    "TMP",
    "TMPDIR",
    "USER",
  ]);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && safeNames.has(name)) env[name] = value;
  }
  const omkNames = [
    "OMK_AUTHORITY_PROVIDER",
    "OMK_CHAT_NO_BANNER",
    "OMK_DEBUG",
    "OMK_DEFAULT_PROVIDER",
    "OMK_LEGACY_CHAT",
    "OMK_MCP_PREFLIGHT",
    "OMK_PROVIDER_TIMEOUT_MS",
    "OMK_TURN_TIMEOUT_MS",
  ];
  for (const name of omkNames) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...createOmkSessionEnv(root, sessionId) };
}

function filterRuntimeCapabilityNames(names: readonly string[], allowlist: readonly string[] | undefined): string[] {
  if (allowlist === undefined) return [...names];
  const allowed = new Set(allowlist);
  return names.filter((name) => allowed.has(name));
}

function attachSelectedProviderEnv(
  env: Record<string, string>,
  provider: string,
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const next = { ...env };
  const add = (name: string): void => {
    const value = source[name];
    if (value !== undefined) next[name] = value;
  };
  if (provider === "deepseek" || provider === "auto") {
    add("DEEPSEEK_API_KEY");
    add("DEEPSEEK_MODEL");
  }
  if (provider === "codex" || provider === "auto") {
    add("CODEX_BIN");
    add("OPENAI_API_KEY");
    add("OPENAI_BASE_URL");
  }
  if (provider === "commandcode" || provider === "auto") add("COMMANDCODE_BIN");
  if (provider === "opencode" || provider === "auto") add("OPENCODE_BIN");
  if (provider === "kimi" || provider === "auto") add("KIMI_BIN");
  return next;
}

function formatRuntimeBootstrapFailure(bootstrap: Awaited<ReturnType<typeof resolveRuntimeBootstrap>>): string {
  const lines = [
    `[omk] No runnable runtime for provider=${bootstrap.providerPolicy}.`,
    bootstrap.selectedProvider !== bootstrap.providerPolicy ? `Selected provider: ${bootstrap.selectedProvider}` : undefined,
    bootstrap.reason ? `Reason: ${bootstrap.reason}` : undefined,
    `Runtime OK: ${bootstrap.runtimeOk ? "yes" : "no"}; Auth OK: ${bootstrap.authOk ? "yes" : "no"}; Model OK: ${bootstrap.modelOk ? "yes" : "no"}.`,
  ].filter((line): line is string => Boolean(line));
  if (bootstrap.setupHints.length > 0) {
    lines.push("Fix:");
    for (const hint of bootstrap.setupHints) lines.push(`  - ${hint}`);
  }
  return lines.join("\n");
}

export async function runChatRuntime(
  options: {
    agentFile?: string;
    runId?: string;
    workers?: string;
    maxStepsPerTurn?: string;
    layout?: ChatLayout;
    brand?: ChatBrand;
    mode?: string;
    execution?: string;
    provider?: string;
    model?: string;
    cockpitRefresh?: string;
    cockpitRedraw?: "diff" | "full" | "append";
    cockpitHistory?: "off" | "static" | "watch";
    cockpitSideWidth?: string;
    cockpitHeight?: string;
    ui?: string;
    mcpScope?: string;
    smoke?: boolean;
    json?: boolean;
    showThink?: string;
    reasoningNlp?: boolean;
    reasoningSummary?: string;
  },
  input: ChatRuntimeInput
): Promise<number> {
  const {
    root,
    rootSource,
    activeCwd,
    effectiveRunId,
    effectiveAgentFile,
    sessionId,
    layout,
    providerPolicy,
    modelArg,
    mcpScope,
    effectiveResources,
    effectiveWorkers,
    currentMode,
    ui,
    chatRuntimeMcpAllowlist,
    chatRuntimeSkillAllowlist,
  } = input;

  const directKimiFallbackEnabled = shouldUseDirectKimiFallback(providerPolicy);

  // ── Live heartbeat: keep state.json fresh while chat is active ──
  const HEARTBEAT_MS = 2000;
  const pendingUpdates = new Set<Promise<void>>();
  function track(p: Promise<void>): void {
    pendingUpdates.add(p);
    p.then(() => pendingUpdates.delete(p), () => pendingUpdates.delete(p));
  }
  const heartbeat = setInterval(() => {
    track(enqueueChatHeartbeat(effectiveRunId).catch(() => {}));
  }, HEARTBEAT_MS);

  let env = buildBaseChatRuntimeEnv(root, sessionId);
  env.OMK_WORKERS = effectiveWorkers;
  if (providerPolicy && providerPolicy !== "auto" && providerPolicy !== "kimi") {
    env.OMK_PROVIDER_POLICY = providerPolicy;
  }
  if (modelArg.model) {
    env.OMK_PROVIDER_MODEL = modelArg.model;
  }

  env.OMK_RUN_ID = effectiveRunId;
  env.OMK_MODE = currentMode;
  env.OMK_MCP_SCOPE = mcpScope;
  env.OMK_SKILLS_SCOPE = effectiveResources.skillsScope;
  env.OMK_HOOKS_SCOPE = effectiveResources.hooksScope;

  // Inherit into AgentWorker subprocess / in-process env
  process.env.OMK_RUN_ID = effectiveRunId;
  process.env.OMK_MODE = currentMode;
  process.env.OMK_MCP_SCOPE = mcpScope;
  process.env.OMK_SKILLS_SCOPE = effectiveResources.skillsScope;
  process.env.OMK_HOOKS_SCOPE = effectiveResources.hooksScope;
  process.env.OMK_WORKERS = effectiveWorkers;

  let lastThinking = "";
  const reasoningFrames: ReasoningFrame[] = [];
  const reasoningVisibility = resolveReasoningVisibility(options.showThink, process.env.OMK_SHOW_THINK);
  const reasoningSummaryMode = resolveReasoningSummaryMode(options.reasoningSummary, process.env.OMK_REASONING_SUMMARY);
  const reasoningEnabled = reasoningVisibility !== "off" || options.reasoningNlp || process.env.OMK_REASONING_NLP === "1";

  let exitCode = 0;
  let recentChatOutput = "";
  let observedKimiSessionId: string | undefined;
  let bridgeSucceeded = false;
  // Chunk-array buffer to avoid repeated large string copies during todo parsing
  const pendingChunks: string[] = [];
  let pendingLength = 0;

  // ── Debounced TODO sync ──
  let pendingTodoSync: Promise<void> | null = null;
  let todoSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let accumulatedTodos: TodoItem[] = [];

  function flushTodoSync(): void {
    if (todoSyncTimer) {
      clearTimeout(todoSyncTimer);
      todoSyncTimer = null;
    }
    if (accumulatedTodos.length === 0) return;
    const todosToSync = accumulatedTodos;
    accumulatedTodos = [];
    const p = (async () => {
      const existing = (await readTodos(effectiveRunId).catch(() => [] as TodoItem[])) ?? [];
      const merged = mergeTodos(existing, todosToSync);
      await writeTodos(effectiveRunId, merged);
      const doneCount = merged.filter((t) => t.status === "done").length;
      const now2 = new Date().toISOString();
      const meta = await readSessionMeta(effectiveRunId).catch(() => null);
      const startedAt = meta?.startedAt ?? now2;
      await writeSessionMeta(effectiveRunId, {
        runId: effectiveRunId,
        type: "chat",
        status: "active",
        startedAt,
        updatedAt: now2,
        todoCount: merged.length,
        todoDoneCount: doneCount,
      });
      // Mark real activity in state.json via the queued writer
      await queueChatStatePatch(effectiveRunId, { lastActivityAt: now2 });
    })().catch(() => {});
    track(p);
    pendingTodoSync = p;
  }

  function scheduleTodoSync(newTodos: TodoItem[]): void {
    accumulatedTodos = mergeTodos(accumulatedTodos, newTodos);
    if (todoSyncTimer) clearTimeout(todoSyncTimer);
    todoSyncTimer = setTimeout(flushTodoSync, 500); // 500ms debounce
  }

  try {
    if (!directKimiFallbackEnabled) {
      const bootstrap = await resolveRuntimeBootstrap({
        provider: providerPolicy,
        model: options.model,
        cwd: root,
        env: process.env,
      });
      env = attachSelectedProviderEnv(env, bootstrap.selectedProvider);

      if (!bootstrap.ok) {
        console.error(style.metricsRed(formatRuntimeBootstrapFailure(bootstrap)));
        exitCode = 1;
        bridgeSucceeded = true;
      } else if (!process.stdin.isTTY) {
        console.error(
          style.metricsRed(
             `[omk] Native OMK chat requires an interactive TTY for the root loop. ` +
               `Use \`omk run\`/\`omk parallel\` for non-interactive execution.`
          )
        );
        exitCode = 1;
        bridgeSucceeded = true;
      } else {
        const [skillNames, hookNames] = await Promise.all([
          getActiveSkillNames(effectiveResources.skillsScope),
          getActiveHookNames(root),
        ]);
        const runtimeSkillNames = filterRuntimeCapabilityNames(skillNames, chatRuntimeSkillAllowlist);
        const toolPlane = await buildOmkToolPlaneManifest({
          mcpScope,
          mcpAllowlist: chatRuntimeMcpAllowlist,
          skills: runtimeSkillNames,
          hooks: hookNames,
        });
        if (toolPlane.mcpConfigFile) {
          env.OMK_MCP_CONFIG_FILE = toolPlane.mcpConfigFile;
          env.OMK_MCP_SERVERS = toolPlane.mcpServers.join(",");
        }
        const nativeWorkers = Number.parseInt(input.effectiveWorkers, 10);
        const runner = await createRuntimeBackedTaskRunner({
          cwd: root,
          env,
          runId: effectiveRunId,
          goal: "native-chat",
          onOutput: (text: string) => {
            process.stdout.write(sanitizeUserVisibleOutput(text));
          },
        });
        const renderer = ui === "neon-grid"
          ? new NeonGridRenderer()
          : ui === "green-rain"
            ? new GreenRainRenderer()
            : ui === "system24"
            ? new System24Renderer()
            : ui === "rich" ? new RichRenderer() : new PlainModernRenderer();
        exitCode = await runNativeOmkRootLoop({
          bootstrap,
          taskRunner: runner,
          runId: effectiveRunId,
          root,
          rootSource,
          activeCwd,
          env,
          layout,
          agentFile: effectiveAgentFile,
          mcpAllowlist: toolPlane.mcpServers,
          skillNames: [...toolPlane.skills],
          hookNames: [...toolPlane.hooks],
          workers: Number.isFinite(nativeWorkers) && nativeWorkers > 0 ? nativeWorkers : 1,
          executionPrompt: input.executionPrompt,
          renderer,
          onData: (data) => {
            recentChatOutput = appendRecentChatOutput(recentChatOutput, data);
            // Reasoning NLP normalization for native root loop
            if (reasoningEnabled) {
              const frames = normalizeReasoningChunk(data, {
                visibility: reasoningVisibility,
                summaryMode: reasoningSummaryMode,
                provider: options.provider,
              });
              if (frames.length > 0) {
                reasoningFrames.push(...frames);
                const summary = extractThinkingSummary(frames);
                if (summary) {
                  lastThinking = summary;
                  track(updateChatActivity(effectiveRunId, `🧠 ${summary}`).catch(() => {}));
                  renderer.setThinkingSummary(summary);
                  renderer.emit({ type: "turn:reasoning", summary, frames: frames.map(f => ({ text: f.text, elapsedMs: f.elapsedMs })) });
                }
                const runDir = `${root}/.omk/runs/${effectiveRunId}`;
                appendReasoningFrames(runDir, frames).catch(() => {});
              }
            }
            // Parse SetTodoList from output
            pendingChunks.push(data);
            pendingLength += data.length;
            while (pendingLength > 8192 && pendingChunks.length > 1) {
              const removed = pendingChunks.shift()!;
              pendingLength -= removed.length;
            }
            if (pendingLength > 8192 && pendingChunks.length === 1) {
              pendingChunks[0] = pendingChunks[0].slice(-4096);
              pendingLength = pendingChunks[0].length;
            }
            const pendingOutput = pendingChunks.join("");
            const newTodos = parseSetTodoListFromOutput(pendingOutput);
            if (newTodos && newTodos.length > 0) {
              scheduleTodoSync(newTodos);
              const doneCount = newTodos.filter(t => t.status === "done").length;
              const inProgressCount = newTodos.filter(t => t.status === "in_progress").length;
              renderer.emit({ type: "turn:todo", total: newTodos.length, done: doneCount, inProgress: inProgressCount, items: newTodos.map(t => ({ title: t.title, status: t.status })) });
            }
          },
          onTodoSync: (output) => {
            const parsedTodos = parseSetTodoListFromOutput(output);
            if (parsedTodos && parsedTodos.length > 0) scheduleTodoSync(parsedTodos);
          },
        });
        bridgeSucceeded = true;
      }
    }

    if (!bridgeSucceeded && directKimiFallbackEnabled) {
      const args: string[] = ["--agent-file", effectiveAgentFile];
      await injectKimiGlobals(args, {
        role: "coordinator",
        mcpScope,
        skillsScope: effectiveResources.skillsScope,
        hooksScope: effectiveResources.hooksScope,
        mcpAllowlist: chatRuntimeMcpAllowlist,
      });
      if (options.maxStepsPerTurn) {
        args.push("--max-steps-per-turn", options.maxStepsPerTurn);
      }
      if (options.model) {
        args.push("--model", options.model);
      }
      if (process.env.OMK_DEBUG === "1") {
        console.error("[OMK_DEBUG] chat args:", args);
      }

      exitCode = await runKimiInteractive(args, {
        cwd: root,
        env: attachSelectedProviderEnv(env, "kimi"),
        onKimiMeta: (meta) => {
          const kimiSessionId = meta.session?.trim();
          if (!kimiSessionId || kimiSessionId === observedKimiSessionId) return;
          observedKimiSessionId = kimiSessionId;
          track(
            (async () => {
              const existing = await readSessionMeta(effectiveRunId).catch(() => null);
              const now = new Date().toISOString();
              await writeSessionMeta(effectiveRunId, {
                runId: effectiveRunId,
                type: "chat",
                status: existing?.status ?? "active",
                startedAt: existing?.startedAt ?? now,
                updatedAt: now,
                endedAt: existing?.endedAt,
                goalTitle: existing?.goalTitle,
                omkSessionId: sessionId,
                kimiSessionId,
                todoCount: existing?.todoCount ?? 0,
                todoDoneCount: existing?.todoDoneCount ?? 0,
              });
            })().catch(() => {})
          );
        },
        onData: (data) => {
          recentChatOutput = appendRecentChatOutput(recentChatOutput, data);
          // Reasoning NLP normalization
          if (reasoningEnabled) {
            const frames = normalizeReasoningChunk(data, {
              visibility: reasoningVisibility,
              summaryMode: reasoningSummaryMode,
              provider: options.provider,
            });
            if (frames.length > 0) {
              reasoningFrames.push(...frames);
              const summary = extractThinkingSummary(frames);
              if (summary) {
                lastThinking = `🧠 ${summary}`;
                track(updateChatActivity(effectiveRunId, lastThinking).catch(() => {}));
              }
              // Async flush to reasoning.jsonl (non-blocking)
              const runDir = `${root}/.omk/runs/${effectiveRunId}`;
              appendReasoningFrames(runDir, frames).catch(() => {});
            }
          }

          // Legacy lightweight activity sampling (kept for compatibility)
          const lines = data.split("\n");
          for (const raw of lines) {
            const line = raw.trim();
            if (isKimiPromptReadyLine(line)) {
              lastThinking = "";
              track(updateChatActivity(effectiveRunId, "").catch(() => {}));
              continue;
            }
            if (!line || line.length < 3) continue;
            if (/read_file|write_file|edit_file|search_files|glob|grep|ctx_read/i.test(line)) {
              const m = line.match(/["']([^"']{1,60})["']/);
              if (!reasoningEnabled) lastThinking = m ? `📄 ${m[1].split("/").pop() ?? m[1]}` : `🔧 ${line.slice(0, 60)}`;
              track(updateChatActivity(effectiveRunId, lastThinking).catch(() => {}));
              continue;
            }
            const explicit = line.match(/^<think(?:ing)?>[\s:]*(.+?)(?:<\/think(?:ing)?>)?$/i);
            if (explicit) {
              if (!reasoningEnabled) lastThinking = `🧠 ${explicit[1].trim().slice(0, 100)}`;
              track(updateChatActivity(effectiveRunId, lastThinking).catch(() => {}));
              continue;
            }
          }

          // Parse SetTodoList from output with chunk-boundary buffering
          pendingChunks.push(data);
          pendingLength += data.length;
          // Trim from front to keep last ~4096-8192 chars without massive string copies
          while (pendingLength > 8192 && pendingChunks.length > 1) {
            const removed = pendingChunks.shift()!;
            pendingLength -= removed.length;
          }
          if (pendingLength > 8192 && pendingChunks.length === 1) {
            pendingChunks[0] = pendingChunks[0].slice(-4096);
            pendingLength = pendingChunks[0].length;
          }
          const pendingOutput = pendingChunks.join("");
          const newTodos = parseSetTodoListFromOutput(pendingOutput);
          if (newTodos && newTodos.length > 0) {
            scheduleTodoSync(newTodos);
          }
        },
      });
    } else if (!bridgeSucceeded) {
      const message =
        `[omk] runtime bridge failed and direct Kimi fallback is disabled for provider policy '${providerPolicy || "auto"}'. ` +
        `Set OMK_LEGACY_CHAT=1 to allow the legacy direct Kimi CLI fallback.`;
      recentChatOutput = appendRecentChatOutput(recentChatOutput, `\n${message}\n`);
      console.error(`\n${message}\n`);
      exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recentChatOutput = appendRecentChatOutput(recentChatOutput, `\n[omk] chat failed: ${message}\n`);
    console.error(`\n[omk] chat failed: ${message}\n`);
    exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    flushTodoSync();
    if (pendingTodoSync) {
      pendingUpdates.add(pendingTodoSync);
    }
    await Promise.all(pendingUpdates);
    if (exitCode !== 0) {
      await writeChatStartupFailureArtifact({
        root,
        runId: effectiveRunId,
        exitCode,
        agentFile: effectiveAgentFile,
        recentOutput: recentChatOutput,
        resources: effectiveResources,
      }).catch(() => {});
    }
    // Flush remaining reasoning frames
    if (reasoningEnabled && reasoningFrames.length > 0) {
      const runDir = `${root}/.omk/runs/${effectiveRunId}`;
      await appendReasoningFrames(runDir, reasoningFrames).catch(() => {});
    }
    await finalizeChatState(effectiveRunId, exitCode === 0);
    // Update session.json
    try {
      const meta = await readSessionMeta(effectiveRunId).catch(() => null);
      const now = new Date().toISOString();
      if (meta) {
        meta.status = exitCode === 0 ? "completed" : "failed";
        meta.endedAt = now;
        meta.updatedAt = now;
        meta.omkSessionId ??= sessionId;
        if (observedKimiSessionId) meta.kimiSessionId = observedKimiSessionId;
        await writeSessionMeta(effectiveRunId, meta);
      } else {
        await writeSessionMeta(effectiveRunId, {
          runId: effectiveRunId,
          type: "chat",
          status: exitCode === 0 ? "completed" : "failed",
          startedAt: now,
          updatedAt: now,
          omkSessionId: sessionId,
          kimiSessionId: observedKimiSessionId,
          todoCount: 0,
          todoDoneCount: 0,
        });
      }
    } catch {
      // ignore session finalize failures
    }
    if (ui !== "plain-modern" && ui !== "rich" && ui !== "system24" && ui !== "green-rain" && ui !== "neon-grid") {
      await printChatExitBanner({
        runId: effectiveRunId,
        sessionId,
        kimiSessionId: observedKimiSessionId,
        workers: options.workers,
        root,
        mcpScope,
      });
    }
    if (isCockpitChild()) {
      const sanitized = effectiveRunId.replace(/[^a-zA-Z0-9]/g, "-");
      const session = `omk-chat-${sanitized}`;
      await runShell("tmux", ["kill-session", "-t", session], { cwd: root, timeout: 5000 }).catch(() => {});
    }
  }

  return exitCode;
}

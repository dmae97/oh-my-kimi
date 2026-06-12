import { getOmkPath, resolveProjectRoot, displayProjectRootPath, type ProjectRootResolution } from "../../util/fs.js";
import { style, status, header } from "../../util/theme.js";
import { t } from "../../util/i18n.js";
import { createOmkSessionId } from "../../util/session.js";
import type { OmkMode } from "../../util/mode-preset.js";
import { getOmkResourceSettings } from "../../util/resource-profile.js";
import { parseExecutionPromptPolicy } from "../../util/execution-selection.js";
import { normalizeProviderPolicy, parseProviderModelArg } from "../../providers/model-registry.js";
import { validateAgentYamlFile, formatAgentYamlIssues } from "../../util/agent-schema.js";
import { ensureChatStartupArtifacts } from "../../util/chat-startup.js";
import { ensureChatRunState } from "../../util/chat-cockpit.js";
import { buildChatAgentRuntimeMcpAllowlist, buildChatAgentRuntimeSkillAllowlist, prepareChatAgentModeAgent, type ChatAgentModeResources } from "../../util/chat-agent-mode.js";
import { parseRuntimeScopeOption } from "../../util/runtime-scope.js";
import { queueChatStatePatch } from "../../util/chat-state.js";
import { initCommand } from "../init.js";
import { checkCommand, resolveKimiBin } from "../../util/shell.js";
import { readTodos } from "../../util/todo-sync.js";
import { relative, join, resolve } from "path";
import { readFile } from "fs/promises";

import {
  type ChatLayout,
  type ChatBrand,
  type ChatUi,
  resolveLayout,
  resolveChatUi,
  resolveChatWorkerCount,
  renderChatIntro,
  getActiveMcpNames,
  getActiveSkillNames,
  getActiveHookNames,
  verifyAgentPrompt,
} from "./utils.js";
import { buildChatSmokeReport, failChatBeforeLaunch } from "./startup.js";
import { runChatRuntime } from "./runtime.js";

function resolveChatProjectRoot(options: {
  cwd?: string;
  projectRoot?: string;
}): ProjectRootResolution {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OMK_PREFER_CWD_ROOT: process.env.OMK_PREFER_CWD_ROOT ?? "1",
  };

  if (options.projectRoot) {
    env.OMK_PROJECT_ROOT = resolve(options.projectRoot);
  } else if (process.env.OMK_CHAT_RESPECT_PROJECT_ROOT_ENV !== "1") {
    delete env.OMK_PROJECT_ROOT;
  }

  return resolveProjectRoot({ cwd, env });
}

export async function chatCommand(options: {
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
  cwd?: string;
  projectRoot?: string;
  ui?: ChatUi;
  cockpitRefresh?: string;
  cockpitRedraw?: "diff" | "full" | "append";
  cockpitHistory?: "off" | "static" | "watch";
  cockpitSideWidth?: string;
  cockpitHeight?: string;
  mcpScope?: string;
  smoke?: boolean;
  json?: boolean;
  showThink?: string;
  reasoningNlp?: boolean;
  reasoningSummary?: string;
}): Promise<void> {
  const rootResolution = resolveChatProjectRoot(options);
  const root = rootResolution.root;
  process.env.OMK_PROJECT_ROOT = root;
  if (rootResolution.isHomeRoot && rootResolution.warning) {
    const message = `Project root resolved to HOME (${displayProjectRootPath(root) ?? root}). ${rootResolution.recommendation ?? "Set OMK_PROJECT_ROOT or OMK_DEFAULT_PROJECT_ROOT."}`;
    if (process.env.OMK_ALLOW_HOME_PROJECT_ROOT !== "1") {
      const error = `${message} Refusing to start chat from HOME without an explicit project root.`;
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error }, null, 2));
      } else {
        console.error(status.error(error));
      }
      process.exit(1);
    }
    if (!options.json) console.error(status.warn(message));
  }
  const { getCurrentMode, isValidMode } = await import("../../util/mode-preset.js");
  let currentMode: OmkMode = "agent";
  if (options.mode) {
    const m: string = options.mode.toLowerCase().trim();
    if (m === "default") {
      currentMode = "agent";
    } else if (isValidMode(m)) {
      currentMode = m as OmkMode;
    } else {
      console.log(status.warn(`Invalid mode: ${options.mode}. Falling back to current mode.`));
      currentMode = await getCurrentMode();
    }
  } else {
    currentMode = await getCurrentMode();
  }
  const agentFile = options.agentFile ?? getOmkPath("agents/root.yaml");
  const sessionId = createOmkSessionId("chat");
  const runId = options.runId;
  const effectiveRunId = runId ?? sessionId;
  const layout = resolveLayout(options.layout);
  const ui = resolveChatUi(options.ui);
  const brand = options.brand ?? "minimal";
  const resources = await getOmkResourceSettings();
  const modelArg = parseProviderModelArg(options.model);
  const providerInput = options.provider
    ?? modelArg.provider
    ?? process.env.OMK_DEFAULT_PROVIDER
    ?? "kimi";
  const providerPolicy = normalizeProviderPolicy(providerInput);
  const mcpScope = parseRuntimeScopeOption(options.mcpScope, resources.mcpScope, "--mcp-scope");
  const effectiveResources = { ...resources, mcpScope };
  const effectiveWorkers = resolveChatWorkerCount(options.workers, resources.maxWorkers);
  const executionPrompt = parseExecutionPromptPolicy(options.execution, "--execution") ?? resources.executionPrompt;

  // Dependency preflight: the Kimi binary + node-pty are required only when the
  // Kimi adapter is explicitly selected. Provider-neutral auto mode can route to
  // non-Kimi runtimes, so it must not fail before OMK runtime routing runs.
  const kimiBin = resolveKimiBin();
  const needsKimi = providerPolicy === "kimi";
  if (needsKimi) {
    const kimiAvailable = await checkCommand(kimiBin);
    if (!kimiAvailable) {
      console.error(
        status.error(
          `[omk] \`${kimiBin}\` command not found in PATH. ` +
            "Install the primary CLI first: npm i -g @anthropic-ai/kimi-code\n" +
            "If already installed, check your PATH or set KIMI_BIN env var.\n" +
            "To use a non-Kimi provider: omk chat --provider deepseek (or codex, openrouter, qwen)"
        )
      );
      process.exit(1);
    }
    try {
      await import("node-pty");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        status.error(
          `[omk] Failed to load node-pty native module. (${message})\n` +
            "This usually happens when installed with --ignore-scripts.\n" +
            "Fix: npm rebuild -g open-multi-agent-kit\n" +
            "Or reinstall: npm uninstall -g open-multi-agent-kit && npm install -g open-multi-agent-kit"
        )
      );
      process.exit(1);
    }
  }

  const promptOk = await verifyAgentPrompt(agentFile);
  if (!promptOk) {
    console.log(status.warn(t("chat.notInitialized")));
    await initCommand({ profile: "default" });
    console.log(status.ok(t("chat.autoInitComplete")));
  }

  try {
    const bootstrap = await ensureChatStartupArtifacts({ root, runId: effectiveRunId });
    if (layout !== "plain" && bootstrap.created.length > 0) {
      console.log(status.ok(t("chat.bootstrapReady", bootstrap.date, bootstrap.created.length)));
    }
  } catch (err) {
    if (layout !== "plain") {
      const message = err instanceof Error ? err.message : String(err);
      console.log(status.warn(t("chat.bootstrapWarning", message)));
    }
  }

  // ── Star prompt at chat start (parent only, skipped in cockpit child) ──
  try {
    const { maybeAskForGitHubStarAtChatStart } = await import("../../util/first-run-star.js");
    const { getOmkVersionSync } = await import("../../util/version.js");
    await maybeAskForGitHubStarAtChatStart({ version: getOmkVersionSync() });
  } catch {
    // Swallow star prompt errors so chat entry is preserved.
  }

  // Ensure run state exists before launching cockpit so right pane can read it
  await ensureChatRunState(root, effectiveRunId);

  let effectiveAgentFile = agentFile;
  let chatRuntimeMcpAllowlist: string[] | undefined = effectiveResources.mcpScope === "none" ? undefined : ["omk-project"];
  let chatRuntimeSkillAllowlist: string[] | undefined;
  if (!options.agentFile) {
    try {
      const [mcpNames, skillNames, hookNames] = await Promise.all([
        getActiveMcpNames(effectiveResources.mcpScope),
        getActiveSkillNames(resources.skillsScope),
        getActiveHookNames(root),
      ]);
      const chatAgentResources: ChatAgentModeResources = {
        workers: effectiveWorkers,
        maxStepsPerTurn: options.maxStepsPerTurn,
        resourceProfile: effectiveResources.profile,
        approvalPolicy: "interactive",
        providerPolicy,
        authorityProvider: process.env.OMK_AUTHORITY_PROVIDER,
        providerModel: modelArg.model,
        ensembleDefaultEnabled: effectiveResources.ensembleDefaultEnabled,
        executionPrompt,
        executionPromptSource: options.execution ? "cli" : "config",
        mcpScope: effectiveResources.mcpScope,
        skillsScope: effectiveResources.skillsScope,
        hooksScope: effectiveResources.hooksScope,
        mcpNames,
        skillNames,
        hookNames,
      };
      chatRuntimeMcpAllowlist = buildChatAgentRuntimeMcpAllowlist({
        mode: currentMode,
        resources: chatAgentResources,
      });
      chatRuntimeSkillAllowlist = buildChatAgentRuntimeSkillAllowlist({
        mode: currentMode,
        resources: chatAgentResources,
      });
      const prepared = await prepareChatAgentModeAgent({
        root,
        runId: effectiveRunId,
        baseAgentFile: agentFile,
        basePromptPath: getOmkPath("prompts/root.md"),
        mode: currentMode,
        resources: chatAgentResources,
      });
      effectiveAgentFile = prepared.agentFile;
      await queueChatStatePatch(effectiveRunId, {
        lastActivityAt: new Date().toISOString(),
      }).catch(() => {});
    } catch (err) {
      effectiveAgentFile = agentFile;
      if (layout !== "plain") {
        const detail = process.env.OMK_DEBUG === "1" && err instanceof Error ? `: ${err.name}` : "";
        console.log(status.warn(`Chat agent harness unavailable; using base agent${detail}`));
      }
    }
  }

  const agentSchema = await validateAgentYamlFile(effectiveAgentFile, root);
  if (!agentSchema.ok) {
    const schemaIssues = agentSchema.issues.map((item) => `${item.file}: ${item.message}`);
    const okabeYamlPath = join(root, ".omk", "agents", "okabe.yaml");
    let okabeOk = true;
    try {
      const okabeContent = await readFile(okabeYamlPath, "utf8");
      okabeOk = okabeContent.trim().length > 0;
    } catch {
      okabeOk = false;
    }
    const repairHint = okabeOk
      ? "Fix: run `omk doctor --fix`, then retry `omk chat`."
      : "Fix: run `omk init` to regenerate agents, then retry `omk chat`.";
    await failChatBeforeLaunch({
      root,
      runId: effectiveRunId,
      agentFile: effectiveAgentFile,
      resources: effectiveResources,
      message: `invalid agent YAML schema for ${relative(root, effectiveAgentFile)}: ${formatAgentYamlIssues(agentSchema, 4)}\n${repairHint}`,
      schemaIssues,
    });
  }

  if (options.smoke) {
    const report = await buildChatSmokeReport({
      root,
      rootSource: rootResolution.source,
      activeCwd: rootResolution.cwd,
      runId: effectiveRunId,
      agentFile: effectiveAgentFile,
      schemaOk: agentSchema.ok,
      resources: effectiveResources,
      mcpScope,
      mcpAllowlist: chatRuntimeMcpAllowlist,
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(header("OMK Chat Smoke"));
      for (const check of report.checks) {
        const line = `${check.name}: ${check.message}`;
        console.log(check.status === "ok" ? status.ok(line) : status.error(line));
      }
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (!options.json) {
    try {
      const { maybePromptForOmkUpdate } = await import("../../util/update-check.js");
      const updatePrompt = await maybePromptForOmkUpdate({ source: "chat" });
      if (updatePrompt.shouldExit) process.exit(updatePrompt.exitCode ?? 0);
    } catch {
      // Update prompts are advisory and must not block chat startup.
    }
  }

  // ── tmux/auto layout: use System24 renderer inline ──
  // cockpit removed — System24 TUI handles all rendering

  // ── plain / inline: run Kimi directly ──
  const isPlain = layout === "plain";

  if (!isPlain && ui !== "green-rain" && ui !== "neon-grid") {
    const trust = `${effectiveResources.mcpScope} MCP / ${effectiveResources.skillsScope} skills`;
    const agentDisplay = relative(root, effectiveAgentFile);
    const { getModePreset } = await import("../../util/mode-preset.js");
    const modePreset = getModePreset(currentMode);
    const modeDisplay = modePreset ? `${modePreset.icon} ${modePreset.label}` : currentMode;
    console.log(
      renderChatIntro(brand, {
        agent: agentDisplay,
        runId: effectiveRunId,
        layout: isPlain ? "plain" : "inline",
        trust,
        mode: modeDisplay,
      }) + "\n"
    );
  }

  // ── Deferred HUD + history: fire-and-forget, let the agent loop start immediately ──
  if (!isPlain) {
    // Show a minimal status line while we defer the full HUD
    const providerLabel = providerPolicy === "auto" ? "auto-detect" : providerPolicy;
    const modeLabel = currentMode;
    const mcpLabel = effectiveResources.mcpScope === "none" ? "mcp=off" : `mcp=${effectiveResources.mcpScope}`;
    console.log(style.phosphorDim(`  ⟡ ${providerLabel} · ${modeLabel} · ${mcpLabel} · workers=${effectiveWorkers}`));
    console.log(style.gray(`  Run ${style.cream("omk hud")} for dashboard, ${style.cream("omk runs")} for history.`));
    // Defer full HUD + history rendering to after the agent loop starts (non-blocking)
    setImmediate(async () => {
      try {
        const { renderHudDashboard } = await import("../hud.js");
        const hud = await renderHudDashboard({ runId: effectiveRunId, terminalWidth: process.stdout.columns, fetchQuota: false });
        const lines = hud.split("\n");
        const termRows = process.stdout.rows || 24;
        const maxLines = Math.max(10, termRows - 4);
        const summary = lines.slice(0, Math.min(lines.length, maxLines)).join("\n");
        process.stderr.write(`\n${summary}\n${style.gray(t("chat.scrollUpForHud"))}\n`);
      } catch { /* ignore */ }
    });
    setImmediate(async () => {
      try {
        const { listRunCandidates: listRuns } = await import("../hud.js");
        const { pathExists, getRunsDir, getRunPath } = await import("../../util/fs.js");
        const { readFile } = await import("fs/promises");
        const runsDir = getRunsDir();
        if (await pathExists(runsDir)) {
          const candidates = await listRuns(runsDir);
          const sorted = candidates
            .filter((c) => c.name !== effectiveRunId)
            .sort((a, b) => b.stateUpdatedAtMs - a.stateUpdatedAtMs)
            .slice(0, 3);
          if (sorted.length > 0) {
            process.stderr.write(`\n${style.purpleBold("▣ Recent Runs")}\n`);
            for (const c of sorted) {
              let statusStr = style.gray("unknown");
              try {
                const statePath = getRunPath(c.name, "state.json");
                const raw = await readFile(statePath, "utf-8");
                const state = JSON.parse(raw) as Record<string, unknown>;
                const st = String(state.status ?? "unknown");
                if (st === "done") statusStr = style.mint(st);
                else if (st === "running") statusStr = style.purple(st);
                else if (st === "failed") statusStr = style.red(st);
                else statusStr = style.gray(st);
              } catch { /* ignore */ }
              let goalTitle = "";
              try {
                const goalRaw = await readFile(getRunPath(c.name, "goal.md"), "utf-8");
                const firstLine = goalRaw.split(/\r?\n/)[0]?.trim() ?? "";
                goalTitle = firstLine.replace(/^#+\s*/, "").slice(0, 30);
              } catch { /* ignore */ }
              const titlePart = goalTitle ? style.gray(` → ${goalTitle}`) : "";
              process.stderr.write(`  ${style.gray("•")} ${style.cream(c.name.slice(0, 31))} ${statusStr}${titlePart}\n`);
            }
            process.stderr.write(style.gray(`  Run ${style.cream("omk runs")} for full history\n`));
          }
        }
      } catch { /* ignore */ }
    });
  }

  // ── Resume: show existing TODO summary if resuming ──
  if (!isPlain) {
    try {
      const existingTodos = await readTodos(effectiveRunId).catch(() => null);
      if (existingTodos && existingTodos.length > 0) {
        const doneCount = existingTodos.filter((t) => t.status === "done").length;
        console.log(style.gray(`📋 Resuming with ${existingTodos.length} todos (${doneCount} done)`));
      }
    } catch {
      // ignore resume check failures
    }
  }

  const exitCode = await runChatRuntime(options, {
    root,
    rootSource: rootResolution.source,
    activeCwd: rootResolution.cwd,
    effectiveRunId,
    effectiveAgentFile,
    sessionId,
    layout,
    brand,
    currentMode,
    providerPolicy,
    modelArg,
    mcpScope,
    effectiveResources,
    effectiveWorkers,
    executionPrompt,
    ui,
    chatRuntimeMcpAllowlist,
    chatRuntimeSkillAllowlist,
  });

  if (exitCode !== 0) process.exitCode = exitCode;
  return;
}

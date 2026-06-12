import { getRunPath, pathExists } from "../../util/fs.js";
import { relative } from "path";
import { style, status, box, label, separator } from "../../util/theme.js";
import { writeSessionMeta } from "../../util/session.js";
import { finalizeChatState } from "../../util/chat-state.js";
import { getOmkResourceSettings } from "../../util/resource-profile.js";
import { buildOmkToolPlaneManifest } from "../../runtime/tool-plane.js";
import type { OmkToolPlaneDiagnostic } from "../../runtime/tool-plane.js";
import {
  sanitizeChatStartupFailureOutput,
  CHAT_STARTUP_FAILURE_OUTPUT_LIMIT,
  formatResourceCount,
  getActiveMcpNames,
  getActiveSkillNames,
} from "./utils.js";

export interface ChatSmokeReport {
  ok: boolean;
  command: "chat smoke";
  runId: string;
  agentFile: string;
  schemaOk: boolean;
  mcpScope: "all" | "project" | "none";
  skillsScope: "all" | "project" | "none";
  hooksScope: "all" | "project" | "none";
  runtimeMcpConfig: {
    injected: boolean;
    path: string | null;
    exists: boolean;
  };
  root: {
    path: string;
    cwd: string;
    source: string;
  };
  diagnostics: {
    toolPlane: readonly OmkToolPlaneDiagnostic[];
  };
  startupFailureArtifactExists: boolean;
  checks: Array<{ name: string; status: "ok" | "fail"; message: string }>;
}

export async function buildChatSmokeReport(options: {
  root: string;
  rootSource?: string;
  activeCwd?: string;
  runId: string;
  agentFile: string;
  schemaOk: boolean;
  resources: Awaited<ReturnType<typeof getOmkResourceSettings>>;
  mcpScope: "all" | "project" | "none";
  mcpAllowlist?: string[];
}): Promise<ChatSmokeReport> {
  const toolPlane = await buildOmkToolPlaneManifest({
    mcpScope: options.mcpScope,
    mcpAllowlist: options.mcpAllowlist,
  });
  const runtimeMcpPath = toolPlane.mcpConfigFile ?? null;
  const runtimeMcpExists = runtimeMcpPath ? await pathExists(runtimeMcpPath) : false;
  const failurePath = getRunPath(options.runId, "chat-startup-failure.json", options.root);
  const startupFailureArtifactExists = await pathExists(failurePath);
  const toolPlaneErrorCount = toolPlane.diagnostics.filter((diagnostic) => diagnostic.level === "error").length;
  const toolPlaneWarningCount = toolPlane.diagnostics.filter((diagnostic) => diagnostic.level === "warning").length;
  const checks: ChatSmokeReport["checks"] = [
    {
      name: "agent schema",
      status: options.schemaOk ? "ok" : "fail",
      message: options.schemaOk ? "agent YAML schema is valid" : "agent YAML schema is invalid",
    },
    {
      name: "runtime MCP merge",
      status: options.mcpScope === "none" || runtimeMcpExists ? "ok" : "fail",
      message: runtimeMcpPath
        ? `runtime MCP config: ${relative(options.root, runtimeMcpPath)}`
        : options.mcpScope === "none"
          ? "MCP disabled by scope none"
          : "runtime MCP config was not generated",
    },
    {
      name: "startup failure artifact",
      status: startupFailureArtifactExists ? "fail" : "ok",
      message: startupFailureArtifactExists ? "chat-startup-failure.json exists" : "no startup failure artifact",
    },
    {
      name: "tool-plane diagnostics",
      status: toolPlaneErrorCount > 0 ? "fail" : "ok",
      message: toolPlane.diagnostics.length === 0
        ? "no tool-plane diagnostics"
        : `${toolPlaneErrorCount} error(s), ${toolPlaneWarningCount} warning(s)`,
    },
  ];
  return {
    ok: checks.every((check) => check.status === "ok"),
    command: "chat smoke",
    runId: options.runId,
    agentFile: relative(options.root, options.agentFile),
    schemaOk: options.schemaOk,
    mcpScope: options.mcpScope,
    skillsScope: options.resources.skillsScope,
    hooksScope: options.resources.hooksScope,
    runtimeMcpConfig: {
      injected: Boolean(runtimeMcpPath),
      path: runtimeMcpPath ? relative(options.root, runtimeMcpPath) : null,
      exists: runtimeMcpExists,
    },
    root: {
      path: options.root,
      cwd: options.activeCwd ?? process.cwd(),
      source: options.rootSource ?? "unknown",
    },
    diagnostics: {
      toolPlane: toolPlane.diagnostics,
    },
    startupFailureArtifactExists,
    checks,
  };
}

export async function writeChatStartupFailureArtifact(options: {
  root: string;
  runId: string;
  exitCode: number;
  agentFile: string;
  recentOutput: string;
  resources: Awaited<ReturnType<typeof getOmkResourceSettings>>;
  reason?: string;
  schemaIssues?: string[];
}): Promise<void> {
  const artifactPath = getRunPath(options.runId, "chat-startup-failure.json", options.root);
  const artifact = {
    runId: options.runId,
    exitCode: options.exitCode,
    capturedAt: new Date().toISOString(),
    agentFile: relative(options.root, options.agentFile),
    mcpScope: options.resources.mcpScope,
    skillsScope: options.resources.skillsScope,
    hooksScope: options.resources.hooksScope,
    reason: options.reason,
    schemaIssues: options.schemaIssues ?? [],
    recentOutput: sanitizeChatStartupFailureOutput(options.recentOutput).slice(-CHAT_STARTUP_FAILURE_OUTPUT_LIMIT),
  };
  await import("fs/promises").then(({ writeFile }) =>
    writeFile(artifactPath, JSON.stringify(artifact, null, 2) + "\n", "utf-8")
  );
}

export async function failChatBeforeLaunch(options: {
  root: string;
  runId: string;
  agentFile: string;
  resources: Awaited<ReturnType<typeof getOmkResourceSettings>>;
  message: string;
  schemaIssues?: string[];
}): Promise<never> {
  const detail = options.schemaIssues?.length
    ? `\n${options.schemaIssues.slice(0, 8).map((item) => `  - ${item}`).join("\n")}`
    : "";
  console.error(status.error(`[omk] ${options.message}`));
  if (detail) console.error(detail);
  console.error(style.gray("Fix: run `omk doctor --fix`, then retry `omk chat`."));
  await writeChatStartupFailureArtifact({
    root: options.root,
    runId: options.runId,
    exitCode: 1,
    agentFile: options.agentFile,
    recentOutput: `${options.message}${detail}`,
    resources: options.resources,
    reason: options.message,
    schemaIssues: options.schemaIssues,
  }).catch(() => {});
  await finalizeChatState(options.runId, false).catch(() => {});
  const now = new Date().toISOString();
  await writeSessionMeta(options.runId, {
    runId: options.runId,
    type: "chat",
    status: "failed",
    startedAt: now,
    endedAt: now,
    updatedAt: now,
    todoCount: 0,
    todoDoneCount: 0,
  }).catch(() => {});
  process.exit(1);
}

export async function printChatExitBanner(options: {
  runId: string;
  sessionId: string;
  kimiSessionId?: string;
  workers?: string;
  root: string;
  mcpScope?: "all" | "project" | "none";
}): Promise<void> {
  const { runId, sessionId, kimiSessionId, workers } = options;
  const resources = await getOmkResourceSettings();
  const mcpScope = options.mcpScope ?? resources.mcpScope;

  // Parallel discovery of MCP + skills
  const [mcpNames, skillNames] = await Promise.all([
    getActiveMcpNames(mcpScope),
    getActiveSkillNames(resources.skillsScope),
  ]);

  const mcpText = formatResourceCount(mcpNames.length, mcpScope);
  const skillText = formatResourceCount(skillNames.length, resources.skillsScope);
  const workersText = workers ?? resources.maxWorkers.toString();

  const lines: string[] = [
    "",
    style.purpleBold("  🌸 Session Ended"),
    separator(50),
    label("Run ID", runId),
    label("OMK Session", sessionId),
    ...(kimiSessionId ? [label("Primary Session", kimiSessionId)] : []),
    label("Resume", `omk runs`),
    label("Workers", workersText),
    label("MCP", mcpText),
    label("Skills", skillText),
    separator(50),
    style.gray(`  Run ${style.cream("omk hud")} for dashboard, ${style.cream("omk runs")} for history.`),
    "",
  ];

  console.log(box(lines));
}

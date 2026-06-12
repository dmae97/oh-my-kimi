import type { McpDoctorReport, McpDoctorServerReport, McpDoctorSourceReport } from "../commands/mcp.js";
import { buildMcpDoctorReport, repairMcpDoctorIssues, type McpDoctorFixReport } from "../commands/mcp.js";
import { getProjectRoot, getUserHome } from "../util/fs.js";
import { style } from "../util/theme.js";
import { maskSensitiveText } from "../util/secret-mask.js";
import { isAbsolute, join, relative } from "path";

export type McpAutoConnectScope = "none" | "project" | "all" | string;
export type McpAutoConnectTransport = "stdio" | "remote" | "invalid";
export type McpAutoConnectSource = "builtin" | "project" | "global" | "runtime";
export type McpAutoConnectStatus = "mounted" | "ready" | "warn" | "error";
export type McpAutoConnectPreflightMode = "off" | "fast" | "full";

export interface McpAutoConnectEntry {
  name: string;
  transport: McpAutoConnectTransport;
  source: McpAutoConnectSource;
  status: McpAutoConnectStatus;
  reason?: string;
}

export interface McpAutoConnectSourceReport {
  path: string;
  exists: boolean;
  active: boolean;
  parsed: boolean;
  status: "ok" | "empty" | "error";
}

export interface McpAutoConnectReport {
  command: "mcp connect";
  ok: boolean;
  degraded: boolean;
  checkedAt: string;
  scope: McpAutoConnectScope;
  preflight: McpAutoConnectPreflightMode;
  autoMounted: McpAutoConnectEntry[];
  sources: McpAutoConnectSourceReport[];
  errors: string[];
  warnings: string[];
  fixes?: McpDoctorFixReport;
  data: {
    active: number;
    ready: number;
    mounted: number;
    warning: number;
    error: number;
  };
}

export interface McpAutoConnectOptions {
  fix?: boolean;
  dryRun?: boolean;
  global?: boolean;
  preflight?: McpAutoConnectPreflightMode;
  env?: Record<string, string | undefined>;
}

export async function runMcpAutoConnect(options: McpAutoConnectOptions = {}): Promise<McpAutoConnectReport> {
  const preflight = normalizePreflightMode(options.preflight);
  const env = buildAutoConnectEnv(preflight, options.env);
  const fixes = options.fix
    ? await repairMcpDoctorIssues({ dryRun: Boolean(options.dryRun), global: Boolean(options.global) })
    : undefined;
  const doctor = await buildMcpDoctorReport({ env });
  return mapDoctorToAutoConnectReport(doctor, { preflight, fixes });
}

export function mapDoctorToAutoConnectReport(
  doctor: McpDoctorReport,
  options: { preflight?: McpAutoConnectPreflightMode; fixes?: McpDoctorFixReport } = {}
): McpAutoConnectReport {
  const preflight = normalizePreflightMode(options.preflight);
  const autoMounted = doctor.servers
    .filter((server) => server.active)
    .map((server) => mapServerToEntry(server));
  const data = summarizeEntries(autoMounted);
  const coreMounted = autoMounted.some((entry) => entry.name === "omk-project" && entry.status !== "error");
  const ok = doctor.activeScope === "none" ? true : coreMounted;
  return {
    command: "mcp connect",
    ok,
    degraded: doctor.errors.length > 0 || doctor.warnings.length > 0 || data.error > 0 || data.warning > 0,
    checkedAt: doctor.checkedAt,
    scope: doctor.activeScope,
    preflight,
    autoMounted,
    sources: doctor.sources.map(mapSourceReport),
    errors: doctor.errors.map(maskSensitiveText),
    warnings: doctor.warnings.map(maskSensitiveText),
    fixes: options.fixes,
    data,
  };
}

export function renderMcpAutoConnectBanner(report: McpAutoConnectReport): string {
  return renderMcpAutoConnectLines(report).join("\n");
}

export function renderMcpAutoConnectLines(report: McpAutoConnectReport): string[] {
  const modeLabel = report.preflight === "full" ? "full/preflight" : report.preflight === "fast" ? "fast/offline" : "off/offline";
  const statusLabel = !report.ok ? "error" : report.degraded ? "ready with optional warnings" : "ready";
  const lines = [
    style.purpleBold("MCP Tool Plane"),
    [
      `MCP: ${report.scope} scope`,
      `${report.data.active} active`,
      `${report.data.ready + report.data.mounted} ready`,
      `${report.data.warning} warning`,
      `${report.data.error} error`,
      modeLabel,
    ].join(" · "),
    `Status: ${statusLabel}`,
  ];

  if (report.autoMounted.length === 0) {
    lines.push("  no active MCP servers; run `omk mcp connect --fix` to create project-local MCP config");
    return lines;
  }

  for (const entry of report.autoMounted.slice(0, 6)) {
    lines.push(formatAutoConnectEntry(entry));
  }
  if (report.autoMounted.length > 6) {
    lines.push(`  … ${report.autoMounted.length - 6} more active MCP server(s); run \`omk mcp connect --json\``);
  }

  const hasVirtualProjectMcp = report.autoMounted.some((entry) => entry.name === "omk-project" && entry.source === "builtin");
  if (hasVirtualProjectMcp) {
    lines.push("  Offline snapshot only; no MCP servers were started.");
    lines.push("  Built-in omk-project MCP mounted; full validation: omk mcp doctor && omk mcp connect --all");
  }
  if (report.fixes) {
    const fixMode = report.fixes.dryRun ? "previewed" : report.fixes.changed ? "applied" : "checked";
    lines.push(`  Fixes: ${fixMode} ${report.fixes.actions.length} action(s); ${report.fixes.skipped.length} skipped`);
  }
  if (report.degraded) {
    lines.push("  degraded: optional MCP issues do not block root startup; run `omk mcp connect --fix` or `omk mcp doctor`");
  }
  return lines;
}

export async function mcpConnectCommand(options: { json?: boolean; fix?: boolean; all?: boolean } = {}): Promise<void> {
  const report = await runMcpAutoConnect({
    fix: Boolean(options.fix),
    preflight: options.all ? "full" : "fast",
  });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  console.log(renderMcpAutoConnectBanner(report));
  if (!report.ok) process.exitCode = 1;
}

function normalizePreflightMode(mode: McpAutoConnectPreflightMode | undefined): McpAutoConnectPreflightMode {
  return mode === "full" || mode === "off" || mode === "fast" ? mode : "fast";
}

function buildAutoConnectEnv(
  preflight: McpAutoConnectPreflightMode,
  env: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  if (preflight === "full") {
    return { ...env, OMK_MCP_PREFLIGHT: env.OMK_MCP_PREFLIGHT && env.OMK_MCP_PREFLIGHT !== "off" ? env.OMK_MCP_PREFLIGHT : "warn-skip" };
  }
  return { ...env, OMK_MCP_PREFLIGHT: "off" };
}

function summarizeEntries(entries: McpAutoConnectEntry[]): McpAutoConnectReport["data"] {
  return {
    active: entries.length,
    ready: entries.filter((entry) => entry.status === "ready").length,
    mounted: entries.filter((entry) => entry.status === "mounted").length,
    warning: entries.filter((entry) => entry.status === "warn").length,
    error: entries.filter((entry) => entry.status === "error").length,
  };
}

function mapSourceReport(source: McpDoctorSourceReport): McpAutoConnectSourceReport {
  return {
    path: maskSensitiveText(source.path),
    exists: source.exists,
    active: source.active,
    parsed: source.parsed,
    status: source.status,
  };
}

function mapServerToEntry(server: McpDoctorServerReport): McpAutoConnectEntry {
  const virtualProject = server.name === "omk-project" && server.sources.includes("runtime:auto-injected");
  const statusValue: McpAutoConnectStatus = virtualProject
    ? "mounted"
    : server.status === "ok"
      ? "ready"
      : server.status === "warn"
        ? "warn"
        : "error";
  return {
    name: server.name,
    transport: server.transport,
    source: classifySource(server.activeSources[0] ?? server.sources[0]),
    status: statusValue,
    reason: firstReason(server),
  };
}

function classifySource(source: string | undefined): McpAutoConnectSource {
  if (!source) return "runtime";
  if (source === "runtime:auto-injected") return "builtin";
  const home = getUserHome();
  const globalKimi = join(home, ".kimi", "mcp.json");
  const globalOmk = join(home, ".omk", "mcp.json");
  if (source === globalKimi || source === globalOmk) return "global";
  const root = getProjectRoot();
  const relativeToProject = relative(root, source);
  if (relativeToProject === "" || (!relativeToProject.startsWith("..") && !isAbsolute(relativeToProject))) return "project";
  return "runtime";
}

function firstReason(server: McpDoctorServerReport): string | undefined {
  const check = server.checks.find((item) => item.severity === "error")
    ?? server.checks.find((item) => item.severity === "warn")
    ?? server.checks.find((item) => item.kind === "virtual-runtime-injected")
    ?? server.checks[0];
  return check?.message ? maskSensitiveText(check.message) : undefined;
}

function formatAutoConnectEntry(entry: McpAutoConnectEntry): string {
  const icon = entry.status === "error" ? "✗" : entry.status === "warn" ? "⚠" : "✓";
  const coloredIcon = entry.status === "error" ? style.pink(icon) : entry.status === "warn" ? style.skin(icon) : style.mint(icon);
  const suffix = entry.reason ? ` — ${entry.reason}` : "";
  return `  ${coloredIcon} ${entry.name.padEnd(20)} ${formatStatusLabel(entry.status).padEnd(15)} ${formatSourceLabel(entry.source).padEnd(8)} ${entry.transport}${suffix}`;
}

function formatStatusLabel(status: McpAutoConnectStatus): string {
  switch (status) {
    case "mounted":
      return "Mounted";
    case "ready":
      return "Ready";
    case "warn":
      return "Needs attention";
    case "error":
      return "Error";
  }
}

function formatSourceLabel(source: McpAutoConnectSource): string {
  switch (source) {
    case "builtin":
      return "Built-in";
    case "project":
      return "Project";
    case "global":
      return "Global";
    case "runtime":
      return "Runtime";
  }
}

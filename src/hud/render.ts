import { readdir, readFile, stat as fsStat } from "fs/promises";
import { join } from "path";
import { execFile, execSync } from "child_process";
import { promisify } from "util";
import { getOmkPath, pathExists, getProjectRoot, getRunPath, getRunsDir } from "../util/fs.js";
import { getKimiUsage, type UsageStats } from "../kimi/usage.js";
import { buildUsageViewModel } from "../util/usage-view-model.js";
import { getOmkResourceSettings } from "../util/resource-profile.js";
import { formatBytes } from "../util/output-buffer.js";
import { formatOmkVersionFooter } from "../util/version.js";
import { t } from "../util/i18n.js";
import type { RunCapabilityAssignment, RunState } from "../contracts/orchestration.js";
import type { GoalSpec, GoalEvidence } from "../contracts/goal.js";
import {
  parseRunStateResult,
  buildRunViewModel,
  renderRunSummary,
  sanitizeForDisplay,
  type RunViewModel,
  type RunHealth,
} from "../util/run-view-model.js";
import type { HudTheme } from "./types.js";
import { hudTheme } from "../util/theme.js";

import { loadTodos, type TodoItem } from "../util/todo-sync.js";
import { readSessionMeta, type SessionMeta } from "../util/session.js";

const theme: HudTheme = hudTheme;

const execFileAsync = promisify(execFile);

export interface HudGitChange {
  status: string;
  path: string;
}

export interface HudRunCandidate {
  name: string;
  mtimeMs: number;
  stateUpdatedAtMs: number;
  hasState: boolean;
  hasGoal: boolean;
  hasPlan: boolean;
  schemaVersion?: number;
}

export type HudSection = "run" | "project" | "resources";

export interface HudRenderOptions {
  runId?: string;
  terminalWidth?: number;
  kimiUsage?: UsageStats;
  footerRefreshMs?: number;
  compact?: boolean;
  section?: HudSection;
  fetchQuota?: boolean;
  showHeap?: boolean;
  showDisk?: boolean;
  showUptime?: boolean;
  systemRefreshMs?: number;
  thinking?: import("./types.js").HudThinkingEntry[];
}

export interface HudCommandOptions extends HudRenderOptions {
  watch?: boolean;
  refreshMs?: number;
  clear?: boolean;
  noClear?: boolean;
  alternateScreen?: boolean;
}

interface HudDashboardData {
  vm: RunViewModel;
  stateError: RunViewModel["stateError"];
  gitChangesResult: HudGitChange[] | null;
  gitChanges: HudGitChange[];
  latestRunName: string | null;
  sessionMeta: SessionMeta | null;
  todos: TodoItem[] | null;
  goalTitle: string | null;
}

interface GoalData {
  title: string;
  status?: string;
  requiredTotal: number;
  requiredPassed: number;
  firstUnmet?: { id: string; description: string };
  latestEvidenceAt?: string;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function getDiskUsage(): { used: number; total: number; percent: number } | null {
  try {
    const raw = execSync("df -k .", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"], timeout: 5000 });
    const line = raw.trim().split("\n").pop();
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) return null;
    const total = parseInt(parts[1], 10) * 1024;
    const used = parseInt(parts[2], 10) * 1024;
    const percent = Math.round((used / total) * 100);
    return { used, total, percent };
  } catch {
    return null;
  }
}

export function parseGitStatusPorcelain(output: string): HudGitChange[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const statusCode = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const renamedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() ?? rawPath : rawPath;
      return {
        status: statusCode.trim() || statusCode,
        path: renamedPath.replace(/^"|"$/g, ""),
      };
    });
}

async function getGitChanges(root: string): Promise<HudGitChange[] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
      cwd: root,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });
    return parseGitStatusPorcelain(String(stdout));
  } catch {
    return null;
  }
}

function lineWidth(line: string): number {
  return theme.sanitizeTerminalText(line).length;
}

function blockWidth(block: string): number {
  return Math.max(0, ...block.split("\n").map(lineWidth));
}

function truncateText(value: string, maxLength: number): string {
  const clean = theme.sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
  const chars = [...clean];
  if (chars.length <= maxLength) return clean;
  return `${chars.slice(0, Math.max(1, maxLength - 1)).join("")}…`;
}

function statusRank(statusValue: string): number {
  switch (statusValue) {
    case "running": return 0;
    case "pending": return 1;
    case "blocked": return 2;
    case "failed": return 3;
    case "skipped": return 4;
    case "done": return 5;
    default: return 6;
  }
}

function todoMarker(statusValue: string): string {
  switch (statusValue) {
    case "running": return theme.style.purpleBold("▶");
    case "done": return theme.style.mintBold("✓");
    case "failed": return theme.style.red("✕");
    case "blocked": return theme.style.orange("■");
    case "skipped": return theme.style.gray("⊘");
    default: return theme.style.gray("□");
  }
}

function gitMarker(changeStatus: string): string {
  const normalized = changeStatus.replace(/\s/g, "");
  if (normalized === "??") return theme.style.blue("?");
  if (normalized.includes("D")) return theme.style.red("D");
  if (normalized.includes("A")) return theme.style.mint("A");
  if (normalized.includes("R")) return theme.style.purple("R");
  return theme.style.orange("M");
}

function truncateLine(line: string, maxWidth: number): string {
  const clean = theme.sanitizeTerminalText(line);
  if (clean.length <= maxWidth) return line;
  const visible = clean.slice(0, Math.max(1, maxWidth - 1));
  return visible + "…";
}

function healthColor(health: RunHealth): (s: string) => string {
  switch (health) {
    case "ok": return theme.style.mint;
    case "warn": return theme.style.orange;
    case "blocked": return theme.style.orange;
    case "failed": return theme.style.red;
    default: return theme.style.gray;
  }
}

function formatProviderCounts(metrics: RunViewModel["providerRouting"]): string {
  return Object.entries(metrics.byProvider)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, count]) => `${provider}=${count}`)
    .join(", ");
}

function formatProviderMetricLine(metrics: RunViewModel["providerRouting"]): string | null {
  if (metrics.attempts <= 0) return null;
  const counts = formatProviderCounts(metrics);
  const fallback = metrics.fallbackCount > 0 ? ` · fallback ${metrics.fallbackCount}` : "";
  return `${metrics.attempts} attempt${metrics.attempts === 1 ? "" : "s"}${counts ? ` · ${counts}` : ""}${fallback}`;
}

function formatAssignmentSummary(assignment: RunCapabilityAssignment | undefined, maxItems = 2): string | null {
  if (!assignment) return null;
  const parts = [
    assignment.skills.length > 0 ? `skills:${assignment.skills.slice(0, maxItems).join(",")}` : "",
    assignment.hooks.length > 0 ? `hooks:${assignment.hooks.slice(0, maxItems).join(",")}` : "",
    assignment.mcpServers.length > 0 ? `mcp:${assignment.mcpServers.slice(0, maxItems).join(",")}` : "",
    assignment.tools && assignment.tools.length > 0 ? `tools:${assignment.tools.slice(0, maxItems).join(",")}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? sanitizeForDisplay(parts.join(" ")) : null;
}

function todoItemMarker(statusValue: TodoItem["status"]): string {
  switch (statusValue) {
    case "in_progress": return theme.style.purpleBold("▶");
    case "done": return theme.style.mintBold("✓");
    case "failed": return theme.style.red("✕");
    case "blocked": return theme.style.orange("■");
    case "skipped": return theme.style.gray("⊘");
    case "pending": return theme.style.gray("□");
    default: return theme.style.gray("□");
  }
}

function sessionStatusColor(statusValue: SessionMeta["status"]): (s: string) => string {
  switch (statusValue) {
    case "active": return theme.style.mint;
    case "completed": return theme.style.mintBold;
    case "failed": return theme.style.red;
    case "idle": return theme.style.gray;
    default: return theme.style.gray;
  }
}

function stateErrorRecovery(error: RunViewModel["stateError"], runId: string | null): string {
  switch (error) {
    case "corrupt": return `omk summary-show ${runId ?? "<run-id>"}`;
    case "missing": return `omk run --run-id ${runId ?? "<id>"}`;
    case "invalid":
    case "oldSchema":
      return `omk verify --run ${runId ?? "<run-id>"}`;
    default:
      return "";
  }
}

async function loadGoalData(goalId: string): Promise<GoalData | null> {
  const goalsBase = getOmkPath("goals");
  const goalPath = join(goalsBase, goalId, "goal.json");
  const evidencePath = join(goalsBase, goalId, "evidence.json");

  try {
    const goalContent = await readFile(goalPath, "utf-8");
    const goal = JSON.parse(goalContent) as Partial<GoalSpec>;
    if (!goal || typeof goal !== "object" || !goal.title) return null;

    let evidence: GoalEvidence[] = [];
    try {
      const evContent = await readFile(evidencePath, "utf-8");
      evidence = JSON.parse(evContent) as GoalEvidence[];
    } catch {
      // no evidence file
    }

    const criteria = (goal.successCriteria ?? []).filter((c) => c.requirement === "required");
    const requiredTotal = criteria.length;
    const requiredPassed = criteria.filter((c) =>
      evidence.some((e) => e.criterionId === c.id && e.passed)
    ).length;

    const firstUnmet = criteria.find((c) =>
      !evidence.some((e) => e.criterionId === c.id && e.passed)
    );

    const latestEvidenceAt = evidence.length > 0
      ? evidence.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0].checkedAt
      : undefined;

    return {
      title: goal.title,
      status: goal.status,
      requiredTotal,
      requiredPassed,
      firstUnmet: firstUnmet ? { id: firstUnmet.id, description: firstUnmet.description } : undefined,
      latestEvidenceAt,
    };
  } catch {
    return null;
  }
}

function buildSummaryBar(
  vm: RunViewModel,
  stateError: RunViewModel["stateError"],
  _goalTitle: string | null,
  width: number
): string {
  if (stateError !== "ok") {
    const warning = `⟁ Latest Run state is ${stateError}. Run: ${stateErrorRecovery(stateError, vm.runId)}`;
    return truncateLine(warning, width);
  }

  const summary = renderRunSummary(vm);
  return truncateLine(summary, width);
}

function buildStateErrorPanel(
  stateError: RunViewModel["stateError"],
  runId: string | null
): string {
  const recovery = stateErrorRecovery(stateError, runId);
  const lines = [
    "",
    `  ${theme.style.orangeBold("⟁ State:")} ${theme.style.orange(stateError)}`,
    `  ${theme.style.gray("Suggested recovery:")}`,
    recovery ? `    ${theme.style.cream(recovery)}` : "",
    "",
  ].filter(Boolean);
  return theme.panel(lines, "ROUTE WARNING");
}

function renderNeonControlHeader(runId: string): string {
  const runLabel = theme.style.gray(`run ${truncateText(runId, 28)}`);
  return [
    "",
    theme.style.phosphor("OMK//HUD") + "  " + runLabel,
    theme.style.gray("NEON GRID ONLINE"),
    theme.style.gray("Route agents. Verify evidence. Control the loop."),
    "",
  ].join("\n");
}

export function buildHudSidebar(
  state: RunState | null,
  changes: HudGitChange[],
  options: { maxTodos?: number; maxFiles?: number; viewModel?: RunViewModel; maxWidth?: number; todos?: TodoItem[] | null; thinking?: import("./types.js").HudThinkingEntry[] } = {}
): string {
  const maxTodos = options.maxTodos ?? 9;
  const maxFiles = options.maxFiles ?? 12;
  const lines: string[] = ["", `  ${theme.style.pinkBold("Right Rail")}`];

  const vm = options.viewModel ?? (state ? buildRunViewModel(state) : null);

  const nodes = [...(state?.nodes ?? [])].sort((a, b) => {
    const rank = statusRank(a.status) - statusRank(b.status);
    return rank !== 0 ? rank : a.id.localeCompare(b.id);
  });

  if (vm) {
    lines.push(`  ${theme.style.gray("run")} ${theme.style.creamBold(truncateText(vm.runId ?? "--", 34))}`);
    lines.push(`  ${theme.style.gray("progress")} ${theme.style.mintBold(`${vm.progress.settled}/${vm.progress.total}`)} ${theme.style.gray(`settled, ${vm.progress.running} active`)}`);
    if (vm.progress.skipped > 0) {
      lines.push(`  ${theme.style.gray("skipped")} ${theme.style.gray(`${vm.progress.skipped}`)}`);
    }
    if (vm.health !== "ok") {
      lines.push(`  ${theme.style.gray("health")} ${healthColor(vm.health)(vm.health.toUpperCase())}`);
    }
    if (vm.routeDecision) {
      lines.push(`  ${theme.style.gray("intent")} ${theme.style.cream(truncateText(vm.routeDecision.intent, 28))}`);
      lines.push(`  ${theme.style.gray("mode")} ${theme.style.cream(vm.routeDecision.mode)}`);
    }
    const providerLine = formatProviderMetricLine(vm.providerRouting);
    if (providerLine) {
      lines.push(`  ${theme.style.gray("provider")} ${theme.style.cream(providerLine)}`);
    }
    lines.push("");
  } else if (state) {
    const done = nodes.filter((node) => node.status === "done").length;
    const skipped = nodes.filter((node) => node.status === "skipped").length;
    const failed = nodes.filter((node) => node.status === "failed").length;
    const blocked = nodes.filter((node) => node.status === "blocked").length;
    const active = nodes.filter((node) => node.status === "running").length;
    lines.push(`  ${theme.style.gray("run")} ${theme.style.creamBold(truncateText(state.runId, 34))}`);
    lines.push(`  ${theme.style.gray("progress")} ${theme.style.mintBold(`${done + skipped + failed + blocked}/${nodes.length}`)} ${theme.style.gray(`settled, ${active} active`)}`);
    lines.push("");
  }

  lines.push(`  ${theme.style.pinkBold("TODO")}`);
  if (options.todos) {
    const todos = [...options.todos].sort((a, b) => statusRank(a.status) - statusRank(b.status));
    if (todos.length === 0) {
      lines.push(`  ${theme.style.gray("TODO 없음")}`);
    } else {
      for (const todo of todos.slice(0, maxTodos)) {
        const role = todo.role ? theme.style.gray(`[${truncateText(sanitizeForDisplay(todo.role), 9)}]`) : "";
        const name = truncateText(sanitizeForDisplay(todo.title), 30);
        lines.push(`  ${todoItemMarker(todo.status)} ${role} ${name}`.replace(/\s+/g, " ").trimEnd());
      }
      if (todos.length > maxTodos) {
        lines.push(`  ${theme.style.gray(`… ${todos.length - maxTodos} more todos`)}`);
      }
    }
  } else if (nodes.length === 0) {
    lines.push(`  ${theme.style.gray(t("hud.noActiveRun"))}`);
    lines.push(`  ${theme.style.gray(t("hud.runToSeeTodos"))}`);
  } else {
    for (const node of nodes.slice(0, maxTodos)) {
      const role = theme.style.gray(`[${truncateText(sanitizeForDisplay(node.role), 9)}]`);
      const name = truncateText(sanitizeForDisplay(node.name || node.id), 30);
      lines.push(`  ${todoMarker(node.status)} ${role} ${name}`);
    }
    if (nodes.length > maxTodos) {
      lines.push(`  ${theme.style.gray(`… ${nodes.length - maxTodos} more tasks`)}`);
    }
  }

  if (vm && vm.workers.length > 0) {
    lines.push("", `  ${theme.style.pinkBold("AGENTS")}`);
    for (const worker of vm.workers.slice(0, Math.max(1, Math.min(5, maxTodos)))) {
      const stateTag = worker.state === "running"
        ? theme.style.purple("▶")
        : worker.state === "done"
          ? theme.style.mint("✓")
          : worker.state === "failed"
            ? theme.style.red("✕")
            : worker.state === "skipped"
              ? theme.style.gray("⊘")
              : theme.style.gray("□");
      const live = worker.liveStatus && worker.liveStatus !== worker.state ? theme.style.gray(` ${worker.liveStatus}`) : "";
      lines.push(`  ${stateTag}${live} ${truncateText(sanitizeForDisplay(worker.label), 32)}`);
      const assignment = formatAssignmentSummary(worker.assignment, 1);
      if (assignment) {
        lines.push(`    ${theme.style.gray(truncateText(assignment, 70))}`);
      }
    }
  }

  if (options.thinking && options.thinking.length > 0) {
    lines.push("", `  ${theme.style.pinkBold("THINKING")}`);
    for (const entry of options.thinking.slice(0, 5)) {
      const statusTag = entry.status === "running"
        ? theme.style.purple("▶")
        : entry.status === "done"
          ? theme.style.mint("✓")
          : theme.style.red("✕");
      lines.push(`  ${statusTag} ${truncateText(sanitizeForDisplay(entry.step), 32)} ${theme.style.gray(`[${entry.agentId}]`)}`);
    }
  }

  lines.push("", `  ${theme.style.pinkBold("Changed Files")} ${theme.style.gray(`(${changes.length})`)}`);
  if (changes.length === 0) {
    lines.push(`  ${theme.style.mint("✓")} ${theme.style.gray("clean worktree")}`);
  } else {
    for (const change of changes.slice(0, maxFiles)) {
      lines.push(`  ${gitMarker(change.status)} ${truncateText(change.path, 38)}`);
    }
    if (changes.length > maxFiles) {
      lines.push(`  ${theme.style.gray(`… ${changes.length - maxFiles} more files`)}`);
    }
  }
  lines.push("");

  const contentLines = options.maxWidth
    ? lines.map((l) => truncateLine(l, Math.max(1, options.maxWidth! - 4)))
    : lines;

  return theme.panel(contentLines, "TODO / CHANGED FILES");
}

export function renderHudColumns(mainPanels: string[], sidebar: string, terminalWidth = defaultHudTerminalWidth()): string {
  const left = mainPanels.join("\n\n");
  const leftLines = left.split("\n");
  const rightLines = sidebar.split("\n");
  const leftWidth = blockWidth(left);
  const rightWidth = blockWidth(sidebar);
  const gap = 2;

  if (terminalWidth < 100 || leftWidth + gap + rightWidth > terminalWidth) {
    return `${left}\n\n${sidebar}`;
  }

  const panelWidth = Math.floor((terminalWidth - gap) / 2);
  const height = Math.max(leftLines.length, rightLines.length);
  const output: string[] = [];
  for (let i = 0; i < height; i += 1) {
    const leftLine = leftLines[i] ?? "";
    const rightLine = rightLines[i] ?? "";
    output.push(`${theme.padEndAnsi(leftLine, panelWidth)}${" ".repeat(gap)}${theme.padEndAnsi(rightLine, panelWidth)}`.trimEnd());
  }
  return output.join("\n");
}

function defaultHudTerminalWidth(): number {
  const stdoutWidth = process.stdout.columns;
  if (typeof stdoutWidth === "number" && stdoutWidth > 0) return stdoutWidth;
  const envWidth = Number.parseInt(process.env.COLUMNS ?? "", 10);
  return Number.isFinite(envWidth) && envWidth > 0 ? envWidth : 120;
}

export function renderHudColumnsWithDetectedWidth(mainPanels: string[], sidebar: string): string {
  return renderHudColumns(mainPanels, sidebar, defaultHudTerminalWidth());
}

export function normalizeRefreshMs(refreshMs: number | undefined): number {
  if (refreshMs === undefined) return 2_000;
  if (!Number.isFinite(refreshMs)) return 2_000;
  return Math.min(60_000, Math.max(250, Math.round(refreshMs)));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHudFooter(refreshMs?: number): string {
  const footerLines = [
    theme.separator(50),
    theme.style.mint(t("hud.hint")) + "  " + theme.style.gray("omk chat") + " " + t("hud.interactive") + "  |  " + theme.style.gray("omk plan") + " " + t("hud.plan") + "  |  " + theme.style.gray("omk run") + " " + t("hud.execute") + "  |  " + theme.style.gray("omk merge") + " " + t("hud.merge"),
  ];
  if (refreshMs) {
    footerLines.push(theme.style.gray(t("hud.liveRefresh", refreshMs)));
  }
  footerLines.push(theme.style.gray("  " + formatOmkVersionFooter()), theme.separator(50));
  return footerLines.join("\n");
}

export function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

export function enterAlternateScreen(): void {
  process.stdout.write("\x1b[?1049h");
}

export function leaveAlternateScreen(): void {
  process.stdout.write("\x1b[?1049l");
}

function runCandidateScore(candidate: HudRunCandidate): number {
  let score = 0;
  if (candidate.schemaVersion === 1) score += 1;
  if (candidate.name === "latest") score -= 8;
  return score;
}

export function selectLatestRunName(candidates: HudRunCandidate[]): string | null {
  const valid = candidates.filter((candidate) => candidate.hasState || candidate.hasGoal || candidate.hasPlan);
  if (valid.length === 0) return null;

  return [...valid]
    .sort((a, b) => {
      const activity = (b.stateUpdatedAtMs ?? b.mtimeMs ?? 0) - (a.stateUpdatedAtMs ?? a.mtimeMs ?? 0);
      if (activity !== 0) return activity;
      const mtime = b.mtimeMs - a.mtimeMs;
      if (mtime !== 0) return mtime;
      const score = runCandidateScore(b) - runCandidateScore(a);
      if (score !== 0) return score;
      return b.name.localeCompare(a.name);
    })[0].name;
}

export async function listRunCandidates(runsDir: string): Promise<HudRunCandidate[]> {
  const entries = await readdir(runsDir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());
  return Promise.all(dirs.map(async (entry) => {
    const runDir = join(runsDir, entry.name);
    const info = await fsStat(runDir).catch(() => null);
    const statePath = getRunPath(entry.name, "state.json");
    const [hasState, hasGoal, hasPlan] = await Promise.all([
      pathExists(statePath),
      pathExists(getRunPath(entry.name, "goal.md")),
      pathExists(getRunPath(entry.name, "plan.md")),
    ]);
    let schemaVersion: number | undefined;
    let stateUpdatedAtMs = info?.mtimeMs ?? 0;
    if (hasState) {
      try {
        const stateContent = await readFile(statePath, "utf-8");
        const parsed = JSON.parse(stateContent) as { schemaVersion?: number; updatedAt?: string };
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.schemaVersion === "number") {
            schemaVersion = parsed.schemaVersion;
          }
          if (typeof parsed.updatedAt === "string") {
            const parsedTime = Date.parse(parsed.updatedAt);
            if (!Number.isNaN(parsedTime)) {
              stateUpdatedAtMs = parsedTime;
            }
          }
        }
      } catch {
        // ignore parse errors; fall back to directory mtime
      }
      if (stateUpdatedAtMs === (info?.mtimeMs ?? 0)) {
        try {
          const stateStat = await fsStat(statePath);
          stateUpdatedAtMs = stateStat.mtimeMs;
        } catch {
          // ignore
        }
      }
    }
    return {
      name: entry.name,
      mtimeMs: info?.mtimeMs ?? 0,
      stateUpdatedAtMs,
      hasState,
      hasGoal,
      hasPlan,
      schemaVersion,
    };
  }));
}

let cachedSystemPanel: string | undefined;
let cachedSystemPanelTime = 0;

async function buildSystemPanel(options: HudRenderOptions = {}): Promise<string> {
  const now = Date.now();
  const refreshMs = options.systemRefreshMs ?? 5000;
  if (cachedSystemPanel && now - cachedSystemPanelTime < refreshMs) {
    return cachedSystemPanel;
  }

  const usage = theme.getSystemUsage();
  const disk = options.showDisk !== false ? getDiskUsage() : null;
  const resources = await getOmkResourceSettings();

  const sysLines: string[] = [
    "",
    theme.gauge("CPU Load", usage.cpuPercent, 100, 20),
    theme.gauge("Memory  ", usage.memPercent, 100, 20),
    disk ? theme.gauge("Disk    ", disk.percent, 100, 20) : "",
    "",
    theme.stat("Load Avg", usage.loadAvg.map((v) => v.toFixed(2)).join(", "), ""),
    theme.stat("Memory", `${usage.memUsedGB} / ${usage.memTotalGB}`, " GB"),
    options.showHeap !== false ? theme.stat("Heap", `${usage.heapUsedMB} / ${usage.heapTotalMB}`, " MB") : "",
    options.showHeap !== false ? theme.stat("Heap Ext", `${usage.heapExternalMB}`, " MB") : "",
    theme.stat("Event Loop", `${usage.eventLoopLagMs.toFixed(1)}`, " ms"),
    theme.stat("OMK Buffer", formatBytes(resources.shellMaxBufferBytes), ""),
    disk ? theme.stat("Disk", `${(disk.used / 1024 / 1024 / 1024).toFixed(1)} / ${(disk.total / 1024 / 1024 / 1024).toFixed(1)}`, " GB") : "",
    options.showUptime !== false ? theme.stat("Uptime", formatUptime(usage.uptimeSeconds), "") : "",
    "",
  ].filter(Boolean);

  const result = theme.panel(sysLines, "RUNTIME");
  cachedSystemPanel = result;
  cachedSystemPanelTime = now;
  return result;
}

async function buildContextUsagePanel(kimiUsage?: UsageStats, fetchQuota = true): Promise<string> {
  const usage = kimiUsage ?? await getKimiUsage({ fetchQuota });
  const LIMIT_HOURS = 5;
  const limitSeconds = LIMIT_HOURS * 3600;
  const vm = buildUsageViewModel(usage);

  const fiveHourGaugePercent = vm.fiveHour.percent ??
    Math.min(100, Math.round((usage.totalSecondsLast5Hours / limitSeconds) * 100));
  const weekGaugePercent = vm.weekly.percent ??
    Math.min(100, Math.round((usage.totalSecondsWeek / (limitSeconds * 7)) * 100));

  const loginLine = vm.source === "missingAuth"
    ? theme.stat("OAuth Login", "login required; showing local sessions only", "")
    : theme.stat("OAuth Login", `${vm.accountLabel} (${vm.authStatus})`, "");

  const planLines: string[] = [
    "",
    theme.gauge("5h Window", fiveHourGaugePercent, 100, 20),
    theme.gauge("This Week", weekGaugePercent, 100, 20),
    "",
    loginLine,
    theme.stat("5h Usage", vm.fiveHour.label, ""),
    theme.stat("5h Sessions", `${usage.sessionCountLast5Hours}`, ""),
    theme.stat("Today Used", vm.today.label, ""),
    theme.stat("Today Sessions", `${vm.today.sessionCount}`, ""),
    theme.stat("Week Usage", vm.weekly.label, ""),
    theme.stat("Week Sessions", `${usage.sessionCountWeek}`, ""),
    vm.error ? theme.stat("Quota Source", `local fallback (${vm.error})`, "") : "",
    "",
  ].filter(Boolean);

  return theme.panel(planLines, "CONTEXT");
}

async function buildProjectStatusPanel(gitChangesResult: HudGitChange[] | null): Promise<string> {
  const root = getProjectRoot();
  const gitChanges = gitChangesResult ?? [];
  const projLines: string[] = [""];

  projLines.push(
    `  ${theme.style.purple("◇ Git")}      ${gitChangesResult === null ? theme.status.warn("unavailable") : gitChanges.length === 0 ? theme.status.ok("clean") : theme.status.warn(`${gitChanges.length} changes`)}`
  );

  const [omkExists, agentsMdExists, designMdExists] = await Promise.all([
    pathExists(join(root, ".omk")),
    pathExists(join(root, "AGENTS.md")),
    pathExists(join(root, "DESIGN.md")),
  ]);
  projLines.push(`  ${theme.style.purple("▣ OMK")}      ${omkExists ? theme.status.ok("initialized") : theme.status.warn("omk init needed")}`);
  projLines.push(`  ${theme.style.purple("✎ AGENTS")}   ${agentsMdExists ? theme.status.ok("exists") : theme.status.warn("missing")}`);
  projLines.push(`  ${theme.style.purple("◇ DESIGN")}   ${designMdExists ? theme.status.ok("exists") : theme.status.info("optional")}`);

  projLines.push("");
  return theme.panel(projLines, "PROJECT");
}

function workerLiveness(ageMs?: number): { label: string; color: (s: string) => string } {
  if (ageMs === undefined) return { label: "active", color: theme.style.mint };
  if (ageMs > 180_000) return { label: "stale", color: theme.style.red };
  if (ageMs > 90_000) return { label: "quiet", color: theme.style.orange };
  if (ageMs > 30_000) return { label: "slow", color: theme.style.cream };
  return { label: "active", color: theme.style.mint };
}

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function buildLatestRunPanel(
  options: HudRenderOptions,
  vm: RunViewModel,
  stateError: RunViewModel["stateError"],
  _gitChanges: HudGitChange[],
  maxWidth?: number,
  sessionMeta?: SessionMeta | null,
  todos?: TodoItem[] | null,
): Promise<string> {
  const runsDir = getRunsDir();
  let runLines: string[] = [];

  if (await pathExists(runsDir)) {
    let latestRunName: string | null = options?.runId ?? null;

    if (!latestRunName) {
      const runCandidates = await listRunCandidates(runsDir);
      latestRunName = selectLatestRunName(runCandidates);
    }

    if (latestRunName) {
      let goalTitle: string | null = null;
      let goalData: GoalData | null = null;

      if (vm.runId && stateError === "ok") {
        try {
          const stateContent = await readFile(getRunPath(latestRunName, "state.json"), "utf-8");
          const { state } = parseRunStateResult(stateContent);
          if (state?.goal?.title) {
            goalTitle = state.goal.title;
          }
          if (state?.goalId) {
            goalData = await loadGoalData(state.goalId);
            if (goalData) goalTitle = goalData.title;
          }
          if (!goalData && state?.goalSnapshot?.title) {
            goalTitle = state.goalSnapshot.title;
          }
        } catch {
          // ignore
        }
      }

      const [goalMd, plan] = await Promise.all([
        readFile(getRunPath(latestRunName, "goal.md"), "utf-8").catch(() => null),
        readFile(getRunPath(latestRunName, "plan.md"), "utf-8").catch(() => null),
      ]);

      if (!goalTitle && goalMd) {
        goalTitle = goalMd.replace(/# Goal\n\n?/, "").split("\n")[0].trim();
      }
      if (!goalTitle) goalTitle = "N/A";

      const staleWorkers = vm.workers.filter((w) => w.state === "running" && (w.lastActivityAgeMs ?? 0) > 90_000).length;
      const chatBadge = sessionMeta?.type === "chat" ? ` ${theme.style.cream("◌ Chat")}` : "";
      const providerLine = formatProviderMetricLine(vm.providerRouting);
      runLines = [
        "",
        `  ${theme.style.gray("Run:")}    ${theme.style.creamBold(latestRunName)}${chatBadge}`,
        `  ${theme.style.gray("Goal:")}    ${theme.style.cream(goalTitle)}`,
        `  ${theme.style.gray("Health:")}  ${healthColor(vm.health)(vm.health.toUpperCase())}`,
        `  ${theme.style.gray("Progress:")} ${theme.style.mintBold(`${vm.progress.settled}/${vm.progress.total}`)} ${theme.style.gray(`(${vm.progress.percent}%)`)}`,
      ];
      if (vm.routeDecision) {
        const requiredEvidence = vm.routeDecision.requiredEvidence
          .filter((item) => item.required)
          .map((item) => item.kind)
          .join(",");
        runLines.push(`  ${theme.style.gray("Intent:")}  ${theme.style.cream(vm.routeDecision.intent)}`);
        runLines.push(`  ${theme.style.gray("Mode:")}    ${theme.style.cream(vm.routeDecision.mode)}`);
        if (requiredEvidence) {
          runLines.push(`  ${theme.style.gray("Evidence:")} ${theme.style.cream(requiredEvidence)}`);
        }
      }
      if (providerLine) {
        runLines.push(`  ${theme.style.gray("Provider:")} ${theme.style.cream(providerLine)}`);
      }
      if (vm.eta) {
        runLines.push(`  ${theme.style.gray("ETA:")}     ${theme.style.cream(vm.eta)}`);
      }
      if (staleWorkers > 0) {
        runLines.push(`  ${theme.style.gray("Stale:")}   ${theme.style.redBold(`${staleWorkers} worker${staleWorkers > 1 ? "s" : ""}`)}`);
      }
      if (sessionMeta) {
        const statusColor = sessionStatusColor(sessionMeta.status);
        runLines.push(`  ${theme.style.gray("Session:")} ${statusColor(sessionMeta.status.toUpperCase())}`);
        if (sessionMeta.todoCount > 0) {
          runLines.push(`  ${theme.style.gray("Todos:")}   ${theme.style.mintBold(`${sessionMeta.todoDoneCount}/${sessionMeta.todoCount}`)} ${theme.style.gray("completed")}`);
        }
      }
      runLines.push("");

      if (goalData) {
        if (goalData.status) {
          runLines.push(`  ${theme.style.gray("Goal Status:")} ${theme.style.creamBold(goalData.status)}`);
        }
        if (goalData.requiredTotal > 0) {
          runLines.push(`  ${theme.style.gray("Criteria:")}   ${theme.style.mintBold(`${goalData.requiredPassed}/${goalData.requiredTotal}`)} ${theme.style.gray("required passed")}`);
        }
        if (goalData.firstUnmet) {
          runLines.push(`  ${theme.style.gray("Next Up:")}    ${theme.style.orange(truncateText(goalData.firstUnmet.description, 50))}`);
        }
        runLines.push("");
      } else if (vm.goalTitle) {
        if (vm.goalScore != null) {
          runLines.push(`  ${theme.style.gray("Score:")}     ${theme.style.mintBold(`${vm.goalScore}%`)}`);
        }
        runLines.push("");
      }

      if (vm.teamRuntime) {
        const team = vm.teamRuntime;
        const presentWindows = team.windows.filter((w) => w.status === "present").length;
        const missingWindows = team.windows.filter((w) => w.status === "missing").length;
        runLines.push(`  ${theme.style.pinkBold("Team Runtime")}`);
        runLines.push(`    ${theme.style.gray("session")} ${theme.style.cream(team.session)} ${theme.style.gray("status")} ${healthColor(missingWindows > 0 ? "warn" : "ok")(team.status)}`);
        runLines.push(`    ${theme.style.gray("windows")} ${theme.style.mintBold(`${presentWindows}/${team.windows.length}`)} ${theme.style.gray(`present · workers ${team.workerCount} · reviewer ${team.reviewerCount}`)}`);
        if (team.coordinatorPanes > 0) {
          runLines.push(`    ${theme.style.gray("coordinator panes")} ${theme.style.mint(String(team.coordinatorPanes))}`);
        }
        if (missingWindows > 0) {
          runLines.push(`    ${theme.style.orange(`${missingWindows} expected window(s) missing`)}`);
        }
        runLines.push("");
      }

      // ── Worker table ──
      if (vm.workers.length > 0) {
        runLines.push(`  ${theme.style.pinkBold("Workers")}`);
        for (const w of vm.workers) {
          const live = workerLiveness(w.lastActivityAgeMs);
          const stateTag = w.state === "running"
            ? `${live.color("▶")} ${live.color(w.state)}`
            : w.state === "done"
            ? `${theme.style.mintBold("✓")} ${theme.style.mint(w.state)}`
            : w.state === "failed"
            ? `${theme.style.red("✕")} ${theme.style.red(w.state)}`
            : w.state === "skipped"
            ? `${theme.style.gray("⊘")} ${theme.style.gray(w.state)}`
            : `${theme.style.gray("□")} ${theme.style.gray(w.state)}`;
          const elapsed = w.elapsedMs > 0 ? theme.style.gray(` · ${formatDurationMs(w.elapsedMs)}`) : "";
          const activity = w.lastActivityAgeMs != null
            ? theme.style.gray(` · activity ${formatDurationMs(w.lastActivityAgeMs)} ago`)
            : "";
          const phaseLine = w.phase ? theme.style.gray(` · ${truncateText(w.phase, 50)}`) : "";
          runLines.push(`    ${stateTag}${elapsed}${activity}${phaseLine}`);
          runLines.push(`      ${theme.style.gray(truncateText(w.label, 40))}`);
          const assignment = formatAssignmentSummary(w.assignment);
          if (assignment) {
            runLines.push(`      ${theme.style.gray(truncateText(assignment, 58))}`);
          }
        }
        runLines.push("");
      }

      if (vm.blocker) {
        runLines.push(`  ${theme.style.redBold("Blocker:")} ${theme.style.red(vm.blocker.reason)}`);
        runLines.push(`  ${theme.style.gray("Action:")}  ${theme.style.cream(vm.blocker.nextAction)}`);
        runLines.push("");
      } else if (vm.nextAction && vm.nextAction !== "Ready") {
        runLines.push(`  ${theme.style.gray("Next:")}    ${theme.style.cream(vm.nextAction)}`);
        runLines.push("");
      }

      if (plan) {
        runLines.push(`  ${theme.style.gray("Plan:")}    ${theme.style.mint("✔ generated")}`);
        runLines.push("");
      }

      if (!options.compact && todos && todos.length > 0) {
        runLines.push(`  ${theme.style.pinkBold("TODOs")}`);
        for (const todo of todos.slice(0, 5)) {
          const marker = todoItemMarker(todo.status);
          const title = truncateText(todo.title, 50);
          runLines.push(`    ${marker} ${title}`);
        }
        if (todos.length > 5) {
          runLines.push(`    ${theme.style.gray(`… ${todos.length - 5} more`)}`);
        }
        runLines.push("");
      }
    }
  }

  if (runLines.length === 0) {
    runLines = ["", `  ${theme.style.gray(t("hud.noRunHistory"))}`, ""];
  }

  if (maxWidth) {
    const contentMaxWidth = Math.max(1, maxWidth - 4);
    runLines = runLines.map((l) => truncateLine(l, contentMaxWidth));
  }

  return theme.panel(runLines, "LATEST RUN");
}

async function fetchHudDashboardData(options: HudRenderOptions): Promise<HudDashboardData> {
  const root = getProjectRoot();
  const gitChangesResult = await getGitChanges(root);
  const gitChanges = gitChangesResult ?? [];

  const runsDir = getRunsDir();
  let vm: RunViewModel = buildRunViewModel(null);
  let stateError: RunViewModel["stateError"] = "missing";
  let latestRunName: string | null = options.runId ?? null;

  if (await pathExists(runsDir)) {
    if (!latestRunName) {
      const candidates = await listRunCandidates(runsDir);
      latestRunName = selectLatestRunName(candidates);
    }
    if (latestRunName) {
      const stateContent = await readFile(getRunPath(latestRunName, "state.json"), "utf-8").catch(() => null);
      if (stateContent) {
        const result = parseRunStateResult(stateContent);
        stateError = result.error;
        vm = buildRunViewModel(result.state, { changedFiles: gitChanges.map((c) => c.path) });
      }
    }
  }

  let sessionMeta: SessionMeta | null = null;
  let todos: TodoItem[] | null = null;
  if (latestRunName) {
    sessionMeta = await readSessionMeta(latestRunName).catch(() => null);
    todos = await loadTodos(latestRunName).catch(() => null);
  }

  return {
    vm,
    stateError,
    gitChangesResult,
    gitChanges,
    latestRunName,
    sessionMeta,
    todos,
    goalTitle: vm.goalTitle ?? null,
  };
}

function buildHudHeader(
  options: HudRenderOptions,
  vm: RunViewModel,
  stateError: RunViewModel["stateError"],
  goalTitle: string | null
): string {
  const width = options.terminalWidth ?? defaultHudTerminalWidth();
  const lines: string[] = [];
  lines.push(renderNeonControlHeader(options.runId ?? "omk"));
  lines.push(buildSummaryBar(vm, stateError, goalTitle, width - 4));
  lines.push("");
  return lines.join("\n");
}

async function renderCompactDashboard(options: HudRenderOptions): Promise<string> {
  const data = await fetchHudDashboardData(options);
  const { vm, stateError, gitChanges, latestRunName, sessionMeta, todos, goalTitle } = data;
  const width = options.terminalWidth ?? defaultHudTerminalWidth();
  const effectiveWidth = Math.max(40, width - 4);
  const output: string[] = [];

  output.push(buildHudHeader(options, vm, stateError, goalTitle));
  output.push(await buildSystemPanel(options));

  const runPanel = await buildLatestRunPanel(options, vm, stateError, gitChanges, effectiveWidth, sessionMeta, todos);
  output.push(runPanel);
  output.push("");

  if (stateError !== "ok" && latestRunName) {
    output.push(buildStateErrorPanel(stateError, latestRunName));
    output.push("");
  }

  const sidebar = buildHudSidebar(null, gitChanges, { viewModel: vm, maxWidth: effectiveWidth, todos, thinking: options.thinking });
  output.push(sidebar);
  output.push("");

  output.push(buildHudFooter(options.footerRefreshMs));
  output.push("");
  return output.join("\n");
}

async function renderMediumDashboard(options: HudRenderOptions): Promise<string> {
  const data = await fetchHudDashboardData(options);
  const { vm, stateError, gitChangesResult, gitChanges, latestRunName, sessionMeta, todos, goalTitle } = data;
  const width = options.terminalWidth ?? defaultHudTerminalWidth();
  const mainPanels: string[] = [];
  const output: string[] = [];

  output.push(buildHudHeader(options, vm, stateError, goalTitle));

  mainPanels.push(await buildProjectStatusPanel(gitChangesResult));
  mainPanels.push(await buildLatestRunPanel(options, vm, stateError, gitChanges, undefined, sessionMeta, todos));

  if (stateError !== "ok" && latestRunName) {
    mainPanels.push(buildStateErrorPanel(stateError, latestRunName));
  }

  const sidebar = buildHudSidebar(null, gitChanges, { viewModel: vm, todos, thinking: options.thinking });
  output.push(renderHudColumns(mainPanels, sidebar, width));
  output.push("");

  output.push(buildHudFooter(options.footerRefreshMs));
  output.push("");
  return output.join("\n");
}

async function renderFullDashboard(options: HudRenderOptions): Promise<string> {
  const data = await fetchHudDashboardData(options);
  const { vm, stateError, gitChangesResult, gitChanges, latestRunName, sessionMeta, todos, goalTitle } = data;
  const width = options.terminalWidth ?? defaultHudTerminalWidth();
  const mainPanels: string[] = [];
  const output: string[] = [];

  output.push(buildHudHeader(options, vm, stateError, goalTitle));

  mainPanels.push(await buildSystemPanel(options));
  mainPanels.push(await buildContextUsagePanel(options.kimiUsage, options.fetchQuota ?? true));
  mainPanels.push(await buildProjectStatusPanel(gitChangesResult));
  mainPanels.push(await buildLatestRunPanel(options, vm, stateError, gitChanges, undefined, sessionMeta, todos));

  if (stateError !== "ok" && latestRunName) {
    mainPanels.push(buildStateErrorPanel(stateError, latestRunName));
  }

  const sidebar = buildHudSidebar(null, gitChanges, { viewModel: vm, todos, thinking: options.thinking });
  output.push(renderHudColumns(mainPanels, sidebar, width));
  output.push("");

  output.push(buildHudFooter(options.footerRefreshMs));
  output.push("");
  return output.join("\n");
}

async function renderSectionDashboard(options: HudRenderOptions): Promise<string> {
  const data = await fetchHudDashboardData(options);
  const { vm, stateError, gitChangesResult, gitChanges, latestRunName, sessionMeta, todos, goalTitle } = data;
  const output: string[] = [];

  output.push(buildHudHeader(options, vm, stateError, goalTitle));

  switch (options.section) {
    case "run": {
      const runPanel = await buildLatestRunPanel(options, vm, stateError, gitChanges, undefined, sessionMeta, todos);
      output.push(runPanel);
      output.push("");
      if (stateError !== "ok" && latestRunName) {
        output.push(buildStateErrorPanel(stateError, latestRunName));
        output.push("");
      }
      const sidebar = buildHudSidebar(null, gitChanges, { viewModel: vm, todos, thinking: options.thinking });
      output.push(sidebar);
      break;
    }
    case "project": {
      output.push(await buildProjectStatusPanel(gitChangesResult));
      break;
    }
    case "resources": {
      output.push(await buildSystemPanel(options));
      output.push("");
      output.push(await buildContextUsagePanel(options.kimiUsage, options.fetchQuota ?? true));
      break;
    }
  }

  output.push("");
  output.push(buildHudFooter(options.footerRefreshMs));
  output.push("");
  return output.join("\n");
}

export async function renderHudDashboard(options: HudRenderOptions = {}): Promise<string> {
  const width = options.terminalWidth ?? defaultHudTerminalWidth();

  if (options.section) {
    return renderSectionDashboard(options);
  }

  if (options.compact || width < 90) {
    return renderCompactDashboard(options);
  }

  if (width < 120) {
    return renderMediumDashboard(options);
  }

  return renderFullDashboard(options);
}

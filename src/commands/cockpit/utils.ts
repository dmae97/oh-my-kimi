/**
 * OMK Chat Cockpit — shared helpers, types, and resource collection.
 */

import { readFile, readdir } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import {
  getProjectRootAsync,
  getUserHome,
  pathExists,
  getRunPath,
} from "../../util/fs.js";
import {
  type RunViewModel,
  type RunHealth,
  type RunViewModelWorker,
} from "../../util/run-view-model.js";
import { getKimiUsage } from "../../kimi/usage.js";
import { loadTodos, type TodoItem } from "../../util/todo-sync.js";
import { getSystemUsage, sanitizeTerminalText } from "../../util/theme.js";
import { checkDeepSeekBalance } from "../../providers/deepseek/deepseek-balance.js";
import {
  getDeepSeekProviderStatus,
  resolveDeepSeekApiKey,
} from "../../providers/deepseek/deepseek-config.js";
import { loadMergedMcpConfig } from "../../orchestration/routing/mcp-config.js";
import { type TelemetryEvent } from "../../util/events-logger.js";
import { parseGitStatusPorcelain } from "../hud.js";

const execFileAsync = promisify(execFile);

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
  ]);
}

export interface CockpitCommandOptions {
  runId?: string;
  watch?: boolean;
  refreshMs?: number;
  height?: number;
  redraw?: "diff" | "full" | "append";
  section?: "agents" | "todos" | "mcp" | "all";
  events?: "on" | "off";
  view?: "panel" | "rail" | "compact" | "json";
}

export interface CockpitRenderOptions {
  runId?: string;
  terminalWidth?: number;
  cache?: CockpitCache;
  quick?: boolean;
  showHistory?: boolean;
  height?: number;
  resourceProvider?: () => Promise<CockpitResourceSnapshot | null>;
  deepSeekProvider?: () => Promise<CockpitDeepSeekSnapshot | null>;
  section?: "agents" | "todos" | "mcp" | "all";
  events?: "on" | "off";
  view?: "panel" | "rail" | "compact" | "json";
}

// ── Cache types ──

interface CacheEntry<T> {
  value: T;
  ts: number;
}

export interface CockpitCache {
  stateTodos?: CacheEntry<Awaited<ReturnType<typeof loadTodos>> | null>;
  gitChanges?: CacheEntry<{ status: string; path: string }[] | null>;
  history?: CacheEntry<string[]>;
  primaryUsage?: CacheEntry<NonNullable<Awaited<ReturnType<typeof getKimiUsage>>> | null>;
  systemUsage?: CacheEntry<ReturnType<typeof getSystemUsage>>;
  resources?: CacheEntry<CockpitResourceSnapshot | null>;
  deepSeek?: CacheEntry<CockpitDeepSeekSnapshot | null>;
  events?: CacheEntry<TelemetryEvent[]>;
}

export interface CockpitResourceEntry {
  name: string;
  source: "project" | "global" | "builtin" | "run";
  status?: "connected" | "connecting" | "failed" | "unknown";
  toolsCount?: number;
  reason?: string;
}

export interface CockpitResourceSnapshot {
  scope: "run" | "all";
  mcpServers: CockpitResourceEntry[];
  skills: CockpitResourceEntry[];
  hooks: CockpitResourceEntry[];
  checkedAt: number;
}

export interface CockpitDeepSeekBalanceLine {
  currency: string;
  total: string;
  granted: string;
  toppedUp: string;
}

export interface CockpitDeepSeekSnapshot {
  enabled: boolean;
  apiKeySet: boolean;
  apiKeySource?: string;
  available: boolean;
  reason?: string;
  balances: CockpitDeepSeekBalanceLine[];
  checkedAt: number;
}

export interface CockpitDeepSeekRunUsage {
  attempts: number;
  fallbackCount: number;
  directCount: number;
  advisoryCount: number;
  byModel: Record<string, number>;
  byTier: Record<string, number>;
}

export interface CockpitDeepSeekRequest {
  nodeId: string;
  role: string;
  kind: "direct" | "advisory" | "fallback";
  tier?: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  durationMs?: number;
}

export interface CockpitDashboardSnapshot {
  pulse: {
    runId: string | null;
    type: "chat" | "run" | "--";
    health: RunHealth;
    elapsed: string;
    activeLane: string | null;
    lastActivity: string | null;
    blocker: { reason: string; nodeId: string } | null;
    eta: string | null;
    goalTitle: string | null;
    goalScore: number | null;
    nextAction: string | null;
    etaConfidence: "low" | "medium" | "high" | null;
  };
  workQueue: {
    todosDone: number;
    todosTotal: number;
    activeItems: Array<{ title: string; status: string; agent?: string }>;
    blockedItems: Array<{ title: string; status: string }>;
    workerCounts: {
      running: number;
      done: number;
      failed: number;
      blocked: number;
      skipped: number;
      settled: number;
      total: number;
    };
    workers: RunViewModelWorker[];
    todos: TodoItem[];
  };
  runtimeContract: {
    mcpCount: number;
    skillCount: number;
    hookCount: number;
    scope: string;
    workerCap: number | null;
    maxStepsPerTurn: number | null;
    gateCount: number;
  } | null;
  evidence: {
    failedGates: number;
    skippedGates: number;
    latestVerification: string | null;
  };
  providers: {
    primary: {
      source: string;
      status: string;
      account: string;
      fiveHour: string;
      weekly: string;
    } | null;
    deepSeek: {
      status: string;
      balance: string;
      snapshot: CockpitDeepSeekSnapshot | null;
    };
  };
  resources: CockpitResourceSnapshot | null;
  deepSeekUsage: CockpitDeepSeekRunUsage;
  deepSeekRequests: CockpitDeepSeekRequest[];
  worktree: {
    totalChanged: number;
    counts: { M: number; A: number; D: number; "?": number; R: number };
    topPaths: string[];
    changes: { status: string; path: string }[];
  };
  system: {
    cpuPercent: number | null;
    memPercent: number | null;
    workerBudget: number | null;
  };
  stateError: RunViewModel["stateError"];
  latestRunName: string | null;
}

// ── Constants ──

export const PANEL_HORIZONTAL_OVERHEAD = 4;
export const MIN_COCKPIT_FRAME_WIDTH = 20;
export const MAX_COCKPIT_FRAME_WIDTH = 180;

// ── Local helpers ──

export function truncateText(value: string, maxLength: number): string {
  const clean = sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
  if (maxLength <= 0) return "";
  const chars = [...clean];
  if (chars.length <= maxLength) return clean;
  return `${chars.slice(0, Math.max(1, maxLength - 1)).join("")}…`;
}

export function statusRank(statusValue: string): number {
  const normalized = statusValue.toLowerCase();
  switch (normalized) {
    case "running":
    case "in_progress": return 0;
    case "pending": return 1;
    case "blocked": return 2;
    case "failed": return 3;
    case "skipped": return 4;
    case "done":
    case "completed": return 5;
    default: return 6;
  }
}

export function normalizeRefreshMs(refreshMs: number | undefined): number {
  if (refreshMs === undefined) return 2_000;
  if (!Number.isFinite(refreshMs)) return 2_000;
  return Math.min(60_000, Math.max(250, Math.round(refreshMs)));
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "--";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

export function gitStatusPriority(changeStatus: string): number {
  const normalized = changeStatus.replace(/\s/g, "");
  if (normalized === "??") return 3;
  if (normalized.includes("D")) return 2;
  if (normalized.includes("A")) return 1;
  if (normalized.includes("R")) return 4;
  return 0;
}

export async function getGitChanges(root: string): Promise<{ status: string; path: string }[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=normal"],
      { cwd: root, timeout: 5000, maxBuffer: 1024 * 1024, encoding: "utf-8" }
    );
    return parseGitStatusPorcelain(String(stdout));
  } catch {
    return null;
  }
}

// ── Cache helpers ──

export function getCacheEntry<T>(entry: CacheEntry<T> | undefined, ttlMs: number, now: number): T | undefined {
  if (!entry) return undefined;
  if (now - entry.ts > ttlMs) return undefined;
  return entry.value;
}

// ── Resource helpers ──

export async function getCockpitResources(root?: string, runId?: string | null): Promise<CockpitResourceSnapshot> {
  const resolvedRoot = root ?? await getProjectRootAsync();
  const harness = runId ? await readHarnessResources(runId).catch(() => null) : null;
  if (harness) {
    return applyMcpStatus(runId ?? null, harness);
  }
  const [mcp, skills, hooks] = await Promise.all([
    loadMergedMcpConfig(resolvedRoot, "all").catch(() => ({ servers: {}, sources: new Map<string, CockpitResourceEntry["source"]>() })),
    collectSkillEntries(resolvedRoot),
    collectHookEntries(resolvedRoot),
  ]);
  return {
    scope: "all",
    mcpServers: Object.keys(mcp.servers)
      .map((name) => ({ name, source: mcp.sources.get(name) ?? "project", status: "connected" as const }))
      .sort(compareResourceEntries),
    skills,
    hooks,
    checkedAt: Date.now(),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readHarnessResources(runId: string): Promise<CockpitResourceSnapshot | null> {
  const raw = await readFile(getRunPath(runId, "chat-agent-harness.json"), "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) return null;
  const resources = isRecord(parsed.resources) ? parsed.resources : null;
  const active = resources && isRecord(resources.active) ? resources.active : null;
  if (!active) return null;
  return {
    scope: "run",
    mcpServers: normalizeResourceEntries(active.mcp, "run"),
    skills: normalizeResourceEntries(active.skills, "run"),
    hooks: normalizeResourceEntries(active.hooks, "run"),
    checkedAt: Date.now(),
  };
}

function normalizeResourceEntries(value: unknown, source: CockpitResourceEntry["source"]): CockpitResourceEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): CockpitResourceEntry | null => {
      if (typeof entry === "string") {
        return { name: entry, source, status: source === "run" ? "connected" : undefined };
      }
      if (!isRecord(entry)) return null;
      const name = typeof entry.name === "string" ? entry.name : typeof entry.id === "string" ? entry.id : null;
      if (!name) return null;
      const statusValue = typeof entry.status === "string" ? entry.status : undefined;
      const status = statusValue === "connected" || statusValue === "connecting" || statusValue === "failed" || statusValue === "unknown"
        ? statusValue
        : source === "run" ? "connected" : undefined;
      const toolsCount = typeof entry.toolsCount === "number"
        ? entry.toolsCount
        : typeof entry.toolCount === "number"
          ? entry.toolCount
          : Array.isArray(entry.tools)
            ? entry.tools.length
            : undefined;
      return { name, source, status, toolsCount };
    })
    .filter((entry): entry is CockpitResourceEntry => entry !== null)
    .sort(compareResourceEntries);
}

async function applyMcpStatus(runId: string | null, snapshot: CockpitResourceSnapshot): Promise<CockpitResourceSnapshot> {
  if (!runId) return snapshot;
  const statusEntries = await readMcpStatusEntries(runId).catch(() => []);
  if (statusEntries.length === 0) return snapshot;
  const byName = new Map(statusEntries.map((entry) => [entry.name, entry]));
  return {
    ...snapshot,
    mcpServers: snapshot.mcpServers.map((entry) => {
      const live = byName.get(entry.name);
      return live ? { ...entry, status: live.status ?? entry.status, toolsCount: live.toolsCount ?? entry.toolsCount } : entry;
    }),
    checkedAt: Date.now(),
  };
}

async function readMcpStatusEntries(runId: string): Promise<CockpitResourceEntry[]> {
  const raw = await readFile(getRunPath(runId, "mcp-status.json"), "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) return [];
  const servers = parsed.servers ?? parsed.mcpServers;
  if (Array.isArray(servers)) return normalizeResourceEntries(servers, "run");
  if (isRecord(servers)) {
    return Object.entries(servers)
      .map(([name, value]): CockpitResourceEntry => {
        const record = isRecord(value) ? value : {};
        const statusValue = typeof record.status === "string" ? record.status : undefined;
        const status = statusValue === "connected" || statusValue === "connecting" || statusValue === "failed" || statusValue === "unknown"
          ? statusValue
          : "unknown";
        const toolsCount = typeof record.toolsCount === "number"
          ? record.toolsCount
          : typeof record.toolCount === "number"
            ? record.toolCount
            : Array.isArray(record.tools)
              ? record.tools.length
              : undefined;
        return { name, source: "run", status, toolsCount };
      })
      .sort(compareResourceEntries);
  }
  return [];
}

async function collectSkillEntries(root: string): Promise<CockpitResourceEntry[]> {
  return collectNamedDirs([
    { path: join(root, ".agents", "skills"), source: "project" },
    { path: join(root, ".kimi", "skills"), source: "project" },
    { path: join(root, ".omk", "skills"), source: "project" },
    { path: join(getUserHome(), ".codex", "skills"), source: "global" },
    { path: join(getUserHome(), ".agents", "skills"), source: "global" },
    { path: join(getUserHome(), ".kimi", "skills"), source: "global" },
  ], "SKILL.md");
}

async function collectHookEntries(root: string): Promise<CockpitResourceEntry[]> {
  return collectNamedFiles([
    { path: join(root, ".omk", "hooks"), source: "project" },
    { path: join(root, ".kimi", "hooks"), source: "project" },
    { path: join(getUserHome(), ".kimi", "hooks"), source: "global" },
    { path: join(getUserHome(), ".codex", "hooks"), source: "global" },
  ]);
}

async function collectNamedDirs(
  dirs: Array<{ path: string; source: CockpitResourceEntry["source"] }>,
  requiredFile: string
): Promise<CockpitResourceEntry[]> {
  const byName = new Map<string, CockpitResourceEntry>();
  for (const dir of dirs) {
    const entries = await readdir(dir.path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!(await pathExists(join(dir.path, entry.name, requiredFile)))) continue;
      upsertResource(byName, { name: entry.name, source: dir.source });
    }
  }
  return [...byName.values()].sort(compareResourceEntries);
}

async function collectNamedFiles(
  dirs: Array<{ path: string; source: CockpitResourceEntry["source"] }>
): Promise<CockpitResourceEntry[]> {
  const byName = new Map<string, CockpitResourceEntry>();
  for (const dir of dirs) {
    const entries = await readdir(dir.path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || entry.name.endsWith(".sample")) continue;
      upsertResource(byName, { name: entry.name, source: dir.source });
    }
  }
  return [...byName.values()].sort(compareResourceEntries);
}

function upsertResource(byName: Map<string, CockpitResourceEntry>, entry: CockpitResourceEntry): void {
  const current = byName.get(entry.name);
  if (!current || (current.source === "global" && entry.source === "project")) {
    byName.set(entry.name, entry);
  }
}

function compareResourceEntries(a: CockpitResourceEntry, b: CockpitResourceEntry): number {
  const rank = (source: CockpitResourceEntry["source"]): number => source === "run" ? 0 : source === "project" ? 1 : source === "builtin" ? 2 : 3;
  const sourceRank = rank(a.source) - rank(b.source);
  return sourceRank || a.name.localeCompare(b.name);
}

// ── DeepSeek helpers ──

export async function getCockpitDeepSeekSnapshot(): Promise<CockpitDeepSeekSnapshot> {
  const [providerStatus, key] = await Promise.all([
    getDeepSeekProviderStatus(),
    resolveDeepSeekApiKey(),
  ]);
  const base = {
    enabled: providerStatus.enabled,
    apiKeySet: providerStatus.apiKeySet,
    apiKeySource: providerStatus.apiKeySource,
    checkedAt: Date.now(),
  };
  if (!providerStatus.enabled) {
    return {
      ...base,
      available: false,
      reason: providerStatus.disabledReason ?? "DeepSeek disabled",
      balances: [],
    };
  }
  if (!key.apiKey) {
    return {
      ...base,
      available: false,
      reason: `${key.apiKeyEnv} is not set`,
      balances: [],
    };
  }
  const balance = await checkDeepSeekBalance({ apiKey: key.apiKey, timeoutMs: 4_000 });
  return {
    ...base,
    available: balance.available,
    reason: balance.reason,
    balances: (balance.balance?.balance_infos ?? []).map((item) => ({
      currency: item.currency,
      total: item.total_balance,
      granted: item.granted_balance,
      toppedUp: item.topped_up_balance,
    })),
    checkedAt: balance.checkedAt,
  };
}

export function formatDeepSeekBalance(snapshot: CockpitDeepSeekSnapshot): string {
  if (!snapshot.apiKeySet) return "key-missing";
  if (snapshot.balances.length === 0) return snapshot.available ? "unknown" : "n/a";
  return snapshot.balances
    .slice(0, 2)
    .map((balance) => `${balance.currency} ${formatBalanceValue(balance.total)}`)
    .join(",");
}

function formatBalanceValue(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return truncateText(value, 10);
  return parsed.toFixed(parsed >= 100 ? 0 : 2);
}

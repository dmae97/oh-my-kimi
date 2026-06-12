import { readTextFile, writeFileSafe, pathExists } from "./fs.js";
import { getOmkVersionSync } from "./version.js";
import { runShell, type ShellResult } from "./shell.js";
import { join } from "path";
import { homedir } from "os";

export interface UpdateStatus {
  omk: PackageUpdateStatus;
  kimi: KimiUpdateStatus;
  checkedAt: string;
  cacheHit: boolean;
}

export interface PackageUpdateStatus {
  current: string;
  latest: string | null;
  outdated: boolean;
  error: string | null;
  installCmd: string;
}

export interface KimiUpdateStatus {
  installed: string | null;
  latest: string | null;
  outdated: boolean;
  error: string | null;
  installCmd: string;
  fallbackInstallCmd: string;
  installScript: string;
}

interface UpdateCache {
  omkLatest: string | null;
  kimiLatest: string | null;
  checkedAt: string;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_UPDATE_REMIND_HOURS = 24;
const UPDATE_PROMPT_TIMEOUT_MS = 30_000;
export const OMK_NPM_PACKAGE_NAME = "open-multi-agent-kit";
const OMK_UPDATE_INSTALL_CMD = `npm i -g ${OMK_NPM_PACKAGE_NAME}`;

type UpdatePromptEnv = Record<string, string | undefined>;

export type OmkUpdatePromptChoice = "update-now" | "skip-version" | "remind-later";

export type OmkUpdatePromptDecisionReason =
  | "disabled"
  | "ci"
  | "non-tty"
  | "not-outdated"
  | "missing-latest"
  | "skipped-version"
  | "remind-active"
  | "prompt";

export type OmkUpdatePromptAction =
  | Exclude<OmkUpdatePromptDecisionReason, "prompt">
  | "suppressed"
  | "prompted-skip"
  | "prompted-remind"
  | "updated"
  | "update-failed"
  | "cancelled"
  | "timeout";

export interface OmkUpdatePromptState {
  skippedVersion?: string;
  remindAfter?: string;
  updatedAt?: string;
}

export interface OmkUpdatePromptDecision {
  shouldPrompt: boolean;
  reason: OmkUpdatePromptDecisionReason;
  latestVersion?: string;
  remindAfter?: string;
}

export interface OmkUpdatePromptResult {
  action: OmkUpdatePromptAction;
  shouldExit: boolean;
  exitCode?: number;
  version?: string;
  message?: string;
}

interface OmkUpdatePromptChoiceItem {
  name: string;
  value: OmkUpdatePromptChoice;
  description?: string;
}

interface OmkUpdatePromptSelectConfig {
  message: string;
  choices: OmkUpdatePromptChoiceItem[];
}

export interface OmkUpdatePromptOptions {
  status?: UpdateStatus | null;
  checkUpdatesFn?: () => Promise<UpdateStatus>;
  env?: UpdatePromptEnv;
  isTTY?: boolean;
  isCI?: boolean;
  now?: Date;
  statePath?: string;
  source?: "chat" | "root" | "test";
  promptTimeoutMs?: number;
  selectPrompt?: (
    config: OmkUpdatePromptSelectConfig,
    options?: { signal?: AbortSignal }
  ) => Promise<OmkUpdatePromptChoice>;
  runUpdate?: () => Promise<ShellResult>;
  onLog?: (message: string) => void;
}

function getCachePath(): string {
  return join(homedir(), ".omk", "update-cache.json");
}

export function getOmkUpdatePromptStatePath(): string {
  return join(homedir(), ".omk", "update-prompt.json");
}

function normalizeVersionForPrompt(version: string | null | undefined): string {
  if (!version) return "unknown";
  return version.startsWith("v") ? version : `v${version}`;
}

function isTruthyCiValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "off";
}

function getUpdatePromptMode(env: UpdatePromptEnv): "off" | "force" | "normal" {
  const normalized = env.OMK_UPDATE_PROMPT?.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "never") {
    return "off";
  }
  if (normalized === "force") return "force";
  return "normal";
}

function getUpdateRemindHours(env: UpdatePromptEnv): number {
  const parsed = Number(env.OMK_UPDATE_REMIND_HOURS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_UPDATE_REMIND_HOURS;
}

function getUpdateRemindMs(env: UpdatePromptEnv): number {
  return getUpdateRemindHours(env) * 60 * 60 * 1000;
}

function isPromptState(value: unknown): value is OmkUpdatePromptState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    (state.skippedVersion === undefined || typeof state.skippedVersion === "string") &&
    (state.remindAfter === undefined || typeof state.remindAfter === "string") &&
    (state.updatedAt === undefined || typeof state.updatedAt === "string")
  );
}

export async function readOmkUpdatePromptState(statePath = getOmkUpdatePromptStatePath()): Promise<OmkUpdatePromptState | null> {
  if (!(await pathExists(statePath))) return null;
  try {
    const parsed = JSON.parse(await readTextFile(statePath)) as unknown;
    return isPromptState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeOmkUpdatePromptState(
  state: OmkUpdatePromptState,
  statePath = getOmkUpdatePromptStatePath()
): Promise<void> {
  await writeFileSafe(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function resolveOmkUpdatePromptState(options: {
  status: UpdateStatus | null;
  state?: OmkUpdatePromptState | null;
  env?: UpdatePromptEnv;
  isTTY?: boolean;
  isCI?: boolean;
  now?: Date;
}): OmkUpdatePromptDecision {
  const env = options.env ?? process.env;
  const mode = getUpdatePromptMode(env);
  if (mode === "off") return { shouldPrompt: false, reason: "disabled" };

  const isCI = options.isCI ?? (isTruthyCiValue(env.CI) || isTruthyCiValue(env.GITHUB_ACTIONS));
  if (isCI) return { shouldPrompt: false, reason: "ci" };

  if (options.isTTY === false) return { shouldPrompt: false, reason: "non-tty" };

  const status = options.status;
  if (!status?.omk.outdated) return { shouldPrompt: false, reason: "not-outdated" };
  const latestVersion = status.omk.latest ?? undefined;
  if (!latestVersion) return { shouldPrompt: false, reason: "missing-latest" };

  if (mode === "force") return { shouldPrompt: true, reason: "prompt", latestVersion };

  const state = options.state;
  if (state?.skippedVersion === latestVersion) {
    return { shouldPrompt: false, reason: "skipped-version", latestVersion };
  }

  if (state?.remindAfter) {
    const remindAt = new Date(state.remindAfter).getTime();
    const now = options.now ?? new Date();
    if (Number.isFinite(remindAt) && remindAt > now.getTime()) {
      return { shouldPrompt: false, reason: "remind-active", latestVersion, remindAfter: state.remindAfter };
    }
  }

  return { shouldPrompt: true, reason: "prompt", latestVersion };
}

export function formatStartupUpdateBanner(updateStatus: UpdateStatus): string {
  let banner = "";
  if (updateStatus.omk.outdated) {
    banner += `\n  ! omk ${updateStatus.omk.current} → ${updateStatus.omk.latest}  |  ${updateStatus.omk.installCmd}`;
  }
  // kimi-cli dependency removed — kimi-api uses direct Moonshot HTTP API
  return banner;
}

async function defaultSelectUpdatePrompt(
  config: OmkUpdatePromptSelectConfig,
  options?: { signal?: AbortSignal }
): Promise<OmkUpdatePromptChoice> {
  const { select } = await import("@inquirer/prompts");
  return (await select(config, options)) as OmkUpdatePromptChoice;
}

function classifyPromptError(err: unknown): "timeout" | "cancelled" {
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) return "timeout";
  return "cancelled";
}

function promptActionToDecisionAction(reason: OmkUpdatePromptDecisionReason): OmkUpdatePromptAction {
  return reason === "prompt" ? "suppressed" : reason;
}

export async function maybePromptForOmkUpdate(options: OmkUpdatePromptOptions = {}): Promise<OmkUpdatePromptResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const isCI = options.isCI ?? (isTruthyCiValue(env.CI) || isTruthyCiValue(env.GITHUB_ACTIONS));
  const log = options.onLog ?? ((message: string) => console.log(message));

  const preflight = resolveOmkUpdatePromptState({
    status: null,
    env,
    isTTY,
    isCI,
    now,
  });
  if (preflight.reason === "disabled" || preflight.reason === "ci" || preflight.reason === "non-tty") {
    return { action: preflight.reason, shouldExit: false };
  }

  let updateStatus: UpdateStatus;
  try {
    updateStatus = options.status ?? await (options.checkUpdatesFn ?? checkUpdates)();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { action: "suppressed", shouldExit: false, message };
  }

  const statePath = options.statePath ?? getOmkUpdatePromptStatePath();
  const state = await readOmkUpdatePromptState(statePath);
  const decision = resolveOmkUpdatePromptState({
    status: updateStatus,
    state,
    env,
    isTTY,
    isCI,
    now,
  });
  if (!decision.shouldPrompt) {
    return {
      action: promptActionToDecisionAction(decision.reason),
      shouldExit: false,
      version: decision.latestVersion,
    };
  }

  const latestVersion = decision.latestVersion ?? updateStatus.omk.latest ?? "";
  const currentVersion = updateStatus.omk.current;
  const promptMessage = `New OMK version available: ${normalizeVersionForPrompt(latestVersion)}. You are using ${normalizeVersionForPrompt(currentVersion)}. Update now?`;
  const remindHours = getUpdateRemindHours(env);
  const choices: OmkUpdatePromptChoiceItem[] = [
    { name: "Update now", value: "update-now", description: updateStatus.omk.installCmd },
    { name: "Skip this version", value: "skip-version", description: normalizeVersionForPrompt(latestVersion) },
    { name: "Remind me later", value: "remind-later", description: `${remindHours}h` },
  ];

  let answer: OmkUpdatePromptChoice;
  try {
    answer = await (options.selectPrompt ?? defaultSelectUpdatePrompt)(
      { message: promptMessage, choices },
      { signal: AbortSignal.timeout(options.promptTimeoutMs ?? UPDATE_PROMPT_TIMEOUT_MS) }
    );
  } catch (err) {
    const action = classifyPromptError(err);
    log(action === "timeout" ? "Update prompt timed out; continuing without updating." : "Update prompt cancelled.");
    return { action, shouldExit: false, version: latestVersion };
  }

  const updatedAt = now.toISOString();
  if (answer === "skip-version") {
    try {
      await writeOmkUpdatePromptState({ skippedVersion: latestVersion, updatedAt }, statePath);
    } catch {
      // State persistence is advisory; never block startup.
    }
    log(`Skipping OMK ${normalizeVersionForPrompt(latestVersion)} update prompt for this version.`);
    return { action: "prompted-skip", shouldExit: false, version: latestVersion };
  }

  if (answer === "remind-later") {
    const remindAfter = new Date(now.getTime() + getUpdateRemindMs(env)).toISOString();
    try {
      await writeOmkUpdatePromptState({ remindAfter, updatedAt }, statePath);
    } catch {
      // State persistence is advisory; never block startup.
    }
    log(`OMK update reminder scheduled for ${remindAfter}.`);
    return { action: "prompted-remind", shouldExit: false, version: latestVersion };
  }

  log(`Running update: ${OMK_UPDATE_INSTALL_CMD}`);
  const runUpdate = options.runUpdate ?? (() => runShell("npm", ["i", "-g", OMK_NPM_PACKAGE_NAME], { timeout: 120_000 }));
  const updateResult = await runUpdate();
  if (updateResult.failed) {
    const detail = updateResult.stderr.trim() || updateResult.stdout.trim() || `exit ${updateResult.exitCode}`;
    log(`Update failed: ${detail}`);
    log(`Manual update command: ${OMK_UPDATE_INSTALL_CMD}`);
    return { action: "update-failed", shouldExit: true, exitCode: 1, version: latestVersion, message: detail };
  }

  log("OMK update completed successfully. Restart omk chat to use the new version.");
  return { action: "updated", shouldExit: true, exitCode: 0, version: latestVersion };
}

async function readCache(): Promise<UpdateCache | null> {
  const cachePath = getCachePath();
  if (!(await pathExists(cachePath))) return null;

  try {
    const raw = await readTextFile(cachePath);
    const parsed = JSON.parse(raw) as UpdateCache;
    const age = Date.now() - new Date(parsed.checkedAt).getTime();
    if (age > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(cache: UpdateCache): Promise<void> {
  const cachePath = getCachePath();
  try {
    await writeFileSafe(cachePath, JSON.stringify(cache, null, 2));
  } catch {
    // non-fatal
  }
}

export function parseSemverParts(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: string, b: string): number {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! > pb[i]!) return 1;
    if (pa[i]! < pb[i]!) return -1;
  }
  return 0;
}

export function isOutdated(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0;
}

async function fetchOmkLatest(): Promise<string | null> {
  try {
    const result = await runShell("npm", ["view", OMK_NPM_PACKAGE_NAME, "version"], {
      timeout: 8000,
    });
    if (result.failed) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

export async function checkUpdates(forceRefresh = false): Promise<UpdateStatus> {
  const cached = forceRefresh ? null : await readCache();
  const cacheHit = cached !== null;

  const omkCurrent = getOmkVersionSync();
  let omkLatest: string | null = cached?.omkLatest ?? null;
  let kimiLatest: string | null = cached?.kimiLatest ?? null;

  if (!cacheHit) {
    omkLatest = await fetchOmkLatest();
    kimiLatest = null;

    await writeCache({
      omkLatest,
      kimiLatest,
      checkedAt: new Date().toISOString(),
    });
  }

  const omkOutdated = !!omkLatest && isOutdated(omkCurrent, omkLatest);

  let omkError: string | null = null;

  if (!omkLatest && !cacheHit) omkError = "registry unreachable";

  return {
    omk: {
      current: omkCurrent,
      latest: omkLatest,
      outdated: omkOutdated,
      error: omkError,
      installCmd: OMK_UPDATE_INSTALL_CMD,
    },
    kimi: {
      installed: null,
      latest: null,
      outdated: false,
      error: null,
      installCmd: "echo 'kimi-api uses direct Moonshot HTTP API — no CLI needed'",
      installScript: "echo 'kimi-api uses direct Moonshot HTTP API'",
      fallbackInstallCmd: "echo 'kimi-api uses direct Moonshot HTTP API'",
    },
    checkedAt: new Date().toISOString(),
    cacheHit,
  };
}

import type { IPty } from "node-pty";
import { readFile } from "fs/promises";
import { BannerReplacer } from "./banner.js";
import { KimiBugFilter } from "./bug-filter.js";
import { KimiContinuePromptGuard } from "./continue-prompt-guard.js";
import { omkBanner, style, loadThemeConfig } from "../../util/theme.js";
import { ensureDir, injectKimiGlobals, getProjectRoot, getUserHome, pathExists } from "../../util/fs.js";
import { pasteScreenshot } from "../../util/screenshot-store.js";
import { isAbsolute, join, relative, resolve } from "path";
import type { TaskRunner, TaskResult } from "../../contracts/orchestration.js";
import type { DagNode } from "../../orchestration/dag.js";
import { capabilityScopesFromRouting } from "../../orchestration/capability-routing.js";
import { runShellStreaming } from "../../util/shell.js";
import { resolveTimeoutMs } from "../../util/timeout-config.js";
import { getOmkResourceSettings, type OmkRuntimeScope } from "../../util/resource-profile.js";
import { KimiStatusLineEnhancer } from "./statusline.js";
import { formatOmkVersionFooter } from "../../util/version.js";
import { prepareIsolatedKimiHome, cleanupIsolatedKimiHome, resolveOriginalHome } from "./isolated-home.js";
import { enableRawTerminalInput, restoreTerminalInputState } from "../../util/terminal-input.js";
import { checkCommand, resolveKimiBin } from "../../util/shell.js";
import { defaultScopedRoleAgentFile, writeScopedAgentFile } from "../../util/scoped-agent-file.js";
import { terminateProcessTree, type ProcessTreeTarget } from "../../util/process-tree.js";
import { sanitizeUserVisibleOutput } from "../../util/user-visible-output.js";
import { isDeniedChildEnvName } from "../../runtime/child-env.js";

const REQUIRED_KIMI_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SHELL",
  "TERM",
  "COLORTERM",
  "TMP",
  "TMPDIR",
  "TEMP",
  "USER",
  "LOGNAME",
  "PWD",
  "LANG",
  "LC_ALL",
]);

const SECRET_ENV_KEY_PATTERN =
  /(?:^|[_-])(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTHORIZATION|AUTH|COOKIE|SESSION(?:[_-]?(?:ID|TOKEN|SECRET))?|JSESSIONID|PHPSESSID|BEARER|DATABASE[_-]?URL|REDIS[_-]?URL|MONGO(?:DB)?[_-]?URI|CONNECTION[_-]?STRING|DSN)(?:[_-]|$)/i;

const NON_SECRET_KIMI_METADATA_ENV_KEYS = new Set([
  "KIMI_SESSION_ID",
  "OMK_RUN_ID",
  "OMK_SESSION_ID",
  "OMK_INHERIT_LOCAL_AUTH",
  "OMK_ISOLATED_HOME_INHERIT_AUTH",
  "OMK_TOTAL_TOKENS",
  "OMK_NODE_PROVIDER_AUTHORITY",
]);

const TRUSTED_KIMI_EXPLICIT_SECRET_ENV_PATTERN = /^(1|true|yes)$/i;
const KIMI_EXPLICIT_SECRET_ENV_WARNED = new Set<string>();

function isAllowedInheritedKimiEnvKey(key: string): boolean {
  if (isDeniedChildEnvName(key)) return false;
  if (NON_SECRET_KIMI_METADATA_ENV_KEYS.has(key)) return true;
  if (SECRET_ENV_KEY_PATTERN.test(key)) return false;
  return REQUIRED_KIMI_ENV_KEYS.has(key) || key.startsWith("LC_") || key.startsWith("KIMI_") || key.startsWith("OMK_");
}

export function isSecretLikeKimiEnvKey(key: string): boolean {
  if (NON_SECRET_KIMI_METADATA_ENV_KEYS.has(key)) return false;
  return SECRET_ENV_KEY_PATTERN.test(key);
}

function isTrustedExplicitSecretEnvEnabled(env: Record<string, string | undefined>): boolean {
  return TRUSTED_KIMI_EXPLICIT_SECRET_ENV_PATTERN.test(env.OMK_TRUST_KIMI_EXPLICIT_SECRET_ENV ?? "");
}

function warnExplicitSecretLikeKimiEnvKey(
  key: string,
  context: string,
  onWarning: (message: string) => void
): void {
  const warningKey = `${context}:${key}`;
  if (KIMI_EXPLICIT_SECRET_ENV_WARNED.has(warningKey)) return;
  KIMI_EXPLICIT_SECRET_ENV_WARNED.add(warningKey);
  onWarning(
    `[omk] Warning: explicit Kimi child env includes secret-like key "${key}" in ${context}; ` +
      "the key was dropped. Set OMK_TRUST_KIMI_EXPLICIT_SECRET_ENV=1 only inside an isolated runner to pass it through."
  );
}

export interface KimiChildEnvOptions {
  warnExplicitSecrets?: boolean;
  explicitEnvContext?: string;
  onWarning?: (message: string) => void;
}

export function buildSafeKimiChildEnv(
  inheritedEnv: Record<string, string | undefined> = process.env,
  explicitEnv: Record<string, string | undefined> = {},
  forcedEnv: Record<string, string | undefined> = {},
  options: KimiChildEnvOptions = {}
): Record<string, string> {
  const safeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (value !== undefined && isAllowedInheritedKimiEnvKey(key)) {
      safeEnv[key] = value;
    }
  }
  const trustedExplicitSecretEnv = isTrustedExplicitSecretEnvEnabled({ ...inheritedEnv, ...explicitEnv, ...forcedEnv });
  const explicitEnvContext = options.explicitEnvContext ?? "kimi child env";
  const onWarning = options.onWarning ?? ((message: string) => process.stderr.write(`${message}\n`));

  for (const [key, value] of Object.entries(explicitEnv)) {
    if (value === undefined) {
      delete safeEnv[key];
      continue;
    }
    if (isDeniedChildEnvName(key)) {
      delete safeEnv[key];
      continue;
    }
    if (isSecretLikeKimiEnvKey(key) && !trustedExplicitSecretEnv) {
      if (options.warnExplicitSecrets) {
        warnExplicitSecretLikeKimiEnvKey(key, explicitEnvContext, onWarning);
      }
      delete safeEnv[key];
      continue;
    }
    safeEnv[key] = value;
  }
  for (const [key, value] of Object.entries(forcedEnv)) {
    if (value === undefined) delete safeEnv[key];
    else safeEnv[key] = value;
  }
  return safeEnv;
}

function readFlagValue(args: string[], longName: string, shortName?: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === longName || (shortName && arg === shortName)) {
      return args[index + 1];
    }
    if (arg.startsWith(`${longName}=`)) {
      return arg.slice(longName.length + 1);
    }
    if (shortName && arg.startsWith(`${shortName}=`)) {
      return arg.slice(shortName.length + 1);
    }
  }
  return undefined;
}

export function parseKimiLaunchMeta(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd()
): { directory: string; session?: string; model?: string } {
  return {
    directory: cwd,
    session: env.KIMI_SESSION_ID ?? env.OMK_SESSION_ID ?? env.OMK_RUN_ID,
    model: readFlagValue([...args], "--model", "-m") ?? env.OMK_KIMI_MODEL ?? env.OMK_MODEL,
  };
}

export type KimiProviderFailureKind = "monthly-quota" | "rate-limit" | "provider";

export interface KimiProviderFailureDiagnosis {
  kind: KimiProviderFailureKind;
  title: string;
  remediation: string[];
}

export function classifyKimiProviderFailure(output: string): KimiProviderFailureDiagnosis | null {
  const normalized = output.toLowerCase();
  const isMonthlyQuota =
    normalized.includes("exceeded_current_quota_error") ||
    normalized.includes("monthly usage limit") ||
    (normalized.includes("billing cycle") && (normalized.includes("quota") || normalized.includes("usage limit"))) ||
    (normalized.includes("quota") && normalized.includes("refreshed in the next cycle"));
  const isRateLimit =
    normalized.includes("error code: 429") ||
    normalized.includes("rate limit") ||
    (/\b429\b/.test(normalized) &&
      (normalized.includes("llm") || normalized.includes("provider") || normalized.includes("kimi") || normalized.includes("moonshot")));
  const isProviderError =
    normalized.includes("llm provider error") ||
    normalized.includes("provider error") ||
    isMonthlyQuota ||
    isRateLimit;
  if (!isProviderError) return null;

  if (isMonthlyQuota) {
    return {
      kind: "monthly-quota",
      title: "Kimi monthly quota exhausted",
      remediation: [
        "Login/auth can be valid while the Kimi account's monthly provider quota is exhausted.",
        "This is a provider quota/billing limit, not an MCP or repository failure.",
        "Use a non-Kimi provider/profile until the quota refreshes, or upgrade Kimi Code quota.",
        "For this repo, try: omk provider deepseek enable (if configured) or rerun with a non-Kimi provider.",
        "If Kimi support asks for diagnostics, run: kimi export — keep the exported file private.",
      ],
    };
  }

  if (isRateLimit) {
    return {
      kind: "rate-limit",
      title: "Kimi provider rate limit reached",
      remediation: [
        "Wait and retry later, reduce parallel workers, or switch to a configured fallback provider.",
        "For worker runs, reduce concurrency with --workers 1 or OMK_WORKERS=1.",
      ],
    };
  }

  return {
    kind: "provider",
    title: "Kimi provider unavailable",
    remediation: [
      "Check Kimi account/provider status and retry, or switch to a configured fallback provider.",
    ],
  };
}

export function formatKimiProviderFailureHint(output: string): string | null {
  const diagnosis = classifyKimiProviderFailure(output);
  if (!diagnosis) return null;
  const lines = [
    `[omk] ${diagnosis.title}.`,
    ...diagnosis.remediation.map((line) => `      - ${line}`),
  ];
  return lines.join("\n") + "\n";
}

export type KimiMcpFailurePolicy = "required-only" | "strict";

export function shouldFailOnMcpError(input: {
  readonly serverName: string;
  readonly requiredServers: readonly string[];
  readonly failurePolicy: KimiMcpFailurePolicy;
}): boolean {
  if (input.failurePolicy === "strict") return true;
  return input.requiredServers.includes(input.serverName);
}

export function extractKimiMcpConnectionFailureNames(output: string): string[] {
  if (!/Failed to connect MCP servers/i.test(output)) return [];
  const names = new Set<string>();
  const objectMatches = output.matchAll(/['"]([^'"]+)['"]\s*:/g);
  for (const match of objectMatches) {
    const name = match[1]?.trim();
    if (name) names.add(name);
  }
  const fallbackMatches = output.matchAll(/\b(?:server|MCP)\s+([a-zA-Z0-9_.-]+)\s+(?:failed|unavailable|closed)/gi);
  for (const match of fallbackMatches) {
    const name = match[1]?.trim();
    if (name && name.toLowerCase() !== "servers") names.add(name);
  }
  return [...names];
}

function optionalRootMcpAllowlist(names: readonly string[] | undefined): string[] {
  const normalized = [...new Set((names ?? []).map((name) => name.trim()).filter(Boolean))];
  const preferred = normalized.filter((name) => {
    const lowered = name.toLowerCase();
    return lowered === "omk-project" || lowered === "memory" || lowered.includes("filesystem") || lowered === "git";
  });
  return preferred.length > 0 ? preferred : ["omk-project"];
}

function parseMcpHints(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function resolveNodeMcpAllowlist(
  node: DagNode,
  nodeEnv: Record<string, string>,
  fallbackNames: readonly string[] | undefined
): string[] {
  const envHints = parseMcpHints(nodeEnv.OMK_MCP_HINTS);
  if (envHints !== undefined) return envHints;
  if (node.routing?.mcpServers) return [...node.routing.mcpServers];
  return optionalRootMcpAllowlist(fallbackNames);
}

function isOptionalMcpFailureResult(node: DagNode, output: string, hasStdout: boolean): boolean {
  const failedNames = extractKimiMcpConnectionFailureNames(output);
  if (failedNames.length === 0 || !hasStdout) return false;
  const requiredServers = node.routing?.requiresMcp ? node.routing.mcpServers ?? [] : [];
  return failedNames.every((serverName) => !shouldFailOnMcpError({
    serverName,
    requiredServers,
    failurePolicy: node.routing?.requiresMcp ? "strict" : "required-only",
  }));
}

export interface KimiStartupExitDiagnosis {
  elapsedMs: number;
  thresholdMs: number;
  message: string;
}

const DEFAULT_KIMI_FAST_EXIT_MS = 1500;
const DEFAULT_KIMI_STARTUP_TIMEOUT_MS = 45_000;

function resolveKimiFastExitThresholdMs(env: Record<string, string | undefined>): number {
  const raw = env.OMK_CHAT_FAST_EXIT_MS;
  if (!raw) return DEFAULT_KIMI_FAST_EXIT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_KIMI_FAST_EXIT_MS;
  return Math.max(0, parsed);
}

export function resolveKimiStartupTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.OMK_CHAT_STARTUP_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_KIMI_STARTUP_TIMEOUT_MS;
  if (raw.trim() === "0") return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1000) return DEFAULT_KIMI_STARTUP_TIMEOUT_MS;
  return Math.min(parsed, 10 * 60_000);
}

function stripAnsiControls(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isKimiPromptReadyLine(line: string): boolean {
  const trimmed = stripAnsiControls(line).trim();
  return /(?:^|\s)(?:waiting for input|ready for input|enter your prompt|prompt ready)(?:\s|$)/i.test(trimmed)
    || /^kimi[❯>›]\s*$/i.test(trimmed);
}

export function isKimiStartupReadyData(data: string): boolean {
  const clean = stripAnsiControls(data);
  if (/(?:^|\n)\s*(?:Kimi\s+)?Session(?:\s*ID)?\s*:/i.test(clean)) return true;
  return clean.split(/\r?\n/).some(isKimiPromptReadyLine);
}

function createPtyProcessTreeTarget(ptyProcess: IPty): ProcessTreeTarget {
  let exitCode: number | null = null;
  const exitListeners = new Set<(...args: unknown[]) => void>();
  const disposable = ptyProcess.onExit((event) => {
    exitCode = event.exitCode;
    for (const listener of exitListeners) {
      listener(event.exitCode, event.signal);
    }
    exitListeners.clear();
    disposable.dispose();
  });

  return {
    pid: ptyProcess.pid,
    get exitCode(): number | null {
      return exitCode;
    },
    signalCode: null,
    kill(signal?: NodeJS.Signals | number): boolean {
      try {
        ptyProcess.kill(typeof signal === "string" ? signal : undefined);
        return true;
      } catch {
        return false;
      }
    },
    once(event: "exit" | "close" | "error", listener: (...args: unknown[]) => void): unknown {
      if (event === "error") return undefined;
      if (exitCode !== null) {
        queueMicrotask(() => listener(exitCode));
        return undefined;
      }
      exitListeners.add(listener);
      return {
        dispose: () => exitListeners.delete(listener),
      };
    },
  };
}

export function classifyKimiStartupExit(
  exitCode: number,
  elapsedMs: number,
  env: Record<string, string | undefined> = process.env
): KimiStartupExitDiagnosis | null {
  const allowFastExit = /^(1|true|yes)$/i.test(env.OMK_ALLOW_FAST_CHAT_EXIT ?? "");
  if (allowFastExit || exitCode !== 0) return null;
  const thresholdMs = resolveKimiFastExitThresholdMs(env);
  if (thresholdMs <= 0 || elapsedMs > thresholdMs) return null;
  return {
    elapsedMs,
    thresholdMs,
    message: `Kimi exited immediately after ${elapsedMs}ms before an interactive chat could start.`,
  };
}

/** args 배열에서 --mcp-config-file 경로들을 찾아 존재 여부 검증 (fail-fast, 3s timeout) */
async function preflightMcpConfigs(args: string[]): Promise<void> {
  const MCP_PREFLIGHT_TIMEOUT_MS = 3000;
  const start = Date.now();
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--mcp-config-file") {
      const configPath = args[i + 1];
      if (!configPath) continue;
      if (Date.now() - start > MCP_PREFLIGHT_TIMEOUT_MS) {
        console.warn(style.orange(`[omk] ⚠️  MCP preflight timed out after ${MCP_PREFLIGHT_TIMEOUT_MS}ms`));
        break;
      }
      if (!(await pathExists(configPath))) {
        console.warn(
          style.orange(`[omk] ⚠️  MCP config not found: ${configPath}`) +
            "\n  Kimi may fail to start. Run `omk doctor` to check MCP configuration."
        );
      }
    }
  }
}
export async function runKimiInteractive(
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    onMeta?: (meta: { directory?: string; session?: string; model?: string }) => void;
    onKimiMeta?: (meta: { directory?: string; session?: string; model?: string }) => void;
    onData?: (data: string) => void;
  }
): Promise<number> {
  const resources = await getOmkResourceSettings();

  // Debug: log args so we can verify MCP/skills flags are present
  if (process.env.OMK_DEBUG === "1") {
    process.stderr.write(`[omk-debug] runKimiInteractive args: ${JSON.stringify(args)}\n`);
  }

  const noBanner = process.env.OMK_CHAT_NO_BANNER === "1";
  const theme = await loadThemeConfig();
  const launchMeta = parseKimiLaunchMeta(args, { ...process.env, ...(options?.env ?? {}) }, options?.cwd ?? process.cwd());
  let observedKimiSession: string | undefined;
  let startupReady = false;
  const markStartupReady = (): void => {
    startupReady = true;
  };
  const replacer = new BannerReplacer((meta) => {
    if (noBanner) return;
    writeStdout(omkBanner(meta, formatOmkVersionFooter(), theme ?? undefined) + "\n");
    options?.onMeta?.(meta);
  }, true, (rawMeta) => {
    const kimiSession = rawMeta.session?.trim();
    if (!kimiSession || kimiSession === observedKimiSession) return;
    observedKimiSession = kimiSession;
    process.env.KIMI_SESSION_ID = kimiSession;
    options?.onKimiMeta?.(rawMeta);
    markStartupReady();
    if (!noBanner) {
      const omkSession = launchMeta.session;
      const suffix = omkSession && omkSession !== kimiSession ? ` ${style.gray(`(OMK session: ${omkSession})`)}` : "";
      writeStdout(`${style.gray("[omk] Kimi session:")} ${style.cream(kimiSession)}${suffix}\n`);
    }
  });
  const bugFilter = new KimiBugFilter();
  const continuePromptGuard = new KimiContinuePromptGuard({ maxAutoEnters: Number(process.env.OMK_KIMI_MAX_AUTO_ENTER ?? 5) });
  const statusLine = await KimiStatusLineEnhancer.create();

  const baseEnv = buildSafeKimiChildEnv(process.env, options?.env ?? {}, {}, {
    warnExplicitSecrets: true,
    explicitEnvContext: "interactive Kimi options.env",
  });
  const originalHome = resolveOriginalHome(baseEnv);
  const tmpHome = await prepareIsolatedKimiHome({
    originalHome,
    env: baseEnv,
    skillsScope: resources.skillsScope,
    hooksScope: resources.hooksScope,
  });
  const env = buildSafeKimiChildEnv({}, baseEnv, {
    KIMI_HIDE_BANNER: "1",
    KIMI_NO_BANNER: "1",
    OMK_RESOURCE_PROFILE_EFFECTIVE: resources.profile,
    OMK_ORIGINAL_HOME: originalHome,
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    HOMEDRIVE: "",
    HOMEPATH: tmpHome,
    PWD: options?.cwd ?? process.cwd(),
    CODEX_HOME: join(tmpHome, ".codex"),
  });


  const kimiBin = resolveKimiBin(env);

  // Binary resolution guard: verify `kimi` is reachable before spawn
  const kimiAvailable = await checkCommand(kimiBin);
  if (!kimiAvailable) {
    await cleanupIsolatedKimiHome(tmpHome);
    throw new Error(
      "[omk] `kimi` command not found in PATH. " +
        "Kimi/OMK primary provider not found. Install Kimi CLI: npm i -g @anthropic-ai/kimi-code, or set KIMI_BIN to an alternative provider binary.\n" +
        "If already installed, check your PATH or set KIMI_BIN env var."
    );
  }

  // MCP preflight: verify config files exist before spawn
  await preflightMcpConfigs(args);

  // ── Backpressure-safe stdout writer (circular buffer) ──
  // Prevents process.stdout.write from blocking the event loop when the
  // TTY is slow, which in turn starves stdin keypress handlers.
  const rawMaxLines = parseInt(process.env.OMK_MAX_STDOUT_LINES ?? "10000", 10);
  const MAX_STDOUT_LINES = Number.isNaN(rawMaxLines) ? 10000 : Math.max(1000, Math.min(20000, rawMaxLines));
  const MAX_CHUNK_BYTES = 65536; // cap individual chunks to avoid memory spikes
  const stdoutQueue: string[] = [];
  let stdoutHead = 0;
  let stdoutCount = 0;
  let stdoutWriting = false;

  function circularPush(data: string): void {
    // Limit individual chunk size to prevent memory spikes from huge single writes
    const chunks = data.length > MAX_CHUNK_BYTES
      ? [data.slice(0, MAX_CHUNK_BYTES), data.slice(MAX_CHUNK_BYTES)]
      : [data];
    for (const chunk of chunks) {
      const idx = (stdoutHead + stdoutCount) % MAX_STDOUT_LINES;
      if (stdoutCount < MAX_STDOUT_LINES) {
        stdoutQueue[idx] = chunk;
        stdoutCount++;
      } else {
        stdoutQueue[stdoutHead] = chunk;
        stdoutHead = (stdoutHead + 1) % MAX_STDOUT_LINES;
      }
    }
  }

  function circularShift(): string | undefined {
    if (stdoutCount === 0) return undefined;
    const data = stdoutQueue[stdoutHead];
    stdoutQueue[stdoutHead] = "";
    stdoutHead = (stdoutHead + 1) % MAX_STDOUT_LINES;
    stdoutCount--;
    return data;
  }

  function flushStdoutQueue(): void {
    stdoutWriting = true;
    while (stdoutCount > 0) {
      const chunk = circularShift()!;
      if (!process.stdout.write(chunk)) {
        process.stdout.once("drain", () => {
          stdoutWriting = false;
          flushStdoutQueue();
        });
        return;
      }
    }
    stdoutWriting = false;
  }

  function writeStdout(data: string): void {
    circularPush(sanitizeUserVisibleOutput(data));
    if (!stdoutWriting) {
      flushStdoutQueue();
    }
  }

  // Print OMK banner BEFORE spawning Kimi
  const meta = launchMeta;
  if (!noBanner) {
    writeStdout(omkBanner(meta, formatOmkVersionFooter(), theme ?? undefined) + "\n");
  }
  options?.onMeta?.(meta);

  let ptyModule: typeof import("node-pty");
  try {
    ptyModule = await import("node-pty");
  } catch (err) {
    await cleanupIsolatedKimiHome(tmpHome);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      "[omk] Failed to load node-pty native module. " +
        `(${message})\n` +
        "This usually happens when installed with --ignore-scripts.\n" +
        "Fix: npm rebuild -g open-multi-agent-kit\n" +
        "Or reinstall: npm uninstall -g open-multi-agent-kit && npm install -g open-multi-agent-kit"
    );
  }

  let ptyProcess: IPty;
  try {
    ptyProcess = ptyModule.spawn(kimiBin, args, {
      name: "xterm-256color",
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: options?.cwd ?? process.cwd(),
      env,
    });
  } catch (err) {
    await cleanupIsolatedKimiHome(tmpHome);
    throw err;
  }
  const spawnedAt = Date.now();
  const ptyTarget = createPtyProcessTreeTarget(ptyProcess);

  // ── Signal handlers registered inside Promise below ──

  let recentProviderOutput = "";
  const rememberProviderOutput = (chunk: string): void => {
    recentProviderOutput = (recentProviderOutput + chunk).slice(-8000);
  };

  // stdout → 터미널 (버그 필터 → 배너 필터링 적용)
  ptyProcess.onData((data) => {
    options?.onData?.(data);
    if (isKimiStartupReadyData(data)) markStartupReady();
    rememberProviderOutput(data);
    // Strip terminal sequences that break scrollback / native mouse scrolling:
    // - alternate-screen buffer enter/exit (1049, legacy 47)
    // - mouse tracking (1000, 1002, 1006)
    // - scroll-region setting (r) — prevents partial-screen redraws that confuse scrollback
    data = data
      .replace(/\x1b\[\?1049[hl]/g, "")
      .replace(/\x1b\[\?47[hl]/g, "")
      .replace(/\x1b\[\?(1000|1002|1003|1006)[hl]/g, "")
      .replace(/\x1b\[\d+;\d+[r]/g, "");
    const bugResult = bugFilter.process(data);
    if (bugResult.sendEnter) {
      ptyProcess.write("\n");
    }
    const continueResult = continuePromptGuard.process(data);
    if (continueResult.sendEnter) {
      ptyProcess.write("\r");
      process.stderr.write("[omk] auto-entered Kimi continue prompt\n");
    }
    if (continueResult.exceeded) {
      process.stderr.write(`[omk] ${continueResult.reason}\n`);
      forceTerminate(1);
    }
    if (bugResult.output === null) {
      return;
    }
    const output = replacer.process(bugResult.output);
    if (output !== null) {
      writeStdout(statusLine.process(output));
    }
  });

  // stdin → pty (Buffer passthrough for lower latency)
  const terminalInputState = enableRawTerminalInput(process.stdin);
  const handleStdinData = (data: string | Buffer): void => {
    const text = typeof data === "string" ? data : data.toString("utf8");

    // Ctrl+V (0x16) — auto-attach a clipboard image if Windows Capture/Snipping Tool
    // copied one via Ctrl+C. Text paste still falls through to Kimi unchanged.
    // Set OMK_IMAGE_PASTE_MODE=native/off to disable, or managed to show clipboard errors.
    if (text.includes("\x16")) {
      const mode = (process.env.OMK_IMAGE_PASTE_MODE ?? "auto").toLowerCase();
      const remaining = text.replace(/\x16/g, "");
      if (!["native", "off", "disabled", "0"].includes(mode)) {
        const result = pasteScreenshot(getProjectRoot());
        if (result.ok && result.relativePath) {
          // Insert path but do NOT auto-submit; user must press Enter.
          ptyProcess.write(`Image file: ${result.relativePath}`);
          if (remaining) {
            ptyProcess.write(remaining);
          }
          return;
        }
        if (mode === "managed" && remaining.trim().length === 0) {
          ptyProcess.write(`[Clipboard: ${result.error ?? "no image found"}]`);
          return;
        }
      }
      ptyProcess.write(text);
      return;
    }

    // /paste-image — explicit command to save clipboard image and insert path
    if (text.trim() === "/paste-image") {
      const result = pasteScreenshot(getProjectRoot());
      if (result.ok && result.relativePath) {
        // Insert path but do NOT auto-submit; user must press Enter.
        ptyProcess.write(`Image file: ${result.relativePath}`);
      } else {
        ptyProcess.write(`[Screenshot error: ${result.error ?? "No image found"}]`);
      }
      return;
    }


    ptyProcess.write(text);
  };
  process.stdin.on("data", handleStdinData);

  // 터미널 리사이즈 → pty 동기화
  const handleStdoutResize = (): void => {
    ptyProcess.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  };
  process.stdout.on("resize", handleStdoutResize);

  // 종료 대기
  let forceTerminate: (exitCode: number) => void;
  return new Promise<number>((resolve) => {
    let cleaned = false;
    let settled = false;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationStarted: Promise<void> | undefined;
    const clearWatchdogs = (): void => {
      if (startupTimer) clearTimeout(startupTimer);
    };
    const cleanupRuntime = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      clearWatchdogs();
      try {
        process.stdin.off("data", handleStdinData);
        process.stdout.off("resize", handleStdoutResize);
        process.removeListener("SIGINT", signalHandler as NodeJS.SignalsListener);
        process.removeListener("SIGTERM", signalHandler as NodeJS.SignalsListener);
      } finally {
        try {
          statusLine.dispose();
        } finally {
          restoreTerminalInputState(process.stdin, terminalInputState);
        }
      }
      await cleanupIsolatedKimiHome(tmpHome);
    };
    const resolveOnce = (code: number): void => {
      if (settled) return;
      settled = true;
      clearWatchdogs();
      resolve(code);
    };
    forceTerminate = (exitCode: number): void => {
      if (!terminationStarted) {
        terminationStarted = terminateProcessTree(ptyTarget, { graceMs: 1000, waitMs: 5000 })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[omk] PTY termination warning: ${message}\n`);
            try {
              process.kill(-ptyProcess.pid, "SIGKILL");
            } catch {
              try {
                ptyProcess.kill("SIGKILL");
              } catch { /* pty already dead */ }
            }
          });
      }
      terminationStarted
        .then(() => cleanupRuntime())
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[omk] PTY cleanup warning: ${message}\n`);
        })
        .finally(() => resolveOnce(exitCode));
    };

    const startupTimeoutMs = resolveKimiStartupTimeoutMs(env);
    if (startupTimeoutMs > 0) {
      startupTimer = setTimeout(() => {
        if (startupReady || settled) return;
        const runId = options?.env?.OMK_RUN_ID;
        const resumeHint = runId ? ` • resume: omk chat --run-id ${runId}` : "";
        process.stderr.write(style.red(`[omk] Kimi startup timed out after ${startupTimeoutMs}ms without session or prompt-ready signal${resumeHint}\n`));
        forceTerminate(1);
      }, startupTimeoutMs);
      startupTimer.unref?.();
    }

    const signalHandler = (signal: string): void => {
      // Remove listeners first to prevent re-entry
      process.removeListener("SIGINT", signalHandler as NodeJS.SignalsListener);
      process.removeListener("SIGTERM", signalHandler as NodeJS.SignalsListener);
      process.exitCode = signal === "SIGINT" ? 130 : 143; // 128+2, 128+15
      forceTerminate(process.exitCode);
    };
    process.once("SIGINT", signalHandler as NodeJS.SignalsListener);
    process.once("SIGTERM", signalHandler as NodeJS.SignalsListener);

    ptyProcess.onExit(({ exitCode }) => {
      if (settled) return;
      void (async () => {
        const elapsedMs = Date.now() - spawnedAt;
        const bugRest = bugFilter.forceFlush();
        if (bugRest) writeStdout(statusLine.process(bugRest));
        const replacerRest = replacer.forceFlush();
        if (replacerRest) writeStdout(statusLine.process(replacerRest));
        await cleanupRuntime().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[omk] PTY cleanup warning: ${message}\n`);
        });
        const runId = options?.env?.OMK_RUN_ID;
        const resumeHint = runId ? ` • resume: omk chat --run-id ${runId}` : "";
        const startupExit = classifyKimiStartupExit(exitCode, elapsedMs, env);
        if (startupExit) {
          process.stderr.write(style.red(`[omk] ${startupExit.message}${resumeHint}\n`));
          process.stderr.write(
            style.orange(
              `[omk] Treating this as a startup failure so OMK does not silently close the chat.\n` +
                `      Run 'kimi' directly or 'omk doctor --fix' to diagnose startup configuration.\n`
            )
          );
        } else if (exitCode !== 0) {
          process.stderr.write(style.red(`[omk] kimi exited with code ${exitCode}${resumeHint}\n`));
          // Detect MCP connection failures from stderr that was buffered in PTY
          const providerHint = formatKimiProviderFailureHint(recentProviderOutput);
          if (providerHint) {
            process.stderr.write(style.orange(providerHint));
          } else if (exitCode === 1) {
            process.stderr.write(
              style.orange(
                `[omk] If this was caused by MCP server connection failure, run 'omk doctor' to diagnose.\n` +
                  `      You can also try: OMK_MCP_SCOPE=none omk chat --provider kimi\n`
              )
            );
          }
        }
        resolveOnce(startupExit ? 1 : exitCode);
      })();
    });
  });
}

export interface KimiTaskRunnerOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  agentFile?: string;
  promptPrefix?: string;
  mcpScope?: OmkRuntimeScope;
  skillsScope?: OmkRuntimeScope;
  hooksScope?: OmkRuntimeScope;
  mcpNames?: string[];
  skillNames?: string[];
  hookNames?: string[];
  toolNames?: string[];
  onThinking?: (thinking: string) => void;
  onOutput?: (text: string) => void;
  roleAgentFiles?: boolean;
}

function createLiveThinkingHandler(onThinking: ((thinking: string) => void) | undefined) {
  if (!onThinking) return undefined;
  let recentLine = "";
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (recentLine) onThinking(`📝 ${recentLine}`);
  };

  return (chunk: string) => {
    const lines = chunk.split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.length < 3) continue;

      // Explicit thinking markers
      const explicit = line.match(/^<think(?:ing)?>[\s:]*(.+?)(?:<\/think(?:ing)?>)?$/i);
      if (explicit) {
        onThinking(`🧠 ${explicit[1].trim().slice(0, 100)}`);
        continue;
      }

      // Tool/file activity
      if (/read_file|write_file|edit_file|search_files|glob|grep|ctx_read/i.test(line)) {
        const m = line.match(/["']([^"']{1,60})["']/);
        onThinking(m ? `📄 ${m[1].split("/").pop() ?? m[1]}` : `🔧 ${line.slice(0, 60)}`);
        continue;
      }

      if (line.length > 5 && line.length < 120 && !line.startsWith("```")) {
        recentLine = line.slice(0, 80);
      }
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, 400);
  };
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function formatFallbackAgentFilePath(fallback: string, projectRoot: string): string {
  const normalizedFallback = resolve(fallback);
  if (isPathInside(projectRoot, normalizedFallback)) {
    return `project fallback ${relative(projectRoot, normalizedFallback).replace(/\\/g, "/") || "."}`;
  }
  const userHome = getUserHome();
  if (isPathInside(userHome, normalizedFallback)) {
    return `global fallback ~/${relative(userHome, normalizedFallback).replace(/\\/g, "/")}`;
  }
  return `external fallback ${fallback}`;
}

export async function resolveAgentFileForRole(role: string, fallback?: string): Promise<string | undefined> {
  const projectRoot = getProjectRoot();
  const candidates = [
    join(projectRoot, ".omk", "agents", `${role}.yaml`),
    join(projectRoot, ".omk", "agents", `${role}.yml`),
    join(projectRoot, ".omk", "agents", "roles", `${role}.yaml`),
    join(projectRoot, ".omk", "agents", "roles", `${role}.yml`),
    join(projectRoot, ".kimi", "agents", `${role}.yaml`),
    join(projectRoot, ".kimi", "agents", `${role}.yml`),
    join(projectRoot, ".kimi", "agents", "roles", `${role}.yaml`),
    join(projectRoot, ".kimi", "agents", "roles", `${role}.yml`),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  if (fallback) {
    const searched = candidates.map((candidate) => relative(projectRoot, candidate).replace(/\\/g, "/"));
    console.warn(
      `[omk] No agent file found for role "${role}" in ${searched.join(", ")}; ` +
      `falling back to ${formatFallbackAgentFilePath(fallback, projectRoot)}. ` +
      `Run "omk doctor --fix" to restore missing generated role files and root aliases.`
    );
  }
  return fallback;
}

export function createKimiTaskRunner(options: KimiTaskRunnerOptions = {}): TaskRunner {
  const { cwd, timeout = 120000, env, agentFile, promptPrefix, mcpScope, skillsScope, hooksScope, mcpNames, skillNames, hookNames, toolNames, onThinking, roleAgentFiles } = options;
  let currentOnThinking = onThinking;

  const runner: TaskRunner = {
    get onThinking() {
      return currentOnThinking;
    },
    set onThinking(fn) {
      currentOnThinking = fn;
    },

    fork(newOnThinking) {
      return createKimiTaskRunner({ ...options, onThinking: newOnThinking });
    },

    async run(node: DagNode, nodeEnv: Record<string, string>, signal?: AbortSignal): Promise<TaskResult> {
      const baseEnv = buildSafeKimiChildEnv(process.env, { ...(env ?? {}), ...nodeEnv }, {}, {
        warnExplicitSecrets: true,
        explicitEnvContext: "Kimi DAG env/nodeEnv",
      });
      const resources = await getOmkResourceSettings();
      const effectiveMcpScope = mcpScope ?? resources.mcpScope;
      const effectiveSkillsScope = skillsScope ?? resources.skillsScope;
      const effectiveHooksScope = hooksScope ?? resources.hooksScope;
      const originalHome = resolveOriginalHome(baseEnv);
      const tmpHome = await prepareIsolatedKimiHome({
        originalHome,
        env: baseEnv,
        skillsScope: effectiveSkillsScope,
        hooksScope: effectiveHooksScope,
      });
      const worktree = node.worktree ?? cwd;
      const mergedEnv = buildSafeKimiChildEnv({}, baseEnv, {
        OMK_ORIGINAL_HOME: originalHome,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        HOMEDRIVE: "",
        HOMEPATH: tmpHome,
        PWD: worktree ?? process.cwd(),
        CODEX_HOME: join(tmpHome, ".codex"),
      });
      const args: string[] = [];
      const mcpAllowlist = resolveNodeMcpAllowlist(node, nodeEnv, mcpNames);
      await injectKimiGlobals(args, { mcpScope: effectiveMcpScope, skillsScope: effectiveSkillsScope, hooksScope: effectiveHooksScope, role: node.role, mcpAllowlist });
      await preflightMcpConfigs(args);

      if (process.env.OMK_DEBUG === "1") {
        const mcpConfigIdx = args.indexOf("--mcp-config-file");
        if (mcpConfigIdx >= 0) {
          const configPath = args[mcpConfigIdx + 1];
          try {
            const configContent = await readFile(configPath, "utf-8");
            const config = JSON.parse(configContent);
            const servers = config.mcpServers ?? {};
            const count = Object.keys(servers).length;
            console.error(`[omk:mcp] passing ${count} server(s) to Kimi via ${configPath}`);
          } catch { /* ignore */ }
        }
      }

      const resolvedAgentFile = roleAgentFiles
        ? await resolveAgentFileForRole(node.role, agentFile)
        : agentFile;
      if (resolvedAgentFile) {
        const capabilityScopes = capabilityScopesFromRouting(node.routing, {
          mcpServers: mcpNames ?? [],
          skills: skillNames ?? [],
          hooks: hookNames ?? [],
          tools: toolNames ?? [],
        });
        const scopedAgentFile = await writeScopedAgentFile({
          baseAgentFile: resolvedAgentFile,
          outputFile: defaultScopedRoleAgentFile(getProjectRoot(), mergedEnv.OMK_RUN_ID ?? mergedEnv.OMK_SESSION_ID, node.role, node.id),
          role: node.role,
          resources: {
            mcpScope: effectiveMcpScope,
            skillsScope: effectiveSkillsScope,
            hooksScope: effectiveHooksScope,
            mcpNames: [...capabilityScopes.mcpServers],
            skillNames: [...capabilityScopes.skills],
            hookNames: [...capabilityScopes.hooks],
            toolNames: [...capabilityScopes.tools],
          },
        });
        args.push("--agent-file", scopedAgentFile);
      }
      const promptInput = buildNodeMessage(node, mergedEnv, promptPrefix);
      args.push("--print", "--input-format", "text");

      if (worktree) {
        await ensureDir(worktree);
      }

      const runId = mergedEnv.OMK_RUN_ID;
      const logPath = runId
        ? join(getProjectRoot(), ".omk", "runs", runId, `${node.id}.log`)
        : undefined;

      const thinkingHandler = createLiveThinkingHandler(currentOnThinking);

      const effectiveTimeout = await resolveTimeoutMs({ timeoutMs: timeout, timeoutPreset: node.timeoutPreset });

      // Binary resolution guard for DAG mode
      const kimiBin = resolveKimiBin(mergedEnv);
      const kimiAvailable = await checkCommand(kimiBin);
      if (!kimiAvailable) {
        return {
          success: false,
          exitCode: 1,
          stdout: "",
          stderr: `[omk] Primary provider (kimi) not found: ${kimiBin}. Install Kimi CLI or set KIMI_BIN to an alternative provider binary.`,
        };
      }
      let result: Awaited<ReturnType<typeof runShellStreaming>>;
      try {
        const continuePromptGuard = new KimiContinuePromptGuard({ maxAutoEnters: Number(process.env.OMK_KIMI_MAX_AUTO_ENTER ?? 5) });
        result = await runShellStreaming(kimiBin, args, {
          cwd: worktree,
          timeout: effectiveTimeout,
          env: mergedEnv,
          input: promptInput,
          logPath,
          onStdout: (chunk, io) => {
            const safeChunk = sanitizeUserVisibleOutput(chunk);
            options.onOutput?.(safeChunk);
            thinkingHandler?.(chunk);
            const decision = continuePromptGuard.process(chunk);
            if (decision.sendEnter) {
              io?.writeStdin("\n");
              process.stderr.write("[omk] auto-entered Kimi continue prompt\n");
            }
            if (decision.exceeded) {
              process.stderr.write(`[omk] ${decision.reason}\n`);
              io?.terminate(decision.reason ?? "Kimi continue prompt loop detected");
            }
          },
          onStderr: (chunk, io) => {
            const decision = continuePromptGuard.process(chunk);
            if (decision.sendEnter) {
              io?.writeStdin("\n");
              process.stderr.write("[omk] auto-entered Kimi continue prompt\n");
            }
            if (decision.exceeded) {
              process.stderr.write(`[omk] ${decision.reason}\n`);
              io?.terminate(decision.reason ?? "Kimi continue prompt loop detected");
            }
          },
          signal,
        });
      } finally {
        await cleanupIsolatedKimiHome(tmpHome);
      }

      // Debug: log runner result so we can diagnose unexpected failures
      if (result.failed || result.exitCode !== 0) {
        const stderrPreview = result.stderr.slice(0, 500).replace(/\n/g, "\\n");
        process.stderr.write(
          `[omk-debug] node=${node.id} exitCode=${result.exitCode} failed=${result.failed} stdoutLen=${result.stdout.length} stderrLen=${result.stderr.length} stderrPreview=${stderrPreview}\n`
        );
        if (result.stderr.includes("Failed to connect MCP servers")) {
          process.stderr.write(
            style.red(
              `[omk] MCP server connection failure detected in node ${node.id}.\n` +
                `      Run 'omk doctor' to check MCP status, or disable the failing server in ~/.kimi/mcp.json.\n`
            )
          );
        }
        if (result.stderr.includes("text content is empty")) {
          process.stderr.write(
            style.red(
              `[omk] Kimi API returned 400 "text content is empty" in node ${node.id}.\n` +
                `      This is a known Kimi CLI bug (fixed in v1.39.0, 2026-04-24).\n` +
                `      Upgrade Kimi CLI: npm i -g @anthropic-ai/kimi-code\n`
            )
          );
        }
        const providerHint = formatKimiProviderFailureHint(`${result.stderr}\n${result.stdout}`);
        if (providerHint) {
          process.stderr.write(style.orange(providerHint));
        }
      }

      const providerHint = formatKimiProviderFailureHint(`${result.stderr}\n${result.stdout}`);
      if (providerHint && !result.stderr.includes("[omk] Kimi monthly quota exhausted")) {
        result = {
          ...result,
          stderr: result.stderr ? `${result.stderr}\n${providerHint}` : providerHint,
        };
      }

      const prefix = `[${node.id}:${node.role}] `;
      const prefixStdout = result.stdout
        .split("\n")
        .map((line) => (line.trim() ? prefix + line : line))
        .join("\n");
      const prefixStderr = result.stderr
        .split("\n")
        .map((line) => (line.trim() ? prefix + line : line))
        .join("\n");

      // Known MCP soft-failure: Kimi CLI may return exit code 1 when an MCP
      // server fails to connect, even though it produced meaningful stdout.
      // Only allow this specific exception; all other non-zero exits are failures.
      const optionalMcpFailure = isOptionalMcpFailureResult(node, `${result.stderr}\n${result.stdout}`, result.stdout.trim().length > 0);
      const stderrWithOptionalWarning = optionalMcpFailure
        ? [
            prefixStderr,
            `${prefix}[omk] Warning: optional MCP server startup failed; continuing because this node does not require MCP.`,
          ].filter(Boolean).join("\n")
        : prefixStderr;
      return {
        success: (!result.failed && result.exitCode === 0) || optionalMcpFailure,
        exitCode: result.exitCode,
        stdout: prefixStdout,
        stderr: stderrWithOptionalWarning,
      };
    },
  };

  return runner;
}


function buildNodeMessage(
  node: DagNode,
  env: Record<string, string>,
  promptPrefix?: string
): string {
  const routing = node.routing;
  if (routing?.promptMode === "dnc-nlp") {
    return [promptPrefix?.trim(), node.name].filter((section): section is string => Boolean(section)).join("\n\n");
  }
  const routingDirectives: string[] = [];
  if (routing?.skills?.length) {
    routingDirectives.push(`- Selected skills (use when relevant): ${routing.skills.join(", ")}`);
  }
  if (routing?.mcpServers?.length) {
    routingDirectives.push(
      routing.requiresMcp
        ? `- Required MCP servers: ${routing.mcpServers.join(", ")}`
        : `- Optional MCP servers: ${routing.mcpServers.join(", ")}`
    );
  }
  if (routing?.tools?.length) {
    routingDirectives.push(
      routing.requiresToolCalling
        ? `- Required tools: ${routing.tools.join(", ")}`
        : `- Available tools: ${routing.tools.join(", ")}`
    );
  }
  if (routing?.hooks?.length) {
    routingDirectives.push(`- Hooks (active boundaries): ${routing.hooks.join(", ")}`);
  }
  const provider = routing?.assignedProvider ?? routing?.provider;
  if (provider) {
    routingDirectives.push(`- Provider route: ${provider}${routing?.assignedProviderAuthority ? ` (${routing.assignedProviderAuthority})` : ""}`);
  }
  if (routing?.rationale) {
    routingDirectives.push(`- Rationale: ${routing.rationale}`);
  }
  const deepseekAdvisory = env.OMK_DEEPSEEK_ADVISORY?.trim();
  const actionAtom = routing?.actionAtom;
  const actionAtomSection = actionAtom
    ? [
        "ActionAtom contract (source of truth for this node):",
        `- id: ${actionAtom.id}`,
        `- label: ${actionAtom.label}`,
        `- verb: ${actionAtom.verb}`,
        `- object: ${actionAtom.object ?? "assigned scope"}`,
        `- evidence target: ${actionAtom.evidenceTarget}`,
        `- done condition: ${actionAtom.doneCondition}`,
      ].join("\n")
    : undefined;

  const sections = [
    promptPrefix?.trim(),
    [
      `Execute DAG node: ${node.id}`,
      `Name: ${node.name}`,
      `Role: ${node.role}`,
      `Run ID: ${env.OMK_RUN_ID ?? ""}`,
      `Dependencies: ${node.dependsOn.length > 0 ? node.dependsOn.join(", ") : "none"}`,
      `Context budget: ${routing?.contextBudget ?? env.OMK_CONTEXT_BUDGET ?? "small"}`,
      `Evidence required: ${String(routing?.evidenceRequired ?? env.OMK_ROUTE_EVIDENCE_REQUIRED ?? false)}`,
    ].join("\n"),
    actionAtomSection,
    routingDirectives.length > 0
      ? [
          "Routing directives:",
          ...routingDirectives,
          "- Do not activate every available MCP server, skill, or tool.",
          "- Activate only capabilities required by the current task.",
          "- Optional MCP server failures are warnings unless this node lists Required MCP servers.",
        ].join("\n")
      : undefined,
    deepseekAdvisory
      ? [
          "DeepSeek advisory (non-authoritative — verify before editing):",
          `- Status: ${env.OMK_DEEPSEEK_ADVISORY_STATUS ?? "success"}`,
          `- Model: ${env.OMK_DEEPSEEK_ADVISORY_MODEL ?? "deepseek-v4-pro"}`,
          deepseekAdvisory,
          "The OMK authority provider remains responsible for actual file edits, shell execution, evidence, and final acceptance.",
        ].join("\n")
      : undefined,
    [
      "Instructions:",
      "- Treat the prompt prefix as the active OMK orchestration contract; turn it into concrete node work, not a repeated summary.",
      "- Preserve completed work and continue only the unresolved scope named by this node.",
      "- Keep context small and read only the files needed for this node.",
      "- Use selected skills/MCP/tools only when they fit the node.",
      "- Produce concrete evidence, changed files, blockers, and verification result.",
      "- Do not silently skip required gates.",
    ].join("\n"),
  ].filter((section): section is string => Boolean(section));

  return sections.join("\n\n");
}

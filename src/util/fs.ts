import {
  mkdir,
  writeFile,
  readFile,
  access,
  chmod,
  constants,
  readdir,
  stat,
  symlink,
  rm,
  unlink,
  lstat,
  copyFile,
  realpath,
} from "fs/promises";
import { rmSync } from "fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "path";
import { homedir } from "os";
import { execa } from "execa";
import { style } from "./theme.js";
import {
  readQuarantine,
  writeQuarantine,
  addQuarantineEntry,
} from "../mcp/quarantine.js";
import { GLOBAL_MEMORY_CONFIG_TOML, getGlobalMemoryConfigPath } from "../memory/memory-config.js";
import { SyncManifestEntry, sha256, simpleDiff } from "./sync-manifest.js";
import { getOmkResourceSettings, type OmkRuntimeScope } from "./resource-profile.js";
import { getKimiCapabilities } from "../kimi/capability.js";
import {
  getProjectRoot as resolveProjectRootSync,
  getProjectRootAsync as resolveProjectRootAsyncPath,
  getProjectRootDiagnostics,
  resolveProjectRoot,
  resolveProjectRootAsync,
  displayProjectRootPath,
  type ProjectRootResolution,
  type ProjectRootSource,
} from "./project-root.js";

import { resolveRuntimeProfile, buildProfileArgs } from "./runtime-profile.js";

import {
  resolveRuntimeMcpPreflightMode,
  resolveRuntimeMcpPreflightOptions,
  type RuntimeMcpPreflightMode,
  type RuntimeMcpPreflightFailureReason,
  type RuntimeMcpPreflightEntryStatus,
  type RuntimeMcpPreflightOptions,
  type RuntimeMcpPreflightEntry,
  type RuntimeMcpPreflightResult,
} from "./mcp-preflight.js";

export {
  getProjectRootDiagnostics,
  resolveProjectRoot,
  resolveProjectRootAsync,
  displayProjectRootPath,
  type ProjectRootResolution,
  type ProjectRootSource,
  resolveRuntimeMcpPreflightMode,
  resolveRuntimeMcpPreflightOptions,
};

export type {
  RuntimeMcpPreflightMode,
  RuntimeMcpPreflightFailureReason,
  RuntimeMcpPreflightEntryStatus,
  RuntimeMcpPreflightOptions,
  RuntimeMcpPreflightEntry,
  RuntimeMcpPreflightResult,
};

type KimiGlobalSyncStepName = "hooks" | "mcp" | "skills" | "memory";

export interface KimiGlobalSyncOptions {
  dryRun?: boolean;
  diff?: boolean;
  quiet?: boolean;
  manifest?: SyncManifestEntry[];
  timestamp?: string;
}

export interface KimiGlobalSyncStepReport {
  name: KimiGlobalSyncStepName;
  changed: boolean;
  blocked: boolean;
  skipped: boolean;
  error?: string;
  manifest: SyncManifestEntry[];
}

export interface KimiGlobalSyncReport {
  changed: boolean;
  blocked: boolean;
  steps: KimiGlobalSyncStepReport[];
  actions: string[];
  skipped: string[];
  errors: string[];
  manifest: SyncManifestEntry[];
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeFileSafe(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, "utf-8");
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface RuntimeMcpPruneDiagnostic {
  name: string;
  kind: string;
  message: string;
}

export interface RuntimeMcpNormalization {
  name: string;
  kind: string;
  message: string;
}

function isGlobalWriteAllowed(): boolean {
  return /^(?:1|true|yes|on)$/i.test(process.env.OMK_MCP_ALLOW_WRITE_CONFIG ?? "");
}

function shouldRewriteMcpArgPath(server: Record<string, unknown>, arg: unknown, index: number): arg is string {
  if (typeof arg !== "string") return false;
  if (arg.startsWith("/") || arg.startsWith("http") || arg.startsWith("-")) return false;
  if (isShellInlineMcpArg(server, index)) return false;
  if (/[\s;"'|&<>]/.test(arg)) return false;
  if (isPackageManagerMcpServer(server) && isNpmPackageSpecifierArg(arg)) return false;
  return isExplicitRelativeMcpPathArg(arg, server, index);
}

function isShellInlineMcpArg(server: Record<string, unknown>, index: number): boolean {
  const command = typeof server.command === "string" ? server.command : "";
  const commandName = command.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? command.toLowerCase();
  if (!["bash", "sh", "zsh", "fish", "pwsh", "powershell", "cmd", "cmd.exe"].includes(commandName)) {
    return false;
  }
  const args = Array.isArray(server.args) ? server.args : [];
  const previous = args[index - 1];
  return previous === "-c" || previous === "-lc" || previous === "/c" || previous === "--command";
}

function isPackageManagerMcpServer(server: Record<string, unknown>): boolean {
  const command = typeof server.command === "string" ? server.command : "";
  const commandName = command.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? command.toLowerCase();
  return PACKAGE_MANAGER_COMMANDS.has(commandName);
}

function isNpmPackageSpecifierArg(arg: string): boolean {
  if (arg.startsWith(".") || arg.startsWith("/") || arg.includes("\\") || arg.includes(":")) return false;
  return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-z0-9._~+-]+)?$/i.test(arg);
}

function isExplicitRelativeMcpPathArg(arg: string, server: Record<string, unknown>, index: number): boolean {
  const args = Array.isArray(server.args) ? server.args : [];
  const previous = args[index - 1];
  if (typeof previous === "string" && /^(?:--?(?:config|file|path|root|dir|directory|cwd|database|db|schema|mount|workspace)|--(?:config|file|path|root|dir|directory|cwd|database|db|schema|mount|workspace)=)$/i.test(previous)) {
    return true;
  }
  if (arg.startsWith("./") || arg.startsWith("../")) return true;
  if (arg.includes("/") || arg.includes("\\")) return true;
  return /\.(?:[cm]?[jt]s|json|toml|ya?ml|py|sh|db|sqlite3?|wasm|bin)$/i.test(arg);
}

export function getManifestPath(): string {
  return getOmkPath("sync-manifest.json");
}

export function getBackupDir(timestamp: string): string {
  return getOmkPath(join("sync-backups", sanitizeBackupTimestamp(timestamp)));
}

function sanitizeBackupTimestamp(timestamp: string): string {
  const sanitized = timestamp.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  return sanitized.replace(/^-|-$/g, "") || "backup";
}

export async function readManifest(): Promise<SyncManifestEntry[]> {
  const path = getManifestPath();
  if (!(await pathExists(path))) return [];
  try {
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed as SyncManifestEntry[];
  } catch {
    // ignore invalid manifest
  }
  return [];
}

export async function writeManifest(entries: SyncManifestEntry[]): Promise<void> {
  const path = getManifestPath();
  await ensureDir(dirname(path));
  await writeFile(path, JSON.stringify(entries, null, 2) + "\n", "utf-8");
}

export async function backupFile(sourcePath: string, backupDir: string, relativePath: string): Promise<string> {
  const dest = join(backupDir, relativePath);
  await ensureDir(dirname(dest));
  await copyFile(sourcePath, dest);
  return dest;
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFile(path: string, defaultValue = ""): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return defaultValue;
  }
}

export function getProjectRoot(): string {
  return resolveProjectRootSync();
}

export async function getProjectRootAsync(): Promise<string> {
  return resolveProjectRootAsyncPath();
}

export function getUserHome(env: NodeJS.ProcessEnv = process.env): string {
  return (
    normalizeUserHomePath(env.OMK_ORIGINAL_HOME)
    ?? normalizeUserHomePath(env.HOME)
    ?? normalizeUserHomePath(env.USERPROFILE)
    ?? normalizeUserHomePath(homedir())
    ?? homedir()
  );
}

export function normalizeUserHomePath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = stripWrappingQuotes(value.trim());
  if (!trimmed) return undefined;

  const wslPath = normalizeWslUncPath(trimmed);
  return stripKimiConfigSuffix(wslPath ?? trimmed);
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeWslUncPath(value: string): string | undefined {
  const slashPath = value.replace(/\\/g, "/");
  const match = slashPath.match(/^\/\/wsl(?:\.localhost|\$)\/[^/]+(?:\/(.*))?$/i);
  if (!match) return undefined;
  const distroRelative = match[1] ?? "";
  return `/${distroRelative}`.replace(/\/+/g, "/");
}

function stripKimiConfigSuffix(value: string): string {
  const slashPath = value.replace(/\\/g, "/");
  const lower = slashPath.toLowerCase();
  for (const suffix of ["/.kimi/mcp.json", "/.kimi/config.toml", "/.kimi/skills"]) {
    if (lower.endsWith(suffix)) {
      return value.slice(0, value.length - suffix.length);
    }
  }
  if (lower.endsWith("/.kimi")) {
    return value.slice(0, value.length - "/.kimi".length);
  }
  return value;
}

export function getOmkPath(subPath?: string): string {
  const root = getProjectRoot();
  return subPath ? join(root, ".omk", subPath) : join(root, ".omk");
}

export {
  validateRunId,
  sanitizeRunId,
  validateRunArtifactPath,
  getRunsDir,
  getRunPath,
  getRunArtifactPath,
  listValidRunIds,
} from "./run-store.js";

export function getKimiConfigPath(): string {
  return join(getUserHome(), ".kimi", "config.toml");
}

const OMK_START_MARKER = "# >>> omk managed hooks — do not edit manually";
const OMK_END_MARKER = "# >>> end omk managed hooks";

/**
 * .omk/kimi.config.toml 의 hooks 를 ~/.kimi/config.toml 에 병합.
 * 상대 경로를 절대 경로로 변환하여 어디서 실행돼도 작동하도록 함.
 */
export async function mergeKimiHooks(
  omkConfigPath: string,
  options: KimiGlobalSyncOptions = {}
): Promise<boolean> {
  const manifest = options.manifest ?? [];
  const timestamp = options.timestamp ?? new Date().toISOString();
  const kimiConfigPath = getKimiConfigPath();
  const omkContent = await readTextFile(omkConfigPath, "");
  if (!omkContent.trim()) return false;

  const root = await getProjectRootAsync();
  const resolvedContent = resolveHookPaths(omkContent, root);

  const hooksContent = extractHooksBlocks(resolvedContent);
  if (!hooksContent) return false;

  let kimiContent = await readTextFile(kimiConfigPath, "");
  const previousContent = kimiContent;

  // 기존 omk 섹션 제거
  const startIdx = kimiContent.indexOf(OMK_START_MARKER);
  if (startIdx !== -1) {
    const endIdx = kimiContent.indexOf(OMK_END_MARKER, startIdx);
    if (endIdx !== -1) {
      const before = kimiContent.slice(0, startIdx).trimEnd();
      const after = kimiContent.slice(endIdx + OMK_END_MARKER.length).trimStart();
      kimiContent = before + (before && after ? "\n\n" : before ? "\n" : "") + after;
    }
  }

  const omkSection = `${OMK_START_MARKER}\n${hooksContent}\n${OMK_END_MARKER}\n`;

  if (!kimiContent.trim()) {
    kimiContent = omkSection;
  } else {
    kimiContent = kimiContent.trimEnd() + "\n\n" + omkSection;
  }

  if (previousContent === kimiContent) return false;

  if (!isGlobalWriteAllowed()) {
    if (!options.quiet) {
      console.warn(`⚠️  Skipping global write to ${kimiConfigPath} (set OMK_MCP_ALLOW_WRITE_CONFIG=1 to allow)`);
    }
    manifest.push({
      path: kimiConfigPath,
      scope: "global",
      action: "blocked",
      previousHash: previousContent.trim() ? sha256(previousContent) : null,
      newHash: sha256(kimiContent),
      backupPath: null,
      timestamp,
    });
    return true;
  }

  if (options.diff && previousContent.trim()) {
    console.log(`--- ${kimiConfigPath}`);
    console.log(`+++ ${kimiConfigPath}`);
    console.log(simpleDiff(previousContent, kimiContent));
  }

  if (!options.dryRun) {
    let backupPath: string | null = null;
    if (await pathExists(kimiConfigPath)) {
      const backupDir = getBackupDir(timestamp);
      backupPath = await backupFile(kimiConfigPath, backupDir, relative(getUserHome(), kimiConfigPath));
    }
    await writeFileSafe(kimiConfigPath, kimiContent);
    manifest.push({
      path: kimiConfigPath,
      scope: "global",
      action: previousContent.trim() ? "update" : "create",
      previousHash: previousContent.trim() ? sha256(previousContent) : null,
      newHash: sha256(kimiContent),
      backupPath,
      timestamp,
    });
  } else {
    manifest.push({
      path: kimiConfigPath,
      scope: "global",
      action: previousContent.trim() ? "update" : "create",
      previousHash: previousContent.trim() ? sha256(previousContent) : null,
      newHash: sha256(kimiContent),
      backupPath: null,
      timestamp,
    });
  }

  return true;
}

function resolveHookPaths(content: string, root: string): string {
  return content.replace(
    /command\s*=\s*["'](\.omk\/hooks\/[^"']+)["']/g,
    (_match, p1) => {
      const absPath = join(root, p1).replace(/\\/g, "/");
      return `command = "${absPath}"`;
    }
  );
}

export function extractHooksBlocks(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let foundHooks = false;
  for (const line of lines) {
    if (line.trim().startsWith("[[hooks]]")) foundHooks = true;
    if (foundHooks) result.push(line);
  }
  return result.join("\n").trim();
}

/* ──────────────────────────────────────────────
 *  Global sync: .kimi/  →  ~/.kimi/
 * ────────────────────────────────────────────── */

/** 프로젝트의 .omk/mcp.json + .kimi/mcp.json → ~/.kimi/mcp.json 병합 */
export async function syncKimiMcpGlobal(
  options: KimiGlobalSyncOptions = {}
): Promise<boolean> {
  const manifest = options.manifest ?? [];
  const timestamp = options.timestamp ?? new Date().toISOString();
  const globalMcpPath = join(getUserHome(), ".kimi", "mcp.json");
  const root = await getProjectRootAsync();
  const projectConfigs = [join(root, ".omk", "mcp.json"), join(root, ".kimi", "mcp.json")];

  const mergedServers: Record<string, unknown> = {};
  let hasAny = false;

  for (const p of projectConfigs) {
    if (!(await pathExists(p))) continue;
    try {
      const content = await readTextFile(p, "{}");
      const parsed = JSON.parse(content);
      if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
        const root = await getProjectRootAsync();
        for (const [name, server] of Object.entries(parsed.mcpServers)) {
          const s = server as Record<string, unknown>;
          // args의 상대 경로를 MCP 설정 파일 기준 절대 경로로 변환.
          // Shell snippets such as `set -a; source ...; exec npx ...` must
          // remain untouched or MCP configs become broken Windows/WSL paths.
          if (Array.isArray(s.args)) {
            s.args = s.args.map((arg: unknown, index: number) => {
              if (shouldRewriteMcpArgPath(s, arg, index)) {
                return join(root, arg);
              }
              return arg;
            });
          }
          mergedServers[name] = s;
        }
        hasAny = true;
      }
    } catch {
      // ignore invalid JSON
    }
  }

  if (!hasAny) return false;

  // 기존 글로벌 mcp.json 읽기
  let globalParsed: { mcpServers?: Record<string, unknown> } = {};
  let previousContent = "";
  if (await pathExists(globalMcpPath)) {
    try {
      previousContent = await readTextFile(globalMcpPath, "{}");
      globalParsed = JSON.parse(previousContent);
    } catch {
      // ignore
    }
  }

  // 병합: 글로벌 먼저, 프로젝트가 같은 키 덮어씀
  const finalServers = { ...(globalParsed.mcpServers ?? {}), ...mergedServers };
  const newContent = JSON.stringify({ mcpServers: finalServers }, null, 2) + "\n";

  if (previousContent === newContent) return false;

  if (!isGlobalWriteAllowed()) {
    if (!options.quiet) {
      console.warn(`⚠️  Skipping global write to ${globalMcpPath} (set OMK_MCP_ALLOW_WRITE_CONFIG=1 to allow)`);
    }
    manifest.push({
      path: globalMcpPath,
      scope: "global",
      action: "blocked",
      previousHash: previousContent ? sha256(previousContent) : null,
      newHash: sha256(newContent),
      backupPath: null,
      timestamp,
    });
    return true;
  }

  if (options.diff && previousContent) {
    console.log(`--- ${globalMcpPath}`);
    console.log(`+++ ${globalMcpPath}`);
    console.log(simpleDiff(previousContent, newContent));
  }

  if (!options.dryRun) {
    let backupPath: string | null = null;
    if (await pathExists(globalMcpPath)) {
      const backupDir = getBackupDir(timestamp);
      backupPath = await backupFile(globalMcpPath, backupDir, relative(getUserHome(), globalMcpPath));
    }
    await writeFileSafe(globalMcpPath, newContent);
    manifest.push({
      path: globalMcpPath,
      scope: "global",
      action: previousContent ? "update" : "create",
      previousHash: previousContent ? sha256(previousContent) : null,
      newHash: sha256(newContent),
      backupPath,
      timestamp,
    });
  } else {
    manifest.push({
      path: globalMcpPath,
      scope: "global",
      action: previousContent ? "update" : "create",
      previousHash: previousContent ? sha256(previousContent) : null,
      newHash: sha256(newContent),
      backupPath: null,
      timestamp,
    });
  }

  return true;
}

/** 프로젝트의 .kimi/skills/* → ~/.kimi/skills/ 심링크 */
export async function syncKimiSkillsGlobal(
  options: KimiGlobalSyncOptions = {}
): Promise<boolean> {
  const root = await getProjectRootAsync();
  const projectSkillsDir = join(root, ".kimi", "skills");
  const globalSkillsDir = join(getUserHome(), ".kimi", "skills");

  if (!(await pathExists(projectSkillsDir))) return false;

  const entries = await readdir(projectSkillsDir, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory());
  if (skillDirs.length === 0) return false;

  if (options.dryRun) {
    for (const dir of skillDirs) {
      options.manifest?.push({
        path: join(globalSkillsDir, dir.name),
        scope: "global",
        action: "symlink",
        previousHash: null,
        newHash: null,
        backupPath: null,
        timestamp: options.timestamp ?? new Date().toISOString(),
      });
    }
    return true;
  }

  if (!isGlobalWriteAllowed()) {
    if (!options.quiet) {
      console.warn(`⚠️  Skipping global skills sync to ${globalSkillsDir} (set OMK_MCP_ALLOW_WRITE_CONFIG=1 to allow)`);
    }
    for (const dir of skillDirs) {
      options.manifest?.push({
        path: join(globalSkillsDir, dir.name),
        scope: "global",
        action: "blocked",
        previousHash: null,
        newHash: null,
        backupPath: null,
        timestamp: options.timestamp ?? new Date().toISOString(),
      });
    }
    return true;
  }

  await ensureDir(globalSkillsDir);

  // 깨진 심링크 정리
  try {
    const globalEntries = await readdir(globalSkillsDir, { withFileTypes: true });
    for (const e of globalEntries) {
      if (!e.isSymbolicLink()) continue;
      const linkPath = join(globalSkillsDir, e.name);
      try {
        await access(linkPath, constants.F_OK);
      } catch {
        await unlink(linkPath);
      }
    }
  } catch {
    // ignore
  }

  for (const dir of skillDirs) {
    const src = resolve(join(projectSkillsDir, dir.name));
    const dest = join(globalSkillsDir, dir.name);

    // 사용자가 직접 설치한 폴더(심링크 아님)는 건드리지 않음
    try {
      const destStat = await lstat(dest);
      if (!destStat.isSymbolicLink()) continue;
      await unlink(dest);
    } catch {
      // dest 없음 → OK
    }

    try {
      await symlink(src, dest, "dir");
    } catch {
      // 심링크 실패 시 복사 fallback — dest 가 실제 사용자 디렉토리가 아닌지 재확인
      try {
        const st = await lstat(dest);
        if (!st.isSymbolicLink()) continue; // 사용자 데이터 보호
        await rm(dest, { recursive: true, force: true });
      } catch {
        // dest 없음 → 복사만 진행
      }
      await copyDir(src, dest);
    }
  }

  return true;
}

async function copyDir(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

/** local graph memory policy를 ~/.kimi/omk.memory.toml 에 동기화 */
export async function syncKimiMemoryGlobal(
  options: KimiGlobalSyncOptions = {}
): Promise<boolean> {
  const manifest = options.manifest ?? [];
  const timestamp = options.timestamp ?? new Date().toISOString();
  const memoryPath = getGlobalMemoryConfigPath();
  const previousContent = await readTextFile(memoryPath, "");
  const newContent = GLOBAL_MEMORY_CONFIG_TOML;

  if (previousContent === newContent) return false;

  if (!isGlobalWriteAllowed()) {
    if (!options.quiet) {
      console.warn(`⚠️  Skipping global write to ${memoryPath} (set OMK_MCP_ALLOW_WRITE_CONFIG=1 to allow)`);
    }
    manifest.push({
      path: memoryPath,
      scope: "global",
      action: "blocked",
      previousHash: previousContent.trim() ? sha256(previousContent) : null,
      newHash: sha256(newContent),
      backupPath: null,
      timestamp,
    });
    return true;
  }

  if (options.diff && previousContent.trim()) {
    console.log(`--- ${memoryPath}`);
    console.log(`+++ ${memoryPath}`);
    console.log(simpleDiff(previousContent, newContent));
  }

  if (!options.dryRun) {
    let backupPath: string | null = null;
    if (await pathExists(memoryPath)) {
      const backupDir = getBackupDir(timestamp);
      backupPath = await backupFile(memoryPath, backupDir, relative(getUserHome(), memoryPath));
    }
    await writeFileSafe(memoryPath, newContent);
    manifest.push({
      path: memoryPath,
      scope: "global",
      action: previousContent.trim() ? "update" : "create",
      previousHash: previousContent.trim() ? sha256(previousContent) : null,
      newHash: sha256(newContent),
      backupPath,
      timestamp,
    });
  } else {
    manifest.push({
      path: memoryPath,
      scope: "global",
      action: previousContent.trim() ? "update" : "create",
      previousHash: previousContent.trim() ? sha256(previousContent) : null,
      newHash: sha256(newContent),
      backupPath: null,
      timestamp,
    });
  }

  return true;
}

/** Sync hooks + MCP + skills to ~/.kimi/ at once */
export async function syncAllKimiGlobals(
  options: KimiGlobalSyncOptions = {}
): Promise<KimiGlobalSyncReport> {
  const manifest = options.manifest ?? [];
  const steps: KimiGlobalSyncStepReport[] = [];
  const actions: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  async function runStep(name: KimiGlobalSyncStepName, fn: () => Promise<boolean>): Promise<void> {
    const before = manifest.length;
    try {
      const changed = await fn();
      const stepManifest = manifest.slice(before);
      const blockedEntries = stepManifest.filter((entry) => entry.action === "blocked");
      const blocked = blockedEntries.length > 0;
      const step: KimiGlobalSyncStepReport = {
        name,
        changed: changed && !blocked,
        blocked,
        skipped: !changed,
        manifest: stepManifest,
      };
      steps.push(step);
      if (blocked) {
        skipped.push(`${name}: global write blocked for ${blockedEntries.map((entry) => entry.path).join(", ")}`);
      } else if (changed) {
        actions.push(`${name}: synced`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!options.quiet) {
        console.warn(`⚠️  ${name} global sync failed:`, message);
      }
      errors.push(`${name}: ${message}`);
      steps.push({
        name,
        changed: false,
        blocked: false,
        skipped: true,
        error: message,
        manifest: manifest.slice(before),
      });
    }
  }

  const configFile = getOmkPath("kimi.config.toml");
  if (await pathExists(configFile)) {
    await runStep("hooks", () => mergeKimiHooks(configFile, { ...options, manifest }));
  } else {
    steps.push({ name: "hooks", changed: false, blocked: false, skipped: true, manifest: [] });
  }

  await runStep("mcp", () => syncKimiMcpGlobal({ ...options, manifest }));
  await runStep("skills", () => syncKimiSkillsGlobal({ ...options, manifest }));
  await runStep("memory", () => syncKimiMemoryGlobal({ ...options, manifest }));

  return {
    changed: actions.length > 0,
    blocked: steps.some((step) => step.blocked),
    steps,
    actions,
    skipped,
    errors,
    manifest,
  };
}

/** Canonical OMK-first MCP config collection with Kimi files kept as compatibility input. */
export async function collectMcpConfigs(scope: OmkRuntimeScope = "project"): Promise<string[]> {
  const configs: string[] = [];
  if (scope === "none") return configs;

  const root = await getProjectRootAsync();
  const omkMcp = join(root, ".omk", "mcp.json");
  const kimiMcp = join(root, ".kimi", "mcp.json");
  const globalMcp = join(getUserHome(), ".kimi", "mcp.json");
  const globalOmkMcp = join(getUserHome(), ".omk", "mcp.json");

  if (scope === "all") {
    if (await pathExists(globalMcp)) configs.push(globalMcp);
    if (await pathExists(globalOmkMcp)) configs.push(globalOmkMcp);
  }

  const [kimiMcpExists, omkMcpExists] = await Promise.all([
    pathExists(kimiMcp),
    pathExists(omkMcp),
  ]);
  // .kimi/mcp.json is a legacy Kimi-adapter MCP source.
  // .omk/mcp.json is the provider-neutral OMK project MCP mirror/fallback.
  if (kimiMcpExists) configs.push(kimiMcp);
  else if (omkMcpExists) configs.push(omkMcp);

  return [...new Set(configs)];
}

async function readMcpServersForRuntime(configPath: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(content) as { mcpServers?: unknown; mcp_servers?: unknown };
    const servers = parsed.mcpServers ?? parsed.mcp_servers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      return normalizeRuntimeMcpRelativePaths(servers as Record<string, unknown>, configPath);
    }
  } catch {
    // Existing doctor/preflight paths report invalid config details. Runtime merge
    // skips unreadable files so Kimi does not receive partial/broken JSON.
  }
  return {};
}

function normalizeRuntimeMcpRelativePaths(servers: Record<string, unknown>, configPath: string): Record<string, unknown> {
  const baseDir = runtimeMcpPathBase(configPath);
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, normalizeRuntimeMcpRelativePathServer(server, baseDir)])
  );
}

function runtimeMcpPathBase(configPath: string): string {
  const root = resolve(getProjectRoot());
  const resolvedConfig = resolve(configPath);
  const relativeToRoot = relative(root, resolvedConfig);
  if (relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !isAbsolute(relativeToRoot))) {
    return root;
  }
  return dirname(resolvedConfig);
}

function normalizeRuntimeMcpRelativePathServer(server: unknown, baseDir: string): unknown {
  if (!isRecord(server) || typeof server.url === "string") return server;
  let changed = false;
  const next: Record<string, unknown> = { ...server };
  if (typeof next.command === "string" && isRelativeRuntimeMcpPathLike(next.command)) {
    next.command = resolve(baseDir, next.command);
    changed = true;
  }
  if (Array.isArray(next.args)) {
    const args = next.args.map((arg, index) => {
      if (typeof arg === "string" && isShellInlineMcpArg(server, index)) {
        const normalized = normalizeRuntimeMcpInlineScript(arg, baseDir);
        if (normalized.changed) changed = true;
        return normalized.script;
      }
      if (!shouldNormalizeRuntimeMcpRelativeArg(server, arg, index)) return arg;
      changed = true;
      return resolve(baseDir, arg);
    });
    next.args = args;
  }
  return changed ? next : server;
}

function isRelativeRuntimeMcpPathLike(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../") || value.startsWith(".\\") || value.startsWith("..\\");
}

function shouldNormalizeRuntimeMcpRelativeArg(server: Record<string, unknown>, arg: unknown, index: number): arg is string {
  if (typeof arg !== "string" || !isRelativeRuntimeMcpPathLike(arg)) return false;
  if (isShellInlineMcpArg(server, index)) return false;
  if (/[ \t\r\n;"'|&<>]/.test(arg)) return false;
  return true;
}

function normalizeRuntimeMcpInlineScript(script: string, baseDir: string): { script: string; changed: boolean } {
  let changed = false;
  const nextScript = script.replace(
    /(^|[\s"'`=:(])((?:\.{1,2}[\\/])[^ \t\r\n"'`|&;<>:)]+)/g,
    (match, prefix: string, relativePath: string) => {
      if (/[$*?[\]{}]/.test(relativePath)) return match;
      const absolutePath = resolve(baseDir, relativePath);
      if (/[ \t\r\n"'`]/.test(absolutePath)) return match;
      changed = true;
      return `${prefix}${absolutePath}`;
    }
  );
  return { script: nextScript, changed };
}

const SHELL_BUILTIN_MCP_COMMANDS = new Set([
  "set",
  "source",
  "export",
  "alias",
  "cd",
  "copy",
  "del",
  "dir",
  "move",
  "start",
]);

const WINDOWS_SYSTEM32_SET_RE = /(?:^|\/)mnt\/[a-z]\/windows\/system32\/set(?:\.exe)?(?:\s|$|[;&|])/i;
const POSIX_HOME_REF_RE = /\/home\/([A-Za-z0-9._-]+)(?:\/|$)/g;
const NODE_PACKAGE_MANAGER_COMMANDS = new Set([
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "bunx",
  "npm.cmd",
  "npx.cmd",
  "pnpm.cmd",
  "yarn.cmd",
  "bun.cmd",
  "bunx.cmd",
  "npm.exe",
  "npx.exe",
  "pnpm.exe",
  "yarn.exe",
  "bun.exe",
  "bunx.exe",
]);
const PYTHON_PACKAGE_MANAGER_COMMANDS = new Set([
  "uv",
  "uvx",
  "pip",
  "pip3",
  "pipx",
  "poetry",
  "rye",
  "uv.exe",
  "uvx.exe",
  "pip.exe",
  "pip3.exe",
  "pipx.exe",
  "poetry.exe",
  "rye.exe",
]);
const PACKAGE_MANAGER_COMMANDS = new Set([
  ...NODE_PACKAGE_MANAGER_COMMANDS,
  ...PYTHON_PACKAGE_MANAGER_COMMANDS,
]);
const PYTHON_RUNTIME_COMMANDS = new Set(["python", "python3", "py", "python.exe", "python3.exe", "py.exe"]);
const INLINE_PACKAGE_MANAGER_RE = /(?:^|[\s/])(npm|npx|pnpm|yarn|bun|bunx|uv|uvx|pip|pip3|pipx|poetry|rye)(?:\.(?:cmd|exe))?(?:\s|$)/i;
const INLINE_PYTHON_PACKAGE_MANAGER_RE = /(?:^|[\s/])(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+(?:pip|pip3|uv)(?:\s|$)/i;
const STDIO_INCOMPATIBLE_HTTP_MCP_COMMANDS = new Set(["page-design-guide", "mcp-pdf-server"]);
const PDF_MCP_SERVER_RE = /(?:^|\s)(?:@modelcontextprotocol\/server-pdf|mcp-pdf-server)(?:\s|$)/i;
const EXPLICIT_STDIO_TRANSPORT_RE = /(?:^|\s)(?:--stdio|--transport(?:=|\s+)stdio)(?:\s|$)/i;
const EXPLICIT_HTTP_TRANSPORT_RE = /(?:^|\s)--transport(?:=|\s+)(?:http|sse|streamable-http)(?:\s|$)/i;
const HOST_HOME = homedir();

export const STALE_PACKAGE_NAMES: Record<string, string> = {
  "@supabase/mcp-server@latest": "@supabase/mcp-server-supabase@latest",
};

export const QUIET_PACKAGE_MANAGER_ENV: Record<string, string> = {
  npm_config_loglevel: "error",
  NPM_CONFIG_LOGLEVEL: "error",
  npm_config_progress: "false",
  NPM_CONFIG_PROGRESS: "false",
  npm_config_audit: "false",
  NPM_CONFIG_AUDIT: "false",
  npm_config_fund: "false",
  NPM_CONFIG_FUND: "false",
  npm_config_prefer_offline: "true",
  NPM_CONFIG_PREFER_OFFLINE: "true",
  npm_config_fetch_retries: "0",
  NPM_CONFIG_FETCH_RETRIES: "0",
  npm_config_fetch_retry_mintimeout: "1000",
  NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: "1000",
  npm_config_fetch_retry_maxtimeout: "1000",
  NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: "1000",
  npm_config_maxsockets: "3",
  NPM_CONFIG_MAXSOCKETS: "3",
  npm_config_update_notifier: "false",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  NO_UPDATE_NOTIFIER: "1",
  NODE_NO_WARNINGS: "1",
  UV_NO_PROGRESS: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  PIP_NO_INPUT: "1",
  PIP_NO_PYTHON_VERSION_WARNING: "1",
  PIP_PROGRESS_BAR: "off",
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function basenameOfRuntimeCommand(command: string): string {
  return command.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? command.toLowerCase();
}

function isRuntimePathLike(value: string): boolean {
  return value.startsWith("/")
    || value.startsWith("~/")
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith("\\\\");
}

function expandRuntimeUserPath(value: string): string {
  if (value === "~") return getUserHome();
  if (value.startsWith("~/")) return join(getUserHome(), value.slice(2));
  return value;
}

function allowedRuntimeHomes(): string[] {
  return [
    getUserHome(),
    HOST_HOME,
    homedir(),
    posixHomeRoot(process.execPath),
    posixHomeRoot(process.argv[1]),
    posixHomeRoot(getProjectRoot()),
  ]
    .map((home) => home.replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter((home, index, homes) => home.length > 0 && homes.indexOf(home) === index);
}

function posixHomeRoot(value: string | undefined): string {
  const match = value?.replace(/\\/g, "/").match(/^\/home\/[A-Za-z0-9._-]+(?:\/|$)/);
  return match ? match[0].replace(/\/$/, "") : "";
}

function containsStaleHomeReference(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  for (const match of normalized.matchAll(POSIX_HOME_REF_RE)) {
    const referencedHome = `/home/${match[1]}`;
    const allowed = allowedRuntimeHomes().some((home) => {
      const normalizedHome = home.replace(/\\/g, "/").replace(/\/+$/, "");
      return normalizedHome === referencedHome || normalizedHome.startsWith(`${referencedHome}/`);
    });
    if (!allowed) return true;
  }
  return false;
}

function shouldValidateRuntimeMcpArgPath(server: Record<string, unknown>, arg: unknown, index: number): arg is string {
  if (typeof arg !== "string") return false;
  if (!arg || arg.startsWith("-") || arg.startsWith("$") || /^https?:\/\//i.test(arg)) return false;
  if (isShellInlineMcpArg(server, index)) return false;
  if (/[ \t\r\n;"'|&<>]/.test(arg)) return false;
  return isRuntimePathLike(arg);
}

export function runtimeShellInlineScripts(server: Record<string, unknown>): string[] {
  const args = Array.isArray(server.args) ? server.args : [];
  return args.filter((arg, index): arg is string => typeof arg === "string" && isShellInlineMcpArg(server, index));
}

function runtimeCommandText(server: Record<string, unknown>): string {
  const command = typeof server.command === "string" ? server.command : "";
  const args = Array.isArray(server.args)
    ? server.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  return [command, ...args, ...runtimeShellInlineScripts(server)].join(" ");
}

function hasExplicitStdioTransport(server: Record<string, unknown>): boolean {
  return EXPLICIT_STDIO_TRANSPORT_RE.test(runtimeCommandText(server));
}

function hasHttpTransportMismatch(name: string, server: Record<string, unknown>): boolean {
  if (hasExplicitStdioTransport(server)) return false;
  const command = typeof server.command === "string" ? basenameOfRuntimeCommand(server.command) : "";
  const targetText = runtimeCommandText(server);
  if (PDF_MCP_SERVER_RE.test(targetText)) return true;
  if (STDIO_INCOMPATIBLE_HTTP_MCP_COMMANDS.has(command) || STDIO_INCOMPATIBLE_HTTP_MCP_COMMANDS.has(name)) {
    return true;
  }
  return EXPLICIT_HTTP_TRANSPORT_RE.test(targetText);
}

function findInlineScriptPaths(script: string): string[] {
  const paths = new Set<string>();
  const re = /(?:^|[\s"'`=:(])((?:~|\/)[^\s"'`|&;<>:]+?\.(?:cjs|mjs|js|py))(?:$|[\s"'`),;|&<>:])/gi;
  for (const match of script.matchAll(re)) {
    const candidate = match[1];
    if (!candidate || /[*?[\]{}$]/.test(candidate)) continue;
    paths.add(candidate);
  }
  return [...paths];
}

export async function diagnoseRuntimeMcpServer(
  name: string,
  server: unknown
): Promise<RuntimeMcpPruneDiagnostic[]> {
  const diagnostics: RuntimeMcpPruneDiagnostic[] = [];
  if (!isRecord(server)) {
    return [{ name, kind: "invalid-server", message: "server definition must be an object" }];
  }
  if (server.enabled === false) {
    return [{ name, kind: "disabled-server", message: "server is disabled" }];
  }
  if (typeof server.url === "string" && server.url.trim()) {
    return diagnostics;
  }

  const command = typeof server.command === "string" ? server.command.trim() : "";
  if (!command) {
    return [{ name, kind: "missing-command", message: "stdio server has no command" }];
  }

  const commandName = basenameOfRuntimeCommand(command);
  if (SHELL_BUILTIN_MCP_COMMANDS.has(commandName)) {
    diagnostics.push({
      name,
      kind: "shell-builtin-command",
      message: "shell built-in was configured as the MCP command; wrap it in a shell or move values to env",
    });
  }
  if (hasHttpTransportMismatch(name, server)) {
    diagnostics.push({
      name,
      kind: "stdio-http-transport",
      message: "stdio MCP config starts an HTTP MCP server that writes startup logs to stdout; configure it as a remote url or use stdio transport",
    });
  }

  if (isRuntimePathLike(command)) {
    const commandPath = expandRuntimeUserPath(command);
    if (containsStaleHomeReference(commandPath)) {
      diagnostics.push({ name, kind: "stale-home-reference", message: "MCP config references a different user home path" });
    }
    if (!(await pathExists(commandPath))) {
      diagnostics.push({ name, kind: "command-path-not-found", message: "configured command path does not exist" });
    }
  }

  for (const script of runtimeShellInlineScripts(server)) {
    if (containsStaleHomeReference(script)) {
      diagnostics.push({ name, kind: "stale-home-reference", message: "MCP config references a different user home path" });
    }
    if (WINDOWS_SYSTEM32_SET_RE.test(script.replace(/\\/g, "/"))) {
      diagnostics.push({
        name,
        kind: "windows-set-inline",
        message: "Windows System32 set was embedded in a shell MCP command and cannot be launched from WSL",
      });
    }
    for (const candidate of findInlineScriptPaths(script)) {
      const expanded = expandRuntimeUserPath(candidate);
      if (containsStaleHomeReference(expanded)) {
        diagnostics.push({ name, kind: "stale-home-reference", message: "MCP config references a different user home path" });
      }
      if (!(await pathExists(expanded))) {
        diagnostics.push({ name, kind: "inline-script-path-not-found", message: "inline MCP script references a missing local script" });
      }
    }
  }

  const args = Array.isArray(server.args) ? server.args : [];
  for (const [index, arg] of args.entries()) {
    if (!shouldValidateRuntimeMcpArgPath(server, arg, index)) continue;
    const argPath = expandRuntimeUserPath(arg);
    if (containsStaleHomeReference(argPath)) {
      diagnostics.push({ name, kind: "stale-home-reference", message: "MCP config references a different user home path" });
    }
    if (!(await pathExists(argPath))) {
      diagnostics.push({ name, kind: "arg-path-not-found", message: "MCP argument path does not exist" });
    }
  }

  // Detect known renamed/broken npm package names in MCP server args
  for (const arg of args) {
    if (typeof arg !== "string") continue;
    for (const [stale, current] of Object.entries(STALE_PACKAGE_NAMES)) {
      if (arg.includes(stale)) {
        diagnostics.push({
          name,
          kind: "stale-package-name",
          message: `MCP server package was renamed: ${stale} → ${current}. Run \`omk mcp migrate\` to auto-fix, or update the config manually.`,
        });
      }
    }
  }

  return diagnostics;
}

function isPackageManagerRuntimeServer(server: Record<string, unknown>): boolean {
  const command = typeof server.command === "string" ? basenameOfRuntimeCommand(server.command) : "";
  if (PACKAGE_MANAGER_COMMANDS.has(command)) return true;
  if (PYTHON_RUNTIME_COMMANDS.has(command)) {
    const args = Array.isArray(server.args)
      ? server.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] === "-m" && PYTHON_PACKAGE_MANAGER_COMMANDS.has(basenameOfRuntimeCommand(args[index + 1]))) {
        return true;
      }
    }
  }
  return runtimeShellInlineScripts(server).some((script) => {
    const normalized = script.replace(/\\/g, "/");
    return INLINE_PACKAGE_MANAGER_RE.test(normalized) || INLINE_PYTHON_PACKAGE_MANAGER_RE.test(normalized);
  });
}

interface PreflightProbe {
  command: string;
  args: string[];
  env: Record<string, string>;
  packageSpec: string;
}

const NPM_FAMILY_RUNTIME_COMMANDS = new Set([
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "bunx",
  "npm.cmd",
  "npx.cmd",
  "pnpm.cmd",
  "yarn.cmd",
  "bun.cmd",
  "bunx.cmd",
  "npm.exe",
  "npx.exe",
  "pnpm.exe",
  "yarn.exe",
  "bun.exe",
  "bunx.exe",
]);

const PACKAGE_ARG_OPTIONS_WITH_VALUE = new Set([
  "-p",
  "--package",
  "--package-name",
  "--registry",
  "--cache",
  "--userconfig",
  "--prefix",
]);

const PACKAGE_ARG_FLAGS = new Set([
  "-y",
  "--yes",
  "--quiet",
  "--silent",
  "--no",
  "--no-install",
  "--ignore-existing",
  "--prefer-offline",
  "--offline",
]);

function isRuntimePackageSpecifier(value: string): boolean {
  if (!value || value.startsWith("-") || value === "--") return false;
  if (/^(?:https?|git\+ssh|git\+https?):/i.test(value)) return false;
  if (value.startsWith(".") || value.startsWith("/") || value.startsWith("~") || value.includes("\\") || value.includes(":")) return false;
  return /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[a-z0-9._~+-]+)?$/i.test(value);
}

function findPackageSpecifier(args: string[], commandName: string): string | null {
  let start = 0;
  if (commandName === "npm" && ["exec", "x", "dlx"].includes(args[0] ?? "")) start = 1;
  if (commandName === "pnpm" && ["dlx", "exec"].includes(args[0] ?? "")) start = 1;
  if (commandName === "yarn" && ["dlx", "exec"].includes(args[0] ?? "")) start = 1;
  if (commandName === "bun" && ["x", "runx"].includes(args[0] ?? "")) start = 1;

  for (let i = start; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg === "--") break;
    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length);
      return isRuntimePackageSpecifier(value) ? value : null;
    }
    if (PACKAGE_ARG_OPTIONS_WITH_VALUE.has(arg)) {
      const value = args[i + 1];
      if (arg === "-p" || arg === "--package" || arg === "--package-name") {
        return value && isRuntimePackageSpecifier(value) ? value : null;
      }
      i += 1;
      continue;
    }
    if (PACKAGE_ARG_FLAGS.has(arg)) continue;
    if (arg.startsWith("-")) continue;
    return isRuntimePackageSpecifier(arg) ? arg : null;
  }

  return null;
}

function runtimeNpmPreflightEnv(concurrency: number): Record<string, string> {
  const maxSockets = String(Math.max(1, Math.min(16, concurrency)));
  return {
    ...QUIET_PACKAGE_MANAGER_ENV,
    npm_config_maxsockets: maxSockets,
    NPM_CONFIG_MAXSOCKETS: maxSockets,
  };
}

function isSafeNpmPreflightEnvKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (/(?:token|secret|password|passwd|credential|auth|cookie|key)/i.test(key)) return false;
  if (["http_proxy", "https_proxy", "no_proxy"].includes(lower)) return true;
  if (!lower.startsWith("npm_config_")) return false;
  const npmKey = lower.slice("npm_config_".length).replace(/-/g, "_");
  return [
    "registry",
    "proxy",
    "https_proxy",
    "http_proxy",
    "noproxy",
    "no_proxy",
    "strict_ssl",
    "cafile",
    "userconfig",
    "cache",
  ].includes(npmKey);
}

function runtimeNpmPreflightServerEnv(server: Record<string, unknown>): Record<string, string> {
  const env = isRecord(server.env) ? server.env : {};
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isSafeNpmPreflightEnvKey(key)) continue;
    if (typeof value === "string") {
      safe[key] = value;
    }
  }
  return safe;
}

function isNpmFamilyRuntimeServer(server: Record<string, unknown>): boolean {
  const command = typeof server.command === "string" ? basenameOfRuntimeCommand(server.command) : "";
  return NPM_FAMILY_RUNTIME_COMMANDS.has(command);
}

function buildPreflightProbeCommand(server: Record<string, unknown>, concurrency: number): PreflightProbe | null {
  const command = typeof server.command === "string" ? server.command : "";
  if (!command) return null;
  const commandName = basenameOfRuntimeCommand(command);
  if (!NPM_FAMILY_RUNTIME_COMMANDS.has(commandName)) return null;
  if (runtimeShellInlineScripts(server).length > 0) return null;

  const args = Array.isArray(server.args)
    ? server.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const packageSpec = findPackageSpecifier(args, commandName);
  if (!packageSpec) return null;

  return {
    command: "npm",
    args: [
      "view",
      packageSpec,
      "version",
      "--json",
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
      "--progress=false",
      "--loglevel=error",
      "--fetch-retries=0",
      "--fetch-retry-mintimeout=1000",
      "--fetch-retry-maxtimeout=1000",
      `--maxsockets=${Math.max(1, Math.min(16, concurrency))}`,
    ],
    env: {
      ...runtimeNpmPreflightEnv(concurrency),
      ...runtimeNpmPreflightServerEnv(server),
    },
    packageSpec,
  };
}

function sanitizeRuntimeMcpPreflightText(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***")
    .replace(/(--(?:api-)?(?:token|key|secret|password)(?:=|\s+))[^"'`\s;]+/gi, "$1***")
    .replace(/([A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Za-z0-9_]*\s*=\s*)[^"'`\s;]+/gi, "$1***")
    .replace(/([?&](?:token|api[-_]?key|key|secret|password|auth|credential|session|bearer|access[-_]?token|refresh[-_]?token|client[-_]?secret|x[-_]?auth[-_]?token|signature|sig)=)[^&#\s]+/gi, "$1***");
}

function formatPreflightFailureDetail(
  reason: RuntimeMcpPreflightFailureReason | undefined,
  detail: string | undefined
): string {
  if (reason === "timeout") return "timeout";
  return sanitizeRuntimeMcpPreflightText(detail ?? "failed");
}

function safePreflightProcessEnv(): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of ["PATH", "Path", "HOME", "USERPROFILE", "TMP", "TMPDIR", "TEMP", "SystemRoot", "ComSpec"]) {
    const value = process.env[key];
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

async function runBoundedPreflightProcess(
  command: string,
  args: string[],
  options: {
    env: Record<string, string>;
    extendEnv: boolean;
    timeoutMs: number;
  }
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  const timeoutMarker = Symbol("runtime-mcp-preflight-timeout");
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const subprocess = execa(command, args, {
    env: options.env,
    extendEnv: options.extendEnv,
    reject: false,
    stdio: "ignore",
  });

  try {
    const result = await Promise.race([
      subprocess,
      new Promise<typeof timeoutMarker>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutMarker), options.timeoutMs);
      }),
    ]);
    if (result === timeoutMarker) {
      subprocess.kill("SIGTERM", new Error(`timeout after ${options.timeoutMs}ms`));
      subprocess.unref();
      void subprocess.catch(() => {});
      return { exitCode: null, timedOut: true };
    }
    return { exitCode: result.exitCode ?? null, timedOut: Boolean(result.timedOut) };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runPreflightProbe(
  probe: PreflightProbe,
  timeoutMs: number
): Promise<{ failed: boolean; reason?: RuntimeMcpPreflightFailureReason; detail?: string }> {
  try {
    const result = await runBoundedPreflightProcess(probe.command, probe.args, {
      env: { ...safePreflightProcessEnv(), ...probe.env },
      extendEnv: false,
      timeoutMs,
    });
    if (result.timedOut) {
      return { failed: true, reason: "timeout", detail: `timeout after ${timeoutMs}ms` };
    }
    if (result.exitCode !== 0) {
      return { failed: true, reason: "exit", detail: `exit ${result.exitCode}` };
    }
    return { failed: false };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return { failed: true, reason: "exit", detail: code ? `spawn failed (${code})` : "spawn failed" };
  }
}

function probeMcpEnv(name: string, server: Record<string, unknown>): { missing: string[] } {
  const missing: string[] = [];
  const lowerName = name.toLowerCase();

  const knownMappings: [string[], string[]][] = [
    [["nano-banana", "gemini"], ["GEMINI_API_KEY"]],
    [["supabase"], ["SUPABASE_ACCESS_TOKEN", "SUPABASE_SERVICE_ROLE_KEY"]],
    [["railway"], ["RAILWAY_TOKEN", "RAILWAY_API_TOKEN"]],
    [["github"], ["GITHUB_TOKEN", "GITHUB_PAT"]],
    [["zai"], ["ZAI_API_KEY", "OPENROUTER_API_KEY"]],
    [["deepseek"], ["DEEPSEEK_API_KEY"]],
    [["context7"], []],
    [["filesystem"], []],
  ];

  for (const [substrings, requiredVars] of knownMappings) {
    if (substrings.some((s) => lowerName.includes(s))) {
      const hasAny = requiredVars.some((v) => process.env[v]);
      if (requiredVars.length > 0 && !hasAny) {
        missing.push(requiredVars.join(" or "));
      }
      break;
    }
  }

  const textToScan: string[] = [];
  if (typeof server.command === "string") textToScan.push(server.command);
  if (Array.isArray(server.args)) {
    textToScan.push(...server.args.filter((arg): arg is string => typeof arg === "string"));
  }

  const envPattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  const foundVars = new Set<string>();
  for (const text of textToScan) {
    let match: RegExpExecArray | null;
    while ((match = envPattern.exec(text)) !== null) {
      foundVars.add(match[1] ?? match[2]);
    }
  }

  for (const v of foundVars) {
    if (!process.env[v]) {
      missing.push(v);
    }
  }

  return { missing };
}

async function probeMcpHttpEndpoint(
  server: Record<string, unknown>,
  timeoutMs: number
): Promise<{ ok: boolean; reason?: string; detail?: string }> {
  const url = typeof server.url === "string" ? server.url : "";
  if (!url) return { ok: true };

  const transport = String(server.transport ?? server.type ?? "").toLowerCase();
  const isSse = transport === "sse";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "manual",
    });

    if (!response.ok) {
      return { ok: false, reason: "http-fail", detail: `HTTP ${response.status}` };
    }

    if (isSse) {
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        return {
          ok: false,
          reason: "http-fail",
          detail: `expected text/event-stream, got ${contentType || "none"}`,
        };
      }
    }

    return { ok: true };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, reason: "http-fail", detail: `timeout after ${timeoutMs}ms` };
    }
    // Network-level errors (DNS, connection refused) mean the endpoint is unreachable,
    // not necessarily broken. Let Kimi handle it at connection time.
    if (err instanceof TypeError) {
      return { ok: true };
    }
    return { ok: false, reason: "http-fail", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeMcpStdioStartup(
  server: Record<string, unknown>,
  timeoutMs: number
): Promise<{ ok: boolean; reason?: string; detail?: string }> {
  const command = typeof server.command === "string" ? server.command : "";
  if (!command || typeof server.url === "string") return { ok: true };

  const commandName = basenameOfRuntimeCommand(command);
  if (NPM_FAMILY_RUNTIME_COMMANDS.has(commandName)) return { ok: true };

  const args = Array.isArray(server.args)
    ? server.args.filter((arg): arg is string => typeof arg === "string")
    : [];

  for (const flag of ["--version", "-v", "-h", "--help"]) {
    try {
      const result = await runBoundedPreflightProcess(command, [...args, flag], {
        env: safePreflightProcessEnv(),
        extendEnv: true,
        timeoutMs: Math.min(timeoutMs, 3000),
      });
      if (result.exitCode === 0 || result.exitCode === 1) {
        return { ok: true };
      }
    } catch {
      // continue to next flag
    }
  }

  try {
    const result = await runBoundedPreflightProcess(command, args, {
      env: safePreflightProcessEnv(),
      extendEnv: true,
      timeoutMs: 3000,
    });
    if (result.timedOut) {
      return { ok: true };
    }
    return { ok: true };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, reason: "stdio-fail", detail: code ? `spawn failed (${code})` : "spawn failed" };
  }
}

export async function preflightRuntimeMcpServers(
  servers: Record<string, unknown>,
  options: RuntimeMcpPreflightOptions
): Promise<RuntimeMcpPreflightResult> {
  const entries = Object.entries(servers);
  const failed = new Set<string>();
  const details = new Map<string, { reason: RuntimeMcpPreflightFailureReason; detail: string }>();
  const results: RuntimeMcpPreflightEntry[] = [];

  async function probeOne([name, server]: [string, unknown]): Promise<void> {
    if (!isRecord(server)) {
      results.push({ name, status: "skipped", reason: "not-npm-family" });
      return;
    }

    const envPromise = Promise.resolve().then(() => {
      const envResult = probeMcpEnv(name, server);
      if (envResult.missing.length > 0) {
        return {
          failed: true as const,
          reason: "missing-env" as RuntimeMcpPreflightFailureReason,
          detail: `missing ${envResult.missing.join(", ")}`,
        };
      }
      return { failed: false as const };
    });

    let transportPromise: Promise<{
      failed: boolean;
      reason?: RuntimeMcpPreflightFailureReason;
      detail?: string;
      packageSpec?: string;
    }>;

    if (typeof server.url === "string") {
      transportPromise = probeMcpHttpEndpoint(server, options.timeoutMs).then((r) => ({
        failed: !r.ok,
        reason: r.reason as RuntimeMcpPreflightFailureReason | undefined,
        detail: r.detail,
      }));
    } else if (isNpmFamilyRuntimeServer(server)) {
      const probe = buildPreflightProbeCommand(server, options.concurrency);
      if (!probe) {
        results.push({ name, status: "skipped", reason: "no-package-spec" });
        return;
      }
      transportPromise = runPreflightProbe(probe, options.timeoutMs).then((result) => ({
        failed: result.failed,
        reason: result.reason,
        detail: result.detail,
        packageSpec: probe.packageSpec,
      }));
    } else {
      transportPromise = probeMcpStdioStartup(server, options.timeoutMs).then((r) => ({
        failed: !r.ok,
        reason: r.reason as RuntimeMcpPreflightFailureReason | undefined,
        detail: r.detail,
      }));
    }

    const [envResult, transportResult] = await Promise.all([envPromise, transportPromise]);

    if (envResult.failed) {
      failed.add(name);
      const reason = envResult.reason ?? "missing-env";
      const detail = envResult.detail ?? "failed";
      details.set(name, { reason, detail });
      results.push({
        name,
        status: "failed",
        reason,
        detail: formatPreflightFailureDetail(reason, detail),
        packageSpec: transportResult.packageSpec,
      });
      return;
    }

    if (transportResult.failed) {
      failed.add(name);
      const reason = transportResult.reason ?? "exit";
      const detail = transportResult.detail ?? "failed";
      details.set(name, { reason, detail });
      results.push({
        name,
        status: "failed",
        reason,
        detail: formatPreflightFailureDetail(reason, detail),
        packageSpec: transportResult.packageSpec,
      });
      return;
    }

    results.push({ name, status: "ok", packageSpec: transportResult.packageSpec });
  }

  const concurrency = Math.max(1, options.concurrency);
  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    await Promise.all(batch.map(probeOne));
  }

  const order = new Map(entries.map(([name], index) => [name, index]));
  results.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  return { failed, details, entries: results };
}

function emitPreflightSummary(result: RuntimeMcpPreflightResult, removedNames: Set<string> = result.failed): void {
  if (result.failed.size === 0 || process.env.OMK_MCP_SUPPRESS_PRUNE_WARNINGS === "1") return;
  const parts: string[] = [];
  for (const name of result.failed) {
    const detail = result.details.get(name);
    if (detail) {
      parts.push(`${sanitizeRuntimeMcpPreflightText(name)} (${formatPreflightFailureDetail(detail.reason, detail.detail)})`);
    } else {
      parts.push(sanitizeRuntimeMcpPreflightText(name));
    }
  }
  const shown = parts.slice(0, 5).join(", ");
  const suffix = parts.length > 5 ? `, +${parts.length - 5} more` : "";
  const removedCount = removedNames.size;
  const keptCount = Math.max(0, result.failed.size - removedCount);
  const action = removedCount > 0
    ? `Removed ${removedCount} failed server(s)`
    : "No servers were removed";
  const kept = keptCount > 0
    ? ` Kept ${keptCount} timeout server(s) as prewarm-needed.`
    : "";
  console.warn(
    style.orange(`[omk] MCP preflight found ${result.failed.size} issue(s): ${shown}${suffix}. `) +
    `${action}.${kept} Run \`omk mcp check --all\` (or \`omk mcp prewarm --all\`) to check caches, ` +
    "or `omk mcp doctor --fix` for durable repairs."
  );
}

function normalizeRuntimeMcpServer(
  name: string,
  server: unknown
): { server: unknown; normalizations: RuntimeMcpNormalization[] } {
  if (!isRecord(server) || typeof server.url === "string" || !hasHttpTransportMismatch(name, server)) {
    return { server, normalizations: [] };
  }
  const args = Array.isArray(server.args) ? [...server.args] : [];
  let changed = false;
  for (const [index, arg] of args.entries()) {
    if (typeof arg !== "string" || !isShellInlineMcpArg(server, index) || !PDF_MCP_SERVER_RE.test(arg)) continue;
    args[index] = `${arg.trimEnd()} --stdio`;
    changed = true;
  }
  if (!changed && PDF_MCP_SERVER_RE.test(runtimeCommandText(server))) {
    args.push("--stdio");
    changed = true;
  }
  if (!changed) return { server, normalizations: [] };
  return {
    server: { ...server, args },
    normalizations: [{
      name,
      kind: "runtime-stdio-normalized",
      message: "runtime MCP config was normalized to stdio transport before startup; run `omk mcp doctor --fix` to persist the repair",
    }],
  };
}

function prepareRuntimeMcpServer(server: unknown): unknown {
  if (!isRecord(server) || typeof server.url === "string" || !isPackageManagerRuntimeServer(server)) {
    return server;
  }
  const existingEnv = isRecord(server.env) ? server.env : {};
  const env = { ...QUIET_PACKAGE_MANAGER_ENV, ...existingEnv };
  return { ...server, env };
}

export async function pruneRuntimeMcpServers(
  servers: Record<string, unknown>
): Promise<{
  servers: Record<string, unknown>;
  diagnostics: RuntimeMcpPruneDiagnostic[];
  normalizations: RuntimeMcpNormalization[];
}> {
  const pruned: Record<string, unknown> = {};
  const diagnostics: RuntimeMcpPruneDiagnostic[] = [];
  const normalizations: RuntimeMcpNormalization[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const normalized = normalizeRuntimeMcpServer(name, server);
    const normalizedServer = normalized.server;
    const serverDiagnostics = await diagnoseRuntimeMcpServer(name, normalizedServer);
    if (serverDiagnostics.length > 0) {
      diagnostics.push(...serverDiagnostics);
      continue;
    }
    normalizations.push(...normalized.normalizations);
    pruned[name] = prepareRuntimeMcpServer(normalizedServer);
  }
  return { servers: pruned, diagnostics, normalizations };
}

function emitRuntimeMcpNormalizationNotice(normalizations: RuntimeMcpNormalization[]): void {
  if (normalizations.length === 0 || process.env.OMK_MCP_SUPPRESS_PRUNE_WARNINGS === "1") return;
  const names = [...new Set(normalizations.map((diagnostic) => diagnostic.name))];
  const shown = names.slice(0, 5).join(", ");
  const suffix = names.length > 5 ? `, +${names.length - 5} more` : "";
  console.warn(
    `[omk] normalized ${names.length} MCP server(s) for Kimi startup: ${shown}${suffix}. `
    + "Run `omk mcp doctor --fix` to persist the repair."
  );
}

function emitRuntimeMcpPruneWarning(diagnostics: RuntimeMcpPruneDiagnostic[]): void {
  if (diagnostics.length === 0 || process.env.OMK_MCP_SUPPRESS_PRUNE_WARNINGS === "1") return;
  const names = [...new Set(diagnostics.map((diagnostic) => diagnostic.name))];
  const shown = names.slice(0, 5).join(", ");
  const suffix = names.length > 5 ? `, +${names.length - 5} more` : "";
  console.warn(
    `[omk] skipped ${names.length} broken MCP server(s) before Kimi startup: ${shown}${suffix}. `
    + "Run `omk mcp doctor` to repair stale global MCP config."
  );
}

export async function writeRuntimeMcpConfig(
  configPaths: string[],
  allowlist?: readonly string[]
): Promise<string | null> {
  const uniquePaths = [...new Set(configPaths)];
  const mergedServers: Record<string, unknown> = {};
  for (const configPath of uniquePaths) {
    Object.assign(mergedServers, await readMcpServersForRuntime(configPath));
  }

  // Quarantine integration: read existing quarantine and skip known-bad servers early
  const root = await getProjectRootAsync();
  const quarantineEntries = await readQuarantine(root);
  const quarantinedNames = new Set(quarantineEntries.map((e) => e.name));

  let targetServers = mergedServers;
  if (allowlist !== undefined) {
    const allowed = new Set(allowlist);
    const missing = allowlist.filter((name) => !mergedServers[name]);
    if (missing.length > 0) {
      console.warn(`[omk] MCP allowlist contains servers not found in config: ${missing.join(", ")}`);
    }
    targetServers = Object.fromEntries(
      Object.entries(mergedServers).filter(([name]) => allowed.has(name))
    );
  }

  // Filter out already-quarantined servers before prune/preflight
  targetServers = Object.fromEntries(
    Object.entries(targetServers).filter(([name]) => !quarantinedNames.has(name))
  );

  const { servers: runtimeServers, diagnostics, normalizations } = await pruneRuntimeMcpServers(targetServers);
  emitRuntimeMcpPruneWarning(diagnostics);
  emitRuntimeMcpNormalizationNotice(normalizations);

  const preflightOptions = resolveRuntimeMcpPreflightOptions();
  const preflightMode = preflightOptions.mode;
  let newQuarantineEntries = quarantineEntries;
  if (preflightMode !== "off") {
    const preflightResult = await preflightRuntimeMcpServers(runtimeServers, preflightOptions);
    const removedByPreflight = new Set<string>();
    for (const name of Object.keys(runtimeServers)) {
      if (preflightResult.failed.has(name)) {
        if (preflightMode === "strict") {
          const parts: string[] = [];
          for (const failedName of preflightResult.failed) {
            const detail = preflightResult.details.get(failedName);
            parts.push(
              `${sanitizeRuntimeMcpPreflightText(failedName)} (${formatPreflightFailureDetail(detail?.reason, detail?.detail)})`
            );
          }
          throw new Error(
            `[omk] MCP preflight strict mode: server "${name}" failed probe. ` +
            parts.join(", ")
          );
        }
        const detail = preflightResult.details.get(name);
        if (detail?.reason === "timeout") {
          // Timeout-only failures are kept as prewarm-needed; do not delete.
          continue;
        }
        delete runtimeServers[name];
        removedByPreflight.add(name);

        // Persist new failures to quarantine
        newQuarantineEntries = addQuarantineEntry(newQuarantineEntries, {
          name,
          reason: detail?.reason === "exit" ? "npm-fail" : (detail?.reason ?? "npm-fail"),
          detail: detail?.detail ?? "failed",
          configSource: "runtime-preflight",
        });
      }
    }
    if (newQuarantineEntries.length !== quarantineEntries.length) {
      await writeQuarantine(root, newQuarantineEntries);
    }
    if (preflightResult.failed.size > 0) {
      emitPreflightSummary(preflightResult, removedByPreflight);
    }
  }

  if (Object.keys(runtimeServers).length === 0) return null;
  const cacheDir = join(root, ".omk", "cache");
  await ensureDir(cacheDir);
  await chmod(cacheDir, 0o700).catch(() => undefined);

  // Eagerly remove stale runtime configs left by prior crashed/killed processes
  await cleanupStaleRuntimeMcpConfigs(cacheDir);

  const runtimeConfigPath = join(cacheDir, `mcp-runtime-merged-${process.pid}-${Date.now()}.json`);
  await writeFile(runtimeConfigPath, JSON.stringify({ mcpServers: runtimeServers }, null, 2) + "\n", { mode: 0o600 });
  registerRuntimeMcpCleanupPath(runtimeConfigPath);
  return runtimeConfigPath;
}

async function cleanupStaleRuntimeMcpConfigs(cacheDir: string): Promise<void> {
  const now = Date.now();
  try {
    const entries = await readdir(cacheDir);
    const stale = entries.filter((name) => name.startsWith("mcp-runtime-merged-") && name.endsWith(".json"));
    for (const name of stale) {
      const fullPath = join(cacheDir, name);
      if (!(await shouldCleanupRuntimeMcpConfig(fullPath, name, now))) continue;
      try {
        await rm(fullPath, { force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  } catch {
    // Directory may not exist or be unreadable
  }
}

async function shouldCleanupRuntimeMcpConfig(fullPath: string, fileName: string, now: number): Promise<boolean> {
  const match = /^mcp-runtime-merged-(\d+)-(\d+)\.json$/.exec(fileName);
  if (match) {
    const ownerPid = Number.parseInt(match[1], 10);
    if (Number.isFinite(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) {
      return false;
    }
    return true;
  }

  try {
    const info = await stat(fullPath);
    return now - info.mtimeMs > 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const runtimeMcpCleanupPaths = new Set<string>();
let runtimeMcpCleanupRegistered = false;

function cleanupRuntimeMcpFiles(): void {
  for (const path of runtimeMcpCleanupPaths) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Best-effort cleanup for a local runtime cache that may contain MCP env.
    }
  }
}

function registerRuntimeMcpCleanupPath(runtimeConfigPath: string): void {
  runtimeMcpCleanupPaths.add(runtimeConfigPath);
  if (!runtimeMcpCleanupRegistered) {
    runtimeMcpCleanupRegistered = true;
    process.once("exit", cleanupRuntimeMcpFiles);
  }
}

/** 프로젝트의 .kimi/skills 디렉토리 경로 */
export function getKimiSkillsDir(): string {
  return join(getProjectRoot(), ".kimi", "skills");
}

/** ~/.kimi/config.toml 에서 default_model 읽기 */
export async function getKimiDefaultModel(): Promise<string | null> {
  const configPath = getKimiConfigPath();
  try {
    const content = await readFile(configPath, "utf-8");
    const match = content.match(/^default_model\s*=\s*["']([^"']+)["']/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

const MAX_LOGO_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_LOGO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** .omk/config.toml 에서 안전한 logo_image 경로 읽기 (상대경로는 프로젝트 루트 기준) */
export async function getOmkLogoImagePath(): Promise<string | null> {
  const configPath = getOmkPath("config.toml");
  try {
    const content = await readTextFile(configPath, "");
    const match = content.match(/^\s*logo_image\s*=\s*["']([^"']+)["']/m);
    if (!match) return null;
    const p = match[1].trim();
    const root = await getProjectRootAsync();
    const absoluteInput = isAbsolute(p) || p.startsWith("\\") || /^[A-Za-z]:/.test(p);
    if (absoluteInput && !isTrustedLocalFlag(process.env.OMK_TRUST_ABSOLUTE_LOGO_PATH)) {
      return null;
    }
    const candidate = absoluteInput ? resolve(p) : resolve(root, p);
    if (!absoluteInput && isOutsideRoot(root, candidate)) {
      return null;
    }
    return await isSafeLogoImage(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function isTrustedLocalFlag(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function isOutsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith(`..${"\\"}`) || isAbsolute(rel);
}

async function isSafeLogoImage(path: string): Promise<boolean> {
  const ext = extname(path).toLowerCase();
  if (!ALLOWED_LOGO_EXTENSIONS.has(ext)) return false;

  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_LOGO_IMAGE_BYTES) {
    return false;
  }

  const bytes = await readFile(path);
  return hasAllowedImageMagic(bytes);
}

function hasAllowedImageMagic(bytes: Uint8Array): boolean {
  return isPng(bytes) || isJpeg(bytes) || isGif(bytes) || isWebp(bytes);
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a;
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isGif(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false;
  const header = String.fromCharCode(...bytes.slice(0, 6));
  return header === "GIF87a" || header === "GIF89a";
}

function isWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const webp = String.fromCharCode(...bytes.slice(8, 12));
  return riff === "RIFF" && webp === "WEBP";
}

/**
 * Auto-generate a built-in omk-project MCP config so users never need to
 * define it manually in ~/.kimi/mcp.json or .kimi/mcp.json.
 * The config uses the currently-running omk CLI path and sets OMK_PROJECT_ROOT
 * to the current project root.
 */
export async function writeBuiltinMcpConfig(): Promise<string | null> {
  const root = getProjectRoot();
  const cacheDir = join(root, ".omk", "cache");
  await ensureDir(cacheDir);
  await chmod(cacheDir, 0o700).catch(() => undefined);

  let omkCliPath: string;
  try {
    omkCliPath = await realpath(process.argv[1] ?? "");
  } catch {
    omkCliPath = process.argv[1] ?? "omk";
  }

  const autoConfigPath = join(cacheDir, `mcp-auto-omk-project-${process.pid}-${Date.now()}.json`);
  const config = {
    mcpServers: {
      "omk-project": {
        command: process.argv[0] || "node",
        args: [omkCliPath, "mcp", "serve", "omk-project"],
        env: {
          OMK_PROJECT_ROOT: root,
          npm_config_loglevel: "error",
          NODE_NO_WARNINGS: "1",
        },
      },
    },
  };

  await writeFile(autoConfigPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  registerRuntimeMcpCleanupPath(autoConfigPath);
  return autoConfigPath;
}

/** Kimi CLI 실행 인자에 model + MCP + Skills 주입 (전역 동기화는 별도) */
export async function injectKimiGlobals(
  args: string[],
  options: {
    mcpScope?: OmkRuntimeScope;
    skillsScope?: OmkRuntimeScope;
    hooksScope?: OmkRuntimeScope;
    role?: string;
    mcpAllowlist?: readonly string[];
  } = {}
): Promise<void> {
  const resources = await getOmkResourceSettings();
  const mcpScope = options.mcpScope ?? resources.mcpScope;
  const skillsScope = options.skillsScope ?? resources.skillsScope;
  const hooksScope = options.hooksScope ?? resources.hooksScope;

  // Resolve role-based runtime profile and inject supported flags
  let injectedModel: string | undefined;
  if (options.role) {
    const profile = await resolveRuntimeProfile(options.role);
    const caps = getKimiCapabilities();
    const profileArgs = buildProfileArgs(profile, caps);
    args.push(...profileArgs);
    injectedModel = profile.model;

    // maxOutputMb is not a native CLI flag; map to env hint if present
    if (profile.maxOutputMb !== undefined && !process.env.OMK_MAX_OUTPUT_MB) {
      // Handled downstream by resource-profile.ts / shell runners
    }
  }

  // default_model이 있으면 주입 (agent-file 사용 시 model이 unset 될 수 있음)
  // Profile model takes precedence; skip duplicate injection.
  if (!injectedModel) {
    const defaultModel = await getKimiDefaultModel();
    if (defaultModel) {
      args.push("--model", defaultModel);
    }
  }

  if (mcpScope !== "none") {
    const mcpConfigs = await collectMcpConfigs(mcpScope);
    // Auto-inject built-in omk-project MCP server so it never needs user config.
    // Merge runtime configs before passing them to Kimi: Kimi warns on duplicate
    // server names across multiple --mcp-config-file values and then overrides
    // silently. A single merged config preserves the same precedence (global first,
    // project second, built-in omk-project last) without duplicate startup noise.
    const builtinMcp = await writeBuiltinMcpConfig();
    const allowlist = options.mcpAllowlist !== undefined
      ? [...new Set([...options.mcpAllowlist, "omk-project"].map((name) => name.trim()).filter(Boolean))]
      : undefined;
    const runtimeMcp = await writeRuntimeMcpConfig(
      builtinMcp ? [...mcpConfigs, builtinMcp] : mcpConfigs,
      allowlist
    );
    if (runtimeMcp) {
      args.push("--mcp-config-file", runtimeMcp);
    } else if (allowlist && allowlist.length > 0) {
      console.warn(
        style.orange(
          `[omk] MCP allowlist resulted in zero available servers. ` +
            `Allowed: ${allowlist.join(", ")}. ` +
            `Check that the allowlist matches actual MCP server names in your config. ` +
            `MCP config will not be passed to Kimi.`
        )
      );
    }
  }

  const globalSkillsDir = join(getUserHome(), ".kimi", "skills");
  const projectSkillsDir = getKimiSkillsDir();
  const [globalSkillsExists, projectSkillsExists] = await Promise.all([
    skillsScope === "all" ? pathExists(globalSkillsDir) : Promise.resolve(false),
    skillsScope !== "none" ? pathExists(projectSkillsDir) : Promise.resolve(false),
  ]);
  if (globalSkillsExists) args.push("--skills-dir", globalSkillsDir);
  if (projectSkillsExists) args.push("--skills-dir", projectSkillsDir);

  if (process.env.OMK_DEBUG === "1") {
    const mcpFiles = await collectMcpConfigs(mcpScope);
    const skillDirs: string[] = [];
    if (globalSkillsExists) skillDirs.push(globalSkillsDir);
    if (projectSkillsExists) skillDirs.push(projectSkillsDir);
    const modelIdx = args.indexOf("--model");
    const effectiveModel = modelIdx >= 0 ? args[modelIdx + 1] : null;
    const root = await getProjectRootAsync();
    const quarantineEntries = await readQuarantine(root);
    console.error("[OMK_DEBUG] injectKimiGlobals:", {
      role: options.role ?? null,
      model: effectiveModel,
      mcpFiles,
      skillDirs,
      mcpScope,
      skillsScope,
      hooksScope,
      mcpAllowlist: options.mcpAllowlist ?? null,
      quarantined: quarantineEntries.length,
    });
  }
}

import { pathExists, collectMcpConfigs, getKimiSkillsDir, getUserHome } from "../../util/fs.js";
import { style } from "../../util/theme.js";
import { OMK_MATRIX_ASCII_ART } from "../../brand/omk-matrix-art.js";
import { renderMatrixRain } from "../../brand/matrix-rain.js";
import { dirname, join, isAbsolute } from "path";
import type { TodoItem } from "../../util/todo-sync.js";
import { readFile, readdir } from "fs/promises";
import YAML from "yaml";
import { t } from "../../util/i18n.js";

export function mergeTodos(existing: TodoItem[], incoming: TodoItem[]): TodoItem[] {
  const map = new Map<string, TodoItem>();
  for (const t of existing) {
    map.set(t.title, t);
  }
  for (const t of incoming) {
    const current = map.get(t.title);
    if (current) {
      map.set(t.title, { ...current, status: t.status });
    } else {
      map.set(t.title, t);
    }
  }
  return Array.from(map.values());
}

export const CHAT_STARTUP_FAILURE_OUTPUT_LIMIT = 4000;

export function appendRecentChatOutput(current: string, data: string): string {
  const next = current + data;
  return next.length > CHAT_STARTUP_FAILURE_OUTPUT_LIMIT
    ? next.slice(-CHAT_STARTUP_FAILURE_OUTPUT_LIMIT)
    : next;
}

export function sanitizeChatStartupFailureOutput(output: string): string {
  return output
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/(authorization|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s"'`]+/gi, "$1=***")
    .replace(/bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer ***");
}

export function isKimiPromptReadyLine(line: string): boolean {
  return /(?:^|\s)(?:waiting for input|ready for input|enter your prompt|prompt ready)(?:\s|$)/i.test(line)
    || /^[>›]\s*$/.test(line.trim());
}

export function formatResourceCount(count: number, scope: string): string {
  return count > 0 ? `${count} active (${scope})` : style.gray(`none (${scope})`);
}

export type ChatLayout = "auto" | "tmux" | "inline" | "plain";
export type ChatBrand = "omk" | "minimal" | "plain" | "kimicat" | "green-rain" | "neon-grid";
export type ChatUi = "legacy" | "plain-modern" | "rich" | "system24" | "green-rain" | "neon-grid";

export function resolveLayout(requested: ChatLayout | undefined): ChatLayout {
  if (requested && requested !== "auto") return requested;
  return "inline";
}

export function resolveChatUi(requested: string | undefined, env: NodeJS.ProcessEnv = process.env): ChatUi {
  const raw = requested ?? env.OMK_UI ?? env.OMK_CHAT_UI ?? "system24";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "plain-modern" || normalized === "modern" || normalized === "agent-console") return "plain-modern";
  if (normalized === "rich") return "rich";
  if (normalized === "system24" || normalized === "s24") return "system24";
  if (normalized === "green-rain" || normalized === "green" || normalized === "matrix" || normalized === "rain") return "green-rain";
  if (normalized === "neon-grid" || normalized === "neon" || normalized === "grid" || normalized === "control" || normalized === "omk-control") return "neon-grid";
  return "legacy";
}

export function resolveChatWorkerCount(requested: string | undefined, fallback: number): string {
  const trimmed = requested?.trim();
  if (!trimmed || trimmed.toLowerCase() === "auto") {
    return String(Math.max(1, fallback));
  }
  return trimmed;
}

export function renderChatIntro(
  brand: ChatBrand,
  meta: { agent: string; runId?: string; layout: ChatLayout; trust: string; mode?: string }
): string {
  const titleKey: Record<ChatBrand, string> = {
    omk: "chat.intro.omk",
    kimicat: "chat.intro.omk",
    "green-rain": "chat.intro.greenRain",
    "neon-grid": "chat.intro.neonGrid",
    minimal: "chat.intro.minimal",
    plain: "chat.intro.plain",
  };
  const title = t(titleKey[brand] ?? titleKey.omk);
  const lines: string[] = [];
  if (brand === "green-rain") {
    const rainWidth = Math.min(60, process.stdout.columns ?? 80);
    const rain = renderMatrixRain(meta.runId ?? "omk", rainWidth, 4);
    for (const rainLine of rain.split("\n")) {
      lines.push(style.phosphor(rainLine));
    }
    lines.push("");
    for (const artLine of OMK_MATRIX_ASCII_ART.split("\n")) {
      lines.push(style.phosphor(artLine));
    }
    lines.push("");
  } else if (brand !== "plain") {
    lines.push(style.phosphorBold("◇ OMK//CONTROL"));
    lines.push(style.gray("  NEON GRID ONLINE"));
    lines.push(style.gray("  Route agents. Verify evidence. Control the loop."));
    lines.push("");
  }
  lines.push(style.phosphorBold(`▸ ${title}`));
  if (brand !== "plain") {
    lines.push(
      `  ${style.gray(t("chat.intro.agent") + ":")} ${style.cream(meta.agent)}`
    );
    if (meta.runId) {
      lines.push(
        `  ${style.gray(t("chat.intro.run") + ":")} ${style.cream(meta.runId)}`
      );
    }
    lines.push(
      `  ${style.gray(t("chat.intro.layout") + ":")} ${style.cream(meta.layout)}`
    );
    lines.push(
      `  ${style.gray(t("chat.intro.trust") + ":")} ${style.cream(meta.trust)}`
    );
    if (meta.mode) {
      lines.push(
        `  ${style.gray("Mode:")} ${style.cream(meta.mode)}`
      );
    }
  }
  return lines.join("\n");
}

export async function verifyAgentPrompt(agentFile: string): Promise<boolean> {
  if (!(await pathExists(agentFile))) return false;
  try {
    const raw = await readFile(agentFile, "utf8");
    const parsed = YAML.parse(raw);
    const promptPath = parsed?.agent?.system_prompt_path as string | undefined;
    if (!promptPath) return true;
    const resolved = isAbsolute(promptPath)
      ? promptPath
      : join(dirname(agentFile), promptPath);
    return await pathExists(resolved);
  } catch {
    return false;
  }
}

export async function getActiveMcpNames(scope: "all" | "project" | "none"): Promise<string[]> {
  if (scope === "none") return [];
  const configs = await collectMcpConfigs(scope);
  const results = await Promise.all(
    configs.map(async (cfg) => {
      try {
        const raw = await readFile(cfg, "utf-8");
        const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
        return parsed.mcpServers ? Object.keys(parsed.mcpServers) : [];
      } catch {
        return [];
      }
    })
  );
  return [...new Set(results.flat())];
}

export async function getActiveSkillNames(skillsScope: "all" | "project" | "none"): Promise<string[]> {
  if (skillsScope === "none") return [];
  const dirs: string[] = [];
  const projectDir = getKimiSkillsDir();
  if (await pathExists(projectDir)) dirs.push(projectDir);
  if (skillsScope === "all") {
    const globalDir = join(getUserHome(), ".kimi", "skills");
    if (await pathExists(globalDir)) dirs.push(globalDir);
  }
  const results = await Promise.all(
    dirs.map(async (dir) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return [];
      }
    })
  );
  return [...new Set(results.flat())];
}

export async function getActiveHookNames(root: string): Promise<string[]> {
  try {
    const { discoverRoutingInventory } = await import("../../orchestration/routing/inventory.js");
    return [...discoverRoutingInventory(root).hooks.keys()];
  } catch {
    return [];
  }
}

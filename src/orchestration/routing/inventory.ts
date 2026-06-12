/**
 * OMK Routing — Inventory discovery & caching
 * Extracted from routing.ts to break God Module coupling
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { normalizeUserHomePath } from "../../util/fs.js";
import type { RouteCandidate, RouteSource, RoutingInventory } from "./types.js";
import { loadMergedMcpConfigSync } from "./mcp-config.js";

let inventoryCache: { key: string; value: RoutingInventory } | undefined;
let routeCandidatesCache: { key: string; candidates: RouteCandidate[] } | undefined;

const OMK_PROJECT_TOOLS = [
  "omk_search_memory", "omk_read_memory", "omk_memory_mindmap",
  "omk_graph_query", "omk_list_agents", "omk_read_agent",
  "omk_list_runs", "omk_read_run", "omk_run_quality_gate",
  "omk_save_checkpoint", "omk_list_checkpoints",
  "omk_search_snippets", "omk_get_snippet",
];

export function resetRoutingInventoryCache(): void {
  inventoryCache = undefined;
  routeCandidatesCache = undefined;
}

export function getRoutingProjectRoot(): string {
  return process.env.OMK_PROJECT_ROOT ? resolve(process.env.OMK_PROJECT_ROOT) : process.cwd();
}

function getRoutingUserHome(): string {
  return (
    normalizeUserHomePath(process.env.OMK_ORIGINAL_HOME)
    ?? normalizeUserHomePath(process.env.HOME)
    ?? normalizeUserHomePath(homedir())
    ?? homedir()
  );
}

function normalizeScope(value: string | undefined, fallback: RoutingInventory["skillsScope"]): RoutingInventory["skillsScope"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "none" || normalized === "off" || normalized === "disabled") return "none";
  if (normalized === "all" || normalized === "global" || normalized === "local-user" || normalized === "local_user" || normalized === "personal" || normalized === "user") return "all";
  if (normalized === "project" || normalized === "local") return "project";
  return fallback;
}

function readFlatConfig(root: string): Record<string, string> {
  try {
    return parseSimpleToml(readFileSync(join(root, ".omk", "config.toml"), "utf-8"));
  } catch {
    return {};
  }
}

function parseSimpleToml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  let section = "";
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = section ? `${section}.${kv[1].trim()}` : kv[1].trim();
    result[key] = normalizeConfigValue(kv[2].trim());
  }
  return result;
}

function stripComment(line: string): string {
  let inString = false;
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if ((char === "\"" || char === "'") && line[i - 1] !== "\\") {
      if (!inString) { inString = true; quote = char; }
      else if (quote === char) { inString = false; }
    }
    if (char === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function normalizeConfigValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function skillDirs(root: string, scope: RoutingInventory["skillsScope"]): Array<{ path: string; source: RouteSource }> {
  if (scope === "none") return [];
  const dirs: Array<{ path: string; source: RouteSource }> = [
    { path: join(root, ".agents", "skills"), source: "project" },
    { path: join(root, ".kimi", "skills"), source: "project" },
    { path: join(root, ".omk", "skills"), source: "project" },
  ];
  if (scope === "all") {
    const userHome = getRoutingUserHome();
    dirs.push(
      { path: join(userHome, ".codex", "skills"), source: "global" },
      { path: join(userHome, ".agents", "skills"), source: "global" },
      { path: join(userHome, ".kimi", "skills"), source: "global" },
    );
  }
  return dirs;
}

function readSkillNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readMcpServerNames(config: { mcpServers?: Record<string, unknown> }): string[] {
  return Object.keys(config.mcpServers ?? {});
}

function readActiveHookNames(root: string, scope: RoutingInventory["hooksScope"]): Array<{ name: string; source: RouteSource }> {
  if (scope === "none") return [];
  const files: Array<{ path: string; source: RouteSource }> = [
    { path: join(root, ".omk", "kimi.config.toml"), source: "project" },
    { path: join(root, ".kimi", "kimi.config.toml"), source: "project" },
  ];
  if (scope === "all") {
    const userHome = getRoutingUserHome();
    files.unshift(
      { path: join(userHome, ".kimi", "kimi.config.toml"), source: "global" },
      { path: join(userHome, ".codex", "kimi.config.toml"), source: "global" },
    );
  }
  const result: Array<{ name: string; source: RouteSource }> = [];
  for (const file of files) {
    try {
      const content = readFileSync(file.path, "utf-8");
      for (const match of content.matchAll(/^\s*command\s*=\s*["']([^"']*hooks\/([^/"']+))["']/gm)) {
        const name = match[2]?.trim();
        if (name) result.push({ name, source: file.source });
      }
    } catch {
      // ignore missing or invalid hook config
    }
  }
  return result;
}

export function discoverRoutingInventory(projectRoot = getRoutingProjectRoot()): RoutingInventory {
  const root = resolve(projectRoot);
  const config = readFlatConfig(root);
  const skillsScope = normalizeScope(config["runtime.skills_scope"] ?? process.env.OMK_SKILLS_SCOPE, "project");
  const mcpScope = normalizeScope(config["runtime.mcp_scope"] ?? process.env.OMK_MCP_SCOPE, "project");
  const hooksScope = normalizeScope(config["runtime.hooks_scope"] ?? process.env.OMK_HOOKS_SCOPE, "project");
  const key = [root, skillsScope, mcpScope, hooksScope].join("|");
  if (inventoryCache?.key === key) return inventoryCache.value;

  const skills = new Map<string, RouteSource>();
  for (const dir of skillDirs(root, skillsScope)) {
    for (const skill of readSkillNames(dir.path)) {
      if (!skills.has(skill)) skills.set(skill, dir.source);
    }
  }

  const mcpServers = new Map<string, RouteSource>();
  const mergedMcp = loadMergedMcpConfigSync(root, mcpScope);
  for (const server of readMcpServerNames({ mcpServers: mergedMcp.servers })) {
    const source = mergedMcp.sources.get(server) ?? "project";
    if (!mcpServers.has(server)) mcpServers.set(server, source);
  }

  const tools = new Set<string>(["SearchWeb", "FetchURL"]);
  if (mcpServers.has("omk-project")) {
    for (const tool of OMK_PROJECT_TOOLS) tools.add(tool);
  }

  const hooks = new Map<string, RouteSource>();
  for (const hook of readActiveHookNames(root, hooksScope)) {
    if (!hooks.has(hook.name)) hooks.set(hook.name, hook.source);
  }

  const value = { skills, mcpServers, hooks, tools, diagnostics: mergedMcp.diagnostics, skillsScope, mcpScope, hooksScope };
  inventoryCache = { key, value };
  return value;
}

function keywordsFromId(id: string): string[] {
  return unique(id.replace(/^omk-/, "").split(/[-_]/).filter((keyword) => keyword.length >= 2));
}

function rolesFromKeywords(keywords: string[]): string[] {
  if (keywords.some((keyword) => ["review", "security", "quality"].includes(keyword))) return ["reviewer", "qa"];
  if (keywords.some((keyword) => ["test", "debug", "fix"].includes(keyword))) return ["debugger", "tester", "coder"];
  if (keywords.some((keyword) => ["frontend", "implementation", "typescript", "python"].includes(keyword))) return ["coder"];
  if (keywords.some((keyword) => ["repo", "research", "docs"].includes(keyword))) return ["researcher", "explorer"];
  if (keywords.some((keyword) => ["plan", "flow", "dag", "context", "router"].includes(keyword))) return ["planner", "router"];
  return ["planner", "router", "reviewer"];
}

function dynamicSkillCandidate(id: string, source: RouteSource): RouteCandidate {
  const keywords = keywordsFromId(id);
  const readOnly = !keywords.some((keyword) => ["write", "delete", "commit", "git", "fix", "implementation"].includes(keyword));
  return {
    kind: "skill",
    id,
    source,
    roles: rolesFromKeywords(keywords),
    keywords,
    readOnly,
    writeRisk: readOnly ? "none" : "low",
    contextCost: id.includes("flow") ? 2 : 1,
    capabilities: keywords,
  };
}

function dynamicMcpCandidate(id: string, source: RouteSource): RouteCandidate {
  const keywords = keywordsFromId(id);
  return {
    kind: "mcp",
    id,
    source,
    roles: rolesFromKeywords(keywords),
    keywords,
    readOnly: true,
    writeRisk: "none",
    contextCost: 1,
    capabilities: keywords,
  };
}

function dynamicHookCandidate(id: string, source: RouteSource): RouteCandidate {
  const keywords = keywordsFromId(id.replace(/\.(sh|js|mjs|ts)$/i, ""));
  return {
    kind: "hook",
    id,
    source,
    roles: rolesFromKeywords(keywords),
    keywords: [...keywords, "hook"],
    readOnly: !keywords.some((keyword) => ["write", "format", "shell", "guard", "secret"].includes(keyword)),
    writeRisk: keywords.some((keyword) => ["write", "format", "shell", "guard", "secret"].includes(keyword)) ? "low" : "none",
    contextCost: 1,
    capabilities: keywords,
  };
}

export function routeCandidates(inventory: RoutingInventory, staticCandidates: RouteCandidate[]): RouteCandidate[] {
  const cacheKey = [
    inventory.skillsScope,
    inventory.mcpScope,
    inventory.hooksScope,
    [...inventory.skills.keys()].join(","),
    [...inventory.mcpServers.keys()].join(","),
    [...inventory.hooks.keys()].join(","),
    staticCandidates.map((c) => c.id).join(","),
  ].join("|");
  if (routeCandidatesCache?.key === cacheKey) return routeCandidatesCache.candidates;

  const staticIds = new Set(staticCandidates.map((candidate) => `${candidate.kind}:${candidate.id}`));
  const dynamicSkills: RouteCandidate[] = [...inventory.skills.entries()]
    .filter(([id]) => !staticIds.has(`skill:${id}`))
    .map(([id, source]) => dynamicSkillCandidate(id, source));
  const dynamicMcps: RouteCandidate[] = [...inventory.mcpServers.entries()]
    .filter(([id]) => !staticIds.has(`mcp:${id}`))
    .map(([id, source]) => dynamicMcpCandidate(id, source));
  const dynamicHooks: RouteCandidate[] = [...inventory.hooks.entries()]
    .filter(([id]) => !staticIds.has(`hook:${id}`))
    .map(([id, source]) => dynamicHookCandidate(id, source));
  const result = [...staticCandidates, ...dynamicSkills, ...dynamicMcps, ...dynamicHooks];
  routeCandidatesCache = { key: cacheKey, candidates: result };
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

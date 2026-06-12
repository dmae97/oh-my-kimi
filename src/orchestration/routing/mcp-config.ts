/**
 * OMK Routing — MCP configuration loading & redaction
 * Extracted from routing.ts to break God Module coupling
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { normalizeUserHomePath } from "../../util/fs.js";
import type { RouteSource } from "./types.js";
import type { RoutingDiagnostic } from "./types.js";

const SECRET_PATTERNS = ["apikey", "token", "password", "secret", "authorization"];

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return SECRET_PATTERNS.some((pattern) => normalized === pattern || normalized.endsWith(pattern));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const sVal = source[key];
    const tVal = result[key];
    if (isPlainObject(sVal) && isPlainObject(tVal)) {
      result[key] = deepMerge(tVal, sVal);
    } else {
      result[key] = sVal;
    }
  }
  return result;
}

export function redactMcpConfig(cfg: unknown): unknown {
  if (isPlainObject(cfg)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(cfg)) {
      if (isSecretKey(key)) {
        result[key] = "***";
      } else if (isPlainObject(value)) {
        result[key] = redactMcpConfig(value);
      } else if (Array.isArray(value)) {
        result[key] = value.map((item) => redactMcpConfig(item));
      } else {
        result[key] = value;
      }
    }
    return result;
  }
  if (Array.isArray(cfg)) {
    return cfg.map((item) => redactMcpConfig(item));
  }
  return cfg;
}

function getRoutingUserHome(): string {
  return (
    normalizeUserHomePath(process.env.OMK_ORIGINAL_HOME)
    ?? normalizeUserHomePath(process.env.HOME)
    ?? normalizeUserHomePath(homedir())
    ?? homedir()
  );
}

function formatRoutingPath(root: string, path: string): string {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  const rootRelative = relative(resolvedRoot, resolvedPath);
  if (rootRelative === "") return ".";
  if (isRelativeChildPath(rootRelative)) return rootRelative;
  const home = resolve(getRoutingUserHome());
  const homeRelative = relative(home, resolvedPath);
  if (homeRelative === "") return "~";
  if (isRelativeChildPath(homeRelative)) return `~/${homeRelative.split(sep).join("/")}`;
  return resolvedPath;
}

function isRelativeChildPath(path: string): boolean {
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith("../") && !isAbsolute(path);
}

function mcpConfigErrorMessage(err: unknown): string {
  if (err instanceof SyntaxError) return "invalid JSON";
  if (err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    return `unreadable MCP config (${(err as { code: string }).code})`;
  }
  return "invalid MCP config";
}

function createMcpConfigDiagnostic(
  root: string,
  source: "project" | "global",
  path: string,
  err: unknown
): RoutingDiagnostic {
  return {
    kind: "mcp-config",
    source,
    path: formatRoutingPath(root, path),
    message: mcpConfigErrorMessage(err),
  };
}

export function loadMergedMcpConfigSync(
  projectRoot: string,
  scope: "project" | "all" | "none"
): { servers: Record<string, unknown>; sources: Map<string, RouteSource>; diagnostics: RoutingDiagnostic[] } {
  const root = resolve(projectRoot);
  const servers: Record<string, unknown> = {};
  const sources = new Map<string, RouteSource>();
  const diagnostics: RoutingDiagnostic[] = [];

  if (scope === "none") {
    return { servers, sources, diagnostics };
  }

  const globalFiles = scope === "all" ? [join(getRoutingUserHome(), ".kimi", "mcp.json"), join(getRoutingUserHome(), ".omk", "mcp.json")] : [];

  for (const path of globalFiles) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { mcpServers?: Record<string, unknown> };
      for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
        if (!sources.has(name)) {
          servers[name] = cfg;
          sources.set(name, "global");
        }
      }
    } catch (err) {
      diagnostics.push(createMcpConfigDiagnostic(root, "global", path, err));
    }
  }

  const projectFiles = [
    join(root, ".omk", "mcp.json"),
    join(root, ".kimi", "mcp.json"),
  ];

  for (const path of projectFiles) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { mcpServers?: Record<string, unknown> };
      for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
        if (!sources.has(name) || sources.get(name) === "global") {
          if (sources.has(name) && isPlainObject(servers[name]) && isPlainObject(cfg)) {
            servers[name] = deepMerge(servers[name] as Record<string, unknown>, cfg as Record<string, unknown>);
          } else {
            servers[name] = cfg;
          }
          sources.set(name, "project");
        }
      }
    } catch (err) {
      diagnostics.push(createMcpConfigDiagnostic(root, "project", path, err));
    }
  }

  if (!sources.has("omk-project")) {
    servers["omk-project"] = { type: "builtin", command: "omk", args: ["mcp", "serve", "omk-project"] };
    sources.set("omk-project", "builtin");
  }

  return { servers, sources, diagnostics };
}

export function loadMergedMcpConfig(
  projectRoot: string,
  scope: "project" | "all" | "none"
): Promise<{ servers: Record<string, unknown>; sources: Map<string, RouteSource>; diagnostics: RoutingDiagnostic[] }> {
  return Promise.resolve(loadMergedMcpConfigSync(projectRoot, scope));
}

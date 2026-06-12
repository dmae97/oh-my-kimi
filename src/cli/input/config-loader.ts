/**
 * Phase 1 — ConfigLoader
 * Resolves config with priority:
 *   1. CLI flag
 *   2. environment variable
 *   3. project config: .omkrc.json / omk.config.json
 *   4. user config: ~/.omk/config.json
 *   5. default
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

export interface LoadedConfig {
  readonly source: string;
  readonly data: Record<string, unknown>;
}

const PROJECT_CONFIG_NAMES = [".omkrc.json", "omk.config.json"];
const USER_CONFIG_PATH = join(homedir(), ".omk", "config.json");

function loadJsonIfExists(path: string): LoadedConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf-8");
    const data = JSON.parse(text) as Record<string, unknown>;
    return { source: path, data };
  } catch {
    return undefined;
  }
}

export function loadProjectConfig(cwd: string): LoadedConfig | undefined {
  for (const name of PROJECT_CONFIG_NAMES) {
    const cfg = loadJsonIfExists(resolve(cwd, name));
    if (cfg) return cfg;
  }
  return undefined;
}

export function loadUserConfig(): LoadedConfig | undefined {
  return loadJsonIfExists(USER_CONFIG_PATH);
}

export function resolveConfigValue<T>(
  flagValue: T | undefined,
  envValue: T | undefined,
  projectValue: T | undefined,
  userValue: T | undefined,
  defaultValue: T
): T {
  if (flagValue !== undefined) return flagValue;
  if (envValue !== undefined) return envValue;
  if (projectValue !== undefined) return projectValue;
  if (userValue !== undefined) return userValue;
  return defaultValue;
}

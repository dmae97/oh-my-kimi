/**
 * CLI Theme — Theme Resolver
 * Resolves the active theme with priority:
 *   --theme flag → OMK_THEME env → project config → user config → terminal capability default
 */

import {
  resolveConfigValue,
  loadProjectConfig,
  loadUserConfig,
} from "../input/config-loader.js";
import type { ResolvedTheme } from "../runtime/types.js";
import { getTerminalCapability, defaultThemeForCapability } from "./terminal-capability.js";
import { getBuiltinTheme, listBuiltinThemes } from "./theme-registry.js";

function isValidThemeName(name: unknown): name is string {
  return typeof name === "string" && listBuiltinThemes().includes(name);
}

function extractThemeName(config: Record<string, unknown> | undefined): string | undefined {
  if (!config) return undefined;
  if (isValidThemeName(config.theme)) return config.theme;
  if (
    typeof config.cli === "object"
    && config.cli !== null
    && isValidThemeName((config.cli as Record<string, unknown>).theme)
  ) {
    return (config.cli as Record<string, unknown>).theme as string;
  }
  return undefined;
}

export interface ResolveThemeOptions {
  readonly cwd: string;
  readonly flagTheme?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function resolveTheme(options: ResolveThemeOptions): ResolvedTheme {
  const env = options.env ?? process.env;
  const flagValue = options.flagTheme;
  const envValue = env.OMK_THEME;

  const projectCfg = loadProjectConfig(options.cwd);
  const userCfg = loadUserConfig();

  const projectValue = extractThemeName(projectCfg?.data);
  const userValue = extractThemeName(userCfg?.data);

  const defaultCap = defaultThemeForCapability(getTerminalCapability());

  const rawName = resolveConfigValue(
    flagValue,
    envValue,
    projectValue,
    userValue,
    defaultCap.name
  );

  const name = isValidThemeName(rawName) ? rawName : defaultCap.name;
  const palette = getBuiltinTheme(name);

  const mode = palette?.mode ?? defaultCap.mode;

  return { name, mode };
}

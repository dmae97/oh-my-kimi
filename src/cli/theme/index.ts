/**
 * CLI Theme — Barrel export for terminal capability, theme registry, and theme resolver.
 */

export {
  getTerminalCapability,
  defaultThemeForCapability,
} from "./terminal-capability.js";

export type {
  TerminalCapability,
  ColorDepth,
} from "./terminal-capability.js";

export {
  getBuiltinTheme,
  listBuiltinThemes,
  registerBuiltinTheme,
  __registry,
} from "./theme-registry.js";

export type {
  SemanticToken,
  ThemePalette,
} from "./theme-registry.js";

export { resolveTheme } from "./theme-resolver.js";
export type { ResolveThemeOptions } from "./theme-resolver.js";

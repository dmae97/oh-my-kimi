/**
 * CLI Theme — Built-in Theme Registry
 * Maps semantic tokens to ANSI colors. Reuses src/theme/colors.ts exports.
 */

import { style } from "../../theme/colors.js";

export type SemanticToken =
  | "success"
  | "warning"
  | "error"
  | "info"
  | "agent"
  | "task"
  | "tool"
  | "header"
  | "subheader"
  | "dim"
  | "bold"
  | "reset"
  | "separator"
  | "bullet"
  | "labelKey"
  | "labelValue";

export interface ThemePalette {
  readonly name: string;
  readonly mode: "dark" | "light" | "auto" | "mono";
  readonly supportsColor: boolean;
  readonly render: (token: SemanticToken, text: string) => string;
}

// --- omk (full brand) ---

const omkPalette: ThemePalette = {
  name: "omk",
  mode: "dark",
  supportsColor: true,
  render(token, text) {
    switch (token) {
      case "success": return style.mint(text);
      case "warning": return style.orange(text);
      case "error": return style.red(text);
      case "info": return style.blue(text);
      case "agent": return style.purple(text);
      case "task": return style.pink(text);
      case "tool": return style.cyan(text);
      case "header": return style.purpleBold(text);
      case "subheader": return style.blueBold(text);
      case "dim": return style.dim + text + style.reset;
      case "bold": return style.bold + text + style.reset;
      case "reset": return style.reset + text;
      case "separator": return style.gray(text);
      case "bullet": return style.purple("• " + text);
      case "labelKey": return style.dim + text + style.reset;
      case "labelValue": return text;
      default: return text;
    }
  },
};

// --- minimal (basic ANSI, no brand colors) ---

const minimalPalette: ThemePalette = {
  name: "minimal",
  mode: "auto",
  supportsColor: true,
  render(token, text) {
    switch (token) {
      case "success": return style.bold + text + style.reset;
      case "warning": return text;
      case "error": return text;
      case "info": return text;
      case "agent": return text;
      case "task": return text;
      case "tool": return text;
      case "header": return style.bold + text + style.reset;
      case "subheader": return style.bold + text + style.reset;
      case "dim": return style.dim + text + style.reset;
      case "bold": return style.bold + text + style.reset;
      case "reset": return style.reset + text;
      case "separator": return text;
      case "bullet": return "- " + text;
      case "labelKey": return style.dim + text + style.reset;
      case "labelValue": return text;
      default: return text;
    }
  },
};

// --- mono (no color at all) ---

const monoPalette: ThemePalette = {
  name: "mono",
  mode: "mono",
  supportsColor: false,
  render(_token, text) {
    return text;
  },
};

// --- dark (generic dark terminal) ---

const darkPalette: ThemePalette = {
  name: "dark",
  mode: "dark",
  supportsColor: true,
  render(token, text) {
    switch (token) {
      case "success": return style.green(text);
      case "warning": return style.amber(text);
      case "error": return style.metricsRed(text);
      case "info": return style.blue(text);
      case "agent": return style.violet(text);
      case "task": return style.cyan(text);
      case "tool": return style.silver(text);
      case "header": return style.whiteBold(text);
      case "subheader": return style.bold + text + style.reset;
      case "dim": return style.dim + text + style.reset;
      case "bold": return style.bold + text + style.reset;
      case "reset": return style.reset + text;
      case "separator": return style.gray(text);
      case "bullet": return style.dim + "• " + text + style.reset;
      case "labelKey": return style.dim + text + style.reset;
      case "labelValue": return text;
      default: return text;
    }
  },
};

// --- light (generic light terminal) ---

const lightPalette: ThemePalette = {
  name: "light",
  mode: "light",
  supportsColor: true,
  render(token, text) {
    // On light backgrounds, use darker/more saturated variants
    switch (token) {
      case "success": return style.greenBold(text);
      case "warning": return style.amberBold(text);
      case "error": return style.metricsRedBold(text);
      case "info": return style.blueBold(text);
      case "agent": return style.purpleBold(text);
      case "task": return style.cyanBold(text);
      case "tool": return style.slate(text);
      case "header": return style.navy(text);
      case "subheader": return style.bold + text + style.reset;
      case "dim": return style.dim + text + style.reset;
      case "bold": return style.bold + text + style.reset;
      case "reset": return style.reset + text;
      case "separator": return style.gray(text);
      case "bullet": return style.dim + "• " + text + style.reset;
      case "labelKey": return style.dim + text + style.reset;
      case "labelValue": return text;
      default: return text;
    }
  },
};

const registry = new Map<string, ThemePalette>([
  ["omk", omkPalette],
  ["minimal", minimalPalette],
  ["mono", monoPalette],
  ["dark", darkPalette],
  ["light", lightPalette],
]);

export function getBuiltinTheme(name: string): ThemePalette | undefined {
  return registry.get(name);
}

export function listBuiltinThemes(): readonly string[] {
  return Array.from(registry.keys());
}

export function registerBuiltinTheme(name: string, palette: ThemePalette): void {
  registry.set(name, palette);
}

export { registry as __registry };

/**
 * OMK Theme — Parallel execution UI kit (badges, banners, worker boxes)
 * Extracted from util/theme.ts to break God Module coupling
 */

import { OMK_MATRIX_ASCII_ART } from "../brand/omk-matrix-art.js";
import { P, hexToRgb, colorFromHex } from "../brand/palette.js";
import { esc, rgb, stripAnsi, padEndAnsi } from "./ansi.js";
import { style } from "./colors.js";
import { box, gradient } from "./layout.js";
import { label } from "./layout.js";

export const emoji = {
  shell: "🐚",
  code: "💜",
  search: "🔍",
  download: "📥",
  package: "📦",
  sparkles: "✨",
  heart: "🩷",
  star: "🌟",
  magic: "🪄",
  cat: "🐱",
  cookie: "🍪",
  leaf: "🌿",
  candy: "🍬",
  flower: "🌸",
  moon: "🌙",
  cloud: "☁️",
  fire: "🔥",
  zap: "⚡",
  checklist: "☑️",
  wand: "✨",
};

export function omkStatusChips(): string {
  const chips = [
    style.purpleBold("[provider-neutral]"),
    style.blue("[agent-first]"),
    style.mintBold("[plan-first]"),
    style.orange("[safe]"),
    style.lightPurple("[open]"),
  ];
  return chips.join(" ");
}

export function omkCliHero(footer?: string): string {
  const heroLines = [
    gradient("✦ OMK ✦"),
    style.phosphorBold("Open Multi-agent Kit."),
    style.phosphor("Provider-neutral runtime for AI coding teams."),
    style.phosphorDim("DAG scheduling · evidence gates · worktree isolation · replay · memory"),
    "",
    ...OMK_MATRIX_ASCII_ART.split("\n").map((line) => style.matrixGreen(line)),
    "",
    omkStatusChips(),
  ];

  if (footer) {
    heroLines.push("", style.gray(footer));
  }

  return box(heroLines, "OMK — Open Multi-agent Kit");
}

/** @deprecated use omkCliHero */
export const kimicatCliHero = omkCliHero;
/** @deprecated use omkStatusChips */
export const kimicatStatusChips = omkStatusChips;

export function omkMetaBox(meta?: { directory?: string; session?: string; model?: string }): string {
  const metaLines: string[] = [];
  if (meta?.directory) metaLines.push(label("Directory", meta.directory));
  if (meta?.session) metaLines.push(label("Session", meta.session));
  if (meta?.model) metaLines.push(label("Model", meta.model));

  if (metaLines.length === 0) return "";
  return box(metaLines, "Session Info") + "\n";
}

/** @deprecated use omkMetaBox */
export const kimicatMetaBox = omkMetaBox;

export interface OmkThemeConfig {
  banner?: {
    title?: string;
    subtitle?: string;
    style?: "default" | "minimal" | "box" | "hero";
    asciiArt?: string;
    enabled?: boolean;
  };
  colors?: {
    primary?: string;
    accent?: string;
    success?: string;
    warning?: string;
    danger?: string;
    info?: string;
    muted?: string;
    text?: string;
    background?: string;
  };
  metaBox?: boolean;
}

export { P, hexToRgb, colorFromHex };

export async function loadThemeConfig(): Promise<OmkThemeConfig | null> {
  const { readFile } = await import("fs/promises");
  const { join } = await import("path");
  const { getProjectRoot, pathExists } = await import("../util/fs.js");
  const themePath = join(getProjectRoot(), ".omk", "theme.json");
  if (!(await pathExists(themePath))) return null;
  try {
    const content = await readFile(themePath, "utf-8");
    return JSON.parse(content) as OmkThemeConfig;
  } catch {
    return null;
  }
}

function themedGradient(text: string, startHex: string | undefined, endHex: string | undefined): string {
  const start = colorFromHex(startHex, P.purple);
  const end = colorFromHex(endHex, P.pink);
  const chars = [...text];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const t = chars.length === 1 ? 0.5 : i / (chars.length - 1);
    const r = Math.round(start.r + (end.r - start.r) * t);
    const g = Math.round(start.g + (end.g - start.g) * t);
    const b = Math.round(start.b + (end.b - start.b) * t);
    result.push(esc(rgb(r, g, b)) + chars[i] + esc("0"));
  }
  return result.join("");
}

function themedBox(
  lines: string[],
  title: string | undefined,
  primary: { r: number; g: number; b: number },
  _accent: { r: number; g: number; b: number }
): string {
  const primaryFn = (s: string) => esc(rgb(primary.r, primary.g, primary.b)) + s + esc("0");
  const termWidth = process.stdout.columns || 80;
  const rawInner = Math.max(
    ...lines.map((l) => stripAnsi(l).length),
    title ? stripAnsi(title).length + 4 : 0
  );
  const innerWidth = Math.min(rawInner, Math.max(termWidth - 4, 20));
  const width = innerWidth + 4;
  const top = title
    ? primaryFn("╔" + "═".repeat(2) + " " + title + " " + "═".repeat(Math.max(0, width - stripAnsi(title).length - 6)) + "╗")
    : primaryFn("╔" + "═".repeat(width) + "╗");
  const bottom = primaryFn("╚" + "═".repeat(width) + "╝");
  const body = lines.map((l) => primaryFn("║ ") + padEndAnsi(l, innerWidth) + primaryFn(" ║"));
  return [top, ...body, bottom].join("\n");
}

function buildThemedMetaBox(
  meta: { directory?: string; session?: string; model?: string } | undefined,
  primary: { r: number; g: number; b: number },
  text: { r: number; g: number; b: number },
  muted: { r: number; g: number; b: number }
): string {
  if (!meta) return "";
  const metaLines: string[] = [];
  const textFn = (s: string) => esc(rgb(text.r, text.g, text.b)) + s + esc("0");
  const mutedFn = (s: string) => esc(rgb(muted.r, muted.g, muted.b)) + s + esc("0");
  if (meta.directory) metaLines.push("  " + mutedFn("Directory:") + " " + textFn(meta.directory));
  if (meta.session) metaLines.push("  " + mutedFn("Session:") + " " + textFn(meta.session));
  if (meta.model) metaLines.push("  " + mutedFn("Model:") + " " + textFn(meta.model));
  if (metaLines.length === 0) return "";

  const innerWidth = Math.max(...metaLines.map((l) => stripAnsi(l).length));
  const width = innerWidth + 4;
  const top = esc(rgb(primary.r, primary.g, primary.b)) + "╔" + "═".repeat(width) + "╗" + esc("0");
  const bottom = esc(rgb(primary.r, primary.g, primary.b)) + "╚" + "═".repeat(width) + "╝" + esc("0");
  const body = metaLines.map((l) => esc(rgb(primary.r, primary.g, primary.b)) + "║ " + padEndAnsi(l, innerWidth) + " ║" + esc("0"));
  return [top, ...body, bottom].join("\n") + "\n";
}

export function omkBanner(
  meta?: { directory?: string; session?: string; model?: string },
  footer?: string,
  theme?: OmkThemeConfig
): string {
  if (theme?.banner?.enabled === false) return "";

  if (!theme || (!theme.banner && !theme.colors)) {
    const parts: string[] = [omkCliHero(footer)];
    const metaBox = omkMetaBox(meta);
    if (metaBox) parts.push(metaBox);
    return parts.join("\n");
  }

  const title = theme.banner?.title ?? "OMK";
  const subtitle = theme.banner?.subtitle ?? "Open Multi-agent Kit.";
  const styleName = theme.banner?.style ?? "default";
  const art = theme.banner?.asciiArt ?? "";
  const primary = colorFromHex(theme.colors?.primary, P.purple);
  const accent = colorFromHex(theme.colors?.accent, P.pink);
  const muted = colorFromHex(theme.colors?.muted, P.gray);
  const text = colorFromHex(theme.colors?.text, P.cream);

  const primaryFn = (s: string) => esc(rgb(primary.r, primary.g, primary.b)) + s + esc("0");
  const accentFn = (s: string) => esc(rgb(accent.r, accent.g, accent.b)) + s + esc("0");
  const mutedFn = (s: string) => esc(rgb(muted.r, muted.g, muted.b)) + s + esc("0");

  if (styleName === "minimal") {
    const parts: string[] = ["", primaryFn("▸ " + title) + " " + mutedFn(subtitle)];
    if (footer) parts.push(mutedFn(footer));
    if (theme.metaBox !== false && meta) {
      const m = meta.directory ? `dir:${meta.directory}` : "";
      const s = meta.session ? `session:${meta.session}` : "";
      const mo = meta.model ? `model:${meta.model}` : "";
      const metaStr = [m, s, mo].filter(Boolean).join(" │ ");
      if (metaStr) parts.push(mutedFn(metaStr));
    }
    parts.push("");
    return parts.join("\n");
  }

  const heroLines: string[] = [
    themedGradient("✦ " + title + " ✦", theme.colors?.primary, theme.colors?.accent),
    accentFn(subtitle),
    mutedFn("Provider-neutral runtime for AI coding teams."),
  ];

  if (art) {
    heroLines.push("", ...art.split("\n").map((line) => primaryFn(line)), "");
  } else {
    heroLines.push("");
  }

  heroLines.push(omkStatusChips());

  if (footer) heroLines.push("", mutedFn(footer));

  const result: string[] = ["", themedBox(heroLines, styleName === "hero" ? title : undefined, primary, accent), ""];

  if (theme.metaBox !== false) {
    const metaBox = buildThemedMetaBox(meta, primary, text, muted);
    if (metaBox) result.push(metaBox);
  }

  return result.join("\n");
}

/** @deprecated use omkBanner */
export const kimicatBanner = omkBanner;

const ROLE_COLORS: Record<string, (s: string) => string> = {
  orchestrator: style.purple,
  coordinator: style.purple,
  planner: style.blue,
  explorer: style.blue,
  coder: style.mint,
  reviewer: style.pink,
  qa: style.orange,
  architect: style.lightPurple,
  router: style.cream,
  default: style.gray,
};

export function roleColor(role: string): (s: string) => string {
  return ROLE_COLORS[role] ?? ROLE_COLORS.default;
}

export function parallelStatusBadge(nodeStatus: string, role: string): string {
  const color = roleColor(role);
  const badgeBg = nodeStatus === "running" ? style.bgPurple
    : nodeStatus === "done" ? style.bgDark
    : nodeStatus === "failed" ? style.bgPink
    : style.gray;
  const icon = nodeStatus === "running" ? "▶"
    : nodeStatus === "done" ? "✓"
    : nodeStatus === "failed" ? "✕"
    : nodeStatus === "blocked" ? "■"
    : "□";
  return badgeBg(` ${icon} ${nodeStatus.toUpperCase()} `) + " " + color(`[${role}]`);
}

export function workerLabel(id: string, role: string): string {
  const color = roleColor(role);
  return color(`${role}`) + style.gray(":") + " " + style.creamBold(id);
}

export function safetyChip(policy: string): string {
  if (policy === "yolo") return style.mintBold("[SAFETY:YOLO]") + " " + style.gray("auto-allow with hook guards");
  if (policy === "auto") return style.orangeBold("[SAFETY:AUTO]") + " " + style.gray("safe tools auto, destructive ask");
  if (policy === "interactive") return style.pinkBold("[SAFETY:INTERACTIVE]") + " " + style.gray("human approval required");
  if (policy === "block") return style.redBold("[SAFETY:BLOCK]") + " " + style.gray("all blocked");
  return style.gray(`[SAFETY:${policy}]`);
}

export function ensembleQuorumBar(successWeight: number, totalWeight: number, quorumWeight: number, width = 20): string {
  const ratio = totalWeight > 0 ? Math.min(1, successWeight / totalWeight) : 0;
  const quorumRatio = totalWeight > 0 ? Math.min(1, quorumWeight / totalWeight) : 0;
  const filled = Math.round(ratio * width);
  const quorumPos = Math.round(quorumRatio * width);
  const bar: string[] = [];
  for (let i = 0; i < width; i++) {
    if (i === quorumPos) {
      bar.push(style.creamBold("|"));
    } else if (i < filled) {
      bar.push(style.mint("█"));
    } else {
      bar.push(style.gray("░"));
    }
  }

  const pct = style.creamBold(`${Math.round(ratio * 100)}%`);
  return `  ${style.gray("quorum")} ${bar.join("")} ${pct} ${style.gray(`(need ${quorumWeight.toFixed(1)})`)}`;
}

export function workerOutputBox(lines: string[], workerId: string, role: string): string {
  const color = roleColor(role);
  const title = `${workerId} (${role})`;
  const prefix = color(`┃ `);
  const innerWidth = Math.max(...lines.map((l) => stripAnsi(l).length), stripAnsi(title).length + 4);
  const top = color(`┏━ ${style.pinkBold(title)} ${"━".repeat(Math.max(0, innerWidth - stripAnsi(title).length - 4))}┓`);
  const bottom = color(`┗${"━".repeat(innerWidth + 2)}┛`);
  const body = lines.map((l) => prefix + padEndAnsi(l, innerWidth) + color(" ┃"));
  return [top, ...body, bottom].join("\n");
}

export function approvalPromptBox(toolName: string, nodeId: string): string {
  return box([
    style.pinkBold(`⚠️  Approval required for ${toolName}`),
    style.gray(`Requested by node: ${nodeId}`),
    "",
    style.cream("Allow this operation? (y/n/describe):")
  ], "Safety Gate");
}

export function orangeBold(s: string): string {
  return esc("1;" + rgb(P.orange.r, P.orange.g, P.orange.b)) + s + esc("0");
}

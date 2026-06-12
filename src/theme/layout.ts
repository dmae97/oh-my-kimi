/**
 * OMK Theme — Layout primitives (headers, panels, boxes, gauges)
 * Extracted from util/theme.ts to break God Module coupling
 */

import { P } from "../brand/palette.js";
import { esc, rgb, stripAnsi, padEndAnsi, sanitizeTerminalText, visibleTerminalWidth } from "./ansi.js";
import { style } from "./colors.js";

export function header(text: string): string {
  return [
    "",
    style.phosphorDim("╔" + "═".repeat(2) + "✦" + "═".repeat(text.length + 2) + "✦" + "═".repeat(2) + "╗"),
    style.phosphorDim("║") + "  " + style.phosphorBold(text) + "  " + style.phosphorDim("║"),
    style.phosphorDim("╚" + "═".repeat(2) + "✦" + "═".repeat(text.length + 2) + "✦" + "═".repeat(2) + "╝"),
    "",
  ].join("\n");
}

export function subheader(text: string): string {
  return style.purpleBold("▸ " + text);
}

export function separator(width = 50): string {
  return style.gray("─".repeat(width));
}

export function bullet(text: string, color: "purple" | "pink" | "mint" | "blue" | "skin" = "purple"): string {
  const colors = { purple: style.purple, pink: style.pink, mint: style.mint, blue: style.blue, skin: style.skin };
  return "  " + colors[color]("◆") + " " + text;
}

export function label(key: string, value: string): string {
  return "  " + style.gray(sanitizeTerminalText(key) + ":") + " " + style.cream(sanitizeTerminalText(value));
}

export function box(lines: string[], title?: string): string {
  const termWidth = process.stdout.columns || 80;
  const rawTitle = title ? sanitizeTerminalText(title) : "";
  const rawTitleWidth = rawTitle ? visibleTerminalWidth(rawTitle) : 0;
  const rawInner = Math.max(
    ...lines.map((l) => stripAnsi(l).length),
    rawTitle ? rawTitleWidth + 4 : 0
  );
  const innerWidth = Math.min(rawInner, Math.max(termWidth - 4, 20));
  const width = innerWidth + 4;
  const titleText = rawTitle ? style.phosphorBold(rawTitle) : "";
  const top = rawTitle
    ? style.phosphorDim("╔" + "═".repeat(2) + " ") + titleText + style.phosphorDim(" " + "═".repeat(Math.max(0, width - rawTitleWidth - 6)) + "╗")
    : style.phosphorDim("╔" + "═".repeat(width) + "╗");
  const bottom = style.phosphorDim("╚" + "═".repeat(width) + "╝");
  const body = lines.map((l) => style.phosphorDim("║ ") + padEndAnsi(l, innerWidth) + style.phosphorDim(" ║"));
  return [top, ...body, bottom].join("\n");
}

/** Generate Matrix green text */
export function gradient(text: string): string {
  const chars = [...sanitizeTerminalText(text)];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const t = chars.length === 1 ? 0.5 : i / (chars.length - 1);
    const r = Math.round(0 + (P.matrixGreen.r - 0) * t * 0.7);
    const g = Math.round(50 + (P.matrixGreen.g - 50) * t);
    const b = Math.round(0 + (P.matrixGreen.b - 0) * t * 0.7);
    result.push(esc(rgb(r, g, b)) + chars[i] + esc("0"));
  }
  return result.join("");
}

/** Render a horizontal gauge bar */
export function gauge(
  label: string,
  value: number,
  max: number,
  width = 24
): string {
  const ratio = Math.min(Math.max(value / max, 0), 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  let barColor = rgb(P.matrixGreen.r, P.matrixGreen.g, P.matrixGreen.b);
  if (ratio > 0.7) barColor = rgb(P.metricsAmber.r, P.metricsAmber.g, P.metricsAmber.b);
  if (ratio > 0.9) barColor = rgb(P.metricsRed.r, P.metricsRed.g, P.metricsRed.b);

  const bar = esc(barColor) + "█".repeat(filled) + esc("0") + style.phosphorDim("░".repeat(empty));
  const pct = style.phosphorBold(`${Math.round(ratio * 100)}%`.padStart(4));
  return `  ${style.gray(label.padStart(10))} ${bar} ${pct}`;
}

/** Matrix green bordered panel with phosphor glow */
export function panel(lines: string[], title?: string): string {
  const termWidth = process.stdout.columns || 80;
  const rawTitle = title ? sanitizeTerminalText(title) : "";
  const rawTitleWidth = rawTitle ? visibleTerminalWidth(rawTitle) : 0;
  const rawInner = Math.max(...lines.map((l) => stripAnsi(l).length), rawTitle ? rawTitleWidth + 4 : 0);
  const innerWidth = Math.min(rawInner, Math.max(termWidth - 4, 20));
  const width = innerWidth + 4;
  const titleText = rawTitle ? gradient(rawTitle) : "";
  const top = rawTitle
    ? style.phosphorDim("┏" + "━".repeat(2) + " ") + titleText + style.phosphorDim(" " + "━".repeat(Math.max(0, width - rawTitleWidth - 6)) + "┓")
    : style.phosphorDim("┏" + "━".repeat(width) + "┓");
  const bottom = style.phosphorDim("┗" + "━".repeat(width) + "┛");
  const body = lines.map((l) =>
    style.phosphorDim("┃ ") + padEndAnsi(l, innerWidth) + style.phosphorDim(" ┃")
  );
  return [top, ...body, bottom].join("\n");
}

/** Sparkle header with stars */
export function sparkleHeader(text: string): string {
  const deco = "✨ 💜 ✨";
  const total = text.length + deco.length + 4;
  const line = "~".repeat(Math.min(total, 60));
  return [
    "",
    style.lightPurple(line),
    "  " + style.pinkBold(text) + "  " + style.purple(deco),
    style.lightPurple(line),
    "",
  ].join("\n");
}

/** Matrix-style OMK header */
export function matrixHeader(text: string): string {
  return [
    "",
    style.phosphorBold(text),
    style.phosphorDim("═".repeat(Math.min(visibleTerminalWidth(text), 56))),
    "",
  ].join("\n");
}

/** Single stat line: label + value + optional unit */
export function stat(label: string, value: string, unit = ""): string {
  return "  " + style.phosphorDim(label + ":") + " " + style.phosphorBold(value) + style.phosphorDim(unit);
}

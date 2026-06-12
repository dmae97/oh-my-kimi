/**
 * OMK Theme — Metrics panels, gauges, and system usage
 * Extracted from util/theme.ts to break God Module coupling
 */

import { totalmem, freemem, loadavg, cpus } from "os";
import { P } from "../brand/palette.js";
import { esc, stripAnsi, padEndAnsi, visibleTerminalWidth, sanitizeTerminalText } from "./ansi.js";
import { style } from "./colors.js";

export function metricsPanel(lines: string[], title?: string): string {
  const rawTitle = title ? sanitizeTerminalText(title) : "";
  const innerWidth = Math.max(...lines.map((l) => stripAnsi(l).length), rawTitle ? rawTitle.length + 4 : 0);
  const width = innerWidth + 4;
  const top = rawTitle
    ? style.slate("╭" + "─".repeat(2) + " " + style.cyanBold(rawTitle) + " " + "─".repeat(Math.max(0, width - rawTitle.length - 4)) + "╮")
    : style.slate("╭" + "─".repeat(width) + "╮");
  const bottom = style.slate("╰" + "─".repeat(width) + "╯");
  const body = lines.map((l) =>
    style.slate("│ ") + padEndAnsi(l, innerWidth) + style.slate(" │")
  );
  return [top, ...body, bottom].join("\n");
}

export function metricsGauge(
  label: string,
  value: number,
  max: number,
  width = 24
): string {
  const ratio = Math.min(Math.max(value / max, 0), 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  let barColor = "38;2;34;197;94";
  if (ratio > 0.7) barColor = "38;2;245;158;11";
  if (ratio > 0.9) barColor = "38;2;239;68;68";

  const bar = esc(barColor) + "█".repeat(filled) + esc("0") + style.silver("░".repeat(empty));
  const pct = style.whiteBold(`${Math.round(ratio * 100)}%`.padStart(4));
  return `  ${style.silver(label.padStart(10))} ${bar} ${pct}`;
}

export function metricsGradient(text: string): string {
  const chars = [...sanitizeTerminalText(text)];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const t = chars.length === 1 ? 0.5 : i / (chars.length - 1);
    const r = Math.round(P.metricsCyan.r + (P.metricsViolet.r - P.metricsCyan.r) * t);
    const g = Math.round(P.metricsCyan.g + (P.metricsViolet.g - P.metricsCyan.g) * t);
    const b = Math.round(P.metricsCyan.b + (P.metricsViolet.b - P.metricsCyan.b) * t);
    result.push(esc("38;2;" + r + ";" + g + ";" + b + "m") + chars[i] + esc("0"));
  }
  return result.join("");
}

export function metricsHeader(text: string): string {
  return [
    "",
    style.slate("╭" + "─".repeat(2) + "✦" + "─".repeat(text.length + 2) + "✦" + "─".repeat(2) + "╮"),
    style.slate("│") + "  " + style.cyanBold(text) + "  " + style.slate("│"),
    style.slate("╰" + "─".repeat(2) + "✦" + "─".repeat(text.length + 2) + "✦" + "─".repeat(2) + "╯"),
    "",
  ].join("\n");
}

export function metricsStat(label: string, value: string, unit = ""): string {
  return "  " + style.silver(label + ":") + " " + style.cyanBold(value) + style.silver(unit);
}

export function metricsMatrixHeader(text: string): string {
  return [
    "",
    style.cyanBold("╔══ " + text + " ═══════════════════════════════════════════════════════════════════╗"),
    style.cyan("║  ✦ OMK Metrics · real-time dashboard"),
    style.slate("╚" + "═".repeat(Math.min(visibleTerminalWidth(text) + 20, 66)) + "╝"),
    "",
  ].join("\n");
}

/** Get system usage snapshot */
export function getSystemUsage(): {
  cpuPercent: number;
  memUsedGB: number;
  memTotalGB: number;
  memPercent: number;
  loadAvg: number[];
  heapUsedMB: number;
  heapTotalMB: number;
  heapExternalMB: number;
  eventLoopLagMs: number;
  uptimeSeconds: number;
} {
  const memTotal = totalmem();
  const memFree = freemem();
  const memUsed = memTotal - memFree;

  const cores = cpus().length;
  const load1 = loadavg()[0];
  const cpuPercent = Math.min(Math.round((load1 / cores) * 100), 100);

  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memUsage.heapUsed / 1048576);
  const heapTotalMB = Math.round(memUsage.heapTotal / 1048576);
  const heapExternalMB = Math.round(memUsage.external / 1048576);

  const lagStart = process.hrtime.bigint();
  const lagEnd = process.hrtime.bigint();
  const eventLoopLagMs = Number(lagEnd - lagStart) / 1_000_000;

  return {
    cpuPercent,
    memUsedGB: Math.round((memUsed / 1024 / 1024 / 1024) * 10) / 10,
    memTotalGB: Math.round((memTotal / 1024 / 1024 / 1024) * 10) / 10,
    memPercent: Math.round((memUsed / memTotal) * 100),
    loadAvg: loadavg(),
    heapUsedMB,
    heapTotalMB,
    heapExternalMB,
    eventLoopLagMs,
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

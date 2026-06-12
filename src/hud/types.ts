/**
 * HUD Theme Interface — decouples render.ts from theme.ts implementation
 *
 * All HUD rendering goes through this contract. theme.ts implements it;
 * render.ts depends only on the interface.
 */

export interface HudStyle {
  blue: (s: string) => string;
  cream: (s: string) => string;
  creamBold: (s: string) => string;
  gray: (s: string) => string;
  mint: (s: string) => string;
  mintBold: (s: string) => string;
  orange: (s: string) => string;
  orangeBold: (s: string) => string;
  phosphor: (s: string) => string;
  pinkBold: (s: string) => string;
  purple: (s: string) => string;
  purpleBold: (s: string) => string;
  red: (s: string) => string;
  redBold: (s: string) => string;
}

export interface HudStatus {
  ok: (s: string) => string;
  warn: (s: string) => string;
  info: (s: string) => string;
}

export interface SystemUsage {
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
}

export interface HudTheme {
  style: HudStyle;
  status: HudStatus;
  panel(lines: string[], title?: string): string;
  gauge(label: string, value: number, max: number, width?: number): string;
  stat(label: string, value: string, unit?: string): string;
  matrixHeader(text: string): string;
  gradient(text: string): string;
  separator(width?: number): string;
  padEndAnsi(str: string, len: number): string;
  sanitizeTerminalText(value: string): string;
  getSystemUsage(): SystemUsage;
}

export interface HudThinkingEntry {
  agentId: string;
  step: string;
  status: "running" | "done" | "failed";
  timestamp: number;
}

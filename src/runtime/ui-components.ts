/**
 * UI Components — Semantic card/box components for ThemeRenderer.
 *
 * Uses ThemePalette semantic tokens for consistent theming.
 * All components return formatted strings ready for terminal output.
 *
 * Components: statusCard, providerCard, memoryCard, mcpHealthCard,
 *             errorBox, traceSummary, consentNotice
 */

import type { ThemePalette } from "../cli/theme/theme-registry.js";
import type { ReasoningTrace, TraceSummary } from "./contracts/reasoning-trace.js";
import { t } from "../util/i18n.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BOX_H = "─";
const BOX_V = "│";
const BOX_TL = "┌";
const BOX_TR = "┐";
const BOX_BL = "└";
const BOX_BR = "┘";

function themed(p: ThemePalette | undefined, token: Parameters<ThemePalette["render"]>[0], text: string): string {
  if (!p || !p.supportsColor) return text;
  return p.render(token, text);
}

function dim(p: ThemePalette | undefined, text: string): string {
  return themed(p, "dim", text);
}

function separator(p: ThemePalette | undefined, width = 50): string {
  return dim(p, BOX_H.repeat(width));
}

function boxLine(p: ThemePalette | undefined, content: string, width = 50): string {
  const stripped = stripAnsi(content);
  const padding = Math.max(0, width - stripped.length - 2);
  return `${dim(p, BOX_V)} ${content}${" ".repeat(padding)}${dim(p, BOX_V)}`;
}

function boxTop(p: ThemePalette | undefined, title: string, width = 50): string {
  const titleStr = ` ${title} `;
  const remain = width - stripAnsi(titleStr).length - 2;
  const left = Math.floor(remain / 2);
  const right = remain - left;
  return `${dim(p, BOX_TL)}${dim(p, BOX_H.repeat(left))}${titleStr}${dim(p, BOX_H.repeat(right))}${dim(p, BOX_TR)}`;
}

function boxBottom(p: ThemePalette | undefined, width = 50): string {
  return `${dim(p, BOX_BL)}${dim(p, BOX_H.repeat(width))}${dim(p, BOX_BR)}`;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── statusCard ───────────────────────────────────────────────────────────────

export interface StatusCardData {
  intent: string;
  provider: string;
  model?: string;
  runtime?: string;
  risk?: string;
  mcpCount?: number;
  skillCount?: number;
  durationMs?: number;
}

export function statusCard(p: ThemePalette | undefined, data: StatusCardData): string {
  const w = 52;
  const lines: string[] = [];
  lines.push(boxTop(p, themed(p, "header", t("ui.statusCard.title")), w));
  lines.push(boxLine(p, `${dim(p, t("ui.statusCard.intent"))} ${themed(p, "info", data.intent)}`, w));
  lines.push(boxLine(p, `${dim(p, t("ui.statusCard.provider"))} ${themed(p, "agent", data.provider)}${data.model ? ` / ${themed(p, "task", data.model)}` : ""}`, w));
  if (data.runtime) lines.push(boxLine(p, `${dim(p, t("ui.statusCard.runtime"))} ${data.runtime}`, w));
  if (data.risk) lines.push(boxLine(p, `${dim(p, t("ui.statusCard.risk"))} ${themed(p, "warning", data.risk)}`, w));
  if (data.mcpCount !== undefined) lines.push(boxLine(p, `${dim(p, t("ui.statusCard.mcp"))} ${themed(p, "tool", String(data.mcpCount))}`, w));
  if (data.skillCount !== undefined) lines.push(boxLine(p, `${dim(p, t("ui.statusCard.skills"))} ${themed(p, "tool", String(data.skillCount))}`, w));
  if (data.durationMs !== undefined) {
    const dur = data.durationMs >= 1000 ? `${(data.durationMs / 1000).toFixed(1)}s` : `${data.durationMs}ms`;
    lines.push(boxLine(p, `${dim(p, t("ui.statusCard.duration"))} ${themed(p, "info", dur)}`, w));
  }
  lines.push(boxBottom(p, w));
  return lines.join("\n");
}

// ─── providerCard ─────────────────────────────────────────────────────────────

export interface ProviderCardData {
  provider: string;
  model: string;
  runtimeMode?: string;
  apiBase?: string;
  connected?: boolean;
}

export function providerCard(p: ThemePalette | undefined, data: ProviderCardData): string {
  const w = 52;
  const lines: string[] = [];
  lines.push(boxTop(p, themed(p, "header", t("ui.providerCard.title")), w));
  lines.push(boxLine(p, `${dim(p, t("ui.providerCard.provider"))} ${themed(p, "agent", data.provider)}`, w));
  lines.push(boxLine(p, `${dim(p, t("ui.providerCard.model"))} ${themed(p, "task", data.model)}`, w));
  if (data.runtimeMode) lines.push(boxLine(p, `${dim(p, t("ui.providerCard.mode"))} ${data.runtimeMode}`, w));
  if (data.apiBase) lines.push(boxLine(p, `${dim(p, t("ui.providerCard.api"))} ${dim(p, data.apiBase)}`, w));
  if (data.connected !== undefined) {
    const statusText = data.connected ? themed(p, "success", "●") : themed(p, "error", "○");
    lines.push(boxLine(p, `${dim(p, t("ui.providerCard.status"))} ${statusText}`, w));
  }
  lines.push(boxBottom(p, w));
  return lines.join("\n");
}

// ─── memoryCard ───────────────────────────────────────────────────────────────

export interface MemoryCardData {
  projectId?: string;
  decisions?: number;
  todos?: number;
  facts?: number;
  lastUpdated?: string;
}

export function memoryCard(p: ThemePalette | undefined, data: MemoryCardData): string {
  const w = 52;
  const lines: string[] = [];
  lines.push(boxTop(p, themed(p, "header", t("ui.memoryCard.title")), w));
  if (data.projectId) lines.push(boxLine(p, `${dim(p, t("ui.memoryCard.project"))} ${dim(p, data.projectId.slice(0, 12))}`, w));
  if (data.decisions !== undefined) lines.push(boxLine(p, `${dim(p, t("ui.memoryCard.decisions"))} ${themed(p, "info", String(data.decisions))}`, w));
  if (data.todos !== undefined) lines.push(boxLine(p, `${dim(p, t("ui.memoryCard.todos"))} ${themed(p, "warning", String(data.todos))}`, w));
  if (data.facts !== undefined) lines.push(boxLine(p, `${dim(p, t("ui.memoryCard.facts"))} ${themed(p, "tool", String(data.facts))}`, w));
  if (data.lastUpdated) lines.push(boxLine(p, `${dim(p, t("ui.memoryCard.updated"))} ${dim(p, data.lastUpdated)}`, w));
  lines.push(boxBottom(p, w));
  return lines.join("\n");
}

// ─── mcpHealthCard ────────────────────────────────────────────────────────────

export interface McpServerHealth {
  name: string;
  status: "connected" | "failed" | "disabled" | "pending";
  toolCount?: number;
  error?: string;
}

export interface McpHealthCardData {
  servers: McpServerHealth[];
  totalTools?: number;
}

export function mcpHealthCard(p: ThemePalette | undefined, data: McpHealthCardData): string {
  const w = 52;
  const lines: string[] = [];
  lines.push(boxTop(p, themed(p, "header", t("ui.mcpCard.title")), w));
  for (const srv of data.servers) {
    let statusIcon: string;
    switch (srv.status) {
      case "connected": statusIcon = themed(p, "success", "●"); break;
      case "failed": statusIcon = themed(p, "error", "✖"); break;
      case "disabled": statusIcon = dim(p, "○"); break;
      case "pending": statusIcon = themed(p, "warning", "◌"); break;
    }
    const toolStr = srv.toolCount !== undefined ? dim(p, ` (${srv.toolCount})`) : "";
    const errStr = srv.error ? ` ${dim(p, "—")} ${themed(p, "error", srv.error)}` : "";
    lines.push(boxLine(p, `  ${statusIcon} ${themed(p, "tool", srv.name)}${toolStr}${errStr}`, w));
  }
  if (data.totalTools !== undefined) {
    lines.push(boxLine(p, separator(p, w - 4), w));
    lines.push(boxLine(p, `${dim(p, t("ui.mcpCard.total"))} ${themed(p, "info", String(data.totalTools))}`, w));
  }
  lines.push(boxBottom(p, w));
  return lines.join("\n");
}

// ─── errorBox ─────────────────────────────────────────────────────────────────

export interface ErrorBoxData {
  message: string;
  recoverable?: boolean;
  code?: string;
  suggestion?: string;
}

export function errorBox(p: ThemePalette | undefined, data: ErrorBoxData): string {
  const w = 52;
  const lines: string[] = [];
  const title = data.recoverable ? t("ui.errorBox.recoverable") : t("ui.errorBox.fatal");
  lines.push(boxTop(p, themed(p, "error", title), w));
  lines.push(boxLine(p, themed(p, "error", data.message), w));
  if (data.code) lines.push(boxLine(p, `${dim(p, t("ui.errorBox.code"))} ${themed(p, "warning", data.code)}`, w));
  if (data.suggestion) lines.push(boxLine(p, `${dim(p, t("ui.errorBox.suggestion"))} ${data.suggestion}`, w));
  lines.push(boxBottom(p, w));
  return lines.join("\n");
}

// ─── traceSummary ─────────────────────────────────────────────────────────────

export function traceSummaryCard(p: ThemePalette | undefined, trace: ReasoningTrace): string {
  const w = 52;
  const lines: string[] = [];
  lines.push(boxTop(p, themed(p, "header", t("ui.traceCard.title")), w));
  lines.push(boxLine(p, `${dim(p, t("ui.traceCard.intent"))} ${themed(p, "info", trace.userIntent.classified)}`, w));
  lines.push(boxLine(p, `${dim(p, t("ui.traceCard.risk"))} ${themed(p, "warning", trace.userIntent.risk)}`, w));
  lines.push(boxLine(p, `${dim(p, t("ui.traceCard.plan"))} ${trace.plan.summary.slice(0, 40)}`, w));
  const tools = trace.execution.toolSequence.map(tc => tc.name).join(", ");
  lines.push(boxLine(p, `${dim(p, t("ui.traceCard.tools"))} ${dim(p, tools.slice(0, 40))}`, w));
  const statusIcon = trace.result.status === "success" ? themed(p, "success", "✔") :
                     trace.result.status === "partial" ? themed(p, "warning", "◐") :
                     themed(p, "error", "✖");
  lines.push(boxLine(p, `${dim(p, t("ui.traceCard.result"))} ${statusIcon} ${trace.result.summary.slice(0, 35)}`, w));
  lines.push(boxLine(p, `${dim(p, t("ui.traceCard.confidence"))} ${themed(p, "info", `${(trace.result.confidence * 100).toFixed(0)}%`)}`, w));
  lines.push(boxBottom(p, w));
  return lines.join("\n");
}

export function traceSummaryCompact(p: ThemePalette | undefined, summary: TraceSummary): string {
  const statusIcon = summary.outcome === "success" ? themed(p, "success", "✔") :
                     summary.outcome === "partial" ? themed(p, "warning", "◐") :
                     themed(p, "error", "✖");
  return `${statusIcon} ${dim(p, summary.intent)} → ${summary.planSummary.slice(0, 60)} ${dim(p, `[${summary.confidence}%]`)}`;
}

// ─── consentNotice ────────────────────────────────────────────────────────────

export interface ConsentNoticeData {
  level: "l0" | "l1" | "l2" | "l3";
  includedInDataset: boolean;
  redactedFields?: string[];
}

export function consentNotice(p: ThemePalette | undefined, data: ConsentNoticeData): string {
  const w = 52;
  const lines: string[] = [];
  lines.push(boxTop(p, themed(p, "header", t("ui.consent.title")), w));
  const levelLabel = t(`ui.consent.level.${data.level}`);
  lines.push(boxLine(p, `${dim(p, t("ui.consent.level"))} ${themed(p, "info", levelLabel)}`, w));
  const datasetIcon = data.includedInDataset
    ? themed(p, "success", t("ui.consent.eligible"))
    : themed(p, "warning", t("ui.consent.notEligible"));
  lines.push(boxLine(p, `${dim(p, t("ui.consent.dataset"))} ${datasetIcon}`, w));
  if (data.redactedFields && data.redactedFields.length > 0) {
    lines.push(boxLine(p, `${dim(p, t("ui.consent.redacted"))} ${dim(p, data.redactedFields.join(", "))}`, w));
  }
  lines.push(boxBottom(p, w));
  return lines.join("\n");
}

// ─── i18n keys for UI components ──────────────────────────────────────────────
// These should be added to src/util/i18n.ts EN/KO dictionaries.
//
// EN:
//   ui.statusCard.title: "Runtime Status"
//   ui.statusCard.intent: "Intent:"
//   ui.statusCard.provider: "Provider:"
//   ui.statusCard.runtime: "Runtime:"
//   ui.statusCard.risk: "Risk:"
//   ui.statusCard.mcp: "MCP:"
//   ui.statusCard.skills: "Skills:"
//   ui.statusCard.duration: "Duration:"
//   ui.providerCard.title: "Provider"
//   ui.providerCard.provider: "Provider:"
//   ui.providerCard.model: "Model:"
//   ui.providerCard.mode: "Mode:"
//   ui.providerCard.api: "API:"
//   ui.providerCard.status: "Status:"
//   ui.memoryCard.title: "Memory"
//   ui.memoryCard.project: "Project:"
//   ui.memoryCard.decisions: "Decisions:"
//   ui.memoryCard.todos: "Todos:"
//   ui.memoryCard.facts: "Facts:"
//   ui.memoryCard.updated: "Updated:"
//   ui.mcpCard.title: "MCP Health"
//   ui.mcpCard.total: "Total tools:"
//   ui.errorBox.recoverable: "Recoverable Error"
//   ui.errorBox.fatal: "Fatal Error"
//   ui.errorBox.code: "Code:"
//   ui.errorBox.suggestion: "Suggestion:"
//   ui.traceCard.title: "Reasoning Trace"
//   ui.traceCard.intent: "Intent:"
//   ui.traceCard.risk: "Risk:"
//   ui.traceCard.plan: "Plan:"
//   ui.traceCard.tools: "Tools:"
//   ui.traceCard.result: "Result:"
//   ui.traceCard.confidence: "Confidence:"
//   ui.consent.title: "Data Consent"
//   ui.consent.level: "Level:"
//   ui.consent.level.l0: "L0 — Ops Stats"
//   ui.consent.level.l1: "L1 — Trace Meta"
//   ui.consent.level.l2: "L2 — Trajectory"
//   ui.consent.level.l3: "L3 — Sample Pack"
//   ui.consent.dataset: "Dataset:"
//   ui.consent.eligible: "Eligible"
//   ui.consent.notEligible: "Not eligible"
//   ui.consent.redacted: "Redacted:"

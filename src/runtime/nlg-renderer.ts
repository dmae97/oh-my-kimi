/**
 * NLG Renderer — consent-aware Natural Language Generation.
 *
 * Produces human-readable reasoning summaries and consent eligibility reports.
 * Uses i18n for bilingual (KO/EN) support.
 * Integrates with ThemePalette for styled output.
 *
 * Key principle: "사용자에게는 theme/NLG만"
 */

import type { ThemePalette } from "../cli/theme/theme-registry.js";
import type { ReasoningTrace, TraceSummary, ConsentAwareNlgOutput } from "./contracts/reasoning-trace.js";
import { summarizeTrace, generateConsentReport } from "./reasoning-trace.js";
import { t } from "../util/i18n.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NlgRendererOptions {
  /** Theme palette for styled output */
  palette?: ThemePalette;
  /** Language override (defaults to i18n system language) */
  language?: "ko" | "en";
  /** Include file change details */
  includeFiles?: boolean;
  /** Include command execution details */
  includeCommands?: boolean;
  /** Consent level for redaction */
  consentLevel?: "l0" | "l1" | "l2" | "l3";
  /** Write function for output (defaults to process.stdout.write) */
  write?: (text: string) => void;
}

export interface NlgRenderer {
  /** Render a reasoning trace to human-readable summary */
  renderTrace(trace: ReasoningTrace): string;
  /** Render a trace summary (compact one-liner) */
  renderSummary(summary: TraceSummary): string;
  /** Generate consent-aware report */
  renderConsentReport(trace: ReasoningTrace, consentLevel: "l0" | "l1" | "l2" | "l3"): ConsentAwareNlgOutput;
  /** Render turn result with reasoning context */
  renderTurnResult(trace: ReasoningTrace): string;
  /** Flush buffered output */
  flush(): string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function themed(p: ThemePalette | undefined, token: Parameters<ThemePalette["render"]>[0], text: string): string {
  if (!p || !p.supportsColor) return text;
  return p.render(token, text);
}

function outcomeIcon(outcome: string): string {
  switch (outcome) {
    case "success": return "✓";
    case "partial": return "◐";
    case "failed": return "✗";
    case "blocked": return "⊘";
    default: return "·";
  }
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

// ─── NLG Renderer Factory ────────────────────────────────────────────────────

export function createNlgRenderer(options?: NlgRendererOptions): NlgRenderer {
  const palette = options?.palette;
  const lines: string[] = [];

  function write(text: string): void {
    if (options?.write) {
      options.write(text + "\n");
    } else {
      lines.push(text);
    }
  }

  return {
    renderTrace(trace: ReasoningTrace): string {
      const summary = summarizeTrace(trace);
      const out: string[] = [];

      // Header
      out.push(themed(palette, "header", t("nlg.traceHeader")));
      out.push("");

      // Intent + confidence
      out.push(`${themed(palette, "labelKey", t("nlg.intent"))} ${themed(palette, "info", summary.intent)} ${themed(palette, "dim", `(${Math.round(summary.confidence * 100)}%)`)}`);

      // Plan
      out.push(`${themed(palette, "labelKey", t("nlg.plan"))} ${summary.planSummary}`);

      // Tools used
      if (summary.toolsUsed.length > 0) {
        out.push(`${themed(palette, "labelKey", t("nlg.tools"))} ${summary.toolsUsed.map(tool => themed(palette, "tool", tool)).join(", ")}`);
      }

      // Test result
      if (summary.testResult) {
        out.push(`${themed(palette, "labelKey", t("nlg.tests"))} ${summary.testResult}`);
      }

      // Outcome
      const icon = outcomeIcon(summary.outcome);
      const outcomeToken = summary.outcome === "success" ? "success" : summary.outcome === "failed" ? "error" : "warning";
      out.push(`${themed(palette, "labelKey", t("nlg.outcome"))} ${themed(palette, outcomeToken, `${icon} ${summary.outcome}`)}`);

      // Duration
      out.push(`${themed(palette, "labelKey", t("nlg.duration"))} ${formatDuration(trace.execution.durationMs)}`);

      // Failure reason
      if (trace.result.failureReason) {
        out.push(`${themed(palette, "labelKey", t("nlg.failure"))} ${themed(palette, "error", trace.result.failureReason)}`);
      }

      // Decision records
      if (trace.execution.decisionRecords.length > 0) {
        out.push("");
        out.push(themed(palette, "subheader", t("nlg.decisions")));
        for (const d of trace.execution.decisionRecords) {
          out.push(`  ${themed(palette, "bullet", "•")} ${themed(palette, "labelKey", d.point)} → ${themed(palette, "info", d.chosen)} ${themed(palette, "dim", `(${d.reason})`)}`);
        }
      }

      const result = out.join("\n");
      write(result);
      return result;
    },

    renderSummary(summary: TraceSummary): string {
      const icon = outcomeIcon(summary.outcome);
      const outcomeToken = summary.outcome === "success" ? "success" : summary.outcome === "failed" ? "error" : "warning";
      const line = `${themed(palette, outcomeToken, icon)} ${themed(palette, "info", summary.intent)} → ${themed(palette, outcomeToken, summary.outcome)} ${themed(palette, "dim", `(${summary.duration})`)}`;
      write(line);
      return line;
    },

    renderConsentReport(trace: ReasoningTrace, consentLevel: "l0" | "l1" | "l2" | "l3"): ConsentAwareNlgOutput {
      const language = options?.language ?? "en";
      const report = generateConsentReport({
        trace,
        consentLevel,
        includeFiles: options?.includeFiles ?? false,
        includeCommands: options?.includeCommands ?? false,
        language,
      });

      write(report.report);
      return report;
    },

    renderTurnResult(trace: ReasoningTrace): string {
      const summary = summarizeTrace(trace);
      const out: string[] = [];

      // Compact result line
      const icon = outcomeIcon(summary.outcome);
      const outcomeToken = summary.outcome === "success" ? "success" : summary.outcome === "failed" ? "error" : "warning";

      out.push(`${themed(palette, outcomeToken, icon)} ${themed(palette, "info", summary.intent)} → ${themed(palette, outcomeToken, summary.outcome)} ${themed(palette, "dim", `(${summary.duration})`)}`);
      out.push(`  ${themed(palette, "dim", summary.planSummary)}`);

      // Tools used (compact)
      if (summary.toolsUsed.length > 0) {
        out.push(`  ${themed(palette, "dim", summary.toolsUsed.join(", "))}`);
      }

      // Failure reason
      if (trace.result.failureReason) {
        out.push(`  ${themed(palette, "error", trace.result.failureReason)}`);
      }

      const result = out.join("\n");
      write(result);
      return result;
    },

    flush(): string {
      const output = lines.join("\n");
      lines.length = 0;
      return output;
    },
  };
}

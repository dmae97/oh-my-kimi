/**
 * Renderers — three output strategies for OmkEvent consumption.
 *
 * ThemeRenderer: rich terminal output using ThemePalette for semantic colors.
 * NlpRenderer: bilingual (KO/EN) structured NLP output for provider consumption.
 * JsonRenderer: structured JSON output for programmatic consumption.
 *
 * Invariant I-004: provider stdout MUST NOT bypass the router.
 */

import type { OmkEvent, OmkEventData } from "./contracts/command-envelope.js";
import type { ThemePalette, SemanticToken } from "../cli/theme/theme-registry.js";
import { t } from "../util/i18n.js";

// ─── Fallback ANSI helpers (used when no ThemePalette provided) ─────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;

// opencode-style spinner frames
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerIdx = 0;
function spinnerNext(): string {
  const frame = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length];
  spinnerIdx++;
  return frame;
}

function fallbackColorize(text: string, ...codes: string[]): string {
  return `${codes.join("")}${text}${RESET}`;
}

function progressBar(percent: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const bar = `${"█".repeat(filled)}${"░".repeat(empty)}`;
  return `${bar} ${clamped.toFixed(0)}%`;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

/** Strip ANSI escape sequences */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
// ─── ThemePalette helpers ───────────────────────────────────────────────────

/**
 * Render text with a semantic token from the palette.
 * Falls back to plain text if no palette or palette doesn't support color.
 */
function themed(palette: ThemePalette | undefined, token: SemanticToken, text: string): string {
  if (!palette || !palette.supportsColor) return text;
  return palette.render(token, text);
}

/**
 * Render text with dim styling.
 */
function dim(palette: ThemePalette | undefined, text: string): string {
  if (!palette || !palette.supportsColor) return fallbackColorize(text, DIM);
  return palette.render("dim", text);
}

// ─── ThemeRenderer (opencode-style compact output) ──────────────────────────

export interface ThemeRenderer {
  renderTurnStarted(intent: string, provider: string): void;
  renderProgress(message: string, percent?: number): void;
  renderMcpStatus(server: string, status: string): void;
  renderWarning(message: string): void;
  renderResult(content: string): void;
  renderError(message: string, recoverable: boolean): void;
  renderTurnFinished(durationMs: number): void;
  renderStatusBar(provider: string, model: string, intent: string): void;
  flush(): void;
}

export function createThemeRenderer(
  write: (text: string) => void = process.stdout.write.bind(process.stdout),
  palette?: ThemePalette,
): ThemeRenderer {
  function emit(line: string): void {
    write(line + "\n");
  }

  return {
    renderTurnStarted(intent: string, provider: string): void {
      // opencode-style: compact one-liner with dim timestamp
      const ts = dim(palette, timestamp());
      const icon = themed(palette, "success", "●");
      const intentColored = themed(palette, "info", intent);
      const providerColored = themed(palette, "agent", provider);
      emit(`  ${icon} ${ts} ${intentColored} → ${providerColored}`);
    },

    renderProgress(message: string, percent?: number): void {
      // opencode-style: spinner + compact message
      const spin = themed(palette, "warning", spinnerNext());
      const bar = percent !== undefined ? ` ${progressBar(percent)}` : "";
      emit(`  ${spin} ${message}${bar}`);
    },

    renderMcpStatus(server: string, status: string): void {
      // opencode-style: inline dot status
      let dot: string;
      switch (status) {
        case "connected": dot = themed(palette, "success", "●"); break;
        case "failed": dot = themed(palette, "error", "✖"); break;
        case "disabled": dot = dim(palette, "○"); break;
        default: dot = themed(palette, "warning", "◌");
      }
      const srv = themed(palette, "tool", server);
      emit(`    ${dot} ${srv}`);
    },

    renderWarning(message: string): void {
      const icon = themed(palette, "warning", "!");
      emit(`  ${icon} ${themed(palette, "warning", message)}`);
    },

    renderResult(content: string): void {
      // opencode-style: clean output, no tags
      const lines = content.split("\n");
      for (const line of lines) {
        emit(`  ${line}`);
      }
    },

    renderError(message: string, recoverable: boolean): void {
      // opencode-style: box overlay for errors
      const label = recoverable ? " Recoverable Error " : " Fatal Error ";
      const w = Math.max(stripAnsi(message).length + 4, 40);
      const top = `${"┌".padEnd(w + 1, "─")}┐`;
      const bot = `${"└".padEnd(w + 1, "─")}┘`;
      const labelLine = `│ ${themed(palette, "error", label)}${" ".repeat(Math.max(0, w - label.length - 1))}│`;
      const msgLine = `│ ${message}${" ".repeat(Math.max(0, w - stripAnsi(message).length - 1))}│`;
      emit("");
      emit(`  ${dim(palette, top)}`);
      emit(`  ${dim(palette, labelLine)}`);
      emit(`  ${dim(palette, msgLine)}`);
      emit(`  ${dim(palette, bot)}`);
      emit("");
    },

    renderTurnFinished(durationMs: number): void {
      const ts = dim(palette, timestamp());
      const icon = themed(palette, "success", "●");
      const dur = durationMs >= 1000
        ? `${(durationMs / 1000).toFixed(1)}s`
        : `${durationMs}ms`;
      emit(`  ${icon} ${ts} ${dim(palette, "done in")} ${themed(palette, "info", dur)}`);
    },

    renderStatusBar(provider: string, model: string, intent: string): void {
      // opencode-style: bottom status bar
      const p = themed(palette, "agent", provider);
      const m = themed(palette, "task", model);
      const i = themed(palette, "info", intent);
      const sep = dim(palette, "│");
      emit("");
      emit(`  ${sep} ${p} ${sep} ${m} ${sep} ${i} ${sep}`);
    },

    flush(): void {
      // Theme renderer flushes on each emit; nothing buffered.
    },
  };
}

// ─── NlpRenderer (bilingual KO/EN) ──────────────────────────────────────────

export interface NlpRenderer {
  render(event: OmkEvent): string;
  flush(): string;
}

/**
 * Bilingual NLP message templates.
 * Uses the existing i18n system (t()) for KO/EN support.
 */
const nlpMessages = {
  turnStarted: (intent: string, provider: string) =>
    t("nlp.turnStarted", intent, provider),
  progress: (message: string) =>
    t("nlp.progress", message),
  progressWithPercent: (message: string, percent: string) =>
    t("nlp.progressWithPercent", message, percent),
  mcpStatus: (server: string, status: string) =>
    t("nlp.mcpStatus", server, status),
  warning: (message: string) =>
    t("nlp.warning", message),
  result: (content: string) =>
    t("nlp.result", content),
  recoverableError: (message: string) =>
    t("nlp.recoverableError", message),
  fatalError: (message: string) =>
    t("nlp.fatalError", message),
  turnFinished: (duration: string) =>
    t("nlp.turnFinished", duration),
  event: (type: string) =>
    t("nlp.event", type),
};

export function createNlpRenderer(): NlpRenderer {
  const lines: string[] = [];

  function renderEventData(data: OmkEventData): string {
    switch (data.kind) {
      case "turn_started":
        return nlpMessages.turnStarted(data.intent, data.provider);
      case "progress":
        return data.percent !== undefined
          ? nlpMessages.progressWithPercent(data.message, data.percent.toFixed(0))
          : nlpMessages.progress(data.message);
      case "mcp_status":
        return nlpMessages.mcpStatus(data.server, data.status);
      case "warning":
        return nlpMessages.warning(data.message);
      case "result":
        return nlpMessages.result(data.content);
      case "error":
        return data.recoverable
          ? nlpMessages.recoverableError(data.message)
          : nlpMessages.fatalError(data.message);
      case "turn_finished": {
        const dur = data.durationMs >= 1000
          ? `${(data.durationMs / 1000).toFixed(1)}s`
          : `${data.durationMs}ms`;
        return nlpMessages.turnFinished(dur);
      }
    }
  }

  return {
    render(event: OmkEvent): string {
      const text = event.data
        ? renderEventData(event.data)
        : nlpMessages.event(event.type);
      lines.push(text);
      return text;
    },

    flush(): string {
      const output = lines.join("\n");
      lines.length = 0;
      return output;
    },
  };
}

// ─── JsonRenderer ────────────────────────────────────────────────────────────

export interface JsonRenderer {
  render(event: OmkEvent): object;
  flush(): object[];
}

export function createJsonRenderer(): JsonRenderer {
  const records: object[] = [];

  return {
    render(event: OmkEvent): object {
      const record = {
        type: event.type,
        timestamp: event.timestamp,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        ...(event.data !== undefined ? { data: event.data } : {}),
      };
      records.push(record);
      return record;
    },

    flush(): object[] {
      const output = [...records];
      records.length = 0;
      return output;
    },
  };
}

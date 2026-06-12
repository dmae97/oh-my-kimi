/**
 * System24Renderer — OMK-optimized TUI renderer.
 *
 * Design language:
 * - oklch gray-scale backgrounds (near-black base)
 * - Square borders, no rounding
 * - Panel labels, ASCII art headers
 * - Monospace typography (terminal-native)
 * - Minimal color accents on neutral base
 *
 * Panels:
 * ┌─ session ──────────────────────────────────────┐
 * │  ◆ OMK · mimo · mimo-v2.5-pro    run#abc123   │
 * └────────────────────────────────────────────────┘
 * ┌─ turn ─────────────────────────────────────────┐
 * │  ▸ user input                                   │
 * │  ▸ assistant output with markdown                │
 * │  ┌─ code: ts ──────────────────────────────────┐│
 * │  │  const x = 1;                               ││
 * │  └─────────────────────────────────────────────┘│
 * │  🧠 reasoning summary                           │
 * ├─ status ───────────────────────────────────────┤
 * │  ⚙ [context7,gh_grep] ⟨karpathy,…+2⟩ ─ 2.3s   │
 * └────────────────────────────────────────────────┘
 */
import type { CliUiEvent } from "./event.js";
import type { CliRenderer } from "./renderer.js";
import type { OmkBrandTheme } from "../../brand/theme.js";
import { shouldUseAnsiColor, SYSTEM24_THEME } from "../../brand/theme.js";
import { sanitizeUserVisibleOutput } from "../../util/user-visible-output.js";
import { isUnsupportedRuntimeError, renderRouteBlockedPanel } from "./route-blocked-panel.js";

// ── ANSI Helpers ───────────────────────────────────────────────────────────

const ESC = "\x1b[";
const RST = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;

interface System24Palette {
  bg3: string;
  text1: string;
  text2: string;
  text3: string;
  text5: string;
  accent: string;
  green: string;
  amber: string;
  red: string;
  cyan: string;
  border: string;
  borderHL: string;
}

function paletteFromTheme(theme: OmkBrandTheme): System24Palette {
  return {
    bg3: theme.colors.muted,
    text1: theme.colors.text,
    text2: theme.colors.text,
    text3: theme.colors.text,
    text5: theme.colors.muted,
    accent: theme.colors.primary,
    green: theme.colors.success,
    amber: theme.colors.warning,
    red: theme.colors.danger,
    cyan: theme.colors.info,
    border: theme.colors.border,
    borderHL: theme.colors.borderHot,
  };
}

const SEP_CHAR = "─";
const BORDER_V = "│";
const BORDER_TL = "┌";
const BORDER_TR = "┐";
const BORDER_BL = "└";
const BORDER_BR = "┘";
const BORDER_ML = "├";
const BORDER_MR = "┤";

// ── Layout Helpers ─────────────────────────────────────────────────────────

interface WritableStreamLike {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

function termWidth(stream: WritableStreamLike): number {
  const width = stream.columns ?? process.stdout.columns ?? 80;
  return Number.isFinite(width) ? Math.max(40, width) : 80;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLen(s: string): number {
  return stripAnsi(s).length;
}

function padRight(s: string, width: number): string {
  const len = visibleLen(s);
  return len >= width ? s : s + " ".repeat(width - len);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  return `${m}m${rs}s`;
}

// ── Panel Rendering ────────────────────────────────────────────────────────

function renderPanelTop(c: System24Palette, width: number, label?: string): string {
  const inner = width - 2;
  if (label) {
    const labelText = ` ${label} `;
    const left = SEP_CHAR.repeat(2);
    const right = SEP_CHAR.repeat(Math.max(0, inner - visibleLen(labelText) - left.length));
    return c.border + BORDER_TL + left + c.text5 + labelText + c.border + right + BORDER_TR + RST;
  }
  return c.border + BORDER_TL + SEP_CHAR.repeat(inner) + BORDER_TR + RST;
}

function renderPanelBottom(c: System24Palette, width: number): string {
  return c.border + BORDER_BL + SEP_CHAR.repeat(width - 2) + BORDER_BR + RST;
}

function renderPanelDivider(c: System24Palette, width: number, label?: string): string {
  const inner = width - 2;
  if (label) {
    const labelText = ` ${label} `;
    const left = SEP_CHAR.repeat(2);
    const right = SEP_CHAR.repeat(Math.max(0, inner - visibleLen(labelText) - left.length));
    return c.border + BORDER_ML + left + c.text5 + labelText + c.border + right + BORDER_MR + RST;
  }
  return c.border + BORDER_ML + SEP_CHAR.repeat(inner) + BORDER_MR + RST;
}

function renderPanelLine(c: System24Palette, content: string, width: number): string {
  const inner = width - 2;
  const safeContent = visibleLen(content) > inner
    ? `${stripAnsi(content).slice(0, Math.max(0, inner - 1))}…`
    : content;
  const padded = padRight(safeContent, inner);
  return c.border + BORDER_V + RST + padded + c.border + BORDER_V + RST;
}

// ── Code Block Rendering ───────────────────────────────────────────────────

function renderCodeBlock(c: System24Palette, codeLines: string[], lang: string, width: number): string[] {
  const inner = width - 2;
  const codeInner = inner - 4; // 2 chars padding each side
  const label = lang || "code";
  const topBorder =
    c.border + " " + BORDER_TL + SEP_CHAR.repeat(2) +
    c.text5 + ` ${label} ` +
    c.border + SEP_CHAR.repeat(Math.max(0, codeInner - visibleLen(` ${label} `) - 2)) +
    BORDER_TR + RST;
  const bottomBorder =
    c.border + " " + BORDER_BL + SEP_CHAR.repeat(codeInner) + BORDER_BR + RST;

  const result: string[] = [renderPanelLine(c, topBorder, width)];
  for (const line of codeLines) {
    const codeLine = c.bg3 + c.text1 + " " + padRight(line, codeInner - 2) + " " + RST;
    result.push(c.border + BORDER_V + RST + " " + codeLine + " " + c.border + BORDER_V + RST);
  }
  result.push(renderPanelLine(c, bottomBorder, width));
  return result;
}

// ── Inline Markdown (system24 style) ───────────────────────────────────────

function renderInline(c: System24Palette, text: string): string {
  // Bold
  let s = text.replace(/\*\*(.+?)\*\*/g, (_, m) => BOLD + c.text1 + m + RST);
  s = s.replace(/__(.+?)__/g, (_, m) => BOLD + c.text1 + m + RST);
  // Italic
  s = s.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, (_, m) => ITALIC + c.text3 + m + RST);
  // Inline code
  s = s.replace(/`([^`]+)`/g, (_, m) => c.bg3 + c.text1 + " " + m + " " + RST);
  // Links
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, (_, m) => c.cyan + m + RST);
  return s;
}

// ── Thinking Animation ─────────────────────────────────────────────────────

const SPIN = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
let spinIdx = 0;

function renderThinking(c: System24Palette, summary: string | undefined, elapsedMs: number, todoPercent?: number): string {
  const frame = SPIN[spinIdx++ % SPIN.length];
  const time = `${DIM}${c.text5}${formatElapsed(elapsedMs)}${RST}`;
  const parts: string[] = [`  ${c.accent}${frame}${RST}`];

  if (todoPercent !== undefined && todoPercent >= 0) {
    const barLen = 8;
    const filled = Math.round((todoPercent / 100) * barLen);
    const bar = c.green + "█".repeat(filled) + c.text5 + "░".repeat(barLen - filled) + RST;
    parts.push(`${c.text5}TODO${RST} ${bar} ${c.text3}${todoPercent}%${RST}`);
  }

  if (summary) {
    parts.push(DIM + c.text5 + truncate(summary, 40) + RST);
  } else {
    parts.push(DIM + c.text5 + "thinking..." + RST);
  }

  parts.push(time);
  return parts.join(" ");
}

// ── MCP/Skill Name Formatting ──────────────────────────────────────────────

function formatMcpNames(c: System24Palette, names: readonly string[] | undefined): string {
  if (!names || names.length === 0) return "";
  const max = 3;
  const shown = names.slice(0, max).map(n => truncate(n, 12));
  const rest = names.length - max;
  const label = rest > 0 ? shown.join(",") + `,…+${rest}` : shown.join(",");
  return `${c.cyan}[${label}]${RST}`;
}

function formatSkillNames(c: System24Palette, names: readonly string[] | undefined): string {
  if (!names || names.length === 0) return "";
  const max = 2;
  const shown = names.slice(0, max).map(n => truncate(n, 12));
  const rest = names.length - max;
  const label = rest > 0 ? shown.join(",") + `,…+${rest}` : shown.join(",");
  return `${c.accent}⟨${label}⟩${RST}`;
}

// ── System24Renderer ───────────────────────────────────────────────────────

export interface System24RendererStreams {
  stdout?: WritableStreamLike;
  stderr?: WritableStreamLike;
}

export interface System24RendererOptions {
  sessionHeader?: "full" | "compact" | "off";
  noColor?: boolean;
}

export class System24Renderer implements CliRenderer {
  private readonly out: WritableStreamLike;
  private readonly err: WritableStreamLike;
  private readonly palette: System24Palette;
  private readonly sessionHeader: "full" | "compact" | "off";
  private readonly noColor: boolean;
  private heartbeatOpen = false;
  private thinkingSummary: string | undefined;
  private lastRoute: { provider: string; model?: string; risk: string; sandbox: string; mcp?: readonly string[]; skills?: readonly string[] } | null = null;
  private turnStartTime = 0;
  private sessionStartTime = 0;
  private runId = "";
  private panelWidth = 72;
  private todoPercent = -1;
  private inCodeBlock = false;
  private promptOpen = false;
  private codeBlockLang = "";
  private codeBlockLines: string[] = [];

  constructor(streams: System24RendererStreams = {}, theme: OmkBrandTheme = SYSTEM24_THEME, options: System24RendererOptions = {}) {
    this.out = streams.stdout ?? process.stdout;
    this.err = streams.stderr ?? process.stderr;
    this.palette = paletteFromTheme(theme);
    this.sessionHeader = options.sessionHeader ?? "full";
    this.noColor = options.noColor ?? !shouldUseAnsiColor();
  }

  start(): void {
    this.panelWidth = Math.min(76, termWidth(this.out) - 2);
    this.sessionStartTime = Date.now();
  }

  emit(event: CliUiEvent): void {
    const w = this.panelWidth;
    const c = this.palette;

    switch (event.type) {
      case "session:start": {
        if (this.sessionHeader === "off") break;
        this.runId = event.runId;
        const provider = event.provider === "auto" ? "omk" : event.provider;
        const model = event.model ?? "auto";
        const runShort = event.runId.slice(0, 7);
        const rootText = event.root ? truncate(event.root, Math.max(12, w - 22)) : undefined;
        const cwdText = event.cwd && event.cwd !== event.root
          ? truncate(event.cwd, Math.max(12, w - 21))
          : undefined;
        const titleLine =
          c.accent + BOLD + "◆" + RST + " " +
          c.accent + "OMK" + RST + c.text5 + " · " + RST +
          c.text3 + provider + RST + c.text5 + " · " + RST +
          c.text2 + model + RST;
        const runLabel = c.text5 + "run#" + runShort + RST;

        this.writeErr("\n");
        this.writeErr(renderPanelTop(c, w, this.sessionHeader === "compact" ? "route" : "session"));
        this.writeErr("\n");
        this.writeErr(renderPanelLine(c, "  " + titleLine + "  " + runLabel, w));
        this.writeErr("\n");
        if (this.sessionHeader === "full" && rootText) {
          const source = event.rootSource ? ` · ${event.rootSource}` : "";
          this.writeErr(renderPanelLine(c, `  ${c.text5}root${RST} ${c.text3}${rootText}${RST}${c.text5}${source}${RST}`, w));
          this.writeErr("\n");
        }
        if (this.sessionHeader === "full" && cwdText) {
          this.writeErr(renderPanelLine(c, `  ${c.text5}cwd ${RST}${c.text3}${cwdText}${RST}`, w));
          this.writeErr("\n");
        }
        this.writeErr(renderPanelBottom(c, w));
        this.writeErr("\n\n");
        break;
      }

      case "input:submitted": {
        const text = event.text.length > w - 8 ? event.text.slice(0, w - 11) + "..." : event.text;
        if (this.promptOpen) {
          if (!this.err.isTTY) this.writeErr(c.text2 + text + RST);
          this.writeErr("\n");
          this.writeErr(renderPanelBottom(c, w));
          this.writeErr("\n\n");
          this.promptOpen = false;
        } else {
          this.writeErr(renderPanelLine(c, c.cyan + "  › " + RST + c.text2 + text + RST, w));
          this.writeErr("\n\n");
        }
        break;
      }

      case "prompt:ready":
        if (!this.promptOpen) {
          this.writeErr(renderPanelTop(c, w, "input"));
          this.writeErr("\n");
          this.writeErr(c.border + BORDER_V + RST + c.cyan + "  › " + RST);
          this.promptOpen = true;
        }
        break;

      case "control:output": {
        if (this.heartbeatOpen) {
          this.writeErr("\r" + " ".repeat(w) + "\r");
          this.heartbeatOpen = false;
        }
        const sanitized = stripAnsi(sanitizeUserVisibleOutput(event.text));
        for (const line of sanitized.split("\n")) {
          this.writeErr(renderPanelLine(c, "  " + renderInline(c, line), w) + "\n");
        }
        break;
      }

      case "turn:route": {
        this.lastRoute = {
          provider: event.provider,
          model: event.model,
          risk: event.risk,
          sandbox: event.sandbox,
          mcp: event.mcp,
          skills: event.skills,
        };
        break;
      }

      case "turn:start":
        this.thinkingSummary = undefined;
        this.todoPercent = -1;
        this.inCodeBlock = false;
        this.codeBlockLines = [];
        this.turnStartTime = Date.now();
        this.writeErr(renderPanelTop(c, w, "turn"));
        this.writeErr("\n");
        break;

      case "turn:heartbeat": {
        const line = renderThinking(c, this.thinkingSummary, event.elapsedMs, this.todoPercent >= 0 ? this.todoPercent : undefined);
        if (this.err.isTTY) {
          this.writeErr("\r" + " ".repeat(w) + "\r");
          this.writeErr(c.border + BORDER_V + RST + line);
          this.heartbeatOpen = true;
        }
        break;
      }

      case "turn:todo": {
        const total = event.total;
        const done = event.done;
        this.todoPercent = total > 0 ? Math.round((done / total) * 100) : 0;
        break;
      }

      case "turn:reasoning": {
        if (event.summary) {
          this.writeErr(renderPanelLine(c, "  " + c.accent + "🧠 " + RST + DIM + c.text5 + truncate(event.summary, 60) + RST, w));
          this.writeErr("\n");
        }
        break;
      }

      case "assistant:final": {
        if (this.heartbeatOpen) {
          this.writeErr("\r" + " ".repeat(w) + "\r");
          this.heartbeatOpen = false;
        }
        const lines = event.text.split("\n");
        for (const line of lines) {
          // Code block toggle
          if (line.startsWith("```")) {
            if (this.inCodeBlock) {
              // End code block — flush
              const rendered = renderCodeBlock(c, this.codeBlockLines, this.codeBlockLang, w);
              for (const rl of rendered) this.writeOut(rl + "\n");
              this.codeBlockLines = [];
              this.codeBlockLang = "";
              this.inCodeBlock = false;
            } else {
              // Start code block
              this.inCodeBlock = true;
              this.codeBlockLang = line.slice(3).trim();
            }
            continue;
          }

          if (this.inCodeBlock) {
            this.codeBlockLines.push(line);
            continue;
          }

          // Headers
          const hMatch = line.match(/^(#{1,3})\s+(.+)$/);
          if (hMatch) {
            const level = hMatch[1].length;
            const text = hMatch[2];
            if (level === 1) this.writeOut(renderPanelLine(c, "  " + BOLD + c.accent + "▋ " + text + RST, w) + "\n");
            else if (level === 2) this.writeOut(renderPanelLine(c, "  " + c.green + "▸ " + text + RST, w) + "\n");
            else this.writeOut(renderPanelLine(c, "  " + c.cyan + "  · " + text + RST, w) + "\n");
            continue;
          }
          // List items
          const lMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
          if (lMatch) {
            this.writeOut(renderPanelLine(c, "  " + c.accent + "◆" + RST + " " + renderInline(c, lMatch[2]), w) + "\n");
            continue;
          }
          // Horizontal rule
          if (/^[-*_]{3,}$/.test(line.trim())) {
            this.writeOut(renderPanelLine(c, "  " + c.text5 + SEP_CHAR.repeat(Math.min(w - 6, 40)) + RST, w) + "\n");
            continue;
          }
          // Empty
          if (line.trim() === "") {
            this.writeOut(renderPanelLine(c, "", w) + "\n");
            continue;
          }
          // Regular text
          this.writeOut(renderPanelLine(c, "  " + renderInline(c, line), w) + "\n");
        }

        // Flush unclosed code block
        if (this.inCodeBlock && this.codeBlockLines.length > 0) {
          const rendered = renderCodeBlock(c, this.codeBlockLines, this.codeBlockLang, w);
          for (const rl of rendered) this.writeOut(rl + "\n");
          this.codeBlockLines = [];
          this.codeBlockLang = "";
          this.inCodeBlock = false;
        }
        break;
      }

      case "turn:error": {
        if (this.heartbeatOpen) {
          this.writeErr("\r" + " ".repeat(w) + "\r");
          this.heartbeatOpen = false;
        }
        const errMsg = sanitizeUserVisibleOutput(event.message);
        this.writeErr("\n");
        if (isUnsupportedRuntimeError(errMsg)) {
          this.writeErr(renderRouteBlockedPanel(errMsg, { width: Math.min(100, w) }));
          this.writeErr("\n");
          break;
        }
        this.writeErr(renderPanelLine(c, c.red + "  ✖ " + RST + c.text2 + errMsg + RST, w));
        this.writeErr("\n");
        break;
      }

      case "turn:finish": {
        if (this.heartbeatOpen) {
          this.writeErr("\r" + " ".repeat(w) + "\r");
          this.heartbeatOpen = false;
        }
        // Flush unclosed code block if any
        if (this.inCodeBlock && this.codeBlockLines.length > 0) {
          const rendered = renderCodeBlock(c, this.codeBlockLines, this.codeBlockLang, w);
          for (const rl of rendered) this.writeOut(rl + "\n");
          this.codeBlockLines = [];
          this.codeBlockLang = "";
          this.inCodeBlock = false;
        }
        const elapsed = formatElapsed(event.durationMs);

        // Status bar with MCP names, skill names, timing
        const parts: string[] = [];
        if (this.lastRoute) {
          parts.push(c.text5 + this.lastRoute.provider + RST);
          if (this.lastRoute.model) parts.push(c.text5 + truncate(this.lastRoute.model, 16) + RST);
          if (this.lastRoute.risk !== "safe") parts.push(c.amber + this.lastRoute.risk + RST);
          if (this.lastRoute.sandbox !== "none") parts.push(c.green + this.lastRoute.sandbox + RST);

          const mcpStr = formatMcpNames(c, this.lastRoute.mcp);
          if (mcpStr) parts.push(mcpStr);

          const skStr = formatSkillNames(c, this.lastRoute.skills);
          if (skStr) parts.push(skStr);
        }

        const uptime = formatElapsed(Date.now() - this.sessionStartTime);
        const statusLine =
          parts.join(c.text5 + " · " + RST) +
          "  " + c.text5 + "─ " + elapsed + " ─" + RST +
          "  " + DIM + c.text5 + "⏱" + uptime + RST;

        this.writeErr(renderPanelDivider(c, w, "status"));
        this.writeErr("\n");
        this.writeErr(renderPanelLine(c, "  " + statusLine, w));
        this.writeErr("\n");
        this.writeErr(renderPanelBottom(c, w));
        this.writeErr("\n\n");
        break;
      }

      case "session:stop":
        break;
    }
  }

  setThinkingSummary(summary: string | undefined): void {
    this.thinkingSummary = summary;
  }

  private writeOut(chunk: string): void {
    this.out.write(this.noColor ? stripAnsi(chunk) : chunk);
  }

  private writeErr(chunk: string): void {
    this.err.write(this.noColor ? stripAnsi(chunk) : chunk);
  }

  stop(): void {}
}

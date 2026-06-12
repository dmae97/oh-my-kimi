/**
 * RichRenderer — theme-integrated CLI output with markdown rendering.
 *
 * Uses OMK theme primitives (style, layout) for visual richness.
 * Renders inline markdown: **bold**, `code`, ```code blocks```, # headers, - lists.
 * Shows thinking/reasoning frames with visual indicators.
 */
import type { CliUiEvent } from "./event.js";
import type { CliRenderer } from "./renderer.js";
import { sanitizeUserVisibleOutput } from "../../util/user-visible-output.js";
import { style } from "../../theme/colors.js";
import { isUnsupportedRuntimeError, renderRouteBlockedPanel } from "./route-blocked-panel.js";

interface WritableStreamLike {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export interface RichRendererStreams {
  stdout?: WritableStreamLike;
  stderr?: WritableStreamLike;
}

// ── Inline Markdown Renderer ──────────────────────────────────────────────

const RE_CODE_BLOCK = /^```(\w*)$/;
const RE_HEADER = /^(#{1,3})\s+(.+)$/;
const RE_LIST_ITEM = /^(\s*)[-*]\s+(.+)$/;
const RE_NUMBERED_LIST = /^(\s*)\d+\.\s+(.+)$/;

function renderInlineMarkdown(text: string): string {
  // Bold: **text** or __text__
  let s = text.replace(/\*\*(.+?)\*\*/g, (_, m) => style.whiteBold(m));
  s = s.replace(/__(.+?)__/g, (_, m) => style.whiteBold(m));
  // Italic: *text* or _text_ (but not inside words with underscores)
  s = s.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, (_, m) => style.cream(style.italic + m + style.reset));
  // Inline code: `text`
  s = s.replace(/`([^`]+)`/g, (_, m) => style.bgDark(" " + m + " "));
  // Links: [text](url) → just show text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, (_, m) => style.cyan(m));
  return s;
}

function renderMarkdownBlock(lines: string[]): string {
  const output: string[] = [];
  let inCodeBlock = false;
  let codeLang = "";
  let codeLines: string[] = [];

  for (const line of lines) {
    // Code block toggle
    const cbMatch = line.match(RE_CODE_BLOCK);
    if (cbMatch) {
      if (inCodeBlock) {
        // End code block
        output.push(renderCodeBlock(codeLines, codeLang));
        codeLines = [];
        codeLang = "";
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeLang = cbMatch[1];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Headers
    const hMatch = line.match(RE_HEADER);
    if (hMatch) {
      const level = hMatch[1].length;
      const text = hMatch[2];
      if (level === 1) output.push(style.purpleBold("▋ " + text));
      else if (level === 2) output.push(style.mintBold("▸ " + text));
      else output.push(style.cyanBold("  · " + text));
      continue;
    }

    // List items
    const lMatch = line.match(RE_LIST_ITEM) || line.match(RE_NUMBERED_LIST);
    if (lMatch) {
      const indent = lMatch[1];
      const text = lMatch[2];
      output.push(indent + style.purple("◆") + " " + renderInlineMarkdown(text));
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line.trim())) {
      output.push(style.gray("─".repeat(40)));
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      output.push("");
      continue;
    }

    // Regular text with inline markdown
    output.push(renderInlineMarkdown(line));
  }

  // Unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    output.push(renderCodeBlock(codeLines, codeLang));
  }

  return output.join("\n");
}

function renderCodeBlock(codeLines: string[], lang: string): string {
  const maxLen = Math.max(...codeLines.map((l) => l.length), lang.length + 4);
  const width = Math.min(maxLen + 2, 76);
  const top = style.gray("┌" + "─".repeat(width) + "┐");
  const bottom = style.gray("└" + "─".repeat(width) + "┘");
  const langLabel = lang ? style.mint(" " + lang + " ") : "";
  const body = codeLines.map((l) => style.gray("│") + style.cream(" " + l.padEnd(width - 1)) + style.gray("│"));
  return [langLabel ? top.replace("─".repeat(width), "─".repeat(2) + langLabel + "─".repeat(Math.max(0, width - 2 - stripAnsiLen(langLabel)))) : top, ...body, bottom].join("\n");
}

function stripAnsiLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// ── Thinking/Reasoning Display ─────────────────────────────────────────────

const THINK_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let thinkFrameIdx = 0;

function renderThinkingLine(summary: string | undefined, elapsedMs: number): string {
  const spinner = THINK_FRAMES[thinkFrameIdx++ % THINK_FRAMES.length];
  const seconds = Math.floor(elapsedMs / 1000);
  const time = style.phosphorDim(`${seconds}s`);
  if (summary) {
    const truncated = summary.length > 60 ? summary.slice(0, 57) + "..." : summary;
    return `  ${style.purple(spinner)} ${style.gray(truncated)} ${time}`;
  }
  return `  ${style.purple(spinner)} ${style.phosphorDim("thinking...")} ${time}`;
}

// ── RichRenderer ───────────────────────────────────────────────────────────

export class RichRenderer implements CliRenderer {
  private readonly stdout: WritableStreamLike;
  private readonly stderr: WritableStreamLike;
  private heartbeatOpen = false;
  private promptOpen = false;
  private thinkingSummary: string | undefined;
  private sessionStartTime = 0;

  constructor(streams: RichRendererStreams = {}) {
    this.stdout = streams.stdout ?? process.stdout;
    this.stderr = streams.stderr ?? process.stderr;
  }

  start(): void {
    this.sessionStartTime = Date.now();
  }

  emit(event: CliUiEvent): void {
    switch (event.type) {
      case "session:start": {
        const provider = event.provider === "auto" ? "omk" : event.provider;
        const model = event.model ?? "auto";
        this.stderr.write("\n");
        this.stderr.write(style.purpleBold("  ◆ ") + style.whiteBold(provider) + style.gray(" · ") + style.cream(model) + "\n");
        this.stderr.write(style.gray("  " + "─".repeat(Math.min(provider.length + model.length + 5, 40))) + "\n\n");
        break;
      }

      case "input:submitted": {
        const text = event.text.length > 80 ? event.text.slice(0, 77) + "..." : event.text;
        if (this.promptOpen) {
          if (!this.stderr.isTTY) this.stderr.write(style.cream(text));
          this.stderr.write("\n\n");
          this.promptOpen = false;
        } else {
          this.stderr.write(style.mint("  › ") + style.cream(text) + "\n\n");
        }
        break;
      }

      case "prompt:ready":
        if (!this.promptOpen) {
          this.stderr.write(style.mint("  › "));
          this.promptOpen = true;
        }
        break;

      case "control:output":
        if (this.heartbeatOpen) {
          this.stderr.write("\r" + " ".repeat(80) + "\r");
          this.heartbeatOpen = false;
        }
        this.stderr.write(sanitizeUserVisibleOutput(event.text));
        break;

      case "turn:route": {
        // Compact route info bar
        const parts: string[] = [];
        parts.push(style.phosphorDim("⚙ ") + style.white(event.provider));
        if (event.model) parts.push(style.gray(event.model));
        if (event.risk !== "safe") parts.push(style.amber(event.risk));
        if (event.sandbox !== "none") parts.push(style.mint(event.sandbox));
        if (event.mcp && event.mcp.length > 0) parts.push(style.cyan(`${event.mcp.length} mcp`));
        if (event.skills && event.skills.length > 0) parts.push(style.violet(`${event.skills.length} skills`));
        this.stderr.write("  " + parts.join(style.gray(" · ")) + "\n");
        break;
      }

      case "turn:start":
        this.thinkingSummary = undefined;
        break;

      case "turn:heartbeat": {
        const line = renderThinkingLine(this.thinkingSummary, event.elapsedMs);
        if (this.stderr.isTTY) {
          this.stderr.write("\r" + line.padEnd(80) + "\r");
          this.heartbeatOpen = true;
        }
        break;
      }

      case "assistant:final": {
        if (this.heartbeatOpen) {
          this.stderr.write("\r" + " ".repeat(80) + "\r");
          this.heartbeatOpen = false;
        }
        const lines = event.text.split("\n");
        const rendered = renderMarkdownBlock(lines);
        this.stdout.write(rendered + (rendered.endsWith("\n") ? "" : "\n"));
        break;
      }

      case "turn:error": {
        if (this.heartbeatOpen) {
          this.stderr.write("\r" + " ".repeat(80) + "\r");
          this.heartbeatOpen = false;
        }
        const errMsg = sanitizeUserVisibleOutput(event.message);
        if (isUnsupportedRuntimeError(errMsg)) {
          this.stderr.write("\n" + renderRouteBlockedPanel(errMsg) + "\n\n");
          break;
        }
        this.stderr.write("\n" + style.red("  ✖ ") + style.white(errMsg) + "\n\n");
        break;
      }

      case "turn:finish": {
        if (this.heartbeatOpen) {
          this.stderr.write("\r" + " ".repeat(80) + "\r");
          this.heartbeatOpen = false;
        }
        const secs = (event.durationMs / 1000).toFixed(1);
        this.stderr.write(style.gray("  ─ ") + style.phosphorDim(`${secs}s`) + style.gray(" ─") + "\n\n");
        break;
      }

      case "session:stop":
        break;
    }
  }

  /** Update thinking summary from reasoning NLP (called externally) */
  setThinkingSummary(summary: string | undefined): void {
    this.thinkingSummary = summary;
  }

  stop(): void {}
}

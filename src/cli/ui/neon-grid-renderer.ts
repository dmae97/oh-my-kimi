import type { CliUiEvent } from "./event.js";
import type { CliRenderer } from "./renderer.js";
import { System24Renderer, type System24RendererStreams } from "./system24-renderer.js";
import { NEON_GRID_THEME, resolveTuiMotion, shouldUseAnsiColor, type OmkTuiMotion } from "../../brand/theme.js";

interface WritableStreamLike {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

const ESC = "\x1b[";
const RST = `${ESC}0m`;

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function line(stream: WritableStreamLike, text: string, noColor: boolean): void {
  stream.write(`${noColor ? stripAnsi(text) : text}\n`);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function center(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - visibleLength(text)) / 2));
  return `${" ".repeat(pad)}${text}`;
}

function signalScanline(seed: string, width: number): string {
  const glyphs = ["◇", "◆", "●", "○", "▣", "⟁", "⟐", "⟡"];
  let hash = 0;
  for (const char of seed) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  const chars: string[] = [];
  for (let i = 0; i < width; i += 1) {
    hash = (hash * 1664525 + 1013904223) >>> 0;
    chars.push(hash % 7 === 0 ? glyphs[hash % glyphs.length] : hash % 5 === 0 ? "─" : " ");
  }
  return chars.join("").trimEnd();
}

export class NeonGridRenderer implements CliRenderer {
  private readonly base: System24Renderer;
  private readonly err: WritableStreamLike;
  private readonly noColor: boolean;
  private readonly motion: OmkTuiMotion;
  private started = false;

  constructor(streams: System24RendererStreams = {}) {
    this.err = streams.stderr ?? process.stderr;
    this.noColor = !shouldUseAnsiColor();
    this.motion = resolveTuiMotion();
    this.base = new System24Renderer(streams, NEON_GRID_THEME, {
      sessionHeader: "compact",
      noColor: this.noColor,
    });
  }

  start(): void {
    this.started = true;
    this.base.start();
  }

  emit(event: CliUiEvent): void {
    if (event.type === "session:start") {
      this.renderNeonGridHeader(event);
    }
    this.base.emit(event);
  }

  setThinkingSummary(summary: string | undefined): void {
    this.base.setThinkingSummary(summary);
  }

  stop(): void {
    this.base.stop();
  }

  private renderNeonGridHeader(event: Extract<CliUiEvent, { type: "session:start" }>): void {
    const width = Math.min(76, Math.max(40, this.err.columns ?? process.stderr.columns ?? 80) - 2);
    const color = NEON_GRID_THEME.colors.primary;
    const dim = NEON_GRID_THEME.colors.muted;
    const hot = NEON_GRID_THEME.colors.borderHot;
    const success = NEON_GRID_THEME.colors.success;
    const run = event.runId ? `run#${event.runId.slice(0, 7)}` : "run#pending";
    const root = event.root ? truncate(event.root, Math.max(12, width - 16)) : "root:unknown";
    const shouldRenderScanline = this.motion !== "off" && this.started && this.err.isTTY !== false;
    const routeLine = truncate(`${NEON_GRID_THEME.symbols.signal} ${run} · ${event.provider} · ${event.model ?? "auto"}`, width);
    const statusLine = truncate(`▣ agent grid online · evidence gate armed · runtime protected`, width);
    const rootLine = truncate(`${NEON_GRID_THEME.symbols.pending} root ${root}`, width);

    if (shouldRenderScanline) {
      line(this.err, `${dim}${signalScanline(event.runId ?? "omk-control", width)}${RST}`, this.noColor);
    }
    line(this.err, `${hot}${center(NEON_GRID_THEME.label, width)}${RST}`, this.noColor);
    line(this.err, `${color}${center(NEON_GRID_THEME.motto, width)}${RST}`, this.noColor);
    line(this.err, `${dim}${routeLine}${RST}`, this.noColor);
    line(this.err, `${success}${statusLine}${RST}`, this.noColor);
    line(this.err, `${dim}${rootLine}${RST}`, this.noColor);
  }
}

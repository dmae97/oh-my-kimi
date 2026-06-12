import type { CliUiEvent } from "./event.js";
import type { CliRenderer } from "./renderer.js";
import { System24Renderer, type System24RendererStreams } from "./system24-renderer.js";
import { GREEN_RAIN_THEME, resolveTuiMotion, shouldUseAnsiColor, type OmkTuiMotion } from "../../brand/theme.js";
import { renderMatrixRain } from "../../brand/matrix-rain.js";

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

export class GreenRainRenderer implements CliRenderer {
  private readonly base: System24Renderer;
  private readonly err: WritableStreamLike;
  private readonly noColor: boolean;
  private readonly motion: OmkTuiMotion;
  private started = false;

  constructor(streams: System24RendererStreams = {}) {
    this.err = streams.stderr ?? process.stderr;
    this.noColor = !shouldUseAnsiColor();
    this.motion = resolveTuiMotion();
    this.base = new System24Renderer(streams, GREEN_RAIN_THEME, {
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
      this.renderGreenRainHeader(event);
    }
    this.base.emit(event);
  }

  setThinkingSummary(summary: string | undefined): void {
    this.base.setThinkingSummary(summary);
  }

  stop(): void {
    this.base.stop();
  }

  private renderGreenRainHeader(event: Extract<CliUiEvent, { type: "session:start" }>): void {
    const width = Math.min(76, Math.max(40, this.err.columns ?? process.stderr.columns ?? 80) - 2);
    const color = GREEN_RAIN_THEME.colors.primary;
    const dim = GREEN_RAIN_THEME.colors.muted;
    const hot = GREEN_RAIN_THEME.colors.borderHot;
    const run = event.runId ? `run#${event.runId.slice(0, 7)}` : "run#pending";
    const root = event.root ? truncate(event.root, Math.max(12, width - 16)) : "root:unknown";
    const shouldRenderRain = this.motion !== "off"
      && this.started
      && this.err.isTTY !== false
      && GREEN_RAIN_THEME.motion.rain;
    const rain = shouldRenderRain
      ? renderMatrixRain(event.runId ?? "omk", width, 2)
      : "";
    const routeLine = truncate(`${GREEN_RAIN_THEME.symbols.signal} ${run} · ${event.provider} · ${event.model ?? "auto"}`, width);
    const rootLine = truncate(`${GREEN_RAIN_THEME.symbols.pending} root ${root}`, width);

    if (rain) {
      for (const rainLine of rain.split("\n")) line(this.err, `${dim}${rainLine}${RST}`, this.noColor);
    }
    line(this.err, `${hot}${center(GREEN_RAIN_THEME.label.toUpperCase(), width)}${RST}`, this.noColor);
    line(this.err, `${color}${center(GREEN_RAIN_THEME.motto, width)}${RST}`, this.noColor);
    line(this.err, `${dim}${routeLine}${RST}`, this.noColor);
    line(this.err, `${dim}${rootLine}${RST}`, this.noColor);
  }
}

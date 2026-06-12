import type { TuiRenderMode } from "./model.js";

export interface TerminalFrameRendererOptions {
  mode?: TuiRenderMode;
  height?: number;
  write?: (chunk: string) => void;
  clear?: () => void;
}

export class TerminalFrameRenderer {
  private prevLines: string[] = [];
  mode: TuiRenderMode;
  height?: number;
  private readonly write: (chunk: string) => void;
  private readonly clearFrame: () => void;

  constructor(mode?: TuiRenderMode, height?: number);
  constructor(options: TerminalFrameRendererOptions);
  constructor(modeOrOptions: TuiRenderMode | TerminalFrameRendererOptions = "diff", height?: number) {
    if (typeof modeOrOptions === "string") {
      this.mode = modeOrOptions;
      this.height = height;
      this.write = (chunk) => process.stdout.write(chunk);
      this.clearFrame = () => clearTerminalScreen(this.write);
      return;
    }

    this.mode = modeOrOptions.mode ?? "diff";
    this.height = modeOrOptions.height;
    this.write = modeOrOptions.write ?? ((chunk) => process.stdout.write(chunk));
    this.clearFrame = modeOrOptions.clear ?? (() => clearTerminalScreen(this.write));
  }

  render(frame: string): void {
    const newLines = frame.split("\n");

    if (this.mode === "full") {
      this.clear();
      this.write(`${frame}\n`);
      this.prevLines = [...newLines];
      return;
    }

    if (this.mode === "append") {
      this.write(`${frame}\n`);
      this.prevLines = [...newLines];
      return;
    }

    const parts: string[] = ["\x1b[H"];
    const maxLen = Math.max(newLines.length, this.prevLines.length);

    for (let i = 0; i < maxLen; i++) {
      const newLine = newLines[i] ?? "";
      const oldLine = this.prevLines[i] ?? "";

      if (i < newLines.length) {
        if (newLine !== oldLine) {
          parts.push(`${newLine}\x1b[K`);
        }
      } else {
        parts.push("\x1b[K");
      }

      if (i < maxLen - 1) {
        parts.push("\r\n");
      }
    }

    this.write(parts.join(""));
    this.prevLines = [...newLines];
  }

  clear(): void {
    this.clearFrame();
  }
}

export function clearTerminalScreen(write: (chunk: string) => void = (chunk) => process.stdout.write(chunk)): void {
  write("\x1b[2J\x1b[H");
}

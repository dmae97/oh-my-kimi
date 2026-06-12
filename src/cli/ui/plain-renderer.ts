/**
 * PlainModernRenderer — opencode-style minimal CLI output.
 *
 * Pattern: `> provider · model` header + clean output.
 * No route cards, no box drawing, no verbose banners.
 */
import type { CliUiEvent } from "./event.js";
import type { CliRenderer } from "./renderer.js";
import { sanitizeUserVisibleOutput } from "../../util/user-visible-output.js";
import { isUnsupportedRuntimeError, renderRouteBlockedPanel } from "./route-blocked-panel.js";

interface WritableStreamLike {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export interface PlainRendererStreams {
  stdout?: WritableStreamLike;
  stderr?: WritableStreamLike;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function joinList(values: readonly string[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "none";
}

export function renderRouteCard(event: Extract<CliUiEvent, { type: "turn:route" }>): string {
  const lines = [
    "◇ Route",
    `provider  ${event.provider}`,
    `model     ${event.model ?? "auto"}`,
    `risk      ${event.risk}`,
    `sandbox   ${event.sandbox}`,
    `mcp       ${joinList(event.mcp)}`,
    `skills    ${joinList(event.skills)}`,
    `hooks     ${joinList(event.hooks)}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function renderAssistantCard(text: string): string {
  return `\n● Assistant\n${ensureTrailingNewline(sanitizeUserVisibleOutput(text))}`;
}

export class PlainModernRenderer implements CliRenderer {
  private readonly stdout: WritableStreamLike;
  private readonly stderr: WritableStreamLike;
  private heartbeatOpen = false;
  private promptOpen = false;

  constructor(streams: PlainRendererStreams = {}) {
    this.stdout = streams.stdout ?? process.stdout;
    this.stderr = streams.stderr ?? process.stderr;
  }

  start(): void {}

  emit(event: CliUiEvent): void {
    switch (event.type) {
      case "session:start": {
        const provider = event.provider === "auto" ? "omk" : event.provider;
        const model = event.model ?? "auto";
        this.stderr.write(`\nOMK Agent Console\n> ${provider} · ${model}\n\n`);
        break;
      }
      case "input:submitted":
        if (this.promptOpen) {
          if (!this.stderr.isTTY) this.stderr.write(event.text);
          this.stderr.write("\n\n");
          this.promptOpen = false;
        } else {
          this.stderr.write(`› ${event.text}\n\n`);
        }
        break;
      case "prompt:ready":
        if (!this.promptOpen) {
          this.stderr.write("› ");
          this.promptOpen = true;
        }
        break;
      case "control:output":
        if (this.heartbeatOpen) {
          this.stderr.write("\n");
          this.heartbeatOpen = false;
        }
        this.stderr.write(sanitizeUserVisibleOutput(event.text));
        break;
      case "turn:route":
        this.stderr.write(renderRouteCard(event));
        break;
      case "turn:heartbeat": {
        const seconds = Math.floor(event.elapsedMs / 1000);
        const line = `◌ Running ${seconds}s`;
        if (this.stderr.isTTY) {
          this.stderr.write(`\r${line}   `);
          this.heartbeatOpen = true;
        } else {
          this.stderr.write(`${line}\n`);
        }
        break;
      }
      case "assistant:final":
        if (this.heartbeatOpen) {
          this.stderr.write("\r                    \r");
          this.heartbeatOpen = false;
        }
        this.stdout.write(renderAssistantCard(event.text));
        break;
      case "turn:error":
        if (this.heartbeatOpen) {
          this.stderr.write("\r                    \r");
          this.heartbeatOpen = false;
        }
        {
          const errMsg = sanitizeUserVisibleOutput(event.message);
          const rendered = isUnsupportedRuntimeError(errMsg)
            ? renderRouteBlockedPanel(errMsg)
            : `  ✖ ${errMsg}`;
          this.stderr.write(`\n${rendered}\n\n`);
        }
        break;
      case "turn:finish":
        if (this.heartbeatOpen) {
          this.stderr.write("\r                    \r");
          this.heartbeatOpen = false;
        }
        this.stderr.write(`● Finished ${(event.durationMs / 1000).toFixed(1)}s · exit ${event.exitCode}\n`);
        break;
      case "turn:start":
        break;
      case "session:stop":
        // opencode shows nothing on session end
        break;
    }
  }

  setThinkingSummary(_summary: string | undefined): void {}
  stop(): void {}
}

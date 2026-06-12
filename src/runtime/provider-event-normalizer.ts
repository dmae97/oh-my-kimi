/**
 * ProviderEventNormalizer — converts raw provider events into normalized OmkEvent types.
 *
 * Two concrete implementations:
 *   KimiEventNormalizer  — structured wire-protocol events (kimi --wire)
 *   KimiPrintNormalizer  — raw stdout text chunks  (kimi --print)
 *
 * The normalizer never leaks raw provider output to the user; that is
 * OutputRouter's responsibility.  The normalizer only shapes the stream.
 */

import type {
  OmkEvent,
  OmkEventType,
  OmkEventData,
  OutputFormat,
} from "./contracts/command-envelope.js";
import { t } from "../util/i18n.js";

// ───────────────────────────────────────────────────────────────
// Public interface
// ───────────────────────────────────────────────────────────────

export type OmkEventListener = (event: OmkEvent) => void;

export interface ProviderEventNormalizer {
  /** Register a listener for normalized OmkEvents. */
  onEvent(listener: OmkEventListener): () => void;

  /**
   * Feed a raw provider event into the normalizer.
   * The normalizer will emit one or more OmkEvents to registered listeners.
   */
  push(raw: unknown): void;

  /** Flush any buffered state and emit a turn_finished event. */
  finalize(outcome: NormalizerOutcome): void;

  /** Reset all internal state for a new turn. */
  reset(): void;
}

export interface NormalizerOutcome {
  readonly success: boolean;
  readonly durationMs: number;
  readonly tokenUsage?: { readonly input: number; readonly output: number };
}

// ───────────────────────────────────────────────────────────────
// KimiEventNormalizer — structured wire-protocol events
// ───────────────────────────────────────────────────────────────

/**
 * Normalizes Kimi wire-protocol events (JSON-RPC 2.0 messages from kimi --wire).
 *
 * Input shapes (WireEvent union from wire-protocol-types.ts):
 *   { type: "TurnBegin",       payload: TurnBegin }
 *   { type: "TurnEnd" }
 *   { type: "StepBegin",       payload: StepBegin }
 *   { type: "StepInterrupted" }
 *   { type: "CompactionBegin" }
 *   { type: "CompactionEnd" }
 *   { type: "StatusUpdate",    payload: StatusUpdate }
 *   { type: "ContentPart",     payload: TextPart | ThinkPart | … }
 *   { type: "ToolCall",        payload: ToolCallEvent }
 *   { type: "ToolCallPart",    payload: ToolCallPart }
 *   { type: "ToolResult",      payload: ToolResultEvent }
 *   { type: "SubagentEvent",   payload: SubagentEvent }
 *   { type: "PlanDisplay",     payload: PlanDisplay }
 *   { type: "HookTriggered",   payload: HookTriggered }
 *   { type: "HookResolved",    payload: HookResolved }
 *   { type: "ApprovalResponse", payload: ApprovalResponseEvent }
 *   { type: "SteerInput",      payload: SteerInput }
 */
export class KimiEventNormalizer implements ProviderEventNormalizer {
  private listeners: OmkEventListener[] = [];
  private turnId: string | undefined;
  private startedAt = 0;
  private stepCount = 0;
  private accumulatedText = "";
  private toolCallCount = 0;

  constructor(turnId?: string) {
    this.turnId = turnId;
  }

  onEvent(listener: OmkEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  push(raw: unknown): void {
    const msg = raw as { type?: string; payload?: unknown };
    if (typeof msg?.type !== "string") return;

    switch (msg.type) {
      case "TurnBegin": {
        this.startedAt = Date.now();
        this.emit("turn_started", {
          kind: "turn_started",
          intent: extractUserInput(msg.payload as Record<string, unknown>),
          provider: "kimi-wire",
        });
        break;
      }

      case "TurnEnd": {
        // TurnEnd is a no-op here; finalize() handles turn_finished.
        break;
      }

      case "StepBegin": {
        this.stepCount++;
        const n = (msg.payload as { n?: number })?.n ?? this.stepCount;
        this.emit("progress", {
          kind: "progress",
          message: t("normalizer.step", String(n)),
        });
        break;
      }

      case "StepInterrupted": {
        this.emit("warning", {
          kind: "warning",
          message: t("normalizer.stepInterrupted"),
          code: "step_interrupted",
        });
        break;
      }

      case "CompactionBegin": {
        this.emit("progress", {
          kind: "progress",
          message: t("normalizer.compacting"),
        });
        break;
      }

      case "CompactionEnd": {
        this.emit("progress", {
          kind: "progress",
          message: t("normalizer.compactionComplete"),
        });
        break;
      }

      case "StatusUpdate": {
        const payload = msg.payload as {
          context_usage?: number | null;
          token_usage?: { input_other: number; output: number } | null;
          plan_mode?: boolean | null;
        };
        if (payload?.token_usage) {
          this.emit("progress", {
            kind: "progress",
            message: t("normalizer.tokens", String(payload.token_usage.input_other), String(payload.token_usage.output)),
          });
        }
        if (payload?.plan_mode != null) {
          this.emit("mcp_status", {
            kind: "mcp_status",
            server: "plan-mode",
            status: payload.plan_mode ? "connected" : "skipped",
          });
        }
        break;
      }

      case "ContentPart": {
        const payload = msg.payload as { type?: string; text?: string; think?: string };
        if (payload?.type === "text" && typeof payload.text === "string") {
          this.accumulatedText += payload.text;
          this.emit("progress", {
            kind: "progress",
            message: payload.text,
          });
        }
        // ThinkPart is metadata only — not surfaced as an OmkEvent.
        break;
      }

      case "ToolCall": {
        this.toolCallCount++;
        const payload = msg.payload as { function?: { name?: string } };
        const name = payload?.function?.name ?? "unknown";
        this.emit("progress", {
          kind: "progress",
          message: t("normalizer.toolCall", name),
        });
        break;
      }

      case "ToolCallPart": {
        // Streaming argument fragment — too granular for OmkEvent.
        break;
      }

      case "ToolResult": {
        const payload = msg.payload as {
          return_value?: { is_error?: boolean; output?: unknown };
        };
        if (payload?.return_value?.is_error) {
          this.emit("warning", {
            kind: "warning",
            message: t("normalizer.toolError", String(payload.return_value.output).slice(0, 200)),
            code: "tool_error",
          });
        }
        break;
      }

      case "SubagentEvent": {
        const payload = msg.payload as {
          subagent_type?: string | null;
          agent_id?: string | null;
        };
        this.emit("progress", {
          kind: "progress",
          message: t("normalizer.subagent", payload?.subagent_type ?? payload?.agent_id ?? "unknown"),
        });
        break;
      }

      case "PlanDisplay": {
        const payload = msg.payload as { content?: string };
        this.emit("result", {
          kind: "result",
          content: payload?.content ?? "",
          format: "markdown" as OutputFormat,
        });
        break;
      }

      case "HookTriggered": {
        const payload = msg.payload as { event?: string; target?: string };
        this.emit("mcp_status", {
          kind: "mcp_status",
          server: `hook:${payload?.event ?? "unknown"}`,
          status: "connected",
        });
        break;
      }

      case "HookResolved": {
        const payload = msg.payload as { action?: string; reason?: string };
        if (payload?.action === "block") {
          this.emit("warning", {
            kind: "warning",
            message: t("normalizer.hookBlocked", payload.reason ?? "no reason"),
            code: "hook_blocked",
          });
        }
        break;
      }

      case "ApprovalResponse": {
        // Approval responses are handled by the wire client directly.
        break;
      }

      case "SteerInput": {
        this.emit("progress", {
          kind: "progress",
          message: t("normalizer.steerInput"),
        });
        break;
      }

      default: {
        this.emit("warning", {
          kind: "warning",
          message: t("normalizer.unknownWireEvent", msg.type),
          code: "unknown_wire_event",
        });
      }
    }
  }

  finalize(outcome: NormalizerOutcome): void {
    if (this.accumulatedText.length > 0) {
      this.emit("result", {
        kind: "result",
        content: this.accumulatedText,
        format: "text" as OutputFormat,
      });
    }

    this.emit("turn_finished", {
      kind: "turn_finished",
      durationMs: outcome.durationMs,
      tokenUsage: outcome.tokenUsage,
    });
  }

  reset(): void {
    this.startedAt = 0;
    this.stepCount = 0;
    this.accumulatedText = "";
    this.toolCallCount = 0;
  }

  // ── internals ──

  private emit(type: OmkEventType, data: OmkEventData): void {
    const event: OmkEvent = {
      type,
      timestamp: new Date().toISOString(),
      turnId: this.turnId,
      data,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listeners must not throw; swallow silently.
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────
// KimiPrintNormalizer — raw stdout text chunks
// ───────────────────────────────────────────────────────────────

/**
 * Normalizes raw stdout lines from `kimi --print` (execa child process).
 *
 * The print runtime emits plain text — no structured events.
 * This normalizer buffers lines and emits progress/result OmkEvents.
 *
 * Special markers it recognizes:
 *   [omk_mcp:<server>:<status>]   → mcp_status
 *   [ERROR] ...                   → error
 *   [WARN] ...                    → warning
 *   [omk_tool:<name>]             → progress (tool call indicator)
 */
export class KimiPrintNormalizer implements ProviderEventNormalizer {
  private listeners: OmkEventListener[] = [];
  private turnId: string | undefined;
  private startedAt = 0;
  private buffer = "";

  // Pattern: [omk_mcp:<server>:<status>]
  private static readonly MCP_RE = /^\[omk_mcp:([^:]+):(\w+)\]\s*/;
  // Pattern: [ERROR] or [WARN]
  private static readonly ERROR_RE = /^\[ERROR\]\s*/;
  private static readonly WARN_RE = /^\[WARN\]\s*/;
  // Pattern: [omk_tool:<name>]
  private static readonly TOOL_RE = /^\[omk_tool:([^\]]+)\]\s*/;

  constructor(turnId?: string) {
    this.turnId = turnId;
  }

  onEvent(listener: OmkEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Push a raw text chunk (may contain multiple lines).
   * The print runtime delivers stdout in arbitrary chunks.
   */
  push(raw: unknown): void {
    if (typeof raw !== "string") return;

    this.buffer += raw;
    const lines = this.buffer.split("\n");

    // Keep the last incomplete line in the buffer.
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      this.processLine(line);
    }
  }

  finalize(outcome: NormalizerOutcome): void {
    // Flush any remaining buffer content.
    if (this.buffer.length > 0) {
      this.processLine(this.buffer);
      this.buffer = "";
    }

    this.emit("turn_finished", {
      kind: "turn_finished",
      durationMs: outcome.durationMs,
      tokenUsage: outcome.tokenUsage,
    });
  }

  reset(): void {
    this.buffer = "";
    this.startedAt = 0;
  }

  // ── internals ──

  private processLine(line: string): void {
    if (this.startedAt === 0) this.startedAt = Date.now();

    // Check for MCP status marker.
    const mcpMatch = line.match(KimiPrintNormalizer.MCP_RE);
    if (mcpMatch) {
      const server = mcpMatch[1]!;
      const status = mcpMatch[2]!;
      const remainder = line.slice(mcpMatch[0].length);
      this.emit("mcp_status", {
        kind: "mcp_status",
        server,
        status: normalizeMcpStatus(status),
      });
      if (remainder.length > 0) {
        this.emit("progress", { kind: "progress", message: remainder });
      }
      return;
    }

    // Check for tool call marker.
    const toolMatch = line.match(KimiPrintNormalizer.TOOL_RE);
    if (toolMatch) {
      const toolName = toolMatch[1]!;
      const remainder = line.slice(toolMatch[0].length);
      this.emit("progress", {
        kind: "progress",
        message: t("normalizer.toolCall", toolName),
      });
      if (remainder.length > 0) {
        this.emit("progress", { kind: "progress", message: remainder });
      }
      return;
    }

    // Check for error marker.
    if (KimiPrintNormalizer.ERROR_RE.test(line)) {
      const message = line.replace(KimiPrintNormalizer.ERROR_RE, "");
      this.emit("error", {
        kind: "error",
        message,
        code: "provider_error",
        recoverable: true,
      });
      return;
    }

    // Check for warning marker.
    if (KimiPrintNormalizer.WARN_RE.test(line)) {
      const message = line.replace(KimiPrintNormalizer.WARN_RE, "");
      this.emit("warning", {
        kind: "warning",
        message,
        code: "provider_warning",
      });
      return;
    }

    // Default: treat as progress text.
    this.emit("progress", { kind: "progress", message: line });
  }

  private emit(type: OmkEventType, data: OmkEventData): void {
    const event: OmkEvent = {
      type,
      timestamp: new Date().toISOString(),
      turnId: this.turnId,
      data,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listeners must not throw; swallow silently.
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────
// Factory
// ───────────────────────────────────────────────────────────────

/**
 * Create a ProviderEventNormalizer for the given provider name.
 *
 * Supported providers:
 *   "kimi-wire"   → KimiEventNormalizer  (structured JSON-RPC events)
 *   "kimi-print"  → KimiPrintNormalizer   (raw stdout text)
 *   "kimi"        → KimiEventNormalizer   (alias for wire)
 *   "deepseek"    → KimiPrintNormalizer   (advisory uses print-style stdout)
 *   "codex"       → KimiPrintNormalizer   (CLI stdout)
 *   "gemini"      → KimiPrintNormalizer   (CLI stdout)
 *   "claude"      → KimiPrintNormalizer   (CLI stdout)
 *
 * Unknown providers default to KimiPrintNormalizer (stdout-based).
 */
export function createProviderEventNormalizer(
  provider: string,
  turnId?: string,
): ProviderEventNormalizer {
  switch (provider) {
    case "kimi-wire":
    case "kimi":
      return new KimiEventNormalizer(turnId);

    case "kimi-print":
    case "deepseek":
    case "codex":
    case "gemini":
    case "claude":
    default:
      return new KimiPrintNormalizer(turnId);
  }
}

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────

function extractUserInput(payload: Record<string, unknown>): string {
  const input = payload?.user_input;
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    const textParts = input.filter(
      (p: unknown) =>
        typeof p === "object" && p !== null && (p as Record<string, unknown>).type === "text",
    );
    return textParts
      .map((p: unknown) => ((p as Record<string, unknown>).text as string) ?? "")
      .join("");
  }
  return "";
}

function normalizeMcpStatus(
  raw: string,
): "connected" | "failed" | "skipped" {
  switch (raw) {
    case "connected":
    case "ok":
    case "ready":
      return "connected";
    case "failed":
    case "error":
      return "failed";
    case "skipped":
    case "disabled":
      return "skipped";
    default:
      return "connected";
  }
}

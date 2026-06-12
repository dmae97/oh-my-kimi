/**
 * Reasoning NLP — Types, normalizer, accumulator, and JSONL writer for reasoning/thinking frames.
 *
 * Pipeline: provider output → ReasoningAccumulator.feed() → ReasoningFrame[] → reasoning.jsonl
 *
 * Visibility modes:
 *   off     — hidden (production default)
 *   summary — summarized reasoning exposed in chat (recommended)
 *   debug   — raw provider think/trace/status in dev logs only
 */

import { appendFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { style } from "./theme.js";

// ── Types ──

export type ReasoningVisibility = "off" | "summary" | "debug";

export type ReasoningSummaryMode = "auto" | "concise" | "detailed";

export type ReasoningFrameKind =
  | "thinking"      // explicit <think>...</think> or reasoning token
  | "tool-activity" // file read/write/edit/search
  | "status"        // provider status lines
  | "plan"          // plan/reasoning step
  | "unknown";

export interface ReasoningFrame {
  kind: ReasoningFrameKind;
  text: string;
  timestamp: string;       // ISO 8601
  provider?: string;       // e.g. "kimi", "deepseek", "openai"
  elapsedMs?: number;      // time since last frame
  raw?: string;            // original unprocessed line (debug only)
}

// ── Secret redaction ──

const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|token|secret|password|credential|authorization)\s*[:=]\s*["']?([^\s"']{8,})/gi,
  /(?:sk|pk|rk)[-_][A-Za-z0-9]{20,}/g,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g,
  /(?:xoxb|xoxp|xoxa|xoxr)-[A-Za-z0-9-]+/g,
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /(?:-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----)/g,
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

// ── Pattern matching ──

const THINK_OPEN_RE = /^<think(?:ing)?>[\s:]*/i;
const THINK_CLOSE_RE = /<\/think(?:ing)?>\s*$/i;
const THINK_SINGLE_RE = /^<think(?:ing)?>[\s:]*(.+?)(?:<\/think(?:ing)?>)?$/is;
const TOOL_ACTIVITY_RE = /read_file|write_file|edit_file|search_files|glob|grep|ctx_read|bash|webfetch/i;
const TOOL_PATH_RE = /["']([^"']{1,120})["']/;
const PLAN_RE = /^(?:step|plan|phase|first|next|then|finally|now)[\s:]/i;
const STATUS_RE = /^(?:running|processing|thinking|analyzing|searching|generating|loading|saving)/i;

function classifyLine(line: string): { kind: ReasoningFrameKind; text: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 3) return null;

  // Single-line think tags
  const thinkMatch = trimmed.match(THINK_SINGLE_RE);
  if (thinkMatch) {
    return { kind: "thinking", text: thinkMatch[1].trim() };
  }

  // Tool activity
  if (TOOL_ACTIVITY_RE.test(trimmed)) {
    const pathMatch = trimmed.match(TOOL_PATH_RE);
    const text = pathMatch
      ? `📄 ${pathMatch[1].split("/").pop() ?? pathMatch[1]}`
      : `🔧 ${trimmed.slice(0, 80)}`;
    return { kind: "tool-activity", text };
  }

  // Plan lines
  if (PLAN_RE.test(trimmed) && trimmed.length > 10) {
    return { kind: "plan", text: trimmed.slice(0, 200) };
  }

  // Status lines
  if (STATUS_RE.test(trimmed) && trimmed.length < 100) {
    return { kind: "status", text: trimmed };
  }

  return null;
}

// ── ReasoningAccumulator (streaming multi-line think tag support) ──

export class ReasoningAccumulator {
  private buffer = "";
  private inThinkBlock = false;
  private lastFrameTime = Date.now();
  private readonly frames: ReasoningFrame[] = [];

  constructor(private readonly provider?: string) {}

  /**
   * Feed a streaming chunk. Returns any completed frames.
   * Handles multi-line <think>...</think> and <thinking>...</thinking> blocks.
   */
  feed(chunk: string, visibility: ReasoningVisibility): ReasoningFrame[] {
    if (visibility === "off") return [];

    const now = Date.now();
    const elapsed = now - this.lastFrameTime;
    const lines = chunk.split("\n");
    const result: ReasoningFrame[] = [];

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();

      if (this.inThinkBlock) {
        // Check for closing tag
        if (THINK_CLOSE_RE.test(trimmed)) {
          const text = this.buffer.trim();
          if (text) {
            const frame = this.makeFrame("thinking", text, elapsed);
            result.push(frame);
            this.frames.push(frame);
          }
          this.buffer = "";
          this.inThinkBlock = false;
          this.lastFrameTime = now;
          continue;
        }
        // Accumulate inside think block
        this.buffer += (this.buffer ? "\n" : "") + rawLine;
        continue;
      }

      // Check for opening think tag
      if (THINK_OPEN_RE.test(trimmed)) {
        // Check if it's a single-line tag (has close on same line)
        if (THINK_CLOSE_RE.test(trimmed)) {
          const text = trimmed.replace(THINK_OPEN_RE, "").replace(THINK_CLOSE_RE, "").trim();
          if (text) {
            const frame = this.makeFrame("thinking", text, elapsed);
            result.push(frame);
            this.frames.push(frame);
          }
          this.lastFrameTime = now;
          continue;
        }
        // Multi-line: start accumulating
        const afterOpen = trimmed.replace(THINK_OPEN_RE, "").trim();
        this.buffer = afterOpen;
        this.inThinkBlock = true;
        this.lastFrameTime = now;
        continue;
      }

      // Non-think lines: classify normally
      const classified = classifyLine(rawLine);
      if (classified) {
        const frame = this.makeFrame(classified.kind, classified.text, elapsed);
        if (visibility === "debug" || classified.kind === "thinking" || classified.kind === "plan") {
          result.push(frame);
        }
        this.frames.push(frame);
        this.lastFrameTime = now;
      }
    }

    return result;
  }

  /** Flush any pending think block content (e.g. on turn:end). */
  flush(): ReasoningFrame[] {
    if (!this.inThinkBlock || !this.buffer.trim()) return [];
    const now = Date.now();
    const elapsed = now - this.lastFrameTime;
    const frame = this.makeFrame("thinking", this.buffer.trim(), elapsed);
    this.frames.push(frame);
    this.buffer = "";
    this.inThinkBlock = false;
    this.lastFrameTime = now;
    return [frame];
  }

  /** Get all accumulated frames. */
  allFrames(): readonly ReasoningFrame[] {
    return this.frames;
  }

  /** Get the latest thinking summary. */
  summary(): string | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].kind === "thinking" || this.frames[i].kind === "plan") {
        const text = this.frames[i].text;
        return text.length > 120 ? text.slice(0, 117) + "..." : text;
      }
    }
    return undefined;
  }

  private makeFrame(kind: ReasoningFrameKind, text: string, elapsedMs: number): ReasoningFrame {
    return {
      kind,
      text: redactSecrets(text),
      timestamp: new Date().toISOString(),
      provider: this.provider,
      elapsedMs,
    };
  }
}

// ── Legacy normalizer (single-chunk, non-streaming) ──

export interface ReasoningNormalizeOptions {
  visibility: ReasoningVisibility;
  summaryMode: ReasoningSummaryMode;
  provider?: string;
}

/**
 * Process a chunk of provider output and extract reasoning frames.
 * For streaming use, prefer ReasoningAccumulator instead.
 */
export function normalizeReasoningChunk(
  data: string,
  options: ReasoningNormalizeOptions
): ReasoningFrame[] {
  if (options.visibility === "off") return [];
  const acc = new ReasoningAccumulator(options.provider);
  return acc.feed(data, options.visibility);
}

/**
 * Extract a single-line thinking summary from the most recent thinking frame.
 */
export function extractThinkingSummary(frames: ReasoningFrame[]): string | undefined {
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];
    if (frame.kind === "thinking" || frame.kind === "plan") {
      const text = frame.text;
      return text.length > 120 ? text.slice(0, 117) + "..." : text;
    }
  }
  return undefined;
}

// ── JSONL Writer (ENOSPC-resilient) ──

export interface ReasoningJsonlWriter {
  append(frames: ReasoningFrame[]): Promise<void>;
  flush(): Promise<void>;
}

export function createReasoningJsonlWriter(runPath: string): ReasoningJsonlWriter {
  const filePath = `${runPath}/reasoning.jsonl`;
  let buffer: ReasoningFrame[] = [];
  let writePromise: Promise<void> = Promise.resolve();
  let enospcHit = false;

  return {
    async append(frames: ReasoningFrame[]): Promise<void> {
      if (frames.length === 0 || enospcHit) return;
      buffer.push(...frames);
      if (buffer.length >= 10) {
        await this.flush();
      }
    },

    async flush(): Promise<void> {
      if (buffer.length === 0 || enospcHit) return;
      const toWrite = buffer;
      buffer = [];

      writePromise = writePromise.then(async () => {
        try {
          await mkdir(dirname(filePath), { recursive: true });
          const lines = toWrite.map((f) => JSON.stringify(f)).join("\n") + "\n";
          await appendFile(filePath, lines, "utf-8");
        } catch (err: unknown) {
          if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOSPC") {
            enospcHit = true;
            buffer = []; // Drop remaining frames
          }
          // Other errors silently ignored — reasoning is non-critical
        }
      });
      await writePromise;
    },
  };
}

/**
 * Append reasoning frames to `.omk/runs/<runId>/reasoning.jsonl`.
 */
export async function appendReasoningFrames(
  runDir: string,
  frames: ReasoningFrame[]
): Promise<void> {
  if (frames.length === 0) return;
  const filePath = join(runDir, "reasoning.jsonl");
  try {
    await mkdir(dirname(filePath), { recursive: true });
    const lines = frames.map((f) => JSON.stringify(f)).join("\n") + "\n";
    await appendFile(filePath, lines, "utf-8");
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOSPC") {
      return; // Stop trying on disk full
    }
  }
}

// ── CLI Display Helpers ──

const KIND_ICONS: Record<ReasoningFrameKind, string> = {
  "thinking": "🧠",
  "tool-activity": "📄",
  "status": "⚡",
  "plan": "📋",
  "unknown": "💭",
};

/**
 * Format a reasoning frame for terminal display.
 */
export function formatReasoningFrame(frame: ReasoningFrame): string {
  const icon = KIND_ICONS[frame.kind] ?? "💭";
  const maxLen = frame.kind === "thinking" ? 120 : 80;
  const text = frame.text.length > maxLen ? frame.text.slice(0, maxLen - 3) + "..." : frame.text;
  return style.gray(`  ${icon} ${text}`);
}

/**
 * Format a compact thinking summary for HUD/status display.
 */
export function formatThinkingStatusLine(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const truncated = summary.length > 100 ? summary.slice(0, 97) + "..." : summary;
  return style.gray(`  🧠 ${truncated}`);
}

/**
 * Read reasoning.jsonl and return parsed frames.
 */
export async function readReasoningFrames(runDir: string): Promise<ReasoningFrame[]> {
  const filePath = join(runDir, "reasoning.jsonl");
  try {
    const { readFile } = await import("fs/promises");
    const content = await readFile(filePath, "utf-8");
    const frames: ReasoningFrame[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        frames.push(JSON.parse(line));
      } catch { /* skip malformed lines */ }
    }
    return frames;
  } catch {
    return [];
  }
}

/**
 * Resolve reasoning visibility from env/flags.
 */
export function resolveReasoningVisibility(
  flag?: string,
  envOverride?: string
): ReasoningVisibility {
  const raw = flag ?? envOverride ?? "off";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "summary" || normalized === "debug" || normalized === "off") {
    return normalized;
  }
  return "off";
}

/**
 * Resolve reasoning summary mode from env/flags.
 */
export function resolveReasoningSummaryMode(
  flag?: string,
  envOverride?: string
): ReasoningSummaryMode {
  const raw = flag ?? envOverride ?? "auto";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "concise" || normalized === "detailed" || normalized === "auto") {
    return normalized;
  }
  return "auto";
}

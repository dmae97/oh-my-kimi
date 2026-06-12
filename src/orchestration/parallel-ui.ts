/**
 * Parallel Execution Live UI — real-time DAG status renderer
 *
 * Renders a compact, non-intrusive terminal panel showing:
 * - Running / done / failed / blocked nodes with role colors
 * - Progress bar and ETA with confidence
 * - Safety / approval policy chip
 * - Ensemble quorum gauge (when applicable)
 * - Blocker and completion panels
 *
 * Three view modes:
 *   cockpit — full 4-section dashboard (default)
 *   compact — single-line cursor-refresh status
 *   table   — append-only timestamped rows for CI logs
 */

import type { RunState } from "../contracts/orchestration.js";
import {
  buildRunViewModel,
  type RunViewModel,
  type RunViewModelWorker,
} from "../util/run-view-model.js";
import {
  style,
  roleColor,
  padEndAnsi,
} from "../util/theme.js";

let stdoutLock: Promise<void> = Promise.resolve();
async function lockedStdoutWrite(data: string): Promise<void> {
  stdoutLock = stdoutLock.then(() => {
    process.stdout.write(data);
  }).catch(() => {
    process.stdout.write(data);
  });
  await stdoutLock;
}

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return h;
}

export type ParallelViewMode = "cockpit" | "table" | "compact";

export interface ParallelLiveUIOptions {
  runId: string;
  approvalPolicy?: string;
  workerCount?: number;
  ensembleEnabled?: boolean;
  refreshMs?: number;
  onFrame?: (frame: string) => void;
  goalTitle?: string;
  mode?: "watch" | "no-watch" | "chat-handoff";
  workerLabels?: Record<string, string>;
  statePath?: string;
  useAlternateScreen?: boolean;
  view?: ParallelViewMode;
}

function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B[P^_][\s\S]*?\x1B\\/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function truncate(value: string, max: number): string {
  const clean = stripAnsi(value).trim();
  const chars = [...clean];
  if (chars.length <= max) return clean;
  return chars.slice(0, Math.max(1, max - 1)).join("") + "…";
}

function formatDurationMs(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function buildBar(percent: number, width = 24): string {
  const ratio = Math.min(Math.max(percent / 100, 0), 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  let barStr: string;
  if (ratio > 0.9) {
    barStr = style.red("█".repeat(filled)) + style.gray("░".repeat(empty));
  } else if (ratio > 0.7) {
    barStr = style.orange("█".repeat(filled)) + style.gray("░".repeat(empty));
  } else {
    barStr = style.mint("█".repeat(filled)) + style.gray("░".repeat(empty));
  }
  return `[${barStr}]`;
}

function formatCompactPolicyChip(policy: string): string {
  if (policy === "yolo") return style.mintBold("YOLO");
  if (policy === "auto") return style.orangeBold("AUTO");
  if (policy === "interactive") return style.pinkBold("INTERACTIVE");
  if (policy === "block") return style.redBold("BLOCK");
  return style.gray(policy.toUpperCase());
}

function formatStateShort(state: string): string {
  switch (state) {
    case "running":
      return style.purpleBold("running");
    case "done":
      return style.mintBold("done");
    case "failed":
      return style.pinkBold("failed");
    case "blocked":
      return style.orangeBold("blocked");
    case "skipped":
      return style.gray("⊘ skipped");
    default:
      return style.gray("□ idle");
  }
}

function etaConfidence(vm: RunViewModel): { text: string; level: "high" | "medium" | "low" | "warming" } {
  const samples = vm.progress.done;
  if (samples === 0) return { text: "warming up", level: "warming" };
  if (samples >= 5) return { text: "high confidence", level: "high" };
  if (samples >= 2) return { text: "medium confidence", level: "medium" };
  return { text: "low confidence", level: "low" };
}

/* ── Table mode append-only state ───────────────────────────── */

const tablePrintedRows = new Map<string, Set<string>>();

function getTableRowKey(w: RunViewModelWorker): string {
  return `${w.id}#${w.state}#${w.currentNode ?? ""}`;
}

function formatWorkerAssignment(w: RunViewModelWorker, maxItems = 2): string | null {
  const assignment = w.assignment;
  if (!assignment) return null;
  const parts = [
    assignment.skills.length > 0 ? `skills:${assignment.skills.slice(0, maxItems).join(",")}` : "",
    assignment.hooks.length > 0 ? `hooks:${assignment.hooks.slice(0, maxItems).join(",")}` : "",
    assignment.mcpServers.length > 0 ? `mcp:${assignment.mcpServers.slice(0, maxItems).join(",")}` : "",
    assignment.tools && assignment.tools.length > 0 ? `tools:${assignment.tools.slice(0, maxItems).join(",")}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

function renderParallelTable(vm: RunViewModel): string {
  const runId = vm.runId ?? "unknown";
  let printed = tablePrintedRows.get(runId);
  if (!printed) {
    printed = new Set();
    tablePrintedRows.set(runId, printed);
  }

  const rows: string[] = [];
  if (printed.size === 0) {
    rows.push("TIMESTAMP              STATE    ROLE       NODE                 ELAPSED  RETRY  EVIDENCE");
  }

  for (const w of vm.workers) {
    const key = getTableRowKey(w);
    if (printed.has(key)) continue;
    printed.add(key);

    const ts = new Date().toISOString();
    const role = w.label ? w.label.split(":")[0] : "unknown";
    const node = w.currentNode ?? w.label ?? "--";
    const state = w.state;
    const elapsed = w.state === "idle" ? "--" : formatDurationMs(w.elapsedMs);
    const retry = w.retryCount > 0 ? String(w.retryCount) : "--";

    let evidence = "--";
    if (w.lastEvidence) {
      evidence = w.lastEvidence.passed ? "✓" : `✕ ${w.lastEvidence.gate}`;
      if (!w.lastEvidence.passed && w.lastEvidence.message) {
        evidence += ` — ${truncate(w.lastEvidence.message, 40)}`;
      }
    } else if (w.state === "done") {
      evidence = "⚠";
    } else if (w.state === "failed" || w.state === "blocked") {
      evidence = w.state === "failed" ? "✕ failed" : "⊘ blocked";
    }

    rows.push(
      `${ts}  ${state.padEnd(7)} ${role.padEnd(8)} ${truncate(node, 20).padEnd(20)} ${elapsed.padEnd(8)} ${retry.padEnd(6)} ${evidence}`
    );
  }

  return rows.join("\n") + (rows.length > 0 ? "\n" : "");
}

/* ── Cockpit mode ───────────────────────────────────────────── */

export function renderParallelCockpit(
  vm: RunViewModel,
  options: Pick<ParallelLiveUIOptions, "approvalPolicy" | "workerCount" | "ensembleEnabled" | "mode" | "goalTitle" | "statePath" | "view">
): string {
  const view = options.view ?? "cockpit";
  const termWidth = process.stdout.columns || 80;

  if (termWidth < 60 || view === "compact") {
    return buildCompactParallelFrame(vm, options.mode ?? "watch", termWidth);
  }

  if (view === "table") {
    return renderParallelTable(vm);
  }

  const lines: string[] = [];
  const policy = options.approvalPolicy || "auto";
  const workers = options.workerCount || 1;
  const mode = options.mode ?? "watch";
  const modeLabel = mode === "chat-handoff" ? "chat handoff" : mode;
  const goalTitle = options.goalTitle ?? vm.goalTitle ?? "(no goal)";

  // Section 1 — Header
  if (termWidth >= 80) {
    const titlePart = style.creamBold("OMK Parallel Execution");
    const goalPart = style.gray(`[${truncate(goalTitle, termWidth - 30)}]`);
    lines.push(`${titlePart}  ${goalPart}`);
  }
  lines.push(
    `Run: ${vm.runId ?? "—"}  |  Workers: ${workers}  |  Policy: ${formatCompactPolicyChip(policy)}  |  Mode: ${modeLabel}`
  );
  lines.push("");

  // Section 2 — Progress
  const conf = etaConfidence(vm);
  const etaText = vm.eta ?? "--";
  lines.push(`Progress  ${buildBar(vm.progress.percent)} ${vm.progress.percent}%  ·  ETA ${etaText} · ${conf.text}`);
  const pending = vm.progress.total - vm.progress.settled - vm.progress.running;
  lines.push(`${vm.progress.settled} settled · ${vm.progress.done} done · ${vm.progress.running} running · ${vm.progress.failed} failed · ${vm.progress.blocked} blocked · ${vm.progress.skipped} skipped · ${pending} pending`);
  lines.push("");

  // Section 3 — Workers
  if (vm.workers.length > 0) {
    const roleW = 10;
    const stateW = 10;
    const elapsedW = 8;
    const retryW = 6;
    const evidenceW = 12;
    const nodeW = Math.max(12, termWidth - 53);

    lines.push(style.purpleBold("▸ Workers"));
    const header = `  ${padEndAnsi(style.gray("ROLE"), roleW)} ${padEndAnsi(style.gray("NODE"), nodeW)} ${padEndAnsi(style.gray("STATE"), stateW)} ${padEndAnsi(style.gray("ELAPSED"), elapsedW)} ${padEndAnsi(style.gray("RETRY"), retryW)} ${style.gray("EVIDENCE")}`;
    lines.push(header);

    for (const w of vm.workers) {
      const roleRaw = w.label ? w.label.split(":")[0] : w.id;
      const roleText = truncate(roleRaw, roleW);
      const roleCol = roleColor(roleText)(roleText);

      let nodeRaw: string;
      if (w.state === "running" && w.currentNode) {
        nodeRaw = w.currentNode;
      } else if (w.state === "running" && w.label) {
        nodeRaw = w.label;
      } else {
        nodeRaw = w.label ?? w.id;
      }
      nodeRaw = truncate(nodeRaw, nodeW);
      const nodeCol = w.state === "running" ? style.creamBold(nodeRaw) : style.cream(nodeRaw);

      const stateCol = formatStateShort(w.state);
      const elapsedCol = w.state === "idle" ? "--" : formatDurationMs(w.elapsedMs);
      const retryCol = w.retryCount > 0 ? style.orange(String(w.retryCount)) : "--";

      let evidenceCol: string;
      if (w.lastEvidence) {
        evidenceCol = w.lastEvidence.passed
          ? style.mint("✓")
          : `${style.pink("✕")} ${truncate(w.lastEvidence.gate, evidenceW - 2)}`;
      } else if (w.state === "done") {
        evidenceCol = style.orange("⚠");
      } else if (w.state === "failed") {
        evidenceCol = style.pink("✕");
      } else {
        evidenceCol = "--";
      }

      const row = `  ${padEndAnsi(roleCol, roleW)} ${padEndAnsi(nodeCol, nodeW)} ${padEndAnsi(stateCol, stateW)} ${padEndAnsi(elapsedCol, elapsedW)} ${padEndAnsi(retryCol, retryW)} ${evidenceCol}`;
      lines.push(row);
      const assignment = formatWorkerAssignment(w);
      if (assignment) {
        lines.push(`    ${style.gray("↳")} ${style.gray(truncate(assignment, termWidth - 6))}`);
      }
      if (w.state === "running" && w.phase) {
        lines.push(`    ${style.gray("→")} ${truncate(w.phase, nodeW)}`);
      }
    }
    lines.push("");
  }

  // Section 4 — Action
  const hasBlockers = vm.blocker != null || vm.progress.failed > 0 || vm.progress.blocked > 0;
  const allSettled = vm.progress.settled === vm.progress.total && vm.progress.total > 0;
  const doneWithoutEvidence = vm.workers.filter((w) => w.state === "done" && !w.lastEvidence);

  if (hasBlockers) {
    lines.push(style.pinkBold("▸ Blockers"));
    if (vm.blocker) {
      const recoverableIcon = vm.blocker.recoverable ? "🔄" : "❌";
      lines.push(`  ${style.red("Node:")} ${style.creamBold(vm.blocker.nodeId)} ${recoverableIcon}`);
      lines.push(`  ${style.gray("Reason:")} ${vm.blocker.reason}`);
      if (vm.blocker.evidenceMessage) {
        lines.push(`  ${style.gray("Evidence:")} ${style.gray(truncate(vm.blocker.evidenceMessage, termWidth - 14))}`);
      }
      lines.push(`  ${style.gray("Retry:")} ${vm.blocker.retryCount}/${vm.blocker.maxRetries}`);
      if (vm.blocker.logHint) {
        lines.push(`  ${style.gray("Log:")} ${style.gray(vm.blocker.logHint)}`);
      }
      lines.push(`  ${style.gray("Next:")} ${style.cream(vm.blocker.nextAction)}`);
    } else {
      lines.push(`  ${style.gray("Some nodes are failed or blocked. Review the worker grid above.")}`);
    }
    const failedWorkers = vm.workers.filter((w) => w.state === "failed");
    for (const w of failedWorkers) {
      if (w.lastEvidence) {
        lines.push(`  ${style.pink("✕")} ${style.creamBold(w.label)} evidence gate failed: ${style.gray(w.lastEvidence.gate)}`);
        if (w.lastEvidence.message) {
          lines.push(`    ${style.gray(truncate(w.lastEvidence.message, termWidth - 6))}`);
        }
      } else {
        lines.push(`  ${style.pink("✕")} ${style.creamBold(w.label)} failed`);
      }
    }
    if (doneWithoutEvidence.length > 0) {
      lines.push(`  ${style.orange("⚠")} ${doneWithoutEvidence.length} done node(s) missing evidence`);
    }
    lines.push("");
  } else if (allSettled) {
    const success = vm.progress.failed === 0 && vm.progress.blocked === 0;
    if (success && doneWithoutEvidence.length > 0) {
      lines.push(style.orangeBold("▸ Complete (with warnings)"));
      lines.push(`  ${style.orange("⚠")} ${doneWithoutEvidence.length} done node(s) missing evidence`);
    } else if (success) {
      lines.push(style.mintBold("▸ Complete"));
      lines.push(`  ${style.mint("✓ All workers finished successfully")}`);
    } else {
      lines.push(style.pinkBold("▸ Complete (with issues)"));
      lines.push(`  ${style.pink("✕ Some workers failed or blocked")}`);
    }
    if (options.statePath) {
      lines.push(`  ${style.gray("State:")} ${style.cream(options.statePath)}`);
    }
    lines.push(`  ${style.gray("Next:")} ${style.cream("omk summary")} ${style.gray("|")} ${style.cream("omk verify")} ${style.gray("|")} ${style.cream("omk chat --run-id")}`);
    lines.push("");
  }

  // Section 5 — Final failure summary (when run ended with failures)
  if (allSettled && hasBlockers) {
    lines.push(style.pinkBold("▸ Failure Summary"));
    for (const item of vm.blockers ?? []) {
      const icon = item.status === "failed" ? style.pink("✕") : style.orangeBold("⊘");
      lines.push(`  ${icon} ${style.creamBold(item.nodeId)}`);
      lines.push(`    ${style.gray("Reason:")} ${style.gray(truncate(item.reason, termWidth - 14))}`);
      if (vm.runId) {
        lines.push(`    ${style.gray("Log:")} ${style.gray(`.omk/runs/${vm.runId}/logs/${item.nodeId}.log`)}`);
      }
    }
    lines.push(`  ${style.gray("Next:")} ${style.cream("omk summary")} ${style.gray("|")} ${style.cream("omk verify")} ${style.gray("|")} ${style.cream(`omk chat --run-id ${vm.runId ?? "<run-id>"}`)}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** @deprecated Use renderParallelCockpit instead */
export function renderParallelStatusLine(
  vm: RunViewModel,
  options: Pick<ParallelLiveUIOptions, "approvalPolicy" | "workerCount" | "ensembleEnabled" | "mode" | "goalTitle" | "statePath">
): string {
  return renderParallelCockpit(vm, { ...options, view: "cockpit" });
}

export function renderParallelFrame(
  state: RunState,
  options: Omit<ParallelLiveUIOptions, "refreshMs" | "onFrame">
): string {
  const vm = buildRunViewModel(state, { workerLabels: options.workerLabels });
  const view = options.view ?? "cockpit";
  if (view === "compact") {
    return buildCompactParallelFrame(vm, options.mode ?? "watch", process.stdout.columns || 80);
  }
  return renderParallelCockpit(vm, options);
}

function buildCompactParallelFrame(vm: RunViewModel, mode: string, termWidth: number): string {
  const parts: string[] = ["OMK parallel"];
  parts.push(`· ${vm.progress.settled}/${vm.progress.total} settled`);
  if (vm.progress.running > 0) {
    parts.push(`· ${vm.progress.running} running`);
  }
  if (vm.progress.skipped > 0) {
    parts.push(`· ${vm.progress.skipped} skipped`);
  }
  const eta = vm.eta ?? "--";
  parts.push(`· ETA ${eta}`);

  const activeWorker = vm.workers.find((w) => w.state === "running");
  if (activeWorker) {
    const role = activeWorker.label ? activeWorker.label.split(":")[0] : "worker";
    const node = activeWorker.currentNode ?? activeWorker.label ?? "";
    parts.push(`· ${role}: ${truncate(node, 20)}`);
  }

  const line = parts.join(" ");
  return truncate(line, termWidth);
}

export function renderCompactParallelFrame(
  state: RunState,
  options: Omit<ParallelLiveUIOptions, "refreshMs" | "onFrame">
): string {
  const vm = buildRunViewModel(state, { workerLabels: options.workerLabels });
  return buildCompactParallelFrame(vm, options.mode ?? "watch", process.stdout.columns || 80);
}

export class ParallelLiveRenderer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lastFrame = "";
  private lastFrameHash = 0;
  private readonly refreshMs: number;
  private readonly options: Omit<ParallelLiveUIOptions, "refreshMs" | "useAlternateScreen">;
  private readonly useAlternateScreen: boolean;

  constructor(options: ParallelLiveUIOptions) {
    this.refreshMs = options.refreshMs ?? 2000;
    this.useAlternateScreen = options.useAlternateScreen ?? false;
    this.options = (({ refreshMs: _, useAlternateScreen: __, ...rest }) => rest)(options);
  }

  start(stateProvider: () => RunState | undefined): void {
    this.stopped = false;
    if (this.useAlternateScreen) {
      process.stdout.write("\x1b[?1049h");
    }
    this.renderNow(stateProvider);
    this.timer = setInterval(() => {
      if (!this.stopped) this.renderNow(stateProvider);
    }, this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.useAlternateScreen) {
      process.stdout.write("\x1b[?1049l");
    }
  }

  renderOnce(state: RunState): string {
    const frame = renderParallelFrame(state, this.options);
    this.lastFrame = frame;
    return frame;
  }

  private renderNow(stateProvider: () => RunState | undefined): void {
    const state = stateProvider();
    if (!state) return;
    const frame = renderParallelFrame(state, this.options);
    const frameHash = hashString(frame);
    if (frameHash === this.lastFrameHash) return;
    this.lastFrameHash = frameHash;
    this.lastFrame = frame;

    if (this.options.onFrame) {
      this.options.onFrame(frame);
      return;
    }

    const view = this.options.view ?? "cockpit";
    const mode = this.options.mode ?? "watch";
    const isTTY = Boolean(process.stdout.isTTY);

    if (view === "compact") {
      if (mode === "watch" && isTTY) {
        void lockedStdoutWrite(`\x1b[1G\x1b[2K${frame}`);
      } else {
        void lockedStdoutWrite(frame + "\n");
      }
      return;
    }

    if (view === "table") {
      if (frame) void lockedStdoutWrite(frame);
      return;
    }

    // Cockpit mode
    const clearPrefix = this.useAlternateScreen ? "\x1b[2J\x1b[H" : "\x1b[H\x1b[J";
    const output = clearPrefix + frame + "\n";
    void lockedStdoutWrite(output);
  }
}

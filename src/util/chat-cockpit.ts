import { resolve, join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { runShell, type ShellResult } from "./shell.js";
import { getProjectRoot, getRunPath, pathExists } from "./fs.js";
import { writeSessionMeta } from "./session.js";
import { writeTodos } from "./todo-sync.js";

export async function detectTmux(): Promise<boolean> {
  const result: ShellResult = await runShell("tmux", ["-V"], { timeout: 3000 });
  return result.exitCode === 0;
}

export function isCockpitChild(): boolean {
  return process.env.OMK_CHAT_COCKPIT_CHILD === "1";
}

export interface LaunchChatCockpitOptions {
  runId?: string;
  brand?: string;
  cwd?: string;
  agentFile?: string;
  workers?: string;
  maxStepsPerTurn?: string;
  mcpScope?: string;
  provider?: string;
  model?: string;
  execution?: string;
  ui?: string;
  cockpitRefresh?: string;
  cockpitRedraw?: "diff" | "full" | "append";
  cockpitHistory?: "off" | "static" | "watch";
  cockpitSideWidth?: string;
  cockpitHeight?: string;
}

export async function ensureChatRunState(root: string, runId: string): Promise<void> {
  const runDir = getRunPath(runId, undefined, root);
  await mkdir(runDir, { recursive: true });
  const statePath = join(runDir, "state.json");
  if (!(await pathExists(statePath))) {
    const state = {
      schemaVersion: 1,
      runId,
      status: "running",
      nodes: [
        {
          id: "chat",
          name: "Chat Session",
          role: "chat",
          dependsOn: [],
          status: "running",
          retries: 0,
          maxRetries: 0,
          startedAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeFile(statePath, JSON.stringify(state, null, 2));
    // Write initial session metadata and empty todos
    try {
      const now = new Date().toISOString();
      await writeSessionMeta(runId, { runId, type: "chat", status: "active", startedAt: now, updatedAt: now, todoCount: 0, todoDoneCount: 0 });
      await writeTodos(runId, []);
    } catch {
      // ignore initialization failures
    }
  }
}

function parseCockpitRefreshMs(value?: string): number {
  const defaultMs = 2000;
  if (value === undefined) return defaultMs;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultMs;
  return Math.min(60_000, Math.max(750, parsed));
}

function parseCockpitSideWidth(value?: string): number {
  const defaultPct = defaultCockpitSideWidth();
  if (value === undefined) return defaultPct;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultPct;
  return Math.min(80, Math.max(20, parsed));
}

function defaultCockpitSideWidth(): number {
  const columns = process.stdout.columns ?? 0;
  if (columns >= 180) return 50;
  if (columns >= 120) return 45;
  return 40;
}

const DEFAULT_CHAT_COCKPIT_HEIGHT = 32;
const MIN_CHAT_COCKPIT_HEIGHT = 14;
const MAX_CHAT_COCKPIT_HEIGHT = 96;

function parseCockpitHeight(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(MAX_CHAT_COCKPIT_HEIGHT, Math.max(MIN_CHAT_COCKPIT_HEIGHT, parsed));
}

export function buildRightPaneCommand(options: {
  nodeCmd: string;
  cliCmd: string;
  runId: string;
  refreshMs: number;
  redraw?: "diff" | "full" | "append";
  height?: number;
}): string {
  let cmd = `${options.nodeCmd} ${options.cliCmd} cockpit --run-id ${shellQuote(options.runId)} --watch --refresh ${options.refreshMs}`;
  if (options.redraw && options.redraw !== "diff") {
    cmd += ` --redraw ${shellQuote(options.redraw)}`;
  }
  if (options.height) {
    cmd += ` --height ${options.height}`;
  }
  return cmd;
}

export async function launchChatCockpit(options: LaunchChatCockpitOptions = {}): Promise<void> {
  if (isCockpitChild()) {
    throw new Error("Recursive cockpit launch detected");
  }

  const runId = options.runId ?? `chat-${Date.now()}`;
  const cwd = options.cwd ?? getProjectRoot();

  // Ensure run state exists before launching tmux so the right pane can read it
  await ensureChatRunState(cwd, runId);
  const sanitized = runId.replace(/[^a-zA-Z0-9]/g, "-");
  const session = `omk-chat-${sanitized}`;
  const brand = options.brand ?? "omk";
  const omkCli = process.argv[1] ? resolve(process.argv[1]) : "omk";
  const nodeCmd = process.execPath ? shellQuote(process.execPath) : "node";
  const cliCmd = shellQuote(omkCli);

  // 1. Reuse existing session if it already exists
  const hasSessionResult = await runShell(
    "tmux",
    ["has-session", "-t", session],
    { cwd, timeout: 5000 }
  );
  if (hasSessionResult.exitCode === 0) {
    // Session exists — attach to it instead of destroying active work.
    if (process.env.TMUX) {
      await runShell("tmux", ["switch-client", "-t", session], { cwd, timeout: 0, stdio: "inherit" });
    } else {
      await runShell("tmux", ["attach", "-t", session], { cwd, timeout: 0, stdio: "inherit" });
    }
    return;
  }

  // 2. Build commands
  const refreshMs = parseCockpitRefreshMs(options.cockpitRefresh);
  const sideWidth = parseCockpitSideWidth(options.cockpitSideWidth);
  const redraw = options.cockpitRedraw ?? "diff";
  const history = options.cockpitHistory ?? "static";

  const terminalWidth = process.stdout.columns ?? 0;
  const terminalHeight = process.stdout.rows ?? 0;
  const minHistoryPaneHeight = 5;
  const cockpitHeight = parseCockpitHeight(options.cockpitHeight);
  const cockpitPaneHeight = Math.min(cockpitHeight ?? DEFAULT_CHAT_COCKPIT_HEIGHT, terminalHeight - minHistoryPaneHeight);

  const leftCmd = buildLeftPaneCommand({
    nodeCmd,
    cliCmd,
    runId,
    brand,
    agentFile: options.agentFile,
    workers: options.workers,
    maxStepsPerTurn: options.maxStepsPerTurn,
    mcpScope: options.mcpScope,
    provider: options.provider,
    model: options.model,
    execution: options.execution,
    ui: options.ui,
  });
  const rightTopCmd = buildRightPaneCommand({ nodeCmd, cliCmd, runId, refreshMs, redraw, height: cockpitPaneHeight });
  const rightBottomCmd = `${nodeCmd} ${cliCmd} runs --watch --limit 15 --refresh 5000`;

  // 3. Create detached tmux session with left-pane command already running
  const createResult = await runShell(
    "tmux",
    ["new-session", "-d", "-s", session, "-n", "chat", "-e", "OMK_CHAT_COCKPIT_CHILD=1", leftCmd],
    { cwd, timeout: 10000 }
  );
  if (createResult.failed) {
    console.error(`Failed to create tmux session: ${createResult.stderr || createResult.stdout}`);
    process.exitCode = 1;
    return;
  }

  // 4. Get the original pane ID before splitting (works with any pane-base-index)
  const originalPanesResult = await runShell(
    "tmux",
    ["list-panes", "-t", `${session}:chat`, "-F", "#{pane_id}"],
    { cwd, timeout: 5000 }
  );
  if (originalPanesResult.failed) {
    console.error(`Failed to list panes: ${originalPanesResult.stderr || originalPanesResult.stdout}`);
    process.exitCode = 1;
    return;
  }
  const originalPaneIds = originalPanesResult.stdout
    .trim()
    .split(/\r?\n/)
    .filter((s) => s.length > 0);
  const leftPaneId = originalPaneIds[0];
  if (!leftPaneId) {
    throw new Error("No pane found in newly created tmux session");
  }

  // 5. Split window vertically for right pane using configured side width
  // Use -P -F #{pane_id} to capture the new pane ID regardless of pane-base-index.
  const sideWidthArg = `${sideWidth}%`;
  let splitResult = await runShell(
    "tmux",
    ["split-window", "-h", "-P", "-F", "#{pane_id}", "-t", `${session}:chat`, "-l", sideWidthArg, rightTopCmd],
    { cwd, timeout: 5000 }
  );
  if (splitResult.failed) {
    splitResult = await runShell(
      "tmux",
      ["split-window", "-h", "-P", "-F", "#{pane_id}", "-t", `${session}:chat`, "-p", String(sideWidth), rightTopCmd],
      { cwd, timeout: 5000 }
    );
  }
  let rightTopPaneId: string | undefined;
  if (!splitResult.failed) {
    rightTopPaneId = splitResult.stdout.trim().split(/\r?\n/).filter((s) => s.length > 0)[0];
  } else {
    const msg = `Failed to split tmux window: ${splitResult.stderr || splitResult.stdout}`;
    console.warn(msg);
  }

  // 6. Split right pane horizontally for bottom history pane only when there's enough space
  if (history === "watch" && terminalWidth >= 80 && terminalHeight >= cockpitPaneHeight + minHistoryPaneHeight && rightTopPaneId) {
    let bottomSplitResult = await runShell(
      "tmux",
      ["split-window", "-v", "-P", "-F", "#{pane_id}", "-t", rightTopPaneId, "-p", "50", rightBottomCmd],
      { cwd, timeout: 5000 }
    );
    if (bottomSplitResult.failed) {
      bottomSplitResult = await runShell(
        "tmux",
        ["split-window", "-v", "-P", "-F", "#{pane_id}", "-t", rightTopPaneId, rightBottomCmd],
        { cwd, timeout: 5000 }
      );
    }
    if (bottomSplitResult.failed) {
      console.warn(`Failed to split bottom pane: ${bottomSplitResult.stderr || bottomSplitResult.stdout}`);
    }
  }

  // 7. Enable mouse mode so scrolling shows output history, not shell input history
  const mouseResult = await runShell(
    "tmux",
    ["set-option", "-t", session, "mouse", "on"],
    { cwd, timeout: 5000 }
  );
  if (mouseResult.failed) {
    console.warn(`Failed to enable tmux mouse mode: ${mouseResult.stderr || mouseResult.stdout}`);
  }

  // Increase scrollback history so previous code edits remain accessible
  const historyResult = await runShell(
    "tmux",
    ["set-option", "-t", session, "history-limit", "10000"],
    { cwd, timeout: 5000 }
  );
  if (historyResult.failed) {
    console.warn(`Failed to set tmux history limit: ${historyResult.stderr || historyResult.stdout}`);
  }

  // 8. Set a hook so the session is destroyed when the chat pane dies
  const hookResult = await runShell(
    "tmux",
    ["set-hook", "-t", leftPaneId, "pane-died", `if-shell -F '#{==:#{hook_pane},${leftPaneId}}' 'kill-session -t ${session}'`],
    { cwd, timeout: 5000 }
  );
  if (hookResult.failed) {
    const msg = `Failed to set tmux hook: ${hookResult.stderr || hookResult.stdout}`;
    console.warn(msg);
  }

  // 8. Select the left pane
  const selectResult = await runShell(
    "tmux",
    ["select-pane", "-t", leftPaneId],
    { cwd, timeout: 5000 }
  );
  if (selectResult.failed) {
    console.warn(`Failed to select left pane: ${selectResult.stderr || selectResult.stdout}`);
  }

  // 8. Attach to the session (avoid nested-session warning when already inside tmux)
  if (process.env.TMUX) {
    await runShell("tmux", ["switch-client", "-t", session], { cwd, timeout: 0, stdio: "inherit" });
  } else {
    await runShell("tmux", ["attach", "-t", session], { cwd, timeout: 0, stdio: "inherit" });
  }
}

export function buildLeftPaneCommand(options: {
  nodeCmd: string;
  cliCmd: string;
  runId: string;
  brand: string;
  agentFile?: string;
  workers?: string;
  maxStepsPerTurn?: string;
  mcpScope?: string;
  provider?: string;
  model?: string;
  execution?: string;
  ui?: string;
}): string {
  const { nodeCmd, cliCmd, runId, brand, agentFile, workers, maxStepsPerTurn, mcpScope, provider, model, execution, ui } = options;
  let cmd = `${nodeCmd} ${cliCmd} chat --layout plain --run-id ${shellQuote(runId)} --brand ${shellQuote(brand)}`;
  if (agentFile) cmd += ` --agent-file ${shellQuote(agentFile)}`;
  if (workers) cmd += ` --workers ${shellQuote(workers)}`;
  if (maxStepsPerTurn) cmd += ` --max-steps-per-turn ${shellQuote(maxStepsPerTurn)}`;
  if (mcpScope) cmd += ` --mcp-scope ${shellQuote(mcpScope)}`;
  if (provider) cmd += ` --provider ${shellQuote(provider)}`;
  if (model) cmd += ` --model ${shellQuote(model)}`;
  if (execution) cmd += ` --execution ${shellQuote(execution)}`;
  if (ui) cmd += ` --ui ${shellQuote(ui)}`;
  return cmd;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

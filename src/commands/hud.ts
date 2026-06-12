import { getKimiUsage, type UsageStats } from "../kimi/usage.js";
import {
  renderHudDashboard,
  normalizeRefreshMs,
  sleep,
  clearScreen,
  enterAlternateScreen,
  leaveAlternateScreen,
  type HudCommandOptions,
} from "../hud/render.js";
import { readReasoningFrames } from "../util/reasoning-nlp.js";
import { getRunsDir } from "../util/fs.js";
import { readdir } from "fs/promises";
import { join } from "path";

export type {
  HudGitChange,
  HudRunCandidate,
  HudSection,
  HudRenderOptions,
  HudCommandOptions,
} from "../hud/render.js";

export {
  parseGitStatusPorcelain,
  buildHudSidebar,
  renderHudColumns,
  renderHudColumnsWithDetectedWidth,
  renderHudDashboard,
  selectLatestRunName,
  listRunCandidates,
} from "../hud/render.js";

interface HudThinkingEntry {
  agentId: string;
  step: string;
  status: "running" | "done" | "failed";
  timestamp: number;
}

async function loadLatestThinking(limit = 5): Promise<HudThinkingEntry[]> {
  try {
    const runsDir = getRunsDir();
    const entries = await readdir(runsDir, { withFileTypes: true });
    const runDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: join(runsDir, e.name) }))
      .sort((a, b) => b.name.localeCompare(a.name));

    if (runDirs.length === 0) return [];

    const frames = await readReasoningFrames(runDirs[0].path);
    if (frames.length === 0) return [];

    const recent = frames.slice(-limit);
    return recent.map((f, i) => ({
      agentId: f.provider ?? "unknown",
      step: f.text.length > 60 ? f.text.slice(0, 57) + "..." : f.text,
      status: i === recent.length - 1 ? "running" as const : "done" as const,
      timestamp: new Date(f.timestamp).getTime(),
    }));
  } catch {
    return [];
  }
}

export async function hudCommand(options: HudCommandOptions = {}): Promise<void> {
  const refreshMs = normalizeRefreshMs(options.refreshMs);

  if (!options.watch) {
    const thinking = await loadLatestThinking();
    console.log(await renderHudDashboard({ ...options, thinking }));
    return;
  }

  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let cachedUsage: UsageStats | undefined;
  let lastUsageRefreshMs = 0;
  const usageRefreshMs = Math.max(60_000, refreshMs);

  const useAlternateScreen = options.alternateScreen ?? false;
  const shouldClear = !(options.noClear ?? false) && (options.clear ?? true);

  if (useAlternateScreen) {
    enterAlternateScreen();
  }

  try {
    let lastFrame = "";
    while (!stopped) {
      const now = Date.now();
      if (!cachedUsage || now - lastUsageRefreshMs >= usageRefreshMs) {
        cachedUsage = await getKimiUsage();
        lastUsageRefreshMs = now;
      }
      const thinking = await loadLatestThinking();
      const frame = await renderHudDashboard({ ...options, kimiUsage: cachedUsage, footerRefreshMs: refreshMs, thinking });
      if (frame !== lastFrame) {
        lastFrame = frame;
        if (shouldClear) clearScreen();
        process.stdout.write(frame + "\n");
      }
      if (stopped) break;
      await sleep(refreshMs);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (useAlternateScreen) {
      leaveAlternateScreen();
    }
  }
}

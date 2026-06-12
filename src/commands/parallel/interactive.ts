/**
 * Interactive Parallel Orchestration Command
 *
 * 대화형으로 병렬 서브에이전트를 소환하고,
 * 각 에이전트에게 skills, hooks, MCP를 부여하며 총 관리합니다.
 *
 * Usage:
 *   omk parallel:interactive "goal description"
 *   omk parallel:interactive --goal "migrate database to PostgreSQL" --workers 4
 */

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { cpus } from "os";
import { getProjectRoot, getRunPath, sanitizeRunId } from "../../util/fs.js";
import { header, label, status, style } from "../../util/theme.js";
import { getOmkResourceSettings } from "../../util/resource-profile.js";
import {
  createInteractiveOrchestrator,
  formatSubAgentPlan,
  type OrchestratorGoal,
  type SubAgentSpec,
} from "../../orchestration/interactive-orchestrator.js";
import type { ProviderPolicy } from "../../providers/index.js";

export interface InteractiveParallelOptions {
  workers?: string;
  runId?: string;
  timeout?: string;
  autoConfirm?: boolean;
  dryRun?: boolean;
  output?: string;
  provider?: ProviderPolicy;
  model?: string;
  mcpScope?: string;
  signal?: AbortSignal;
}

export async function interactiveParallelCommand(
  goal: string | undefined,
  options: InteractiveParallelOptions = {}
): Promise<{ runId: string; success: boolean }> {
  const root = getProjectRoot();
  const resources = await getOmkResourceSettings();

  if (!goal) {
    throw new Error("Goal is required. Usage: omk parallel:interactive \"your goal\"");
  }

  const runId = sanitizeRunId(
    options.runId ?? new Date().toISOString().replace(/[:.]/g, "-"),
    "interactive"
  );
  const maxWorkers = parseWorkers(options.workers, resources.maxWorkers);
  const timeout = options.timeout ? parseInt(options.timeout, 10) : 600_000;

  // ─── Display Header ────────────────────────────────────────

  console.log(header("Interactive Parallel Orchestration"));
  console.log(label("Run ID", runId));
  console.log(label("Goal", goal));
  console.log(label("Max Workers", String(maxWorkers)));
  console.log(label("Timeout", `${timeout}ms`));
  console.log();

  // ─── Build Goal Spec ───────────────────────────────────────

  const goalSpec: OrchestratorGoal = {
    description: goal,
    maxWorkers,
    timeoutMs: timeout,
    strategy: "parallel",
  };

  // ─── Create Orchestrator ───────────────────────────────────

  const orchestrator = createInteractiveOrchestrator(goalSpec, {
    cwd: root,
    runId,
    autoConfirm: options.autoConfirm ?? false,
    dryRun: options.dryRun ?? false,
    onConfirm: async (agents: readonly SubAgentSpec[]) => {
      // Display plan
      console.log(formatSubAgentPlan(agents));
      console.log();

      if (options.dryRun) {
        console.log(status.ok("Dry run complete — no execution"));
        return false;
      }

      // Auto-confirm if flag set
      if (options.autoConfirm) {
        console.log(status.ok("Auto-confirm enabled — proceeding"));
        return true;
      }

      // Interactive confirmation
      console.log(style.cyan("Execute this plan? [Y/n]"));
      const answer = await readLine();
      return !answer || answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
    },
  });

  // ─── Event Listeners ──────────────────────────────────────

  orchestrator.on("phase", (phase) => {
    const phaseEmoji: Record<string, string> = {
      analyzing: "🔍",
      decomposing: "📦",
      assigning: "🔧",
      confirming: "❓",
      spawning: "🚀",
      running: "⚡",
      merging: "🔗",
      completed: "✅",
      failed: "❌",
    };
    console.log(`\n${phaseEmoji[phase] ?? "📋"} Phase: ${phase}`);
  });

  orchestrator.on("log", (message, level) => {
    if (level === "error") {
      console.error(`  ❌ ${message}`);
    } else if (level === "warn") {
      console.warn(`  ⚠️  ${message}`);
    } else {
      console.log(`  ℹ️  ${message}`);
    }
  });

  orchestrator.on("progress", (state) => {
    const { completed, total, percentage } = state.progress;
    process.stdout.write(
      `\r  📊 Progress: ${completed}/${total} (${percentage.toFixed(1)}%)`
    );
  });

  orchestrator.on("subagent_spawned", (agent) => {
    console.log(`  🟢 Spawned: ${agent.spec.id} (${agent.spec.role})`);
  });

  orchestrator.on("subagent_completed", (agent) => {
    console.log(`  ✅ Completed: ${agent.spec.id}`);
  });

  orchestrator.on("subagent_failed", (agent) => {
    console.log(`  ❌ Failed: ${agent.spec.id} — ${agent.error}`);
  });

  // ─── Execute ──────────────────────────────────────────────

  const runDir = getRunPath(runId);
  await mkdir(runDir, { recursive: true });

  const result = await orchestrator.execute();

  // ─── Save Results ─────────────────────────────────────────

  console.log();
  console.log("─".repeat(60));

  if (result.phase === "completed") {
    console.log(status.ok("Orchestration completed successfully!"));
  } else {
    console.log(status.error(`Orchestration ${result.phase}`));
    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }
  }

  console.log();
  console.log(label("Run ID", result.runId));
  console.log(label("Phase", result.phase));
  console.log(
    label(
      "Progress",
      `${result.progress.completed}/${result.progress.total} (${result.progress.percentage.toFixed(1)}%)`
    )
  );
  console.log(label("Started", result.startedAt));
  if (result.completedAt) {
    console.log(label("Completed", result.completedAt));
  }

  // Sub-agent summary
  console.log();
  console.log("📊 Sub-Agent Summary:");
  for (const agent of result.subAgents) {
    const icon =
      agent.status === "done"
        ? "✅"
        : agent.status === "failed"
        ? "❌"
        : agent.status === "running"
        ? "🔄"
        : "⏳";
    console.log(
      `  ${icon} ${agent.spec.id.padEnd(20)} ${agent.spec.role.padEnd(12)} ${agent.status}`
    );
  }

  // Save state
  await writeFile(
    join(runDir, "state.json"),
    JSON.stringify(result, null, 2)
  );
  await writeFile(
    join(runDir, "goal.md"),
    `# Goal\n\n${goal}\n\n## Sub-Agents\n\n${formatSubAgentPlan(result.subAgents.map((a) => a.spec))}\n`
  );

  if (options.output) {
    await writeFile(options.output, JSON.stringify(result, null, 2));
    console.log(`\n   Output: ${options.output}`);
  }

  return {
    runId: result.runId,
    success: result.phase === "completed",
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

function parseWorkers(workers?: string, maxDefault?: number): number {
  if (!workers || workers === "auto") {
    const cpuCount = cpus().length;
    return Math.min(Math.max(2, cpuCount), maxDefault ?? 8);
  }
  const num = parseInt(workers, 10);
  if (isNaN(num) || num < 1) {
    throw new Error(`Invalid workers value: ${workers}`);
  }
  return Math.min(num, maxDefault ?? 8);
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.once("data", (data) => {
      resolve(data.toString().trim());
    });
  });
}

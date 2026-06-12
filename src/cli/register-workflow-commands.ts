import type { Command } from "commander";
import { t } from "../util/i18n.js";
import { applyExitCode } from "../util/cli-contract.js";

type WorkflowCommandOptions = Record<string, unknown> & {
  runId?: string;
  workers?: string;
  provider?: string;
};

function mergeWorkflowOptions<T extends WorkflowCommandOptions>(program: Command, options: T): T {
  const globalOpts = program.opts() as { runId?: unknown; workers?: unknown; provider?: unknown };
  const merged: T = { ...options };
  if (typeof globalOpts.runId === "string" && !merged.runId) merged.runId = globalOpts.runId;
  if (typeof globalOpts.workers === "string" && globalOpts.workers !== "auto" && (!merged.workers || merged.workers === "auto")) {
    merged.workers = globalOpts.workers;
  }
  if (typeof globalOpts.provider === "string" && globalOpts.provider !== "auto" && (!merged.provider || merged.provider === "auto")) {
    merged.provider = globalOpts.provider;
  }
  return merged;
}

export function registerWorkflowCommands(program: Command): void {
  program
    .command("do <prompt...>")
    .description("Run a natural-language OMK coding task")
    .option("--mode <mode>", "UX mode: plan | guided | act | review | autopilot | safe")
    .option("--provider <provider>", "provider policy (auto | kimi | codex | deepseek | commandcode | opencode | qwen | openrouter)", "auto")
    .option("--model <model>", "provider model or provider/model override")
    .option("--mcp-scope <all|project|none>", "MCP scope for this task (all | project | none)")
    .option("--workers <n>", "Number of workers (integer or 'auto')", "auto")
    .option("--dry-run", "Compile the task plan and artifacts without executing")
    .option("--json", "Print JSON summary")
    .option("--no-watch", "Disable live watch UI")
    .action(async (promptParts: string[], options) => {
      const mergedOptions = mergeWorkflowOptions(program, options);
      const { doCommand } = await import("../commands/do.js");
      const result = await doCommand(promptParts.join(" "), mergedOptions);
      if (!result.success && process.exitCode === undefined) {
        process.exitCode = 1;
      }
    });

  program
    .command("why")
    .description("Explain why the latest or selected OMK run is stuck")
    .option("--run-id <id>", "Run id to explain")
    .option("--json", "Print JSON loop decision")
    .action(async (options) => {
      const globalOpts = program.opts();
      const { whyCommand } = await import("../commands/why.js");
      await whyCommand({
        ...options,
        runId: options.runId ?? globalOpts.runId,
      });
    });

  program
    .command("plan <goal>")
    .description(t("cmd.planDesc"))
    .option("--thinking <mode>", "thinking mode", "enabled")
    .option("--spec-kit", t("cmd.featureSpecKitOption"))
    .option("--no-spec-kit", t("cmd.featureNoSpecKitOption"))
    .action(async (goal, options) => {
      const globalOpts = program.opts();
      const { planCommand } = await import("../commands/plan.js");
      await planCommand(goal, { ...options, runId: globalOpts.runId });
    });

  program
    .command("feature <goal>")
    .description(t("cmd.featureDesc"))
    .option("--spec-kit", t("cmd.featureSpecKitOption"))
    .option("--no-spec-kit", t("cmd.featureNoSpecKitOption"))
    .action(async (goal, options) => {
      const globalOpts = program.opts();
      const { featureCommand } = await import("../commands/workflow.js");
      await featureCommand(goal, { ...options, runId: globalOpts.runId });
    });

  program
    .command("bugfix <goal>")
    .description(t("cmd.bugfixDesc"))
    .option("--spec-kit", t("cmd.bugfixSpecKitOption"))
    .option("--no-spec-kit", t("cmd.bugfixNoSpecKitOption"))
    .action(async (goal, options) => {
      const globalOpts = program.opts();
      const { bugfixCommand } = await import("../commands/workflow.js");
      await bugfixCommand(goal, { ...options, runId: globalOpts.runId });
    });

  program
    .command("refactor <goal>")
    .description(t("cmd.refactorDesc"))
    .option("--spec-kit", t("cmd.refactorSpecKitOption"))
    .option("--no-spec-kit", t("cmd.refactorNoSpecKitOption"))
    .action(async (goal, options) => {
      const globalOpts = program.opts();
      const { refactorCommand } = await import("../commands/workflow.js");
      await refactorCommand(goal, { ...options, runId: globalOpts.runId });
    });

  program
    .command("review")
    .description(t("cmd.reviewDesc"))
    .option("--ci", t("cmd.reviewCiOption"))
    .option("--soft", t("cmd.reviewSoftOption"))
    .action(async (options) => {
      const globalOpts = program.opts();
      const { reviewCommand } = await import("../commands/workflow.js");
      const result = await reviewCommand({ ...options, runId: globalOpts.runId });
      applyExitCode(result);
    });

  program
    .command("run [flow] [goal]")
    .description(t("cmd.runDesc"))
    .option("--workers <n>", t("cmd.runWorkersOption"), "auto")
    .option("--mcp-scope <all|project|none>", "MCP scope for this orchestration run (all | project | none)")
    .option("--execution <ask|auto|parallel|sequential>", "Execution selection policy (ask | auto | parallel | sequential)")
    .option("--timeout-preset <preset>", t("cmd.runTimeoutPresetOption"))
    .option("--provider <provider>", "provider policy (auto | kimi | deepseek | codex | qwen)", "auto")
    .option("--model <model>", "provider model or provider/model override")
    .action(async (flow, goal, options) => {
      const mergedOptions = mergeWorkflowOptions(program, options);
      const { runCommand } = await import("../commands/run.js");
      await runCommand(flow, goal, mergedOptions);
    });

  program
    .command("team")
    .description(t("cmd.teamDesc"))
    .option("--workers <n>", t("cmd.teamWorkersOption"), "auto")
    .action(async (options) => {
      const mergedOptions = mergeWorkflowOptions(program, options);
      const { teamCommand } = await import("../commands/team.js");
      await teamCommand(mergedOptions);
    });

  program
    .command("parallel [goal]")
    .description(t("cmd.parallelDesc"))
    .option("--workers <n>", t("cmd.parallelWorkersOption"), "auto")
    .option("--mcp-scope <all|project|none>", "MCP scope for this parallel DAG run (all | project | none)")
    .option("--execution <ask|auto|parallel|sequential>", "Execution selection policy (ask | auto | parallel | sequential)")
    .option("--timeout-preset <preset>", t("cmd.parallelTimeoutPresetOption"))
    .option("--provider <provider>", "provider policy (auto | kimi | deepseek | codex | qwen)", "auto")
    .option("--model <model>", "provider model or provider/model override")
    .option("--approval-policy <policy>", t("cmd.parallelApprovalOption"), "interactive")
    .option("--watch", t("cmd.parallelWatchOption"))
    .option("--no-watch", t("cmd.parallelNoWatchOption"))
    .option("--view <mode>", "Display mode: cockpit | table | compact", "cockpit")
    .option("--alternate-screen", "Enter alternate screen buffer for full-screen UI")
    .option("--no-pause", "Do not wait for Enter at the end")
    .option("--compact", "Use compact single-line renderer")
    .option("--chat", t("cmd.parallelChatOption"))
    .option("--from-spec <dir>", "Run spec-kit tasks.md as a parallel DAG")
    .action(async (goal, options) => {
      const mergedOptions = mergeWorkflowOptions(program, options);
      const { parallelCommand } = await import("../commands/parallel.js");
      const result = await parallelCommand(goal, {
        ...mergedOptions,
        watch: mergedOptions.watch,
        noWatch: mergedOptions.watch === false,
        view: mergedOptions.view,
        alternateScreen: mergedOptions.alternateScreen,
        noPause: mergedOptions.pause === false,
        compact: mergedOptions.compact,
      });
      if (!result.success && process.exitCode === undefined) {
        process.exitCode = 1;
      }
    });

  program
    .command("orchestrate <goal>")
    .description("🎯 Parallel agent orchestration with skill/MCP/hook assignment")
    .option("--workers <n>", "Number of parallel workers (integer or 'auto')", "auto")
    .option("--timeout <ms>", "Global timeout in milliseconds", "600000")
    .option("--dry-run", "Show execution plan without running")
    .option("--output <file>", "Save result JSON to file")
    .action(async (goal, options) => {
      const mergedOptions = mergeWorkflowOptions(program, options);
      const { orchestrateCommand } = await import("../commands/orchestrate.js");
      const result = await orchestrateCommand(goal, mergedOptions);
      
      if (result && !result.success && process.exitCode === undefined) {
        process.exitCode = 1;
      }
    });

  program
    .command("parallel:interactive [goal]")
    .description("🔄 Interactive parallel sub-agent orchestration with skills/hooks/MCP assignment")
    .option("--workers <n>", "Max parallel workers", "auto")
    .option("--timeout <ms>", "Global timeout in milliseconds", "600000")
    .option("--auto-confirm", "Skip confirmation prompt")
    .option("--dry-run", "Show plan without executing")
    .option("--output <file>", "Save result JSON to file")
    .option("--provider <provider>", "Provider policy", "auto")
    .option("--model <model>", "Provider model override")
    .action(async (goal, options) => {
      const mergedOptions = mergeWorkflowOptions(program, options);
      const { interactiveParallelCommand } = await import("../commands/parallel/interactive.js");
      const result = await interactiveParallelCommand(goal, {
        ...mergedOptions,
        signal: AbortSignal.timeout(parseInt(String(mergedOptions.timeout), 10) || 600_000),
      });
      if (!result.success && process.exitCode === undefined) {
        process.exitCode = 1;
      }
    });
}

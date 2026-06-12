import type { Command } from "commander";
import { t } from "../../util/i18n.js";

export function registerSessionCommands(program: Command): void {
  program
    .command("runs")
    .description(t("cmd.runsDesc"))
    .option("-n, --limit <n>", t("cmd.runsLimitOption"), "20")
    .option("-w, --watch", t("cmd.runsWatchOption"))
    .option("--refresh <ms>", t("cmd.runsRefreshOption"), "3000")
    .option("--status <status>", t("cmd.runsStatusOption"))
    .option("--search <keyword>", t("cmd.runsSearchOption"))
    .option("--since <iso-date>", t("cmd.runsSinceOption"))
    .option("--until <iso-date>", t("cmd.runsUntilOption"))
    .option("--stats", "Show aggregate statistics instead of list")
    .option("--insights", "Show parallel-computed insights (longest, most complex, failure hotspots, activity)")
    .option("--export <path>", t("cmd.runsExportOption"))
    .option("--json", "Output as JSON")
    .action(async (options) => {
      const { runsCommand } = await import("../../commands/runs.js");
      await runsCommand({
        limit: Number.parseInt(options.limit, 10),
        watch: Boolean(options.watch),
        refreshMs: Number.parseInt(options.refresh, 10),
        json: Boolean(options.json),
        statusFilter: options.status,
        searchKeyword: options.search,
        sinceMs: options.since ? Date.parse(options.since) : undefined,
        untilMs: options.until ? Date.parse(options.until) : undefined,
        stats: Boolean(options.stats),
        exportPath: options.export,
        insights: Boolean(options.insights),
      });
    });

  program
    .command("history")
    .description(t("cmd.historyDesc"))
    .option("-n, --limit <n>", t("cmd.runsLimitOption"), "20")
    .option("-w, --watch", t("cmd.runsWatchOption"))
    .option("--refresh <ms>", t("cmd.runsRefreshOption"), "3000")
    .option("--status <status>", t("cmd.runsStatusOption"))
    .option("--search <keyword>", t("cmd.runsSearchOption"))
    .option("--since <iso-date>", t("cmd.runsSinceOption"))
    .option("--until <iso-date>", t("cmd.runsUntilOption"))
    .option("--stats", "Show aggregate statistics instead of list")
    .option("--insights", "Show parallel-computed insights (longest, most complex, failure hotspots, activity)")
    .option("--export <path>", t("cmd.runsExportOption"))
    .option("--json", "Output as JSON")
    .action(async (options) => {
      const { runsCommand } = await import("../../commands/runs.js");
      await runsCommand({
        limit: Number.parseInt(options.limit, 10),
        watch: Boolean(options.watch),
        refreshMs: Number.parseInt(options.refresh, 10),
        json: Boolean(options.json),
        statusFilter: options.status,
        searchKeyword: options.search,
        sinceMs: options.since ? Date.parse(options.since) : undefined,
        untilMs: options.until ? Date.parse(options.until) : undefined,
        stats: Boolean(options.stats),
        exportPath: options.export,
        insights: Boolean(options.insights),
      });
    });

  program
    .command("chat")
    .description(t("cmd.chatDesc"))
    .option("--agent-file <path>", t("cmd.chatAgentOption"))
    .option("--workers <n>", t("cmd.chatWorkersOption"), "auto")
    .option("--mcp-scope <all|project|none>", "MCP scope for this chat session (all | project | none)")
    .option("--execution <ask|auto|parallel|sequential>", "Execution selection policy (ask | auto | parallel | sequential)")
    .option("--provider <provider>", "provider policy (auto | kimi | deepseek | codex | qwen)", "auto")
    .option("--model <model>", "provider model or provider/model override")
    .option("--cwd <path>", "Working directory seed for chat root resolution (defaults to current shell cwd)")
    .option("--project-root <path>", "Force the OMK project root for this chat session")
    .option("--max-steps-per-turn <n>", t("cmd.chatMaxStepsOption"))
    .option("--layout <auto|tmux|inline|plain>", t("cmd.chatLayoutOption"), "auto")
        .option("--ui <legacy|plain-modern|rich|system24|green-rain|neon-grid>", "Single-pane chat renderer (legacy | plain-modern | rich | system24 | green-rain | neon-grid)")
    .option("--brand <omk|minimal|plain|green-rain|neon-grid>", t("cmd.chatBrandOption"), "minimal")
    .option("--mode <agent|plan|chat|debugging|review>", "OMK execution mode")
    .option("--smoke", "Run chat startup preflight and runtime MCP merge checks without launching the agent")
    .option("--show-think <off|summary|debug>", "Thinking visibility mode (off | summary | debug)", "off")
    .option("--reasoning-nlp", "Enable reasoning NLP normalization")
    .option("--reasoning-summary <auto|concise|detailed>", "OpenAI reasoning summary mode (auto | concise | detailed)", "auto")
    .option("--json", "With --smoke, output machine-readable JSON")
    .action(async (options) => {
      const globalOpts = program.opts();
      const { chatCommand } = await import("../../commands/chat.js");
      await chatCommand({ ...options, runId: globalOpts.runId, showThink: options.showThink, reasoningNlp: Boolean(options.reasoningNlp), reasoningSummary: options.reasoningSummary });
    });

  program
    .command("research <query>")
    .description("Run a web research query via native SearchWeb/FetchURL")
    .option("--agent-file <path>", "Custom researcher agent YAML")
    .action(async (query, options) => {
      const { researchCommand } = await import("../../commands/research.js");
      await researchCommand({ query, agentFile: options.agentFile });
    });

  program
    .command("replay <run-id>")
    .description("Replay a previous run by restoring its manifest, context capsules, and decision traces")
    .option("--json", "Output raw ReplayManifest as JSON")
    .option("--context", "Show restored context capsules")
    .option("--evidence", "Show evidence gate results")
    .option("--decisions", "Show all decision traces")
    .option("--repair", "Show repair policy decisions")
    .action(async (runId, options) => {
      const { replayCommand } = await import("../../commands/replay.js");
      await replayCommand(runId, {
        json: Boolean(options.json),
        context: Boolean(options.context),
        evidence: Boolean(options.evidence),
        decisions: Boolean(options.decisions),
        repair: Boolean(options.repair),
      });
    });

  program
    .command("inspect <run-id>")
    .description("Inspect a run, node, or attempt with full decision trace and forensic details")
    .option("--node <node-id>", "Inspect a specific node")
    .option("--attempt <attempt-id>", "Inspect a specific attempt")
    .option("--context", "Deep-dive into context capsules")
    .option("--evidence", "Show evidence gate results")
    .option("--decisions", "Show all decision traces")
    .option("--repair", "Show repair policy decisions")
    .option("--json", "Output as JSON")
    .action(async (runId, options) => {
      const { inspectCommand } = await import("../../commands/inspect.js");
      await inspectCommand(runId, {
        node: options.node,
        attempt: options.attempt,
        json: Boolean(options.json),
        context: Boolean(options.context),
        evidence: Boolean(options.evidence),
        decisions: Boolean(options.decisions),
        repair: Boolean(options.repair),
      });
    });
}

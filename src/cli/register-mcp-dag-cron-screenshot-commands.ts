import type { Command } from "commander";
import { t } from "../util/i18n.js";

export function registerMcpDagCronScreenshotCommands(program: Command): void {
  const mcp = program.command("mcp").description(t("cli.mcpDesc"));
  mcp
    .command("list")
    .description(t("cmd.mcpListDesc"))
    .action(async () => {
      const { mcpListCommand } = await import("../commands/mcp.js");
      await mcpListCommand();
    });
  mcp
    .command("connect")
    .description("Show the MCP Tool Plane and optionally preflight or repair active servers")
    .option("--json", "Output JSON")
    .option("--fix", "Apply safe project-local MCP repairs before reporting")
    .option("--all", "Run full MCP preflight for active servers")
    .action(async (options) => {
      const { mcpConnectCommand } = await import("../mcp/autoconnect.js");
      await mcpConnectCommand(options);
    });
  mcp
    .command("doctor")
    .description(t("cmd.mcpDoctorDesc"))
    .option("--json", "Output JSON")
    .option("--fix", "Apply safe project-local MCP repairs before reporting")
    .option("--dry-run", "Preview MCP doctor fixes without writing configs")
    .option("--global", "Allow MCP doctor fixes to mutate ~/.kimi/mcp.json")
    .action(async (options) => {
      const { mcpDoctorCommand } = await import("../commands/mcp.js");
      await mcpDoctorCommand(options);
    });
  mcp
    .command("test <server>")
    .description(t("cmd.mcpTestDesc"))
    .action(async (server) => {
      const { mcpTestCommand } = await import("../commands/mcp.js");
      await mcpTestCommand(server);
    });
  mcp
    .command("prewarm [server]")
    .description("Compatibility alias for MCP startup/preflight checks")
    .option("--all", "Check all active MCP servers")
    .action(async (server, options) => {
      const { mcpPrewarmCommand } = await import("../commands/mcp.js");
      if (!server && !options.all) {
        console.error("Provide a server name or use --all");
        process.exitCode = 1;
        return;
      }
      await mcpPrewarmCommand(server, { all: Boolean(options.all) });
    });
  mcp
    .command("check [server]")
    .description("Run MCP startup/preflight checks without launching chat")
    .option("--all", "Check all active MCP servers")
    .action(async (server, options) => {
      const { mcpPrewarmCommand } = await import("../commands/mcp.js");
      if (!server && !options.all) {
        console.error("Provide a server name or use --all");
        process.exitCode = 1;
        return;
      }
      await mcpPrewarmCommand(server, { all: Boolean(options.all), label: "check" });
    });
  mcp
    .command("serve <server>")
    .description("Run a bundled MCP server over stdio")
    .action(async (server: string) => {
      switch (server) {
        case "omk-project":
          await import("../mcp/omk-project-server.js");
          break;
        case "omk-acp":
          await import("../mcp/acp-server.js");
          break;
        case "omk-mcp-host":
          await import("../mcp/host.js");
          break;
        case "filesystem-readonly":
          await import("../mcp/filesystem-readonly-server.js");
          break;
        case "omk-web-bridge":
          await import("../mcp/omk-web-bridge-server.js");
          break;
        default:
          console.error(`Unknown bundled MCP server: ${server}`);
          process.exitCode = 1;
      }
    });
  mcp
    .command("remove <server>")
    .description("Remove an MCP server from project-local .kimi/mcp.json or .omk/mcp.json")
    .option("-g, --global", "Remove from global ~/.kimi/mcp.json instead of project-local")
    .action(async (server, options) => {
      const { mcpRemoveCommand } = await import("../commands/mcp.js");
      await mcpRemoveCommand(server, { global: Boolean(options.global) });
    });
  mcp
    .command("add <server>")
    .description("Copy an MCP server from global ~/.kimi/mcp.json into project .kimi/mcp.json")
    .action(async (server) => {
      const { mcpAddCommand } = await import("../commands/mcp.js");
      await mcpAddCommand(server);
    });
  mcp
    .command("install <name> [args...]")
    .description("Install a new MCP server into project .kimi/mcp.json")
    .option("-e, --env <pair>", "Environment variable (KEY=VALUE)", (val: string, prev: string[]) => [...prev, val], [])
    .action(async (name, args, options) => {
      const { mcpInstallCommand } = await import("../commands/mcp.js");
      await mcpInstallCommand(name, args[0] ?? name, args.slice(1), { env: options.env });
    });
  mcp
    .command("import-codex")
    .description("Secret-safe import of Codex CLI MCP servers into project .kimi/mcp.json")
    .option("--dry-run", "Preview the import without writing")
    .option("--project", "Write to project-local .kimi/mcp.json (default)")
    .option("--config <path>", "Codex config.toml path")
    .option("--home-dir <path>", "Codex home directory containing .codex/config.toml")
    .option("--openai-docs", "Also add the read-only OpenAI Developer Docs MCP remote")
    .option("--overwrite", "Overwrite existing project MCP definitions with imported definitions")
    .option("--json", "Output JSON")
    .action(async (options) => {
      const { mcpImportCodexCommand } = await import("../commands/codex.js");
      await mcpImportCodexCommand(options);
    });
  mcp
    .command("sync-global")
    .description("Import global MCP servers into project-local config")
    .option("--overwrite", "Overwrite existing local definitions with global ones")
    .option("--omk", "Write to .omk/mcp.json instead of .kimi/mcp.json")
    .action(async (options) => {
      const { mcpSyncGlobalCommand } = await import("../commands/mcp.js");
      await mcpSyncGlobalCommand(options);
    });
  mcp
    .command("migrate")
    .description("Auto-fix known stale/renamed MCP server package names in config files")
    .option("-g, --global", "Migrate global ~/.kimi/mcp.json instead of project-local configs")
    .option("--dry-run", "Show what would be changed without writing")
    .action(async (options) => {
      const { mcpMigrateCommand } = await import("../commands/mcp.js");
      await mcpMigrateCommand({ global: Boolean(options.global), dryRun: Boolean(options.dryRun) });
    });

  const dag = program.command("dag").description(t("cli.dagDesc"));
  dag
    .command("from-spec [spec-dir]")
    .description("Convert spec-kit tasks.md to OMK DAG JSON")
    .option("-o, --output <path>", "Output JSON file path")
    .option("-p, --parallel", "Enable intra-phase parallelism")
    .option("-r, --run <id>", "Use spec from run ID (latest)")
    .action(async (specDir, options) => {
      const { dagFromSpecCommand } = await import("../commands/dag-from-spec.js");
      const root = (await import("../util/fs.js")).getProjectRoot();
      const dir = specDir ?? `${root}/specs`;
      await dagFromSpecCommand(dir, {
        output: options.output,
        parallel: Boolean(options.parallel),
        run: options.run,
      });
    });
  dag
    .command("validate [file]")
    .description(t("cmd.dagValidateDesc"))
    .action(async (filePath) => {
      const { dagValidateCommand } = await import("../commands/dag.js");
      try {
        await dagValidateCommand(filePath);
      } catch {
        process.exit(1);
      }
    });
  dag
    .command("show <run-id>")
    .description(t("cmd.dagShowDesc"))
    .action(async (runId) => {
      const { dagShowCommand } = await import("../commands/dag.js");
      await dagShowCommand(runId);
    });
  dag
    .command("replay <run-id> [target] [subtarget]")
    .description(t("cmd.dagReplayDesc"))
    .option("--node <id>", t("cmd.dagReplayNodeOption"))
    .option("--from-failure", t("cmd.dagReplayFromFailureOption"))
    .option("--dry-run", t("cmd.dagReplayDryRunOption"))
    .option("--provider <provider>", "provider policy (auto | kimi | deepseek | codex | qwen)", "auto")
    .option("--model <model>", "provider model or provider/model override")
    .action(async (runId, target, subtarget, options) => {
      const { dagReplayCommand } = await import("../commands/dag.js");
      await dagReplayCommand(runId, target, subtarget, options);
    });

  const cron = program.command("cron").description("Manage scheduled cron jobs");
  cron
    .command("list")
    .description("List all configured cron jobs")
    .action(async () => {
      const { cronListCommand } = await import("../commands/cron.js");
      await cronListCommand();
    });
  cron
    .command("run <job-name>")
    .description("Run a cron job immediately")
    .option("--dag-file <path>", "DAG file path for ad-hoc runs")
    .action(async (jobName, options) => {
      const { cronRunCommand } = await import("../commands/cron.js");
      await cronRunCommand(jobName, options);
    });
  cron
    .command("logs <job-name>")
    .description("Show recent runs for a cron job")
    .action(async (jobName) => {
      const { cronLogsCommand } = await import("../commands/cron.js");
      await cronLogsCommand(jobName);
    });
  cron
    .command("enable <job-name>")
    .description("Enable a cron job")
    .action(async (jobName) => {
      const { cronEnableCommand } = await import("../commands/cron.js");
      await cronEnableCommand(jobName);
    });
  cron
    .command("disable <job-name>")
    .description("Disable a cron job")
    .action(async (jobName) => {
      const { cronDisableCommand } = await import("../commands/cron.js");
      await cronDisableCommand(jobName);
    });

  const screenshot = program.command("screenshot").description("Manage project screenshots from clipboard");
  screenshot
    .command("paste")
    .description("Paste clipboard image into .omk/screenshots/ (supports Windows Capture Ctrl+C under WSL)")
    .option("--json", "Output JSON")
    .action(async (options) => {
      const { screenshotPasteCommand } = await import("../commands/screenshot.js");
      await screenshotPasteCommand(options);
    });
  screenshot
    .command("dir")
    .description("Print the screenshot directory path")
    .option("--json", "Output JSON")
    .action(async (options) => {
      const { screenshotDirCommand } = await import("../commands/screenshot.js");
      await screenshotDirCommand(options);
    });
  screenshot
    .command("list")
    .description("List saved screenshots")
    .option("--json", "Output JSON")
    .action(async (options) => {
      const { screenshotListCommand } = await import("../commands/screenshot.js");
      await screenshotListCommand(options);
    });
  screenshot
    .command("clean")
    .description("Remove screenshots older than N days")
    .option("--days <n>", "Age threshold in days", "7")
    .option("--dry-run", "Show what would be deleted without removing")
    .option("--json", "Output JSON")
    .action(async (options) => {
      const { screenshotCleanCommand } = await import("../commands/screenshot.js");
      await screenshotCleanCommand(options);
    });
}

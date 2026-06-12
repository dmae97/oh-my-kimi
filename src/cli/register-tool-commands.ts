import type { Command } from "commander";
import { t } from "../util/i18n.js";

export function registerToolCommands(program: Command): void {
  program.command("auth [provider]")
    .description("Show provider authentication, runtime, model, and setup status")
    .option("--json", "Output JSON")
    .option("--doctor", "Run provider doctor-style status checks")
    .option("--setup", "Show setup commands")
    .option("--soft", "Do not fail when the selected provider is unavailable")
    .action(async (provider, options) => {
      const { authCommand } = await import("../commands/auth.js");
      await authCommand(provider, options);
    });

  const graph = program.command("graph").description("Inspect OMK ontology graph");
  graph
    .command("view")
    .description("Generate an HTML view for .omk/memory/graph-state.json")
    .option("--input <path>", "Input graph-state.json path")
    .option("--output <path>", "Output HTML path")
    .option("--limit <n>", "Maximum visible nodes", "900")
    .option("--type <types>", "Comma-separated node types, e.g. Memory,Decision,Task,Risk,File")
    .option("--include-memory-versions", "Include MemoryVersion nodes")
    .option("--open", "Open generated HTML in browser")
    .action(async (options) => {
      const { graphViewCommand } = await import("../commands/graph.js");
      await graphViewCommand(options);
    });

  program
    .command("hud")
    .description(t("cmd.hudDesc"))
    .option("-w, --watch", t("cmd.hudWatchOption"))
    .option("--refresh <ms>", t("cmd.hudRefreshOption"), "2000")
    .option("--compact", "show compact dashboard")
    .option("--section <section>", "show only one section (run|project|resources)")
    .option("--no-clear", "do not clear screen between refreshes")
    .option("--alternate-screen", "use alternate screen buffer")
    .action(async (options) => {
      const globalOpts = program.opts();
      const { hudCommand } = await import("../commands/hud.js");

      const validSections = ["run", "project", "resources"];
      if (options.section && !validSections.includes(options.section)) {
        console.error(`Invalid section: ${options.section}. Valid values: ${validSections.join(", ")}`);
        process.exit(1);
      }

      await hudCommand({
        runId: globalOpts.runId,
        watch: Boolean(options.watch),
        refreshMs: Number.parseInt(options.refresh, 10),
        compact: options.compact,
        section: options.section,
        noClear: options.noClear,
        alternateScreen: options.alternateScreen,
      });
    });

  program
    .command("merge [run-id]")
    .description(t("cmd.mergeDesc"))
    .option("--run <id>", "run ID", "latest")
    .option("--strategy <strategy>", "merge strategy (first | best)", "first")
    .option("--dry-run", "preview merge without applying")
    .action(async (runIdArg, options) => {
      const globalOpts = program.opts();
      const { mergeCommand } = await import("../commands/merge.js");
      await mergeCommand({ ...options, runId: globalOpts.runId, run: runIdArg ?? options.run });
    });

  program
    .command("sync")
    .description(t("cmd.syncDesc"))
    .option("--global", t("cmd.syncGlobalOption"))
    .option("--dry-run", t("cmd.syncDryRunOption"))
    .option("--diff", t("cmd.syncDiffOption"))
    .option("--rollback", t("cmd.syncRollbackOption"))
    .action(async (options) => {
      const { syncCommand } = await import("../commands/sync.js");
      await syncCommand(options);
    });

  program
    .command("lsp [server]")
    .description(t("cmd.lspDesc"))
    .option("--print-config", t("cmd.lspPrintConfigOption"))
    .option("--check", t("cmd.lspCheckOption"))
    .action(async (server, options) => {
      const { lspCommand } = await import("../commands/lsp.js");
      await lspCommand(server, options);
    });

  const design = program.command("design").description(t("cmd.designDesc"));
  design
    .command("init")
    .description(t("cmd.designInitDesc"))
    .action(async () => {
      const { designInitCommand } = await import("../commands/design.js");
      await designInitCommand();
    });
  design
    .command("list")
    .description(t("cmd.designListDesc"))
    .action(async () => {
      const { designListCommand } = await import("../commands/design.js");
      await designListCommand();
    });
  design
    .command("apply <name>")
    .description(t("cmd.designDownloadDesc"))
    .action(async (name) => {
      const { designApplyCommand } = await import("../commands/design.js");
      await designApplyCommand(name);
    });
  design
    .command("search <keyword>")
    .description(t("cmd.designSearchDesc"))
    .action(async (keyword) => {
      const { designSearchCommand } = await import("../commands/design.js");
      await designSearchCommand(keyword);
    });
  design
    .command("open-design")
    .alias("od")
    .description(t("cmd.designOpenDesignDesc"))
    .option("--dir <path>", "Open Design checkout directory (default: .omk/open-design)")
    .option("--branch <branch>", "Open Design git branch or tag", "main")
    .option("--ref <ref>", "Open Design git ref/branch/tag/SHA (or OMK_OPEN_DESIGN_REF)")
    .option("--daemon-port <port>", "Open Design daemon localhost port", "7457")
    .option("--web-port <port>", "Open Design web localhost port", "5175")
    .option("--doctor", "Check Open Design bridge readiness without cloning, installing, or starting")
    .option("--foreground", "Run tools-dev in the foreground")
    .option("--no-install", "Skip pnpm install")
    .option("--update", "Run git pull --ff-only when the checkout already exists")
    .option("--open", "Open the localhost URL in the default browser")
    .option("--print-only", "Print the launch plan without cloning, installing, or starting")
    .option("--json", "With --doctor, output machine-readable JSON")
    .action(async (options) => {
      const { designOpenDesignCommand } = await import("../commands/design.js");
      await designOpenDesignCommand(options);
    });
  design
    .command("lint [file]")
    .description(t("cmd.designValidateDesc"))
    .action(async (file) => {
      const { designLintCommand } = await import("../commands/design.js");
      await designLintCommand(file);
    });
  design
    .command("diff [from] [to]")
    .description("DESIGN.md diff")
    .action(async (from, to) => {
      const { designDiffCommand } = await import("../commands/design.js");
      await designDiffCommand(from, to);
    });
  design
    .command("export <format> [file]")
    .description(t("cmd.designExportDesc"))
    .action(async (format, file) => {
      const { designExportCommand } = await import("../commands/design.js");
      await designExportCommand(format, file);
    });

  const google = program.command("google").description(t("cmd.googleDesc"));
  google
    .command("stitch-install")
    .description(t("cmd.googleSkillsDesc"))
    .action(async () => {
      const { stitchInstallCommand } = await import("../commands/google.js");
      await stitchInstallCommand();
    });

  const snip = program.command("snip").description("Manage reusable code snippets");
  snip
    .command("save <name>")
    .description("Save a snippet from stdin or file")
    .option("-f, --file <path>", "Read snippet content from file")
    .option("-t, --tags <tags>", "Comma-separated tags")
    .action(async (name, options) => {
      const { snipSaveCommand } = await import("../commands/snip.js");
      await snipSaveCommand(name, options);
    });
  snip
    .command("get <name>")
    .description("Print a snippet")
    .action(async (name) => {
      const { snipGetCommand } = await import("../commands/snip.js");
      await snipGetCommand(name);
    });
  snip
    .command("list")
    .description("List all snippets")
    .action(async () => {
      const { snipListCommand } = await import("../commands/snip.js");
      await snipListCommand();
    });
  snip
    .command("search <query>")
    .description("Search snippets")
    .action(async (query) => {
      const { snipSearchCommand } = await import("../commands/snip.js");
      await snipSearchCommand(query);
    });
  snip
    .command("delete <name>")
    .description("Delete a snippet")
    .action(async (name) => {
      const { snipDeleteCommand } = await import("../commands/snip.js");
      await snipDeleteCommand(name);
    });
}

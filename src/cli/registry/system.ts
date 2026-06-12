import type { Command } from "commander";
import { style } from "../../util/theme.js";
import { t } from "../../util/i18n.js";

export function registerSystemCommands(program: Command): void {
  program
    .command("update")
    .description("Check or run OMK package and optional provider adapter updates")
    .argument("[action]", "check (default) | omk | kimi-adapter")
    .option("--json", "Output update status as JSON")
    .option("--refresh", "Force refresh update cache")
    .option("--yes", "Skip confirmation prompt")
    .option("--install-script", "Print official primary CLI install script (no execution)")
    .action(async (action, options) => {
      const { checkUpdates, OMK_NPM_PACKAGE_NAME } = await import("../../util/update-check.js");
      const actionMode = action ?? "check";
      if (actionMode === "check") {
        const status = await checkUpdates(Boolean(options.refresh));
        if (options.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }
        console.log(`  omk: ${status.omk.current} ${status.omk.outdated ? `→ ${style.orange(status.omk.latest ?? "?")}` : style.gray("(latest)")}`);
        if (status.omk.outdated) console.log(`  ℹ️  ${style.gray(status.omk.installCmd)}`);
        if (status.omk.error) console.log(style.gray(`  omk error: ${status.omk.error}`));
        console.log(style.gray("  kimi-api: uses direct Moonshot HTTP API (no CLI dependency)"));
        if (status.cacheHit) console.log(style.gray(`
    (cached, checked ${status.checkedAt})`));
        console.log("");
        return;
      }

        // install-script handled inside actionMode === "kimi" block

      const isKimiAdapterAction = actionMode === "kimi-adapter" || actionMode === "kimi";
      const isInstallScript = isKimiAdapterAction && options.installScript;
      if (!process.stdout.isTTY && !options.yes && !isInstallScript) {
        console.error("Interactive update requires a TTY. Use --yes to skip confirmation.");
        process.exit(1);
      }
      if (actionMode === "omk") {
        if (!options.yes) {
          console.log(`Upgrade omk via: npm i -g ${OMK_NPM_PACKAGE_NAME}`);
          console.log("Press Enter to continue or Ctrl+C to cancel...");
          const rl = (await import("readline")).createInterface({ input: process.stdin, output: process.stdout });
          await new Promise<void>((resolve) => rl.question("", () => { rl.close(); resolve(); }));
        }
        const { runShell } = await import("../../util/shell.js");
        const result = await runShell("npm", ["i", "-g", OMK_NPM_PACKAGE_NAME], { stdio: "inherit", timeout: 120_000 });
        process.exit(result.failed ? (result.exitCode ?? 1) : 0);
      }
      if (isKimiAdapterAction) {
        console.log("kimi-api uses direct Moonshot HTTP API — no CLI dependency.");
        console.log("To update the Moonshot API key, edit ~/.kimi/config.toml [providers.kimi] api_key.");
        return;
      }
      console.error(`Unknown update action: ${actionMode}`);
      process.exit(1);
    });

  program
    .command("init")
    .description(t("cmd.initDesc"))
    .option("--profile <profile>", t("cmd.initProfileOption"), "fullstack")
    .option("--no-interactive-setup", t("cmd.initNoInteractiveSetupOption"))
    .option("--local-user", "Use global ~/.kimi MCP/skills at runtime without copying personal files into the project")
    .option("--home-dir <path>", "Trusted local home, ~/.kimi/mcp.json, or ~/.kimi/skills path")
    .option("--import-user-skills", "Import personal/global skills into this project (trusted local use only)")
    .action(async (options) => {
      const { initCommand } = await import("../../commands/init.js");
      await initCommand(options);
    });

  program
    .command("doctor")
    .description(t("cmd.doctorDesc"))
    .option("--json", t("cmd.doctorJsonOption"))
    .option("--soft", "Soft mode: do not fail on missing tools")
    .option("--fix", "Apply safe local repairs before reporting")
    .option("--global", "With --fix, also attempt explicit global CLI/git repairs")
    .option("--dry-run", "Preview doctor fixes without writing")
    .option("--fix-level <level>", "Doctor fix safety level: safe | recommended | aggressive", "safe")
    .option("--verify-fix", "Run doctor checks again after applying fixes", true)
    .option("--no-verify-fix", "Skip post-fix doctor verification")
    .option("--set-default-project-root <path>", "With --fix, set user default_project_root for HOME shell launches")
    .action(async (options) => {
      const { doctorCommand } = await import("../../commands/doctor.js");
      await doctorCommand(options);
    });
}

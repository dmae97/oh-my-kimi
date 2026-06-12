import { readdir } from "fs/promises";
import { join } from "path";
import { runShell } from "../../../../util/shell.js";
import { style } from "../../../../util/theme.js";
import { okSlashResult } from "../result.js";
import type { SlashCommandSpec } from "../types.js";

export function buildDiagnosticsSlashCommands(): SlashCommandSpec[] {
  return [
    {
      name: "/runs",
      aliases: ["/history"],
      group: "diagnostics",
      summary: "List recent runs",
      usage: "/runs",
      examples: ["/runs"],
      handler: async (ctx) => {
        try {
          const runsDir = join(ctx.input.root, ".omk", "runs");
          const entries = await readdir(runsDir, { withFileTypes: true });
          const recent = entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .filter((name) => name.startsWith("chat-"))
            .sort()
            .reverse()
            .slice(0, 10);
          const lines = [style.phosphorBold("\n  Recent Chats:")];
          for (const run of recent) lines.push(style.phosphorDim(`    • ${run}`));
          if (recent.length === 0) lines.push(style.phosphorDim("    (none)"));
          lines.push("");
          return okSlashResult({ text: lines.join("\n") });
        } catch {
          return okSlashResult({ text: style.phosphorDim("\n  No runs found.\n") });
        }
      },
    },
    {
      name: "/doctor",
      aliases: [],
      group: "diagnostics",
      summary: "Run omk doctor",
      usage: "/doctor",
      examples: ["/doctor"],
      handler: async (ctx) => {
        try {
          const result = await runShell(process.execPath, ["dist/cli.js", "doctor", "--json"], {
            cwd: ctx.input.root,
            env: ctx.env,
            timeout: 30000,
          });
          const output = (result.stdout || result.stderr || `doctor exited with code ${result.exitCode}`).slice(0, 2000);
          const suffix = result.failed ? `\n${style.metricsRed(`Doctor exited with code ${result.exitCode}`)}` : "";
          return okSlashResult({ text: `${style.phosphorDim("\n  Running doctor...\n")}${output}${suffix}` });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return okSlashResult({ text: style.metricsRed(`Doctor failed: ${message}`) });
        }
      },
    },
  ];
}

import { style } from "../../../../util/theme.js";
import { okSlashResult } from "../result.js";
import type { SlashCommandSpec } from "../types.js";

export function buildHarnessSlashCommands(): SlashCommandSpec[] {
  return [
    {
      name: "/parallel",
      aliases: ["/pa"],
      group: "harness",
      summary: "Run parallel orchestrator with prompt",
      usage: "/parallel <prompt>",
      examples: ["/parallel \"inspect harness health\""],
      handler: async (ctx, args) => {
        const prompt = args.positional.join(" ").trim();
        if (!prompt) return okSlashResult({ text: style.phosphorDim("\n  Usage: /parallel <prompt>\n") });
        const exitCode = await ctx.services?.runParallelTurn?.(prompt, ctx.renderer);
        return okSlashResult({ text: exitCode === undefined ? style.metricsRed("Parallel runner is unavailable.") : undefined });
      },
    },
  ];
}

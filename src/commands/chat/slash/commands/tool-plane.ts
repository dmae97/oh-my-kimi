import { runMcpAutoConnect, renderMcpAutoConnectBanner } from "../../../../mcp/autoconnect.js";
import { style } from "../../../../util/theme.js";
import { formatScopedNames } from "../format.js";
import { okSlashResult } from "../result.js";
import type { SlashCommandSpec } from "../types.js";

export function buildToolPlaneSlashCommands(): SlashCommandSpec[] {
  return [
    {
      name: "/mcp",
      aliases: [":mcp"],
      group: "tool-plane",
      summary: "Show MCP Tool Plane status",
      usage: "/mcp [--all] [--fix]",
      examples: ["/mcp", "/mcp --all"],
      handler: async (ctx, args) => {
        const wantsFullPreflight = Boolean(args.flags.all);
        const wantsFix = Boolean(args.flags.fix) || args.positional.includes("fix") || args.positional.includes("repair");
        const report = await runMcpAutoConnect({
          preflight: wantsFullPreflight ? "full" : "fast",
          env: {
            ...ctx.env,
            OMK_MCP_PREFLIGHT: wantsFullPreflight ? ctx.env.OMK_MCP_PREFLIGHT : "off",
          },
        });
        if (args.flags.json) return okSlashResult({ json: report });
        const lines = ["", renderMcpAutoConnectBanner(report), ""];
        if (wantsFix) lines.push(style.phosphorDim("  Repairs are explicit CLI actions: omk mcp connect --fix\n"));
        return okSlashResult({ text: lines.join("\n") });
      },
    },
    {
      name: "/tools",
      aliases: [":tools"],
      group: "tool-plane",
      summary: "Show scoped MCP/skills/hooks",
      usage: "/tools [--json]",
      examples: ["/tools", "/tools --json"],
      handler: (ctx, args) => {
        const payload = {
          mcp: ctx.input.mcpAllowlist ?? [],
          skills: ctx.input.skillNames ?? [],
          hooks: ctx.input.hookNames ?? [],
          runtime: ctx.state.bootstrap.selectedRuntimeId ?? "none",
          provider: ctx.state.provider,
          execution: ctx.input.executionPrompt ?? "auto",
        };
        if (args.flags.json) return okSlashResult({ json: payload });
        return okSlashResult({
          text: [
            style.phosphorBold("\n  Scoped Tool Plane:"),
            `  MCP:    ${style.phosphorDim(formatScopedNames(ctx.input.mcpAllowlist))}`,
            `  Skills: ${style.phosphorDim(formatScopedNames(ctx.input.skillNames))}`,
            `  Hooks:  ${style.phosphorDim(formatScopedNames(ctx.input.hookNames))}`,
            `  Runtime: ${style.phosphorDim(`${payload.runtime} (${payload.provider})`)}`,
            `  Safety: ${style.phosphorDim(`execution=${payload.execution}; provider metadata is scoped per turn`)}`,
            style.phosphorDim("  Use /mcp for MCP status or `omk mcp connect --json` for the full contract.\n"),
          ].join("\n"),
        });
      },
    },
  ];
}

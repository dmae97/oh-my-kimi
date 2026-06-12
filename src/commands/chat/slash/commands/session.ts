import { style } from "../../../../util/theme.js";
import { readTodos } from "../../../../util/todo-sync.js";
import { commandLine, formatScopedNames, section } from "../format.js";
import { okSlashResult } from "../result.js";
import type { SlashCommandSpec } from "../types.js";

export function buildSessionSlashCommands(): SlashCommandSpec[] {
  return [
    {
      name: "/exit",
      aliases: ["/quit", ":q"],
      group: "session",
      summary: "Exit chat session",
      usage: "/exit",
      examples: ["/quit"],
      handler: () => okSlashResult({ exit: true }),
    },
    {
      name: "/help",
      aliases: ["/h", "/?"],
      group: "session",
      summary: "Show slash command help",
      usage: "/help",
      examples: ["/help"],
      handler: () => okSlashResult({ text: renderSlashHelp() }),
    },
    {
      name: "/status",
      aliases: ["/s"],
      group: "session",
      summary: "Show session status",
      usage: "/status",
      examples: ["/status"],
      handler: async (ctx) => {
        const { input, state } = ctx;
        const uptime = process.uptime();
        const mem = process.memoryUsage();
        const lines = [
          style.phosphorBold(`\n  Session: ${input.runId}`),
          `  Provider: ${style.phosphor(state.provider)} | Model: ${style.phosphorDim(state.model ?? "auto")}`,
          `  Uptime: ${style.phosphorDim(`${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s`)}`,
          `  Heap: ${style.phosphorDim(`${(mem.heapUsed / 1024 / 1024).toFixed(1)}M`)} / ${style.phosphorDim(`${(mem.heapTotal / 1024 / 1024).toFixed(1)}M`)}`,
          `  Layout: ${style.phosphorDim(input.layout)} | Root: ${style.phosphorDim(input.root)}`,
          `  CWD: ${style.phosphorDim(input.activeCwd ?? process.cwd())} | Source: ${style.phosphorDim(input.rootSource ?? "unknown")}`,
          `  MCP: ${style.phosphorDim(formatScopedNames(input.mcpAllowlist, "none"))}`,
          `  Skills: ${style.phosphorDim(formatScopedNames(input.skillNames, "none"))}`,
          `  Hooks: ${style.phosphorDim(formatScopedNames(input.hookNames, "none"))}`,
          `  Theme: ${style.phosphorDim(state.theme ?? "system24")} | View: ${style.phosphorDim(state.view ?? "summary")} | Animation: ${style.phosphorDim(state.animation ?? ctx.env.OMK_ANIMATION ?? "auto")}`,
        ];

        const todos = await readTodos(input.runId).catch(() => null);
        if (todos && todos.length > 0) {
          const counts: Record<string, number> = { pending: 0, in_progress: 0, done: 0, failed: 0, blocked: 0, skipped: 0 };
          for (const todo of todos) counts[todo.status] = (counts[todo.status] ?? 0) + 1;
          lines.push(`  TODOs: ${style.mint(String(counts.in_progress))} active · ${style.phosphorDim(String(counts.pending))} pending · ${style.phosphorDim(String(counts.done))} done`);
          for (const todo of todos.filter((item) => item.status === "in_progress").slice(0, 3)) {
            lines.push(style.phosphorDim(`    ▶ ${todo.title.slice(0, 60)}`));
          }
        }
        lines.push("");
        return okSlashResult({ text: lines.join("\n") });
      },
    },
  ];
}

function renderSlashHelp(): string {
  return section("OMK Slash Commands:", [
    commandLine("/exit", "/quit :q", "Exit chat session"),
    commandLine("/help", "/h /?", "Show this help"),
    commandLine("/auth", "", "Show provider auth status"),
    commandLine("/providers", "", "List available providers"),
    commandLine("/provider", "<name>", "Switch provider"),
    commandLine("/model", "<name>", "Set session model"),
    commandLine("/use", "<ref>", "Provider/model alias"),
    commandLine("/route", "<prompt>", "Preview route policy/evidence/agent lanes"),
    commandLine("/mcp", "[--all]", "MCP Tool Plane status"),
    commandLine("/tools", "", "Scoped MCP/skills/hooks"),
    commandLine("/theme", "<system24|green-rain|neon-grid|plain|high-contrast>", "Set session theme"),
    commandLine("/view", "<summary|graph|evidence|tool-plane|events>", "Set control-plane view"),
    commandLine("/animation", "<off|low|auto|full>", "Set animation policy"),
    commandLine("/status", "", "Session status"),
    commandLine("/clear", "/cls", "Clear screen"),
    commandLine("/runs", "", "Recent run history"),
    commandLine("/doctor", "", "Run omk doctor"),
    commandLine("/parallel", "<prompt>", "Parallel orchestrator"),
    style.phosphorDim("\n  Any other input is routed to the AI agent."),
  ]);
}

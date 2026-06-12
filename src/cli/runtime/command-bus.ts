/**
 * CommandBus — slash command dispatch for the CLI pipeline.
 *
 * Architecture Doc §4: User Input → CommandBus → IntentClassifier
 * Handles slash commands (/model, /status, /theme, /help, etc.)
 * and routes them to appropriate handlers.
 */

import type { CommandEnvelope, CommandKind } from "./types.js";

export type SlashCommandHandler = (
  args: string[],
  envelope: CommandEnvelope
) => Promise<SlashCommandResult> | SlashCommandResult;

export interface SlashCommandResult {
  readonly handled: boolean;
  readonly output?: string;
  readonly exitCode?: 0 | 1;
  readonly newKind?: CommandKind;
}

interface RegisteredCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly handler: SlashCommandHandler;
}

const commands = new Map<string, RegisteredCommand>();
const aliases = new Map<string, string>();

/**
 * Register a slash command handler.
 */
export function registerSlashCommand(cmd: RegisteredCommand): void {
  commands.set(cmd.name, cmd);
  for (const alias of cmd.aliases) {
    aliases.set(alias, cmd.name);
  }
}

/**
 * Check if input is a slash command.
 */
export function isSlashCommand(input: string): boolean {
  return input.trimStart().startsWith("/");
}

/**
 * Parse slash command from input.
 */
export function parseSlashCommand(input: string): { name: string; args: string[] } | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return null;

  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0] ?? "";
  const args = parts.slice(1);

  return { name, args };
}

/**
 * Dispatch a slash command.
 */
export async function dispatchSlashCommand(
  input: string,
  envelope: CommandEnvelope
): Promise<SlashCommandResult> {
  const parsed = parseSlashCommand(input);
  if (!parsed) return { handled: false };

  const resolvedName = aliases.get(parsed.name) ?? parsed.name;
  const cmd = commands.get(resolvedName);

  if (!cmd) {
    return {
      handled: true,
      output: `Unknown command: /${parsed.name}. Type /help for available commands.`,
      exitCode: 1,
    };
  }

  return cmd.handler(parsed.args, envelope);
}

/**
 * List all registered slash commands.
 */
export function listSlashCommands(): readonly RegisteredCommand[] {
  return [...commands.values()];
}

// ── Built-in commands ──────────────────────────────────────────

registerSlashCommand({
  name: "help",
  aliases: ["h", "?"],
  description: "Show available commands",
  handler: () => {
    const cmds = listSlashCommands();
    const lines = ["Available commands:"];
    for (const cmd of cmds) {
      const aliasStr = cmd.aliases.length > 0 ? ` (${cmd.aliases.join(", ")})` : "";
      lines.push(`  /${cmd.name}${aliasStr} — ${cmd.description}`);
    }
    return { handled: true, output: lines.join("\n"), exitCode: 0 };
  },
});

registerSlashCommand({
  name: "status",
  aliases: ["st"],
  description: "Show current runtime status",
  handler: (_args, envelope) => {
    const lines = [
      `Command: ${envelope.kind}`,
      `Provider: ${envelope.runtime.provider ?? "auto"}`,
      `Theme: ${envelope.theme.name} (${envelope.theme.mode})`,
      `Output: ${envelope.output.format}`,
      `Workers: ${envelope.runtime.workers ?? "auto"}`,
    ];
    return { handled: true, output: lines.join("\n"), exitCode: 0 };
  },
});

registerSlashCommand({
  name: "model",
  aliases: ["m"],
  description: "Show or switch model",
  handler: (args, envelope) => {
    if (args.length === 0) {
      return {
        handled: true,
        output: `Current provider: ${envelope.runtime.provider ?? "auto"}`,
        exitCode: 0,
      };
    }
    // Model switching is handled at a higher level
    return {
      handled: true,
      output: `Model switch requested: ${args[0]}`,
      exitCode: 0,
    };
  },
});

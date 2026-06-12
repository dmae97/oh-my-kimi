import type { CommandEnvelope, OmkEvent } from "./contracts/command-envelope.js";
import type { CommandBusResult, CommandHandler } from "./command-bus.js";

export interface SlashCommandResult {
  readonly kind: "status" | "mutation" | "error";
  readonly command: string;
  readonly payload: unknown;
  readonly renderMode: "theme" | "nlp" | "json";
  readonly sideEffects: readonly RuntimeSideEffect[];
}

export type RuntimeSideEffect =
  | { readonly type: "provider_changed"; readonly provider: string; readonly model: string }
  | { readonly type: "session_updated"; readonly sessionId: string }
  | { readonly type: "memory_written"; readonly memoryId: string }
  | { readonly type: "theme_changed"; readonly theme: string };

export interface SlashCommandInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly rawText: string;
  readonly state: {
    readonly provider?: string;
    readonly model?: string;
    readonly sessionId?: string;
    readonly theme?: string;
  };
}

export interface SlashCommandHandler {
  execute(input: SlashCommandInput): Promise<SlashCommandResult>;
}

function parseSlashInput(rawText: string): { command: string; args: string[] } {
  const trimmed = rawText.trimStart();
  const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)\s*(.*)/s);
  if (!match) return { command: "", args: [] };
  const command = match[1]?.toLowerCase() ?? "";
  const argStr = match[2]?.trim() ?? "";
  const args = argStr ? argStr.split(/\s+/) : [];
  return { command, args };
}

function resultToCommandBusResult(result: SlashCommandResult): CommandBusResult {
  const events: OmkEvent[] = [
    {
      type: "result",
      timestamp: new Date().toISOString(),
      data: {
        kind: "result",
        content: JSON.stringify(result.payload, null, 2),
        format: "json",
      },
    },
  ];
  return {
    handled: true,
    events,
    output: JSON.stringify(result.payload, null, 2),
  };
}

class ModelCommandHandler implements SlashCommandHandler {
  async execute(input: SlashCommandInput): Promise<SlashCommandResult> {
    if (!input.args[0]) {
      return {
        kind: "status",
        command: "model.show",
        payload: {
          currentProvider: input.state.provider ?? "unknown",
          currentModel: input.state.model ?? "unknown",
          usage: "/model <provider>/<model>",
        },
        renderMode: "theme",
        sideEffects: [],
      };
    }
    const [provider, model] = input.args[0].split("/");
    return {
      kind: "mutation",
      command: "model.set",
      payload: { provider: provider ?? input.args[0], model: model ?? "default" },
      renderMode: "theme",
      sideEffects: [
        { type: "provider_changed", provider: provider ?? input.args[0], model: model ?? "default" },
      ],
    };
  }
}

class StatusCommandHandler implements SlashCommandHandler {
  async execute(input: SlashCommandInput): Promise<SlashCommandResult> {
    return {
      kind: "status",
      command: "status.show",
      payload: {
        provider: input.state.provider ?? "unknown",
        model: input.state.model ?? "unknown",
        sessionId: input.state.sessionId ?? "none",
        theme: input.state.theme ?? "default",
      },
      renderMode: "theme",
      sideEffects: [],
    };
  }
}

class ThemeCommandHandler implements SlashCommandHandler {
  async execute(input: SlashCommandInput): Promise<SlashCommandResult> {
    if (!input.args[0]) {
      return {
        kind: "status",
        command: "theme.show",
        payload: {
          current: input.state.theme ?? "omk",
          usage: "/theme <name>",
          available: ["omk", "minimal", "mono", "dark", "light"],
        },
        renderMode: "theme",
        sideEffects: [],
      };
    }
    return {
      kind: "mutation",
      command: "theme.set",
      payload: { theme: input.args[0] },
      renderMode: "theme",
      sideEffects: [{ type: "theme_changed", theme: input.args[0] }],
    };
  }
}

class HelpCommandHandler implements SlashCommandHandler {
  async execute(): Promise<SlashCommandResult> {
    return {
      kind: "status",
      command: "help",
      payload: {
        commands: [
          "/model [provider/model] - Show or set provider/model",
          "/status - Show current runtime status",
          "/theme [name] - Show or set theme",
          "/help - Show this help",
        ],
      },
      renderMode: "theme",
      sideEffects: [],
    };
  }
}

const defaultHandlers: Record<string, SlashCommandHandler> = {
  model: new ModelCommandHandler(),
  status: new StatusCommandHandler(),
  theme: new ThemeCommandHandler(),
  help: new HelpCommandHandler(),
};

export function createSlashCommandHandler(
  state: SlashCommandInput["state"] = {},
): CommandHandler {
  return async (envelope: CommandEnvelope): Promise<CommandBusResult> => {
    const { command, args } = parseSlashInput(envelope.rawText);
    const handler = defaultHandlers[command];
    if (!handler) {
      return {
        handled: false,
        events: [],
        output: `Unknown command: /${command}. Use /help for available commands.`,
      };
    }
    const input: SlashCommandInput = {
      command,
      args,
      rawText: envelope.rawText,
      state,
    };
    const result = await handler.execute(input);
    return resultToCommandBusResult(result);
  };
}

export function registerSlashCommands(
  bus: { registerHandler(command: string, handler: CommandHandler): void },
  state: SlashCommandInput["state"] = {},
): void {
  const handler = createSlashCommandHandler(state);
  bus.registerHandler("model", handler);
  bus.registerHandler("status", handler);
  bus.registerHandler("theme", handler);
  bus.registerHandler("help", handler);
}

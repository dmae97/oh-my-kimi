import type { DebloatRisk } from "./debloat-nlp.js";
import { classifyRisk } from "./debloat-nlp.js";
import type { CommandEnvelope, OmkEvent } from "./contracts/command-envelope.js";


export interface CommandBusResult {
  readonly handled: boolean;
  readonly events: readonly OmkEvent[];
  readonly output: string;
}

export type CommandHandler = (envelope: CommandEnvelope) => Promise<CommandBusResult>;

export interface CommandBus {
  dispatch(envelope: CommandEnvelope): Promise<CommandBusResult>;
  registerHandler(command: string, handler: CommandHandler): void;
  listCommands(): readonly string[];
}

function emitEvent(type: string, payload?: unknown): OmkEvent {
  return { type: type as OmkEvent["type"], timestamp: new Date().toISOString(), data: payload as OmkEvent["data"] };
}

function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

function extractSlashCommand(text: string): string {
  const match = text.trimStart().match(/^\/([a-zA-Z0-9_-]+)/);
  return match?.[1]?.toLowerCase() ?? "";
}

function resolveRisk(intent: string, raw: string): DebloatRisk {
  if (intent === "chat") return classifyRisk("chat", raw);
  return classifyRisk(intent as Parameters<typeof classifyRisk>[0], raw);
}

export function createCommandBus(): CommandBus {
  const handlers = new Map<string, CommandHandler>();

  const dispatch = async (envelope: CommandEnvelope): Promise<CommandBusResult> => {
    const events: OmkEvent[] = [];
    const text = envelope.rawText;

    events.push(emitEvent("command:received", { text: text.slice(0, 120) }));

    if (isSlashCommand(text)) {
      const command = extractSlashCommand(text);
      events.push(emitEvent("command:identified", { command, type: "slash" }));

      const handler = handlers.get(command);
      if (handler) {
        events.push(emitEvent("command:dispatching", { command }));
        const result = await handler(envelope);
        return {
          ...result,
          events: [...events, ...result.events],
        };
      }

      events.push(emitEvent("command:unhandled", { command }));
      return {
        handled: false,
        events,
        output: `Unknown command: /${command}. Use /help for available commands.`,
      };
    }

    const risk = resolveRisk("chat", text);
    events.push(emitEvent("command:fallback", { risk, intent: "chat" }));

    return {
      handled: false,
      events,
      output: "",
    };
  };

  const registerHandler = (command: string, handler: CommandHandler): void => {
    handlers.set(command.toLowerCase(), handler);
  };

  const listCommands = (): readonly string[] => {
    return [...handlers.keys()];
  };

  return { dispatch, registerHandler, listCommands };
}

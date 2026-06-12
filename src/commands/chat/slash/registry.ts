import type { ParsedSlashInput } from "./parser.js";
import type { SlashCommandSpec } from "./types.js";

export class SlashCommandRegistry {
  private readonly specs: SlashCommandSpec[];
  private readonly byName = new Map<string, SlashCommandSpec>();

  constructor(specs: readonly SlashCommandSpec[] = []) {
    this.specs = [];
    this.registerMany(specs);
  }

  register(spec: SlashCommandSpec): void {
    const names = [spec.name, ...spec.aliases].map((name) =>
      name.toLowerCase(),
    );
    for (const name of names) {
      if (!name.startsWith("/") && !name.startsWith(":")) {
        throw new Error(`Invalid slash command name: ${name}`);
      }
      if (this.byName.has(name)) {
        throw new Error(`Duplicate slash command name: ${name}`);
      }
    }
    this.specs.push(spec);
    for (const name of names) this.byName.set(name, spec);
  }

  registerMany(specs: readonly SlashCommandSpec[]): void {
    for (const spec of specs) this.register(spec);
  }

  find(command: string): SlashCommandSpec | undefined {
    return this.byName.get(command.toLowerCase());
  }

  resolve(parsed: ParsedSlashInput): SlashCommandSpec | undefined {
    return this.find(parsed.command);
  }

  list(): readonly SlashCommandSpec[] {
    return this.specs;
  }
}

export function createSlashCommandRegistry(
  specs: readonly SlashCommandSpec[],
): SlashCommandRegistry {
  return new SlashCommandRegistry(specs);
}

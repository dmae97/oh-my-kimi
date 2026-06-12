export type SlashFlagValue = boolean | string | readonly string[];

export interface ParsedSlashArgs {
  raw: string;
  argv: readonly string[];
  positional: readonly string[];
  flags: Readonly<Record<string, SlashFlagValue>>;
}

export interface ParsedSlashInput {
  raw: string;
  command: string;
  args: ParsedSlashArgs;
}

function pushFlag(
  flags: Record<string, SlashFlagValue>,
  name: string,
  value: boolean | string
): void {
  const stringify = (flagValue: boolean | string): string => {
    if (flagValue === true) return "true";
    if (flagValue === false) return "false";
    return flagValue;
  };
  const current = flags[name];
  if (current === undefined) {
    flags[name] = value;
    return;
  }
  if (Array.isArray(current)) {
    flags[name] = [...current, stringify(value)];
    return;
  }
  if (typeof current === "string" || typeof current === "boolean") {
    flags[name] = [stringify(current), stringify(value)];
  }
}

export function tokenizeSlashArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;

  for (const char of raw) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export function parseSlashArgs(raw: string): ParsedSlashArgs {
  const argv = tokenizeSlashArgs(raw);
  const flags: Record<string, SlashFlagValue> = {};
  const positional: string[] = [];

  for (const token of argv) {
    if (!token.startsWith("--") || token === "--") {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      pushFlag(flags, body.slice(0, eq), body.slice(eq + 1));
    } else {
      pushFlag(flags, body, true);
    }
  }

  return { raw, argv, positional, flags };
}

export function parseSlashInput(input: string): ParsedSlashInput | undefined {
  const raw = input.trim();
  if (!raw.startsWith("/") && !raw.startsWith(":")) return undefined;
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
  if (!match) return undefined;
  return {
    raw,
    command: match[1]?.toLowerCase() ?? raw.toLowerCase(),
    args: parseSlashArgs(match[2] ?? ""),
  };
}

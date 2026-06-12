/**
 * Phase 1 — ArgvParser
 * Parses raw process.argv into a structured format before Commander swallows it.
 * We still use Commander for subcommand dispatch, but this layer extracts
 * input-source metadata (stdin hints, file paths, positional args) early.
 */

import type { InputSource } from "../runtime/types.js";

export interface ParsedArgv {
  readonly raw: readonly string[];
  readonly command?: string;
  readonly positionalArgs: readonly string[];
  readonly flags: Record<string, string | boolean | undefined>;
  readonly hasStdinPipe: boolean;
}

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const raw = argv.slice(2);
  const hasStdinPipe = !process.stdin.isTTY;

  // Detect command (first non-flag token)
  let command: string | undefined;
  const positionalArgs: string[] = [];
  const flags: Record<string, string | boolean | undefined> = {};

  let i = 0;
  while (i < raw.length) {
    const arg = raw[i];

    if (arg.startsWith("-")) {
      const next = raw[i + 1];
      if (next && !next.startsWith("-")) {
        flags[arg.replace(/^-+/, "")] = next;
        i += 2;
      } else {
        flags[arg.replace(/^-+/, "")] = true;
        i += 1;
      }
      continue;
    }

    if (!command) {
      command = arg;
    } else {
      positionalArgs.push(arg);
    }
    i += 1;
  }

  return { raw, command, positionalArgs, flags, hasStdinPipe };
}

export function inferInputSource(parsed: ParsedArgv): InputSource {
  // Positional args always win over stdin pipe detection
  if (parsed.positionalArgs.length > 0) return "argv";
  if (parsed.hasStdinPipe) return "stdin";
  if (parsed.flags["goal-file"] || parsed.flags["file"]) return "file";
  if (parsed.flags["interactive"] || parsed.flags["i"]) return "interactive";
  return "argv";
}

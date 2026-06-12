import type { Command } from "commander";

export type OmkUxMode = "plan" | "guided" | "act" | "review" | "autopilot" | "safe";

export interface NaturalPromptOptions {
  runId?: string;
  provider?: string;
  model?: string;
  mode?: OmkUxMode;
  mcpScope?: "all" | "project" | "none";
  workers?: string;
  dryRun?: boolean;
  json?: boolean;
  noWatch?: boolean;
}

export interface NaturalPromptInvocation {
  prompt: string;
  options: NaturalPromptOptions;
}

const TASK_WORDS = /\b(fix|add|change|remove|refactor|review|audit|test|explain|plan|debug|diagnose|implement|write|update|repair)\b/i;
const NON_LATIN = /[^\u0000-\u007f]/u;

export function extractNaturalPromptInvocation(
  args: readonly string[],
  knownCommands: ReadonlySet<string>,
): NaturalPromptInvocation | undefined {
  if (args.length === 0) return undefined;
  const options: NaturalPromptOptions = {};
  const promptParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      promptParts.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-r") {
      const parsed = optionValue("runId", undefined, args[index + 1]);
      if (!parsed) return undefined;
      Object.assign(options, parsed.options);
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      const parsed = parseNaturalOption(arg, args[index + 1]);
      if (!parsed) return undefined;
      Object.assign(options, parsed.options);
      if (parsed.consumedValue) index += 1;
      continue;
    }
    promptParts.push(arg);
  }

  if (promptParts.length === 0) return undefined;
  const first = promptParts[0]?.trim() ?? "";
  if (knownCommands.has(first)) return undefined;
  const prompt = promptParts.join(" ").trim();
  if (!looksLikeNaturalPrompt(prompt)) return undefined;
  return { prompt, options };
}

export function knownCommandNames(program: Command): Set<string> {
  const names = new Set<string>();
  for (const command of program.commands) {
    names.add(command.name());
    for (const alias of command.aliases()) names.add(alias);
  }
  return names;
}

export function looksLikeNaturalPrompt(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return false;
  return trimmed.includes(" ") || NON_LATIN.test(trimmed) || TASK_WORDS.test(trimmed) || trimmed.length >= 18;
}

function parseNaturalOption(
  arg: string,
  next: string | undefined,
): { options: NaturalPromptOptions; consumedValue: boolean } | undefined {
  const [name, inlineValue] = splitOption(arg);
  switch (name) {
    case "--dry-run":
      return { options: { dryRun: true }, consumedValue: false };
    case "--json":
      return { options: { json: true }, consumedValue: false };
    case "--no-watch":
      return { options: { noWatch: true }, consumedValue: false };
    case "--provider":
      return optionValue("provider", inlineValue, next);
    case "--run-id":
      return optionValue("runId", inlineValue, next);
    case "--model":
      return optionValue("model", inlineValue, next);
    case "--mode":
      return modeOption(inlineValue, next);
    case "--mcp-scope":
      return mcpScopeOption(inlineValue, next);
    case "--workers":
      return optionValue("workers", inlineValue, next);
    default:
      return undefined;
  }
}

function splitOption(arg: string): [string, string | undefined] {
  const index = arg.indexOf("=");
  if (index < 0) return [arg, undefined];
  return [arg.slice(0, index), arg.slice(index + 1)];
}

function optionValue<K extends "runId" | "provider" | "model" | "workers">(
  key: K,
  inlineValue: string | undefined,
  next: string | undefined,
): { options: Pick<NaturalPromptOptions, K>; consumedValue: boolean } | undefined {
  const value = inlineValue ?? next;
  if (!value || value.startsWith("--")) return undefined;
  return { options: { [key]: value } as Pick<NaturalPromptOptions, K>, consumedValue: inlineValue === undefined };
}

function modeOption(
  inlineValue: string | undefined,
  next: string | undefined,
): { options: NaturalPromptOptions; consumedValue: boolean } | undefined {
  const value = normalizeMode(inlineValue ?? next);
  if (!value) return undefined;
  return { options: { mode: value }, consumedValue: inlineValue === undefined };
}

function mcpScopeOption(
  inlineValue: string | undefined,
  next: string | undefined,
): { options: NaturalPromptOptions; consumedValue: boolean } | undefined {
  const value = inlineValue ?? next;
  if (value === "all" || value === "project" || value === "none") {
    return { options: { mcpScope: value }, consumedValue: inlineValue === undefined };
  }
  return undefined;
}

export function normalizeMode(value: string | undefined): OmkUxMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "guided-edit" || normalized === "edit") return "guided";
  if (normalized === "auto") return "autopilot";
  if (["plan", "guided", "act", "review", "autopilot", "safe"].includes(normalized)) {
    return normalized as OmkUxMode;
  }
  return undefined;
}

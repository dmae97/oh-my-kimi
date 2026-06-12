import { stableValueHash } from "./stable-json.js";

export interface ToolCallContractRef {
  readonly name: string;
}

export interface RawToolCall {
  readonly id?: string;
  readonly name: string;
  readonly arguments: string;
}

export interface RepairedToolCall {
  readonly id?: string;
  readonly name: string;
  readonly input: unknown;
  readonly source: "declared" | "reasoning" | "visible";
  readonly signature: string;
}

export interface ToolCallRepairInput {
  readonly declaredCalls?: readonly RawToolCall[];
  readonly reasoningContent?: string;
  readonly visibleContent?: string;
  readonly allowedToolNames: ReadonlySet<string>;
  readonly toolContracts?: readonly ToolCallContractRef[];
  readonly stormState?: ToolCallStormState;
}

export interface ToolCallStormState {
  readonly seenSignatures: ReadonlySet<string>;
}

export interface ToolCallRepairResult {
  readonly calls: readonly RepairedToolCall[];
  readonly suppressed: readonly string[];
  readonly ignored: readonly string[];
  readonly stormState: ToolCallStormState;
}

export function repairToolCalls(input: ToolCallRepairInput): ToolCallRepairResult {
  const knownTools = new Set(input.toolContracts?.map((contract) => contract.name) ?? []);
  const allowed = new Set([...input.allowedToolNames].filter((name) => knownTools.size === 0 || knownTools.has(name)));
  const candidates: RepairedToolCall[] = [
    ...(input.declaredCalls ?? []).flatMap((call) => normalizeRawCall(call, "declared", allowed)),
    ...scavengeToolCalls(input.reasoningContent ?? "", "reasoning", allowed),
    ...scavengeToolCalls(input.visibleContent ?? "", "visible", allowed),
  ];
  const seen = new Set(input.stormState?.seenSignatures ?? []);
  const accepted: RepairedToolCall[] = [];
  const suppressed: string[] = [];
  const ignored: string[] = [];

  for (const call of candidates) {
    if (!allowed.has(call.name)) {
      ignored.push(call.name);
      continue;
    }
    if (seen.has(call.signature)) {
      suppressed.push(call.signature);
      continue;
    }
    seen.add(call.signature);
    accepted.push(call);
  }

  return {
    calls: accepted,
    suppressed,
    ignored,
    stormState: { seenSignatures: seen },
  };
}

export function repairTruncatedJson(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "{}";
  let output = trimmed;
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (const char of output) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") stack.push("}");
    if (char === "[") stack.push("]");
    if ((char === "}" || char === "]") && stack.at(-1) === char) stack.pop();
  }

  if (inString) output += "\"";
  while (stack.length > 0) output += stack.pop();
  return output;
}

export function reNestFlatArgs(args: Record<string, unknown>): Record<string, unknown> {
  const nested: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const parts = key.split(".").filter(Boolean);
    if (parts.length <= 1) {
      nested[key] = value;
      continue;
    }
    let cursor: Record<string, unknown> = nested;
    for (const part of parts.slice(0, -1)) {
      const existing = cursor[part];
      if (!isPlainObject(existing)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts.at(-1) ?? key] = value;
  }
  return nested;
}

function scavengeToolCalls(
  content: string,
  source: RepairedToolCall["source"],
  allowedToolNames: ReadonlySet<string>,
): RepairedToolCall[] {
  const calls: RepairedToolCall[] = [];
  const jsonBlocks = extractJsonObjects(content);
  for (const block of jsonBlocks) {
    const parsed = parseMaybeToolCall(block);
    if (!parsed || !allowedToolNames.has(parsed.name)) continue;
    calls.push(...normalizeRawCall(parsed, source, allowedToolNames));
  }
  return calls;
}

function extractJsonObjects(content: string): string[] {
  const blocks: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        blocks.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }

  if (depth > 0 && start >= 0) {
    blocks.push(repairTruncatedJson(content.slice(start)));
  }

  return blocks;
}

function parseMaybeToolCall(value: string): RawToolCall | null {
  try {
    const parsed = JSON.parse(repairTruncatedJson(value)) as unknown;
    if (!isPlainObject(parsed)) return null;
    const name = typeof parsed.name === "string" ? parsed.name : typeof parsed.tool === "string" ? parsed.tool : null;
    if (!name) return null;
    const rawArgs = parsed.arguments ?? parsed.args ?? parsed.input ?? {};
    return {
      name,
      arguments: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs),
    };
  } catch {
    return null;
  }
}

function normalizeRawCall(
  call: RawToolCall,
  source: RepairedToolCall["source"],
  allowedToolNames: ReadonlySet<string>,
): RepairedToolCall[] {
  if (!allowedToolNames.has(call.name)) return [];
  let input: unknown;
  try {
    input = JSON.parse(repairTruncatedJson(call.arguments)) as unknown;
  } catch {
    input = call.arguments;
  }
  const normalizedInput = isPlainObject(input) ? reNestFlatArgs(input) : input;
  const signature = stableValueHash({ name: call.name, input: normalizedInput });
  return [{
    id: call.id,
    name: call.name,
    input: normalizedInput,
    source,
    signature,
  }];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

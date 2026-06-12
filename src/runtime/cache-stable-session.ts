import {
  type OmkToolPrefixSpec,
  sortToolPrefixSpecs,
} from "./tool-registry-contract.js";
import { sha256Hex, stableJsonStringify } from "./stable-json.js";

export interface ImmutablePrefixInput {
  readonly systemPrompt: string;
  readonly toolSpecs?: readonly OmkToolPrefixSpec[];
  readonly fewShots?: readonly string[];
  readonly pinnedMemory?: readonly string[];
}

export interface ImmutablePrefixHashes {
  readonly systemPromptHash: string;
  readonly toolSpecsHash: string;
  readonly fewShotsHash: string;
  readonly pinnedMemoryHash: string;
  readonly prefixHash: string;
}

export interface ImmutablePrefix {
  readonly schemaVersion: 1;
  readonly systemPrompt: string;
  readonly toolSpecs: readonly OmkToolPrefixSpec[];
  readonly fewShots: readonly string[];
  readonly pinnedMemory: readonly string[];
  readonly hashes: ImmutablePrefixHashes;
}

export type AppendOnlyLogRole = "user" | "assistant" | "tool" | "system";

export interface AppendOnlyLogEntry {
  readonly role: AppendOnlyLogRole;
  readonly content: string;
  readonly createdAt?: string;
  readonly name?: string;
}

export interface VolatileScratch {
  readonly notes?: readonly string[];
  readonly planState?: unknown;
  readonly diagnostics?: readonly CacheDiagnostic[];
}

export type CacheDiagnosticLevel = "info" | "warning";

export type CacheDiagnosticCode =
  | "prefix_initialized"
  | "prefix_changed"
  | "system_prompt_changed"
  | "tool_specs_changed"
  | "few_shots_changed"
  | "pinned_memory_changed"
  | "scratch_reset";

export interface CacheDiagnostic {
  readonly level: CacheDiagnosticLevel;
  readonly code: CacheDiagnosticCode;
  readonly message: string;
  readonly previousHash?: string;
  readonly currentHash?: string;
}

export interface OmkSessionState {
  readonly schemaVersion: 1;
  readonly prefix: ImmutablePrefix;
  readonly log: readonly AppendOnlyLogEntry[];
  readonly scratch: VolatileScratch;
  readonly diagnostics: readonly CacheDiagnostic[];
}

export function buildImmutablePrefix(input: ImmutablePrefixInput): ImmutablePrefix {
  const systemPrompt = normalizeStableText(input.systemPrompt);
  const toolSpecs = sortToolPrefixSpecs(input.toolSpecs ?? []);
  const fewShots = normalizeStableTextList(input.fewShots ?? []);
  const pinnedMemory = normalizeStableTextList(input.pinnedMemory ?? []);

  const systemPromptHash = sha256Hex(systemPrompt);
  const toolSpecsHash = sha256Hex(stableJsonStringify(toolSpecs));
  const fewShotsHash = sha256Hex(stableJsonStringify(fewShots));
  const pinnedMemoryHash = sha256Hex(stableJsonStringify(pinnedMemory));
  const prefixHash = sha256Hex(
    stableJsonStringify({
      schemaVersion: 1,
      systemPrompt,
      toolSpecs,
      fewShots,
      pinnedMemory,
    }),
  );

  return {
    schemaVersion: 1,
    systemPrompt,
    toolSpecs,
    fewShots,
    pinnedMemory,
    hashes: {
      systemPromptHash,
      toolSpecsHash,
      fewShotsHash,
      pinnedMemoryHash,
      prefixHash,
    },
  };
}

export function createOmkSessionState(input: ImmutablePrefixInput): OmkSessionState {
  const prefix = buildImmutablePrefix(input);
  const diagnostic: CacheDiagnostic = {
    level: "info",
    code: "prefix_initialized",
    message: "Cache-stable immutable prefix initialized.",
    currentHash: prefix.hashes.prefixHash,
  };

  return {
    schemaVersion: 1,
    prefix,
    log: [],
    scratch: {},
    diagnostics: [diagnostic],
  };
}

export function appendLogEntry(
  state: OmkSessionState,
  entry: AppendOnlyLogEntry,
): OmkSessionState {
  return {
    ...state,
    log: [...state.log, normalizeLogEntry(entry)],
  };
}

export function resetScratch(
  state: OmkSessionState,
  scratch: VolatileScratch = {},
): OmkSessionState {
  const diagnostic: CacheDiagnostic = {
    level: "info",
    code: "scratch_reset",
    message: "Volatile scratch reset without mutating immutable prefix.",
    currentHash: state.prefix.hashes.prefixHash,
  };

  return {
    ...state,
    scratch,
    diagnostics: [...state.diagnostics, diagnostic],
  };
}

export function diffImmutablePrefix(
  previous: ImmutablePrefix,
  next: ImmutablePrefix,
): CacheDiagnostic[] {
  const diagnostics: CacheDiagnostic[] = [];

  if (previous.hashes.prefixHash !== next.hashes.prefixHash) {
    diagnostics.push({
      level: "warning",
      code: "prefix_changed",
      message: "Immutable prefix hash changed; provider prefix cache should be invalidated.",
      previousHash: previous.hashes.prefixHash,
      currentHash: next.hashes.prefixHash,
    });
  }

  pushHashDiff(
    diagnostics,
    "system_prompt_changed",
    "System prompt changed.",
    previous.hashes.systemPromptHash,
    next.hashes.systemPromptHash,
  );
  pushHashDiff(
    diagnostics,
    "tool_specs_changed",
    "Tool specs changed.",
    previous.hashes.toolSpecsHash,
    next.hashes.toolSpecsHash,
  );
  pushHashDiff(
    diagnostics,
    "few_shots_changed",
    "Few-shot prefix changed.",
    previous.hashes.fewShotsHash,
    next.hashes.fewShotsHash,
  );
  pushHashDiff(
    diagnostics,
    "pinned_memory_changed",
    "Pinned memory prefix changed.",
    previous.hashes.pinnedMemoryHash,
    next.hashes.pinnedMemoryHash,
  );

  return diagnostics;
}

function normalizeStableText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeStableTextList(values: readonly string[]): string[] {
  return values.map((value) => normalizeStableText(value));
}

function normalizeLogEntry(entry: AppendOnlyLogEntry): AppendOnlyLogEntry {
  return {
    ...entry,
    content: normalizeStableText(entry.content),
  };
}

function pushHashDiff(
  diagnostics: CacheDiagnostic[],
  code: Exclude<CacheDiagnosticCode, "prefix_initialized" | "prefix_changed" | "scratch_reset">,
  message: string,
  previousHash: string,
  currentHash: string,
): void {
  if (previousHash === currentHash) return;
  diagnostics.push({
    level: "warning",
    code,
    message,
    previousHash,
    currentHash,
  });
}

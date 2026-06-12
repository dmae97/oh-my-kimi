import { type ToolManifestEntry } from "./agent-runtime.js";
import { type JsonValue, stableValueHash } from "./stable-json.js";
import { type OmkToolPrefixSpec, sortToolPrefixSpecs } from "./tool-registry-contract.js";

export interface ProviderToolContractView {
  readonly name: string;
  readonly schemaHash: string;
  readonly readOnly: boolean;
  readonly parallelSafe: boolean;
  readonly mutatesState: boolean;
  readonly cacheRelevant: boolean;
}

export interface ProviderFunctionToolPayload {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
}

export interface ProviderToolPayloadBuildResult {
  readonly tools: readonly ProviderFunctionToolPayload[];
  readonly contracts: readonly ProviderToolContractView[];
  readonly toolPlaneHash: string;
}

export function buildProviderToolPayload(
  entries: readonly ToolManifestEntry[],
): ProviderToolPayloadBuildResult {
  const prefixSpecs = sortToolPrefixSpecs(entries.map((entry) => toPrefixSpec(entry)));
  const sortedEntries = prefixSpecs.map((spec) => {
    const entry = entries.find((candidate) => candidate.name === spec.name);
    if (!entry) throw new Error(`missing tool entry for ${spec.name}`);
    return entry;
  });
  const tools = sortedEntries.map((entry) => toProviderPayload(entry));
  const contracts = sortedEntries.map((entry) => toProviderContractView(entry));

  return {
    tools,
    contracts,
    toolPlaneHash: stableValueHash(tools),
  };
}

export function assertToolPlaneHashMatchesPayload(
  payload: ProviderToolPayloadBuildResult,
): void {
  const actual = stableValueHash(payload.tools);
  if (actual !== payload.toolPlaneHash) {
    throw new Error(`provider tool payload hash mismatch: expected ${payload.toolPlaneHash}, got ${actual}`);
  }
}

function toPrefixSpec(entry: ToolManifestEntry): OmkToolPrefixSpec {
  return {
    name: entry.name,
    description: entry.description,
    parameters: entry.inputSchema as JsonValue,
    readOnly: entry.readOnly === true,
    parallelSafe: entry.parallelSafe === true,
    stormExempt: entry.stormExempt === true,
    skipRetentionSave: entry.skipRetentionSave === true,
  };
}

function toProviderPayload(entry: ToolManifestEntry): ProviderFunctionToolPayload {
  return {
    type: "function",
    function: {
      name: entry.name,
      description: entry.description,
      parameters: entry.inputSchema,
    },
  };
}

function toProviderContractView(entry: ToolManifestEntry): ProviderToolContractView {
  const readOnly = entry.readOnly === true;
  return {
    name: entry.name,
    schemaHash: stableValueHash(entry.inputSchema),
    readOnly,
    parallelSafe: entry.parallelSafe === true,
    mutatesState: !readOnly,
    cacheRelevant: entry.skipRetentionSave !== true,
  };
}

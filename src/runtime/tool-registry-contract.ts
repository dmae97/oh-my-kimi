import {
  type JsonObject,
  type JsonValue,
  compareCodepoints,
  stableJsonStringify,
} from "./stable-json.js";

export interface OmkToolContext {
  readonly runId?: string;
  readonly nodeId?: string;
  readonly signal?: AbortSignal;
}

export interface OmkToolDefinition<A = unknown, R = unknown> {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: JsonObject;
  readonly readOnly?: boolean;
  readonly readOnlyCheck?: (args: A) => boolean;
  readonly parallelSafe?: boolean;
  readonly stormExempt?: boolean;
  readonly skipRetentionSave?: boolean;
  readonly fn: (args: A, ctx: OmkToolContext) => Promise<R> | R;
}

export interface OmkToolPrefixSpec {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: JsonValue;
  readonly readOnly: boolean;
  readonly parallelSafe: boolean;
  readonly stormExempt: boolean;
  readonly skipRetentionSave: boolean;
}

export interface OmkToolCall<A = unknown> {
  readonly toolName: string;
  readonly args: A;
}

export type OmkToolExecutionBatchKind = "parallel" | "serial";

export interface OmkToolExecutionBatch<A = unknown> {
  readonly kind: OmkToolExecutionBatchKind;
  readonly calls: readonly OmkToolCall<A>[];
}

export function toToolPrefixSpec(definition: OmkToolDefinition): OmkToolPrefixSpec {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    readOnly: definition.readOnly === true,
    parallelSafe: definition.parallelSafe === true,
    stormExempt: definition.stormExempt === true,
    skipRetentionSave: definition.skipRetentionSave === true,
  };
}

export function sortToolPrefixSpecs(
  specs: readonly OmkToolPrefixSpec[],
): OmkToolPrefixSpec[] {
  return [...specs].sort((left, right) => {
    const byName = compareCodepoints(left.name, right.name);
    if (byName !== 0) return byName;
    return compareCodepoints(stableJsonStringify(left), stableJsonStringify(right));
  });
}

export function toSortedToolPrefixSpecs(
  definitions: readonly OmkToolDefinition[],
): OmkToolPrefixSpec[] {
  return sortToolPrefixSpecs(definitions.map((definition) => toToolPrefixSpec(definition)));
}

export function isToolReadOnly<A>(
  definition: OmkToolDefinition<A>,
  args: A,
): boolean {
  if (definition.readOnlyCheck) return definition.readOnlyCheck(args);
  return definition.readOnly === true;
}

export function createToolExecutionBatches<A>(
  calls: readonly OmkToolCall<A>[],
  registry: ReadonlyMap<string, OmkToolDefinition<A>>,
): OmkToolExecutionBatch<A>[] {
  const batches: OmkToolExecutionBatch<A>[] = [];
  let parallelCalls: OmkToolCall<A>[] = [];

  const flushParallel = (): void => {
    if (parallelCalls.length === 0) return;
    batches.push({ kind: "parallel", calls: parallelCalls });
    parallelCalls = [];
  };

  for (const call of calls) {
    const definition = registry.get(call.toolName);
    const canRunInParallel =
      definition !== undefined &&
      definition.parallelSafe === true &&
      isToolReadOnly(definition, call.args);

    if (canRunInParallel) {
      parallelCalls.push(call);
      continue;
    }

    flushParallel();
    batches.push({ kind: "serial", calls: [call] });
  }

  flushParallel();
  return batches;
}

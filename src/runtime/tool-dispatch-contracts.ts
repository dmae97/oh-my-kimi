import type { OmkToolCall, OmkToolDefinition } from "./tool-registry-contract.js";
import { createToolExecutionBatches } from "./tool-registry-contract.js";

export interface ToolDispatchResult<R = unknown> {
  readonly call: OmkToolCall;
  readonly status: "fulfilled" | "rejected";
  readonly value?: R;
  readonly reason?: unknown;
}

export async function dispatchToolCallsByContract<A, R>(
  calls: readonly OmkToolCall<A>[],
  registry: ReadonlyMap<string, OmkToolDefinition<A, R>>,
  dispatchOne: (call: OmkToolCall<A>) => Promise<R>,
): Promise<ToolDispatchResult<R>[]> {
  const batches = createToolExecutionBatches(calls, registry);
  const appended: ToolDispatchResult<R>[] = [];

  for (const batch of batches) {
    if (batch.kind === "parallel") {
      const settled = await Promise.allSettled(batch.calls.map((call) => dispatchOne(call)));
      settled.forEach((result, index) => {
        const call = batch.calls[index];
        if (!call) return;
        appended.push(toDispatchResult(call, result));
      });
      continue;
    }

    for (const call of batch.calls) {
      try {
        appended.push({ call, status: "fulfilled", value: await dispatchOne(call) });
      } catch (reason) {
        appended.push({ call, status: "rejected", reason });
      }
    }
  }

  return appended;
}

function toDispatchResult<R>(
  call: OmkToolCall,
  result: PromiseSettledResult<R>,
): ToolDispatchResult<R> {
  if (result.status === "fulfilled") {
    return { call, status: "fulfilled", value: result.value };
  }
  return { call, status: "rejected", reason: result.reason };
}

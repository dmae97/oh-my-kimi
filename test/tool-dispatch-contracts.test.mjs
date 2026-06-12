import test from "node:test";
import assert from "node:assert/strict";

const { dispatchToolCallsByContract } = await import("../dist/runtime/tool-dispatch-contracts.js");

test("dispatchToolCallsByContract runs parallel-safe tools concurrently but appends in declared order", async () => {
  const registry = new Map([
    ["slow_read", { name: "slow_read", readOnly: true, parallelSafe: true, fn: async () => "slow" }],
    ["fast_read", { name: "fast_read", readOnly: true, parallelSafe: true, fn: async () => "fast" }],
    ["edit_file", { name: "edit_file", readOnly: false, parallelSafe: false, fn: async () => "edit" }],
  ]);
  const started = [];
  const calls = [
    { toolName: "slow_read", args: {} },
    { toolName: "fast_read", args: {} },
    { toolName: "edit_file", args: {} },
    { toolName: "fast_read", args: { after: "edit" } },
  ];

  const results = await dispatchToolCallsByContract(calls, registry, async (call) => {
    started.push(call.toolName);
    if (call.toolName === "slow_read") {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return call.toolName;
  });

  assert.deepEqual(
    results.map((result) => result.call.toolName),
    ["slow_read", "fast_read", "edit_file", "fast_read"],
  );
  assert.deepEqual(started.slice(0, 2).sort(), ["fast_read", "slow_read"]);
  assert.equal(started[2], "edit_file");
});

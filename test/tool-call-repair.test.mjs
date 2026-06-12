import test from "node:test";
import assert from "node:assert/strict";

const {
  repairToolCalls,
  repairTruncatedJson,
  reNestFlatArgs,
} = await import("../dist/runtime/tool-call-repair.js");

const toolContracts = [
  {
    name: "read_file",
    readOnly: true,
    parallelSafe: true,
    stormExempt: false,
    skipRetentionSave: false,
  },
  {
    name: "edit_file",
    readOnly: false,
    parallelSafe: false,
    stormExempt: false,
    skipRetentionSave: false,
  },
];

test("repairToolCalls ignores unknown tool calls and scavenges allowed calls", () => {
  const repaired = repairToolCalls({
    declaredCalls: [{ name: "unknown", arguments: "{}" }],
    visibleContent: 'assistant text {"name":"read_file","arguments":{"path":"src/index.ts"}}',
    allowedToolNames: new Set(["read_file", "unknown"]),
    toolContracts,
  });

  assert.equal(repaired.calls.length, 1);
  assert.equal(repaired.calls[0]?.name, "read_file");
  assert.deepEqual(repaired.calls[0]?.input, { path: "src/index.ts" });
});

test("repairToolCalls suppresses identical tool storm within a turn", () => {
  const first = repairToolCalls({
    declaredCalls: [{ name: "read_file", arguments: "{\"path\":\"src/a.ts\"}" }],
    allowedToolNames: new Set(["read_file"]),
    toolContracts,
  });
  const second = repairToolCalls({
    declaredCalls: [{ name: "read_file", arguments: "{\"path\":\"src/a.ts\"}" }],
    allowedToolNames: new Set(["read_file"]),
    toolContracts,
    stormState: first.stormState,
  });

  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 0);
  assert.equal(second.suppressed.length, 1);
});

test("repairTruncatedJson closes incomplete JSON and flat args can be re-nested", () => {
  const parsed = JSON.parse(repairTruncatedJson("{\"path\":\"src/a.ts\""));

  assert.deepEqual(parsed, { path: "src/a.ts" });
  assert.deepEqual(
    reNestFlatArgs({ "file.path": "src/a.ts", "file.range.start": 1, dryRun: true }),
    { file: { path: "src/a.ts", range: { start: 1 } }, dryRun: true },
  );
});

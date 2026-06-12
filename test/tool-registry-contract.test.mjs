import test from "node:test";
import assert from "node:assert/strict";

const {
  createToolExecutionBatches,
  isToolReadOnly,
  toSortedToolPrefixSpecs,
  toToolPrefixSpec,
} = await import("../dist/runtime/tool-registry-contract.js");
const { buildOmkToolPlaneManifest } = await import("../dist/runtime/tool-plane.js");

test("toToolPrefixSpec exposes only cache-stable tool metadata", () => {
  const definition = {
    name: "shell",
    description: "Run a command",
    parameters: { type: "object" },
    readOnly: false,
    readOnlyCheck: (args) => String(args.command).startsWith("git status"),
    parallelSafe: false,
    stormExempt: true,
    skipRetentionSave: true,
    fn: () => ({ ok: true }),
  };

  const spec = toToolPrefixSpec(definition);

  assert.deepEqual(Object.keys(spec).sort(), [
    "description",
    "name",
    "parallelSafe",
    "parameters",
    "readOnly",
    "skipRetentionSave",
    "stormExempt",
  ]);
  assert.equal("fn" in spec, false);
  assert.equal("readOnlyCheck" in spec, false);
  assert.equal(spec.stormExempt, true);
});

test("isToolReadOnly honors argument-sensitive readOnlyCheck", () => {
  const shellDefinition = {
    name: "shell",
    readOnly: false,
    readOnlyCheck: (args) => args.command === "git status --short",
    fn: () => "",
  };

  assert.equal(isToolReadOnly(shellDefinition, { command: "git status --short" }), true);
  assert.equal(isToolReadOnly(shellDefinition, { command: "npm run build" }), false);
});

test("createToolExecutionBatches keeps parallel-safe read tools together and side effects as barriers", () => {
  const search = {
    name: "search_content",
    readOnly: true,
    parallelSafe: true,
    fn: () => [],
  };
  const readFile = {
    name: "read_file",
    readOnly: true,
    parallelSafe: true,
    fn: () => "",
  };
  const editFile = {
    name: "edit_file",
    readOnly: false,
    parallelSafe: false,
    fn: () => ({ ok: true }),
  };
  const registry = new Map([
    [search.name, search],
    [readFile.name, readFile],
    [editFile.name, editFile],
  ]);

  const batches = createToolExecutionBatches(
    [
      { toolName: "search_content", args: { pattern: "DAG" } },
      { toolName: "read_file", args: { path: "src/runtime/index.ts" } },
      { toolName: "edit_file", args: { path: "src/runtime/index.ts" } },
      { toolName: "search_content", args: { pattern: "ToolRegistry" } },
    ],
    registry,
  );

  assert.equal(batches.length, 3);
  assert.equal(batches[0]?.kind, "parallel");
  assert.deepEqual(
    batches[0]?.calls.map((call) => call.toolName),
    ["search_content", "read_file"],
  );
  assert.equal(batches[1]?.kind, "serial");
  assert.deepEqual(
    batches[1]?.calls.map((call) => call.toolName),
    ["edit_file"],
  );
  assert.equal(batches[2]?.kind, "parallel");
  assert.deepEqual(
    batches[2]?.calls.map((call) => call.toolName),
    ["search_content"],
  );
});

test("toSortedToolPrefixSpecs sorts with deterministic codepoint order", () => {
  const specs = toSortedToolPrefixSpecs([
    { name: "zeta", readOnly: true, fn: () => "" },
    { name: "alpha", readOnly: true, fn: () => "" },
    { name: "Beta", readOnly: true, fn: () => "" },
  ]);

  assert.deepEqual(
    specs.map((spec) => spec.name),
    ["Beta", "alpha", "zeta"],
  );
});

test("tool-plane manifest carries cache-stable tool contract hash", async () => {
  const first = await buildOmkToolPlaneManifest({
    mcpScope: "none",
    tools: ["search_content", "edit_file"],
    toolContracts: toSortedToolPrefixSpecs([
      { name: "search_content", readOnly: true, parallelSafe: true, fn: () => [] },
      { name: "edit_file", readOnly: false, parallelSafe: false, fn: () => ({ ok: true }) },
    ]),
  });
  const second = await buildOmkToolPlaneManifest({
    mcpScope: "none",
    tools: ["edit_file", "search_content"],
    toolContracts: toSortedToolPrefixSpecs([
      { name: "edit_file", readOnly: false, parallelSafe: false, fn: () => ({ ok: true }) },
      { name: "search_content", readOnly: true, parallelSafe: true, fn: () => [] },
    ]),
  });

  assert.equal(first.toolSpecsHash, second.toolSpecsHash);
  assert.deepEqual(
    first.toolContracts.map((spec) => spec.name),
    ["edit_file", "search_content"],
  );
});

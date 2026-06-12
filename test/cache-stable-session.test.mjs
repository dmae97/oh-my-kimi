import test from "node:test";
import assert from "node:assert/strict";

const {
  appendLogEntry,
  buildImmutablePrefix,
  createOmkSessionState,
  diffImmutablePrefix,
  resetScratch,
} = await import("../dist/runtime/cache-stable-session.js");
const { toSortedToolPrefixSpecs } = await import("../dist/runtime/tool-registry-contract.js");

function toolDefinitions() {
  return [
    {
      name: "search_content",
      description: "Search files",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
        },
      },
      readOnly: true,
      parallelSafe: true,
      fn: () => [],
    },
    {
      name: "edit_file",
      description: "Edit a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
      },
      readOnly: false,
      fn: () => ({ ok: true }),
    },
  ];
}

test("buildImmutablePrefix is stable across tool declaration order", () => {
  const first = buildImmutablePrefix({
    systemPrompt: "OMK runtime\n",
    toolSpecs: toSortedToolPrefixSpecs(toolDefinitions()),
    fewShots: ["Use evidence gates."],
    pinnedMemory: ["project MCP scope"],
  });
  const second = buildImmutablePrefix({
    systemPrompt: "OMK runtime\r\n",
    toolSpecs: toSortedToolPrefixSpecs([...toolDefinitions()].reverse()),
    fewShots: ["Use evidence gates."],
    pinnedMemory: ["project MCP scope"],
  });

  assert.equal(first.hashes.prefixHash, second.hashes.prefixHash);
  assert.equal(first.hashes.toolSpecsHash, second.hashes.toolSpecsHash);
  assert.deepEqual(
    first.toolSpecs.map((spec) => spec.name),
    ["edit_file", "search_content"],
  );
});

test("append-only log and scratch reset do not mutate immutable prefix hash", () => {
  const state = createOmkSessionState({
    systemPrompt: "Cache stable system prompt",
    toolSpecs: toSortedToolPrefixSpecs(toolDefinitions()),
  });
  const afterLog = appendLogEntry(state, {
    role: "user",
    content: "fix failing tests",
    createdAt: "2026-05-30T00:00:00.000Z",
  });
  const afterScratch = resetScratch(afterLog, {
    notes: ["temporary plan"],
    planState: { step: "inspect" },
  });

  assert.equal(afterLog.prefix.hashes.prefixHash, state.prefix.hashes.prefixHash);
  assert.equal(afterScratch.prefix.hashes.prefixHash, state.prefix.hashes.prefixHash);
  assert.equal(afterScratch.log.length, 1);
  assert.equal(afterScratch.diagnostics.at(-1)?.code, "scratch_reset");
});

test("diffImmutablePrefix reports explicit cache invalidation reasons", () => {
  const previous = buildImmutablePrefix({
    systemPrompt: "OMK runtime",
    toolSpecs: toSortedToolPrefixSpecs(toolDefinitions()),
    fewShots: ["Plan before editing."],
  });
  const next = buildImmutablePrefix({
    systemPrompt: "OMK runtime v2",
    toolSpecs: toSortedToolPrefixSpecs([
      ...toolDefinitions(),
      {
        name: "git_status",
        description: "Inspect git state",
        readOnly: true,
        parallelSafe: true,
        fn: () => "",
      },
    ]),
    fewShots: ["Plan before editing."],
  });

  const codes = diffImmutablePrefix(previous, next).map((diagnostic) => diagnostic.code);

  assert.ok(codes.includes("prefix_changed"));
  assert.ok(codes.includes("system_prompt_changed"));
  assert.ok(codes.includes("tool_specs_changed"));
  assert.equal(codes.includes("few_shots_changed"), false);
});

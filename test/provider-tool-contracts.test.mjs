import test from "node:test";
import assert from "node:assert/strict";

const {
  assertToolPlaneHashMatchesPayload,
  buildProviderToolPayload,
} = await import("../dist/runtime/provider-tool-contracts.js");
const { KimiApiRuntime } = await import("../dist/runtime/kimi-api-runtime.js");
const { stableValueHash } = await import("../dist/runtime/stable-json.js");

function toolEntries(schemaOverride = {}) {
  return [
    {
      name: "search_content",
      description: "Search content",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          ...schemaOverride,
        },
      },
      readOnly: true,
      parallelSafe: true,
    },
    {
      name: "edit_file",
      description: "Edit file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      readOnly: false,
      parallelSafe: false,
    },
  ];
}

test("provider tool payload hash is insertion-order stable and schema-sensitive", () => {
  const first = buildProviderToolPayload(toolEntries());
  const second = buildProviderToolPayload([...toolEntries()].reverse());
  const changed = buildProviderToolPayload(toolEntries({ limit: { type: "number" } }));

  assert.equal(first.toolPlaneHash, second.toolPlaneHash);
  assert.notEqual(first.toolPlaneHash, changed.toolPlaneHash);
  assertToolPlaneHashMatchesPayload(first);
});

test("provider payload strips unsupported runtime metadata deterministically", () => {
  const payload = buildProviderToolPayload(toolEntries());
  const serialized = JSON.stringify(payload.tools);

  assert.equal(serialized.includes("parallelSafe"), false);
  assert.equal(serialized.includes("readOnly"), false);
  assert.equal(serialized.includes("stormExempt"), false);
  assert.deepEqual(
    payload.contracts.map((contract) => ({
      name: contract.name,
      readOnly: contract.readOnly,
      parallelSafe: contract.parallelSafe,
      mutatesState: contract.mutatesState,
    })),
    [
      { name: "edit_file", readOnly: false, parallelSafe: false, mutatesState: true },
      { name: "search_content", readOnly: true, parallelSafe: true, mutatesState: false },
    ],
  );
});

test("Kimi adapter records toolPlaneHash matching actual provider payload", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "kimi-test",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "ok" },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const runtime = new KimiApiRuntime({
      apiKey: "test-key",
      model: "kimi-test",
      baseUrl: "https://example.invalid",
    });
    const result = await runtime.execute({
      prompt: "use tools",
      context: {
        runId: "run-provider-tools",
        nodeId: "node-provider-tools",
        providerModel: "kimi-test",
      },
      tools: {
        available: [...toolEntries()].reverse(),
      },
      providerPolicy: {
        strategy: "priority-first",
        preferredProviders: ["kimi"],
        fallbackChain: [],
      },
      capabilities: {
        read: true,
        write: false,
        shell: false,
        mcp: false,
        patch: false,
        review: true,
        merge: false,
        vision: false,
        streaming: false,
        toolCalling: true,
      },
    });

    assert.equal(result.metadata?.toolPlaneHash, stableValueHash(capturedBody.tools));
    assert.deepEqual(
      capturedBody.tools.map((tool) => tool.function.name),
      ["edit_file", "search_content"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kimi adapter repairs content-scavenged tool calls using declared contracts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      id: "chatcmpl-repair-test",
      object: "chat.completion",
      created: 0,
      model: "kimi-test",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: 'tool payload {"name":"search_content","arguments":{"pattern":"ToolRegistry"}}',
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  try {
    const runtime = new KimiApiRuntime({
      apiKey: "test-key",
      model: "kimi-test",
      baseUrl: "https://example.invalid",
    });
    const result = await runtime.execute({
      prompt: "repair tools",
      context: {
        runId: "run-tool-repair",
        nodeId: "node-tool-repair",
        providerModel: "kimi-test",
      },
      tools: { available: toolEntries() },
      providerPolicy: {
        strategy: "priority-first",
        preferredProviders: ["kimi"],
        fallbackChain: [],
      },
      capabilities: {
        read: true,
        write: false,
        shell: false,
        mcp: false,
        patch: false,
        review: true,
        merge: false,
        vision: false,
        streaming: false,
        toolCalling: true,
      },
    });

    assert.equal(result.toolCalls?.[0]?.name, "search_content");
    assert.deepEqual(result.toolCalls?.[0]?.input, { pattern: "ToolRegistry" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

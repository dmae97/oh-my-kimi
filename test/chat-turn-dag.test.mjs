import test from "node:test";
import assert from "node:assert/strict";

import { buildChatTurnDag } from "../dist/commands/chat/chat-turn-dag.js";

function intent(overrides = {}) {
  return {
    taskType: "general",
    complexity: "simple",
    estimatedWorkers: 1,
    requiredRoles: ["coordinator"],
    isReadOnly: true,
    needsResearch: false,
    needsSecurityReview: false,
    needsTesting: false,
    needsDesignReview: false,
    parallelizable: false,
    rationale: "test intent",
    confidence: 0.9,
    matchedRules: [],
    language: "en",
    domainTerms: [],
    targetSurfaces: [],
    extractedFiles: [],
    extractedCommands: [],
    ambiguitySignals: [],
    routingHints: {},
    ...overrides,
  };
}

test("buildChatTurnDag creates a single read-only node for simple chat turns", async () => {
  const dag = await buildChatTurnDag({
    prompt: "Summarize status only",
    runId: "chat-simple",
    providerPolicy: "codex",
    providerModel: "codex-cli",
    mcpAllowlist: ["omk-project"],
    skillNames: ["omk-repo-explorer"],
    hookNames: ["preflight"],
    toolNames: ["ctx_read"],
    intent: intent(),
  });

  assert.equal(dag.nodes.length, 1);
  assert.equal(dag.nodes[0].id, "chat-turn");
  assert.equal(dag.nodes[0].status, "pending");
  assert.equal(dag.nodes[0].role, "coordinator");
  assert.equal(dag.nodes[0].routing.provider, "codex");
  assert.equal(dag.nodes[0].routing.providerModel, "codex-cli");
  assert.equal(dag.nodes[0].routing.readOnly, true);
  assert.equal(dag.nodes[0].routing.evidenceRequired, false);
  assert.deepEqual(dag.nodes[0].routing.mcpServers, ["omk-project"]);
  assert.deepEqual(dag.nodes[0].routing.skills, ["omk-repo-explorer"]);
  assert.deepEqual(dag.nodes[0].routing.hooks, ["preflight"]);
  assert.deepEqual(dag.nodes[0].routing.tools, ["ctx_read"]);
});

test("buildChatTurnDag delegates complex chat turns to dynamic DAG construction", async () => {
  const dag = await buildChatTurnDag({
    prompt: "Implement harness wiring and test it",
    runId: "chat-complex",
    providerPolicy: "codex",
    workerCount: 2,
    now: () => new Date("2026-05-30T00:00:00.000Z"),
    intent: intent({
      taskType: "implement",
      complexity: "complex",
      estimatedWorkers: 2,
      requiredRoles: ["planner", "coder", "reviewer"],
      isReadOnly: false,
      needsTesting: true,
      parallelizable: true,
      targetSurfaces: ["harness", "runtime"],
      routingHints: { requireHarness: true, requireEvidence: true },
    }),
  });

  assert.ok(dag.nodes.length > 1);
  assert.ok(dag.nodes.some((node) => node.id === "bootstrap"));
  assert.ok(dag.nodes.some((node) => node.id === "root-coordinator"));
  assert.ok(dag.nodes.some((node) => node.id === "worker-1"));
  assert.ok(dag.nodes.some((node) => node.id === "review-merge"));
  assert.ok(dag.nodes.some((node) => node.id === "quality-check"));
  assert.equal(dag.nodes.find((node) => node.id === "worker-1")?.routing.provider, "codex");
});

test("buildChatTurnDag honors sequential routing hints for non-simple turns", async () => {
  const dag = await buildChatTurnDag({
    prompt: "Apply this small edit",
    runId: "chat-sequential",
    providerPolicy: "mimo",
    workerCount: 4,
    intent: intent({
      taskType: "implement",
      complexity: "moderate",
      estimatedWorkers: 4,
      isReadOnly: false,
      parallelizable: false,
      routingHints: { preferredExecutionStrategy: "sequential" },
    }),
  });

  const workerNodes = dag.nodes.filter((node) => /^worker-\d+$/.test(node.id));
  assert.equal(workerNodes.length, 1);
  assert.equal(workerNodes[0].routing.provider, "mimo");
});

test("buildChatTurnDag honors an explicit execution strategy override", async () => {
  const dag = await buildChatTurnDag({
    prompt: "Review these changes one lane at a time",
    runId: "chat-explicit-sequential",
    providerPolicy: "codex",
    workerCount: 4,
    executionStrategy: "sequential",
    intent: intent({
      taskType: "review",
      complexity: "complex",
      estimatedWorkers: 4,
      requiredRoles: ["planner", "reviewer", "qa"],
      parallelizable: true,
    }),
  });

  const workerNodes = dag.nodes.filter((node) => /^worker-\d+$/.test(node.id));
  assert.equal(workerNodes.length, 1);
});

test("buildChatTurnDag produces dependency-consistent dynamic DAGs", async () => {
  const dag = await buildChatTurnDag({
    prompt: "Plan harness integration",
    runId: "chat-deps",
    providerPolicy: "auto",
    intent: intent({
      taskType: "plan",
      complexity: "moderate",
      estimatedWorkers: 2,
      requiredRoles: ["planner", "reviewer"],
      parallelizable: true,
    }),
  });

  const nodeIds = new Set(dag.nodes.map((node) => node.id));
  for (const node of dag.nodes) {
    assert.equal(node.status, "pending");
    assert.equal(node.retries, 0);
    for (const dep of node.dependsOn) {
      assert.equal(nodeIds.has(dep), true, `${node.id} depends on missing ${dep}`);
    }
  }
});

test("buildChatTurnDag rejects empty prompts", async () => {
  await assert.rejects(
    () => buildChatTurnDag({
      prompt: "   ",
      runId: "chat-empty",
      providerPolicy: "auto",
      intent: intent(),
    }),
    /must not be empty/
  );
});

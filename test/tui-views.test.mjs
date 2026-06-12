import test from "node:test";
import assert from "node:assert/strict";

const { renderDagView, renderEvidenceView, renderCapabilitiesView } = await import("../dist/tui/views/index.js");

function snapshot() {
  return {
    runId: "green-rain-run",
    updatedAt: "2026-05-30T00:00:00.000Z",
    todos: [],
    events: [],
    state: {
      schemaVersion: 1,
      runId: "green-rain-run",
      startedAt: "2026-05-30T00:00:00.000Z",
      nodes: [
        {
          id: "planner",
          name: "route green rain work",
          role: "planner",
          dependsOn: [],
          status: "done",
          retries: 0,
          maxRetries: 1,
          outputs: [{ name: "plan", gate: "summary", ref: "## Plan" }],
          evidence: [{ gate: "summary", passed: true, ref: "## Plan", message: "captured" }],
          routing: {
            provider: "auto",
            providerModel: "auto",
            mcpServers: ["omk-project"],
            skills: ["omk-design-system", "omk-quality-gate", "omk-typescript-strict"],
            hooks: ["stop-verify.sh"],
            tools: ["ctx_read"],
          },
        },
        {
          id: "reviewer",
          name: "verify evidence gates",
          role: "reviewer",
          dependsOn: ["planner"],
          status: "running",
          retries: 0,
          maxRetries: 1,
          routing: { evidenceRequired: true, assignedCapabilities: { skills: ["omk-code-review"] } },
        },
      ],
    },
  };
}

test("dag view renders node status, routing, and dependency summary", () => {
  const frame = renderDagView(snapshot(), { width: 90 });
  assert.equal(frame.title, "graph");
  assert.match(frame.lines.join("\n"), /✓ planner planner route green rain work route=auto\/auto/);
  assert.match(frame.lines.join("\n"), /▶ reviewer reviewer verify evidence gates route=auto deps=planner/);
  assert.equal(frame.footer, "run#green-rain-run");
});

test("evidence view renders output gates and evidence records", () => {
  const frame = renderEvidenceView(snapshot(), { width: 90 });
  const output = frame.lines.join("\n");
  assert.equal(frame.title, "evidence");
  assert.match(output, /output:summary plan -> ## Plan/);
  assert.match(output, /gate:summary ## Plan captured/);
  assert.match(output, /reviewer evidence required/);
  assert.equal(frame.footer, "Evidence or it did not happen.");
});

test("capabilities view renders tool-plane scopes with truncation-safe frame", () => {
  const frame = renderCapabilitiesView(snapshot(), { width: 120 });
  const output = frame.lines.join("\n");
  assert.equal(frame.title, "tool plane");
  assert.match(output, /mcp=\[omk-project\]/);
  assert.match(output, /skills=\[omk-design-system, omk-quality-gate, \+1\]/);
  assert.match(output, /hooks=\[stop-verify\.sh\]/);
  assert.match(output, /tools=\[ctx_read\]/);
});

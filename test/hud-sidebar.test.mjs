import test from "node:test";
import assert from "node:assert/strict";

import { buildHudSidebar, parseGitStatusPorcelain, renderHudColumns, selectLatestRunName } from "../dist/commands/hud.js";

test("HUD parses porcelain git changes for changed file sidebar", () => {
  const changes = parseGitStatusPorcelain(" M README.md\nA  src/new.ts\nR  old.ts -> src/renamed.ts\n?? test/hud-sidebar.test.mjs\n");

  assert.deepEqual(changes, [
    { status: "M", path: "README.md" },
    { status: "A", path: "src/new.ts" },
    { status: "R", path: "src/renamed.ts" },
    { status: "??", path: "test/hud-sidebar.test.mjs" },
  ]);
});

test("HUD sidebar renders run TODOs and changed files", () => {
  const sidebar = buildHudSidebar(
    {
      schemaVersion: 1,
      runId: "test-run",
      goal: {
        title: "critical_issue_scan",
        objective: "Find critical issues",
        successCriteria: [],
        status: "running",
      },
      routeDecision: {
        intent: "critical_issue_scan",
        selectedAgents: ["repo_explorer", "security_reviewer"],
        reason: "critical scan",
        requiredEvidence: [
          { kind: "diff", required: true, description: "changed file diffs" },
          { kind: "test", required: true, description: "affected test result" },
        ],
        mode: "read-only",
      },
      capabilityAssignments: {
        code: {
          skills: ["omk-typescript-strict"],
          mcpServers: ["omk-project"],
          hooks: ["stop-verify.sh"],
        },
      },
      startedAt: new Date(0).toISOString(),
      nodes: [
        { id: "plan", name: "Plan the work", role: "planner", dependsOn: [], status: "done", retries: 0, maxRetries: 1 },
        { id: "code", name: "Implement HUD sidebar", role: "coder", dependsOn: ["plan"], status: "running", retries: 0, maxRetries: 1 },
      ],
    },
    [{ status: "M", path: "src/commands/hud.ts" }]
  );

  assert.match(sidebar, /TODO/);
  assert.match(sidebar, /Right Rail/);
  assert.match(sidebar, /progress/);
  assert.match(sidebar, /1\/2/);
  assert.match(sidebar, /critical_issue_scan/);
  assert.match(sidebar, /read-only/);
  assert.match(sidebar, /Implement HUD sidebar/);
  assert.match(sidebar, /skills:omk-typescript-strict/);
  assert.match(sidebar, /hooks:stop-verify\.sh/);
  assert.match(sidebar, /mcp:omk-project/);
  assert.match(sidebar, /Changed Files/);
  assert.match(sidebar, /src\/commands\/hud\.ts/);
});

test("HUD sidebar renders provider route and fallback metrics", () => {
  const sidebar = buildHudSidebar(
    {
      schemaVersion: 1,
      runId: "provider-run",
      startedAt: new Date(0).toISOString(),
      nodes: [
        {
          id: "review",
          name: "Review provider route",
          role: "reviewer",
          dependsOn: [],
          status: "done",
          retries: 0,
          maxRetries: 1,
          attempts: [
            {
              attempt: 1,
              startedAt: new Date(0).toISOString(),
              status: "done",
              provider: "kimi",
              requestedProvider: "deepseek",
              fallbackFrom: "deepseek",
              fallbackReason: "provider unavailable",
            },
          ],
        },
      ],
    },
    []
  );

  assert.match(sidebar, /provider/);
  assert.match(sidebar, /1 attempt/);
  assert.match(sidebar, /kimi=1/);
  assert.match(sidebar, /fallback 1/);
});

test("HUD layout can place sidebar beside main panels on wide terminals", () => {
  const layout = renderHudColumns(["LEFT"], "RIGHT", 120);
  assert.match(layout, /LEFT\s+RIGHT/);
});

test("HUD layout honors COLUMNS fallback outside TTY", () => {
  const previousColumns = process.env.COLUMNS;
  process.env.COLUMNS = "80";
  try {
    const layout = renderHudColumns(["LEFT"], "RIGHT");
    assert.equal(layout, "LEFT\n\nRIGHT");
  } finally {
    if (previousColumns === undefined) {
      delete process.env.COLUMNS;
    } else {
      process.env.COLUMNS = previousColumns;
    }
  }
});

test("HUD latest run selection ignores stale latest directory", () => {
  const selected = selectLatestRunName([
    { name: "latest", mtimeMs: 999, hasState: false, hasGoal: false, hasPlan: false },
    { name: "2026-05-01T00-00-00-000Z", mtimeMs: 100, hasState: true, hasGoal: true, hasPlan: true },
  ]);

  assert.equal(selected, "2026-05-01T00-00-00-000Z");
});

test("HUD latest run selection prefers newer state-only run over older state+goal+plan", () => {
  const selected = selectLatestRunName([
    { name: "2026-05-01T00-00-00-000Z", mtimeMs: 100, hasState: true, hasGoal: true, hasPlan: true },
    { name: "2026-05-02T00-00-00-000Z", mtimeMs: 200, hasState: true, hasGoal: false, hasPlan: false },
  ]);
  assert.equal(selected, "2026-05-02T00-00-00-000Z");
});

test("HUD latest run selection deprioritizes latest alias", () => {
  const selected = selectLatestRunName([
    { name: "latest", mtimeMs: 200, hasState: true, hasGoal: true, hasPlan: true },
    { name: "2026-05-01T00-00-00-000Z", mtimeMs: 200, hasState: true, hasGoal: true, hasPlan: true },
  ]);
  assert.equal(selected, "2026-05-01T00-00-00-000Z");
});

test("HUD latest run selection prefers schemaVersion:1 over old schema when same mtime", () => {
  const selected = selectLatestRunName([
    { name: "old-run", mtimeMs: 200, hasState: true, hasGoal: false, hasPlan: false, schemaVersion: 0 },
    { name: "new-run", mtimeMs: 200, hasState: true, hasGoal: false, hasPlan: false, schemaVersion: 1 },
  ]);
  assert.equal(selected, "new-run");
});

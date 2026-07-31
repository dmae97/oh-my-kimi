import test from "node:test";
import assert from "node:assert/strict";

import {
  assertNoParallelWriterConflicts,
  createLaneGrantFromDagNode,
  createLaneIsolationPlan,
  findParallelWriterConflicts,
  isReadOnlyLane,
  isWriteLane,
  validateLaneGrant,
} from "../dist/orchestration/lane-grant.js";

function baseGrant(overrides = {}) {
  return {
    laneId: "impl-core",
    role: "coder",
    goal: "Implement bounded core change",
    authority: "write-scoped",
    scope: "src/core only",
    allowedPaths: ["src/core"],
    blockedPaths: ["**/.env*", "**/*secret*", "**/*key*"],
    skills: ["omk-typescript-strict"],
    hooks: ["protect-secrets.sh"],
    mcp: ["omk-project"],
    acceptance: ["tests pass"],
    evidenceOutput: ".omk/runs/run-1/impl-core.md",
    ...overrides,
  };
}

test("validateLaneGrant enforces explicit provisioning fields", () => {
  const grant = validateLaneGrant(baseGrant());

  assert.equal(grant.laneId, "impl-core");
  assert.equal(isWriteLane(grant), true);
  assert.equal(isReadOnlyLane(grant), false);
});

test("read-only lanes cannot declare product write paths", () => {
  assert.throws(
    () => validateLaneGrant(baseGrant({ authority: "read-only", allowedPaths: ["src"] })),
    /must not declare product write paths/
  );
});

test("write-scoped lanes must declare allowedPaths", () => {
  assert.throws(
    () => validateLaneGrant(baseGrant({ allowedPaths: [] })),
    /must declare allowedPaths/
  );
});

test("evidence output must stay under .omk/runs", () => {
  assert.throws(
    () => validateLaneGrant(baseGrant({ evidenceOutput: "../leak.md" })),
    /escapes repository scope/
  );
  assert.throws(
    () => validateLaneGrant(baseGrant({ evidenceOutput: "tmp/lane.md" })),
    /must stay under \.omk\/runs/
  );
  assert.throws(
    () => validateLaneGrant(baseGrant({ allowedPaths: ["src/.."] })),
    /escapes repository scope/
  );
});

test("parallel writer conflicts catch same path and parent child overlap", () => {
  const conflicts = findParallelWriterConflicts([
    baseGrant({ laneId: "impl-a", allowedPaths: ["src/runtime"] }),
    baseGrant({ laneId: "impl-b", allowedPaths: ["src/runtime/router.ts"], evidenceOutput: ".omk/runs/run-1/impl-b.md" }),
    baseGrant({ laneId: "review", authority: "review-only", allowedPaths: [], evidenceOutput: ".omk/runs/run-1/review.md" }),
  ]);

  assert.deepEqual(conflicts, [
    {
      leftLaneId: "impl-a",
      rightLaneId: "impl-b",
      path: "src/runtime",
      conflictingPath: "src/runtime/router.ts",
    },
  ]);
  assert.throws(
    () => assertNoParallelWriterConflicts([
      baseGrant({ laneId: "impl-a", allowedPaths: ["src/runtime"] }),
      baseGrant({ laneId: "impl-b", allowedPaths: ["src/runtime/router.ts"], evidenceOutput: ".omk/runs/run-1/impl-b.md" }),
    ]),
    /Parallel writer conflict/
  );
});

test("parallel writer checks reject duplicate evidence outputs", () => {
  assert.throws(
    () => assertNoParallelWriterConflicts([
      baseGrant({ laneId: "impl-a" }),
      baseGrant({ laneId: "impl-b", allowedPaths: ["src/other"] }),
    ]),
    /evidenceOutput conflict/
  );
});

test("createLaneIsolationPlan returns deterministic branch and worktree paths", () => {
  const grant = baseGrant({ laneId: "impl-core" });
  const plan = createLaneIsolationPlan(grant, { runId: "run-20260613", worktreeRoot: ".omk/worktrees" });

  assert.deepEqual(plan, {
    laneId: "impl-core",
    branchName: "work/run-20260613/impl-core",
    worktreePath: ".omk/worktrees/run-20260613/impl-core",
    evidenceOutput: ".omk/runs/run-1/impl-core.md",
    readOnly: false,
    authority: "write-scoped",
  });
});

test("createLaneGrantFromDagNode derives routing grants from DAG nodes", () => {
  const grant = createLaneGrantFromDagNode(
    {
      id: "review-api",
      name: "Review API surface",
      role: "reviewer",
      dependsOn: [],
      status: "pending",
      retries: 0,
      maxRetries: 1,
      routing: {
        readOnly: true,
        skills: ["omk-code-review"],
        hooks: ["stop-verify.sh"],
        mcpServers: ["filesystem-readonly"],
      },
      outputs: [{ name: "review evidence", gate: "summary" }],
    },
    { evidenceOutput: ".omk/runs/run-1/review-api.md" }
  );

  assert.equal(grant.authority, "read-only");
  assert.equal(grant.skills.includes("omk-code-review"), true);
  assert.equal(grant.mcp.includes("filesystem-readonly"), true);
  assert.equal(grant.forbiddenActions.includes("out-of-scope edits"), true);
  assert.equal(isReadOnlyLane(grant), true);
});

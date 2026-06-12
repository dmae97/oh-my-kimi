import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { doCommand } = await import("../dist/commands/do.js");

test("doCommand compiles a natural prompt into safe UX artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "omk-do-"));
  try {
    const result = await doCommand("explain this repo", {
      root,
      cwd: root,
      mode: "plan",
      provider: "codex",
      model: "codex-cli",
      mcpScope: "none",
      dryRun: true,
      emit: false,
      now: () => new Date("2026-05-30T00:00:00.000Z"),
    });

    assert.equal(result.success, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.intent, "explain");
    assert.equal(result.mode, "plan");
    assert.equal(result.safety, "read-only");
    assert.equal(existsSync(result.paths.inputEnvelope), true);
    assert.equal(existsSync(result.paths.dag), true);
    assert.equal(existsSync(result.paths.dagReport), true);

    const envelope = JSON.parse(await readFile(result.paths.inputEnvelope, "utf8"));
    assert.equal(envelope.provider, "codex");
    assert.equal(envelope.model, "codex-cli");
    assert.equal(envelope.mcpScope, "none");
    assert.deepEqual(envelope.constraints.includes("ux-mode:plan"), true);

    const report = JSON.parse(await readFile(result.paths.dagReport, "utf8"));
    assert.equal(report.executionStrategy, "plan-only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

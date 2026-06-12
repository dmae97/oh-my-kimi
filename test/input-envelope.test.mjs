import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildInputEnvelope, normalizeMcpScope, sanitizeInputTextForArtifact } =
  await import("../dist/input/input-envelope.js");
const { persistInputEnvelope } =
  await import("../dist/input/input-artifacts.js");

test("InputEnvelope normalizes chat input and redacts secret-shaped values", () => {
  const secret = "github_pat_" + "A".repeat(32);
  const envelope = buildInputEnvelope({
    runId: "run-input-test",
    kind: "plain-prompt",
    raw: `  verify harness with ${secret}  `,
    source: "chat",
    cwd: "/tmp/project",
    root: "/tmp/project",
    rootSource: "strong-marker",
    provider: "codex",
    model: "codex-cli",
    mcpScope: normalizeMcpScope("project"),
    now: () => new Date("2026-05-30T00:00:00.000Z"),
  });

  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.kind, "plain-prompt");
  assert.equal(envelope.normalized.includes(secret), false);
  assert.match(envelope.normalized, /\[REDACTED:secret\]/);
  assert.equal(envelope.provider, "codex");
  assert.equal(envelope.mcpScope, "project");
  assert.match(envelope.inputId, /^input-2026-05-30T00-00-00-000Z-/);
});

test("InputEnvelope preserves slash command structure", () => {
  const envelope = buildInputEnvelope({
    runId: "run-slash-test",
    kind: "slash-command",
    raw: "/view evidence --json",
    source: "chat",
    cwd: "/tmp/project",
    root: "/tmp/project",
    provider: "codex",
    slashCommand: {
      command: "/view",
      argv: ["evidence", "--json"],
      positional: ["evidence"],
      flags: { json: true },
    },
    now: () => new Date("2026-05-30T00:00:01.000Z"),
  });

  assert.equal(envelope.kind, "slash-command");
  assert.equal(envelope.slashCommand.command, "/view");
  assert.deepEqual(envelope.slashCommand.positional, ["evidence"]);
  assert.deepEqual(envelope.slashCommand.flags, { json: true });
});

test("persistInputEnvelope writes latest and append-only history files", async () => {
  const root = await mkdtemp(join(tmpdir(), "omk-input-envelope-"));
  try {
    const envelope = buildInputEnvelope({
      runId: "run-persist-test",
      kind: "plain-prompt",
      raw: "summarize run evidence",
      source: "chat",
      cwd: root,
      root,
      provider: "codex",
      now: () => new Date("2026-05-30T00:00:02.000Z"),
    });

    const paths = await persistInputEnvelope(envelope, { root });
    assert.equal(existsSync(paths.latestPath), true);
    assert.equal(existsSync(paths.historyPath), true);
    const latest = JSON.parse(await readFile(paths.latestPath, "utf8"));
    const history = JSON.parse(await readFile(paths.historyPath, "utf8"));
    assert.equal(latest.inputId, envelope.inputId);
    assert.equal(history.inputId, envelope.inputId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sanitizeInputTextForArtifact redacts token flags while preserving key names", () => {
  const secret = "sk-" + "A".repeat(24);
  const result = sanitizeInputTextForArtifact(`--api-key ${secret}`);
  assert.equal(result.text.includes(secret), false);
  assert.match(result.text, /--api-key \[REDACTED:secret\]/);
  assert.equal(result.redactionCount, 1);
});

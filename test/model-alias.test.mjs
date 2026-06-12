import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist", "cli.js");

function runModelCli(home, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      OMK_ORIGINAL_HOME: home,
      OMK_PROVIDER_CONFIG_PATH: join(home, ".config", "omk", "providers.json"),
      NO_COLOR: "1",
    },
  });
}

test("model alias add and resolve stay user-local and secret-free", () => {
  const home = mkdtempSync(join(tmpdir(), "omk-model-home-"));
  try {
    const add = runModelCli(home, ["model", "alias", "add", "fast", "deepseek/flash", "--json"]);
    assert.equal(add.status, 0, add.stderr);
    const added = JSON.parse(add.stdout);
    assert.equal(added.command, "model alias add");
    assert.equal(added.alias, "fast");
    assert.equal(added.target, "deepseek/deepseek-v4-flash");
    assert.equal(added.secretValuesPrinted, false);

    const resolved = runModelCli(home, ["model", "resolve", "fast", "--json"]);
    assert.equal(resolved.status, 0, resolved.stderr);
    const payload = JSON.parse(resolved.stdout);
    assert.equal(payload.command, "model resolve");
    assert.equal(payload.provider, "deepseek");
    assert.equal(payload.model, "deepseek-v4-flash");
    assert.equal(payload.source, "user-alias");
    assert.equal(payload.tokenFilesRead, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("provider use and model use persist defaults without secret values", () => {
  const home = mkdtempSync(join(tmpdir(), "omk-provider-use-home-"));
  try {
    const providerUse = runModelCli(home, ["provider", "use", "codex", "--model", "codex", "--json"]);
    assert.equal(providerUse.status, 0, providerUse.stderr);
    const providerPayload = JSON.parse(providerUse.stdout);
    assert.equal(providerPayload.command, "provider use");
    assert.equal(providerPayload.defaultProvider, "codex");
    assert.equal(providerPayload.defaultModel, "codex-cli");
    assert.equal(providerPayload.secretValuesPrinted, false);

    const modelUse = runModelCli(home, ["model", "use", "sonnet", "--json"]);
    assert.equal(modelUse.status, 0, modelUse.stderr);
    const modelPayload = JSON.parse(modelUse.stdout);
    assert.equal(modelPayload.command, "model use");
    assert.equal(modelPayload.defaultProvider, "openrouter");
    assert.equal(modelPayload.defaultModel, "claude-sonnet");
    assert.equal(modelPayload.secretValuesPrinted, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

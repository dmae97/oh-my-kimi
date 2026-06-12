import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist", "cli.js");

test("auth --json emits metadata-only provider auth center without secrets", () => {
  const home = mkdtempSync(join(tmpdir(), "omk-auth-home-"));
  const bin = mkdtempSync(join(tmpdir(), "omk-auth-bin-"));
  mkdirSync(join(home, ".config", "omk"), { recursive: true });
  const marker = ["deepseek", "value", "that", "must", "not", "print"].join("-");
  try {
    const result = spawnSync(process.execPath, [CLI, "auth", "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        OMK_ORIGINAL_HOME: home,
        OMK_PROVIDER_CONFIG_PATH: join(home, ".config", "omk", "providers.json"),
        PATH: bin,
        NO_COLOR: "1",
        DEEPSEEK_API_KEY: marker,
      },
      maxBuffer: 10 * 1024 * 1024,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, new RegExp(marker, "u"));
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema, "omk.auth-center/status.v1");
    assert.equal(payload.command, "auth");
    assert.equal(payload.mode, "metadata-only");
    assert.equal(payload.tokenFilesRead, false);
    assert.equal(payload.secretValuesRead, false);
    assert.equal(payload.secretValuesPrinted, false);
    assert.equal(payload.projectFilesWritten, false);
    assert.ok(payload.providers.some((entry) => entry.provider === "deepseek" && entry.apiKeyEnv === "DEEPSEEK_API_KEY" && entry.apiKeyEnvPresent === true));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("auth selected provider exits softly when unavailable", () => {
  const home = mkdtempSync(join(tmpdir(), "omk-auth-soft-home-"));
  const bin = mkdtempSync(join(tmpdir(), "omk-auth-soft-bin-"));
  try {
    const hard = spawnSync(process.execPath, [CLI, "auth", "deepseek", "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        OMK_ORIGINAL_HOME: home,
        OMK_PROVIDER_CONFIG_PATH: join(home, ".config", "omk", "providers.json"),
        PATH: bin,
        NO_COLOR: "1",
        DEEPSEEK_API_KEY: "",
      },
    });
    assert.equal(hard.status, 1, hard.stderr);
    assert.equal(JSON.parse(hard.stdout).ok, false);

    const soft = spawnSync(process.execPath, [CLI, "auth", "deepseek", "--json", "--soft"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        OMK_ORIGINAL_HOME: home,
        OMK_PROVIDER_CONFIG_PATH: join(home, ".config", "omk", "providers.json"),
        PATH: bin,
        NO_COLOR: "1",
        DEEPSEEK_API_KEY: "",
      },
    });
    assert.equal(soft.status, 0, soft.stderr);
    assert.equal(JSON.parse(soft.stdout).ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

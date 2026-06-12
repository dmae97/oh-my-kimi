import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  parseSemverParts,
  compareVersions,
  isOutdated,
  formatStartupUpdateBanner,
  maybePromptForOmkUpdate,
  resolveOmkUpdatePromptState,
} from "../dist/util/update-check.js";

function fakeUpdateStatus(overrides = {}) {
  return {
    omk: {
      current: "1.1.17",
      latest: "1.1.18",
      outdated: true,
      error: null,
      installCmd: "npm i -g open-multi-agent-kit",
      ...(overrides.omk ?? {}),
    },
    kimi: {
      installed: "1.0.0",
      latest: "1.0.0",
      outdated: false,
      error: null,
      installCmd: "uv tool upgrade kimi-cli --no-cache",
      fallbackInstallCmd: "curl -LsSf https://code.kimi.com/install.sh | bash",
      installScript: "curl -LsSf https://code.kimi.com/install.sh | bash",
      ...(overrides.kimi ?? {}),
    },
    checkedAt: "2026-05-21T00:00:00.000Z",
    cacheHit: true,
    ...overrides,
  };
}

test("parseSemverParts parses valid semver", () => {
  assert.deepEqual(parseSemverParts("1.41.0"), [1, 41, 0]);
  assert.deepEqual(parseSemverParts("0.4.0"), [0, 4, 0]);
  assert.deepEqual(parseSemverParts("10.20.30"), [10, 20, 30]);
});

test("parseSemverParts returns null for invalid input", () => {
  assert.equal(parseSemverParts(""), null);
  assert.equal(parseSemverParts("abc"), null);
  assert.equal(parseSemverParts("1.2"), null);
  assert.equal(parseSemverParts("1.2.3-beta"), null);
});

test("compareVersions orders correctly", () => {
  assert.strictEqual(compareVersions("1.41.0", "1.40.0"), 1);
  assert.strictEqual(compareVersions("1.40.0", "1.41.0"), -1);
  assert.strictEqual(compareVersions("1.41.0", "1.41.0"), 0);
  assert.strictEqual(compareVersions("2.0.0", "1.99.99"), 1);
  assert.strictEqual(compareVersions("1.0.1", "1.0.2"), -1);
});

test("compareVersions returns 0 for unparseable versions", () => {
  assert.strictEqual(compareVersions("bad", "1.0.0"), 0);
  assert.strictEqual(compareVersions("1.0.0", "bad"), 0);
});

test("isOutdated detects outdated versions", () => {
  assert.strictEqual(isOutdated("1.40.0", "1.41.0"), true);
  assert.strictEqual(isOutdated("1.41.0", "1.41.0"), false);
  assert.strictEqual(isOutdated("2.0.0", "1.99.99"), false);
  assert.strictEqual(isOutdated("1.0.0", "1.0.1"), true);
});

test("isOutdated handles local newer than latest", () => {
  assert.strictEqual(isOutdated("99.0.0", "1.0.0"), false);
});

test("formatStartupUpdateBanner renders omk package updates and suppresses removed Kimi CLI hints", () => {
  const omkBanner = formatStartupUpdateBanner(fakeUpdateStatus());
  assert.match(omkBanner, /omk 1\.1\.17 → 1\.1\.18/);
  assert.match(omkBanner, /npm i -g open-multi-agent-kit/);
  assert.doesNotMatch(omkBanner, /kimi 1\.0\.0/);

  const kimiBanner = formatStartupUpdateBanner(fakeUpdateStatus({
    omk: { outdated: false },
    kimi: { installed: "0.9.0", latest: "1.0.0", outdated: true },
  }));
  assert.equal(kimiBanner, "");
  assert.doesNotMatch(kimiBanner, /kimi-cli 0\.9\.0 → 1\.0\.0/);
  assert.doesNotMatch(kimiBanner, /omk update kimi-adapter/);
  assert.doesNotMatch(kimiBanner, /npm i -g open-multi-agent-kit/);
});

test("resolveOmkUpdatePromptState respects skip, remind, off, and force", () => {
  const status = fakeUpdateStatus();
  const now = new Date("2026-05-21T00:00:00.000Z");

  assert.deepEqual(
    resolveOmkUpdatePromptState({
      status,
      isTTY: true,
      isCI: false,
      now,
      state: { skippedVersion: "1.1.18" },
    }),
    { shouldPrompt: false, reason: "skipped-version", latestVersion: "1.1.18" }
  );

  assert.deepEqual(
    resolveOmkUpdatePromptState({
      status,
      isTTY: true,
      isCI: false,
      now,
      state: { remindAfter: "2026-05-21T02:00:00.000Z" },
    }),
    {
      shouldPrompt: false,
      reason: "remind-active",
      latestVersion: "1.1.18",
      remindAfter: "2026-05-21T02:00:00.000Z",
    }
  );

  assert.equal(resolveOmkUpdatePromptState({
    status,
    isTTY: true,
    isCI: false,
    env: { OMK_UPDATE_PROMPT: "off" },
    state: { skippedVersion: "1.1.18" },
  }).reason, "disabled");

  assert.deepEqual(
    resolveOmkUpdatePromptState({
      status,
      isTTY: true,
      isCI: false,
      env: { OMK_UPDATE_PROMPT: "force" },
      state: { skippedVersion: "1.1.18" },
    }),
    { shouldPrompt: true, reason: "prompt", latestVersion: "1.1.18" }
  );
});

test("maybePromptForOmkUpdate stores skip and remind-later state", async () => {
  const status = fakeUpdateStatus();
  const now = new Date("2026-05-21T00:00:00.000Z");
  const skipPath = join(mkdtempSync(join(tmpdir(), "omk-update-prompt-skip-")), "update-prompt.json");
  const remindPath = join(mkdtempSync(join(tmpdir(), "omk-update-prompt-remind-")), "update-prompt.json");

  const skip = await maybePromptForOmkUpdate({
    status,
    statePath: skipPath,
    isTTY: true,
    isCI: false,
    now,
    selectPrompt: async () => "skip-version",
    runUpdate: async () => { throw new Error("should not update"); },
    onLog: () => {},
  });
  assert.equal(skip.action, "prompted-skip");
  assert.equal(skip.shouldExit, false);
  assert.deepEqual(JSON.parse(readFileSync(skipPath, "utf-8")), {
    skippedVersion: "1.1.18",
    updatedAt: "2026-05-21T00:00:00.000Z",
  });

  const remind = await maybePromptForOmkUpdate({
    status,
    statePath: remindPath,
    env: { OMK_UPDATE_REMIND_HOURS: "2" },
    isTTY: true,
    isCI: false,
    now,
    selectPrompt: async () => "remind-later",
    runUpdate: async () => { throw new Error("should not update"); },
    onLog: () => {},
  });
  assert.equal(remind.action, "prompted-remind");
  assert.deepEqual(JSON.parse(readFileSync(remindPath, "utf-8")), {
    remindAfter: "2026-05-21T02:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  });
});

test("maybePromptForOmkUpdate skips disabled, non-TTY, and CI before update checks", async () => {
  const cases = [
    { name: "disabled", options: { env: { OMK_UPDATE_PROMPT: "never" }, isTTY: true, isCI: false } },
    { name: "non-tty", options: { env: { OMK_UPDATE_PROMPT: "force" }, isTTY: false, isCI: false } },
    { name: "ci", options: { env: { GITHUB_ACTIONS: "true" }, isTTY: true } },
  ];

  for (const item of cases) {
    let checkCalls = 0;
    const result = await maybePromptForOmkUpdate({
      ...item.options,
      checkUpdatesFn: async () => {
        checkCalls += 1;
        return fakeUpdateStatus();
      },
      selectPrompt: async () => { throw new Error("should not prompt"); },
      runUpdate: async () => { throw new Error("should not update"); },
      onLog: () => {},
    });
    assert.equal(result.action, item.name);
    assert.equal(result.shouldExit, false);
    assert.equal(checkCalls, 0);
  }
});

test("maybePromptForOmkUpdate honors persisted skip and remind state", async () => {
  const now = new Date("2026-05-21T00:00:00.000Z");
  const skipPath = join(mkdtempSync(join(tmpdir(), "omk-update-prompt-skip-state-")), "update-prompt.json");
  const remindPath = join(mkdtempSync(join(tmpdir(), "omk-update-prompt-remind-state-")), "update-prompt.json");

  const first = await maybePromptForOmkUpdate({
    status: fakeUpdateStatus(),
    statePath: skipPath,
    isTTY: true,
    isCI: false,
    now,
    selectPrompt: async () => "skip-version",
    onLog: () => {},
  });
  assert.equal(first.action, "prompted-skip");

  const skipped = await maybePromptForOmkUpdate({
    status: fakeUpdateStatus(),
    statePath: skipPath,
    isTTY: true,
    isCI: false,
    now,
    selectPrompt: async () => { throw new Error("should not prompt"); },
    runUpdate: async () => { throw new Error("should not update"); },
    onLog: () => {},
  });
  assert.equal(skipped.action, "skipped-version");
  assert.equal(skipped.shouldExit, false);

  const remind = await maybePromptForOmkUpdate({
    status: fakeUpdateStatus(),
    statePath: remindPath,
    env: { OMK_UPDATE_REMIND_HOURS: "2" },
    isTTY: true,
    isCI: false,
    now,
    selectPrompt: async () => "remind-later",
    onLog: () => {},
  });
  assert.equal(remind.action, "prompted-remind");

  const activeReminder = await maybePromptForOmkUpdate({
    status: fakeUpdateStatus(),
    statePath: remindPath,
    isTTY: true,
    isCI: false,
    now: new Date("2026-05-21T01:00:00.000Z"),
    selectPrompt: async () => { throw new Error("should not prompt"); },
    runUpdate: async () => { throw new Error("should not update"); },
    onLog: () => {},
  });
  assert.equal(activeReminder.action, "remind-active");
  assert.equal(activeReminder.shouldExit, false);
});

test("maybePromptForOmkUpdate executes update only on Update now", async () => {
  const status = fakeUpdateStatus();
  const logs = [];
  const result = await maybePromptForOmkUpdate({
    status,
    statePath: join(mkdtempSync(join(tmpdir(), "omk-update-prompt-update-")), "update-prompt.json"),
    isTTY: true,
    isCI: false,
    selectPrompt: async (config) => {
      assert.match(config.message, /New OMK version available: v1\.1\.18/);
      assert.equal(config.choices.length, 3);
      return "update-now";
    },
    runUpdate: async () => ({ failed: false, stdout: "ok", stderr: "", exitCode: 0 }),
    onLog: (line) => logs.push(line),
  });

  assert.equal(result.action, "updated");
  assert.equal(result.shouldExit, true);
  assert.equal(result.exitCode, 0);
  assert.match(logs.join("\n"), /Running update: npm i -g open-multi-agent-kit/);
  assert.match(logs.join("\n"), /Restart omk chat/);
});

test("maybePromptForOmkUpdate reports failed updates and manual command", async () => {
  const logs = [];
  const result = await maybePromptForOmkUpdate({
    status: fakeUpdateStatus(),
    statePath: join(mkdtempSync(join(tmpdir(), "omk-update-prompt-fail-")), "update-prompt.json"),
    isTTY: true,
    isCI: false,
    selectPrompt: async () => "update-now",
    runUpdate: async () => ({ failed: true, stdout: "", stderr: "registry denied", exitCode: 1 }),
    onLog: (line) => logs.push(line),
  });

  assert.equal(result.action, "update-failed");
  assert.equal(result.shouldExit, true);
  assert.equal(result.exitCode, 1);
  assert.match(logs.join("\n"), /Update failed: registry denied/);
  assert.match(logs.join("\n"), /Manual update command: npm i -g open-multi-agent-kit/);
});

test("maybePromptForOmkUpdate treats prompt cancellation as non-fatal", async () => {
  let updateCalls = 0;
  const err = new Error("cancelled");
  err.name = "ExitPromptError";
  const result = await maybePromptForOmkUpdate({
    status: fakeUpdateStatus(),
    statePath: join(mkdtempSync(join(tmpdir(), "omk-update-prompt-cancel-")), "update-prompt.json"),
    isTTY: true,
    isCI: false,
    selectPrompt: async () => { throw err; },
    runUpdate: async () => {
      updateCalls += 1;
      return { failed: false, stdout: "", stderr: "", exitCode: 0 };
    },
    onLog: () => {},
  });

  assert.equal(result.action, "cancelled");
  assert.equal(result.shouldExit, false);
  assert.equal(updateCalls, 0);
});

test("maybePromptForOmkUpdate treats prompt timeout as non-fatal", async () => {
  let updateCalls = 0;
  const err = new Error("timeout");
  err.name = "AbortError";
  const result = await maybePromptForOmkUpdate({
    status: fakeUpdateStatus(),
    statePath: join(mkdtempSync(join(tmpdir(), "omk-update-prompt-timeout-")), "update-prompt.json"),
    isTTY: true,
    isCI: false,
    selectPrompt: async () => { throw err; },
    runUpdate: async () => {
      updateCalls += 1;
      return { failed: false, stdout: "", stderr: "", exitCode: 0 };
    },
    onLog: () => {},
  });

  assert.equal(result.action, "timeout");
  assert.equal(result.shouldExit, false);
  assert.equal(updateCalls, 0);
});

test("root startup delegates OMK update prompting to shared helper", () => {
  const source = readFileSync(join(process.cwd(), "src", "cli", "root.ts"), "utf-8");
  assert.match(source, /maybePromptForOmkUpdate/);
  assert.doesNotMatch(source, /A new version of open_multi-agent_kit is available/);
  assert.doesNotMatch(source, /YES — run/);
});

test("checkUpdates returns expected structure via import", async () => {
  const { checkUpdates } = await import("../dist/util/update-check.js");
  const status = await checkUpdates();
  assert.strictEqual(typeof status.omk.current, "string");
  assert.strictEqual(typeof status.kimi.installCmd, "string");
  assert.strictEqual(typeof status.kimi.fallbackInstallCmd, "string");
  assert.strictEqual(typeof status.checkedAt, "string");
  assert.strictEqual(typeof status.cacheHit, "boolean");
  const jsonStr = JSON.stringify(status);
  assert.ok(!jsonStr.includes("\u001b"), "JSON contains ANSI codes");
  assert.ok(!jsonStr.includes("\\u001b"), "JSON contains escaped ANSI codes");
  assert.ok(status.kimi.fallbackInstallCmd.length > 0, "fallbackInstallCmd is empty");
});

test("omk update check --json outputs valid JSON", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "omk-cli-test-"));
  const cliJs = join(process.cwd(), "dist", "cli.js");
  const result = spawnSync("node", [cliJs, "update", "check", "--json", "--refresh"], {
    cwd: tmpDir,
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, OMK_NO_STAR: "1" },
  });
  const status = JSON.parse(result.stdout);
  assert.strictEqual(typeof status.omk.current, "string");
  assert.strictEqual(typeof status.kimi.fallbackInstallCmd, "string");
  assert.strictEqual(typeof status.kimi.installScript, "string");
  assert.strictEqual(typeof status.cacheHit, "boolean");
});

test("omk update kimi-adapter --install-script reports direct Moonshot API configuration", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "omk-cli-test-"));
  const cliJs = join(process.cwd(), "dist", "cli.js");
  const result = spawnSync("node", [cliJs, "update", "kimi-adapter", "--install-script", "--refresh"], {
    cwd: tmpDir,
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, OMK_NO_STAR: "1" },
  });
  const output = result.stdout.trim();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(
    output.includes("kimi-api uses direct Moonshot HTTP API") && output.includes("~/.kimi/config.toml"),
    `Expected direct API configuration guidance, got: ${output}`
  );
});

test("legacy omk update kimi --install-script remains an explicit adapter alias", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "omk-cli-test-"));
  const cliJs = join(process.cwd(), "dist", "cli.js");
  const result = spawnSync("node", [cliJs, "update", "kimi", "--install-script", "--refresh"], {
    cwd: tmpDir,
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, OMK_NO_STAR: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(result.stdout.trim().length > 0);
});

test("omk update kimi-adapter non-TTY exits with error", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "omk-cli-test-"));
  const cliJs = join(process.cwd(), "dist", "cli.js");
  const result = spawnSync("node", [cliJs, "update", "kimi-adapter"], {
    cwd: tmpDir,
    encoding: "utf-8",
    timeout: 30000,
    stdio: "pipe",
    env: { ...process.env, OMK_NO_STAR: "1" },
  });
  assert.ok(
    result.status !== 0 || result.stderr.toLowerCase().includes("tty"),
    `Expected non-TTY error, got exit ${result.status}: ${result.stderr}`
  );
});

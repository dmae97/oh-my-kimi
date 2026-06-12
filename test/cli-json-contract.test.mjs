import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { goalListCommand, goalShowCommand, goalVerifyCommand } from "../dist/commands/goal.js";
import {
  providerAuthCommand,
  providerDeepSeekDisableCommand,
  providerDisableCommand,
  providerDoctorCommand,
  providerEnableCommand,
  providerListCommand,
  providerOAuthCommand,
  providerProfilesCommand,
  providerSetCommand,
} from "../dist/commands/provider.js";
import { doctorCommand } from "../dist/commands/doctor.js";
import { mcpDoctorCommand } from "../dist/commands/mcp.js";
import { runsCommand } from "../dist/commands/runs.js";
import { screenshotDirCommand, screenshotListCommand } from "../dist/commands/screenshot.js";
import { servarrConfigPathCommand, servarrInstancesCommand } from "../dist/integrations/servarr/commands.js";
import { verifyCommand } from "../dist/commands/verify.js";
import { reviewCommand } from "../dist/commands/workflow.js";
import { CliError } from "../dist/util/cli-contract.js"; 
import { resetKimiCapabilities } from "../dist/kimi/capability.js";

async function tempCwd() {
  const dir = await mkdtemp(join(tmpdir(), "omk-cli-"));
  await mkdir(join(dir, ".omk"), { recursive: true });
  return dir;
}


function setEnv(name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

function parseSingleStdoutJson(cap) {
  assert.equal(cap.stdout.length, 1, "should emit exactly one stdout line");
  return JSON.parse(cap.stdout[0]);
}

function captureOutput() {
  const stdout = [];
  const stderr = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => stdout.push(args.join(" "));
  console.error = (...args) => stderr.push(args.join(" "));
  return {
    stdout,
    stderr,
    restore() {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

// ── goal --json contract ──────────────────────────────────────

test("goal list --json skips alpha warning and outputs parseable JSON", async () => {
  const cwd = await tempCwd();
  const prevCwd = process.cwd();
  process.chdir(cwd);
  const cap = captureOutput();

  try {
    await goalListCommand({ json: true });
  } finally {
    cap.restore();
    process.chdir(prevCwd);
  }

  assert.equal(cap.stdout.length, 1, "should emit exactly one stdout line");
  const parsed = JSON.parse(cap.stdout[0]);
  assert.ok(Array.isArray(parsed), "should be an array");
  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
  assert.ok(!cap.stdout[0].includes("alpha"), "should not contain alpha warning");
});

test("goal show --json on missing goal emits JSON error to stdout and stderr", async () => {
  const cwd = await tempCwd();
  const prevCwd = process.cwd();
  process.chdir(cwd);
  const cap = captureOutput();

  let thrown = false;
  try {
    await goalShowCommand("nonexistent", { json: true });
  } catch (err) {
    thrown = true;
    assert.ok(err instanceof CliError, "should throw CliError");
  } finally {
    cap.restore();
    process.chdir(prevCwd);
  }

  assert.ok(thrown, "should throw");
  assert.equal(cap.stdout.length, 1, "should emit exactly one stdout line");
  const parsed = JSON.parse(cap.stdout[0]);
  assert.ok(parsed.error, "should contain error field");
  assert.ok(parsed.error.includes("not found"), "error should mention not found");
  assert.equal(cap.stderr.length, 1, "should emit to stderr");
});

test("goal verify --json on missing goal emits JSON error to stdout and stderr", async () => {
  const cwd = await tempCwd();
  const prevCwd = process.cwd();
  process.chdir(cwd);
  const cap = captureOutput();

  let thrown = false;
  try {
    await goalVerifyCommand("nonexistent", { json: true });
  } catch (err) {
    thrown = true;
    assert.ok(err instanceof CliError, "should throw CliError");
  } finally {
    cap.restore();
    process.chdir(prevCwd);
  }

  assert.ok(thrown, "should throw");
  assert.equal(cap.stdout.length, 1, "should emit exactly one stdout line");
  const parsed = JSON.parse(cap.stdout[0]);
  assert.ok(parsed.error, "should contain error field");
  assert.equal(cap.stderr.length, 1, "should emit to stderr");
});


// ── provider/deepseek --json contract ────────────────────────

test("servarr config-path --json emits parseable stdout-only JSON", async () => {
  const cwd = await tempCwd();
  const prevCwd = process.cwd();
  process.chdir(cwd);
  const cap = captureOutput();

  try {
    await servarrConfigPathCommand({ json: true });
  } finally {
    cap.restore();
    process.chdir(prevCwd);
  }

  const parsed = parseSingleStdoutJson(cap);
  assert.equal(parsed.ok, true);
  assert.match(parsed.path.replace(/\\/g, "/"), /\.omk\/servarr\.yml$/u);
  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
});

test("servarr instances --json with missing config is stdout-pure and secret-free", async () => {
  const cwd = await tempCwd();
  const prevCwd = process.cwd();
  const prevExitCode = process.exitCode;
  process.chdir(cwd);
  process.exitCode = undefined;
  const cap = captureOutput();

  try {
    await servarrInstancesCommand({ json: true });
  } finally {
    cap.restore();
    process.chdir(prevCwd);
    process.exitCode = prevExitCode;
  }

  const parsed = parseSingleStdoutJson(cap);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /Servarr config not found/u);
  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
  assert.doesNotMatch(cap.stdout[0], /api[_-]?key|token.*[A-Za-z0-9]{10}/iu);
});

test("provider deepseek disable --json emits parseable JSON without stderr", async () => {
  const cwd = await tempCwd();
  const restoreConfig = setEnv("OMK_PROVIDER_CONFIG_PATH", join(cwd, ".config", "omk", "providers.json"));
  const restoreSecrets = setEnv("OMK_SECRETS_ENV_PATH", join(cwd, ".config", "omk", "secrets.env"));
  const restoreOpenCodeSecrets = setEnv("OPENCODE_SECRETS_ENV_PATH", join(cwd, ".config", "opencode", "secrets.env"));
  const restoreDeepSeekKey = setEnv("DEEPSEEK_API_KEY", undefined);
  const cap = captureOutput();

  try {
    await providerDeepSeekDisableCommand("contract test", { json: true });
  } finally {
    cap.restore();
    restoreDeepSeekKey();
    restoreOpenCodeSecrets();
    restoreSecrets();
    restoreConfig();
  }

  const parsed = parseSingleStdoutJson(cap);
  assert.equal(parsed.provider, "deepseek");
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.disabledReason, "contract test");
  assert.equal(parsed.disabledBy, "user");
  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
});

test("provider doctor deepseek --json --soft is hermetic when disabled", async () => {
  const cwd = await tempCwd();
  const restoreConfig = setEnv("OMK_PROVIDER_CONFIG_PATH", join(cwd, ".config", "omk", "providers.json"));
  const restoreSecrets = setEnv("OMK_SECRETS_ENV_PATH", join(cwd, ".config", "omk", "secrets.env"));
  const restoreOpenCodeSecrets = setEnv("OPENCODE_SECRETS_ENV_PATH", join(cwd, ".config", "opencode", "secrets.env"));
  const restoreDeepSeekKey = setEnv("DEEPSEEK_API_KEY", undefined);
  const previousExitCode = process.exitCode;
  const cap = captureOutput();

  try {
    await providerDeepSeekDisableCommand("offline contract test", { json: false });
    cap.stdout.length = 0;
    cap.stderr.length = 0;
    await providerDoctorCommand("deepseek", { json: true, soft: true });
  } finally {
    cap.restore();
    process.exitCode = previousExitCode;
    restoreDeepSeekKey();
    restoreOpenCodeSecrets();
    restoreSecrets();
    restoreConfig();
  }

  const parsed = parseSingleStdoutJson(cap);
  assert.equal(parsed.provider, "deepseek");
  assert.equal(parsed.available, false);
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.reason, "offline contract test");
  assert.equal(parsed.apiKeySet, false);
  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
});

test("provider generic list/set/enable/disable/doctor --json stays secret-free", async () => {
  const cwd = await tempCwd();
  const restoreConfig = setEnv("OMK_PROVIDER_CONFIG_PATH", join(cwd, ".config", "omk", "providers.json"));
  const restoreQwenKey = setEnv("QWEN_JSON_CONTRACT_KEY", "secret-value-that-must-not-print");
  const previousExitCode = process.exitCode;
  const cap = captureOutput();

  try {
    await providerSetCommand("qwen", {
      model: "Qwen 3.7 MAX",
      baseUrl: "https://dashscope.example/compatible-mode/v1",
      apiKeyEnv: "QWEN_JSON_CONTRACT_KEY",
      json: true,
    });
    const configured = JSON.parse(cap.stdout.pop());
    assert.equal(configured.provider, "qwen");
    assert.equal(configured.enabled, true);
    assert.equal(configured.defaultModel, "qwen3-max");
    assert.equal(configured.apiKeyEnv, "QWEN_JSON_CONTRACT_KEY");

    await providerDoctorCommand("qwen", { json: true, soft: true });
    const doctor = JSON.parse(cap.stdout.pop());
    assert.equal(doctor.provider, "qwen");
    assert.equal(doctor.available, true);
    assert.equal(doctor.apiKeySet, true);

    await providerDisableCommand("qwen", "contract disable", { json: true });
    const disabled = JSON.parse(cap.stdout.pop());
    assert.equal(disabled.provider, "qwen");
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.disabledReason, "contract disable");

    await providerEnableCommand("qwen", { json: true });
    const enabled = JSON.parse(cap.stdout.pop());
    assert.equal(enabled.provider, "qwen");
    assert.equal(enabled.enabled, true);

    await providerListCommand({ json: true });
    const listed = JSON.parse(cap.stdout.pop());
    assert.ok(listed.providers.some((entry) => entry.provider === "qwen" && entry.defaultModel === "qwen3-max"));
  } finally {
    cap.restore();
    process.exitCode = previousExitCode;
    restoreQwenKey();
    restoreConfig();
  }

  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
  assert.doesNotMatch(cap.stdout.join("\n"), /secret-value-that-must-not-print/u);
});

test("provider oauth --json emits instructions only without reading or storing secrets", async () => {
  const cwd = await tempCwd();
  const restoreRoot = setEnv("OMK_PROJECT_ROOT", cwd);
  const restoreToken = setEnv("CODEX_OAUTH_TOKEN", "oauth-token-that-must-not-print-1234567890");
  const cap = captureOutput();

  try {
    await providerOAuthCommand("codex", { json: true });
  } finally {
    cap.restore();
    restoreToken();
    restoreRoot();
  }

  const parsed = parseSingleStdoutJson(cap);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "provider oauth");
  assert.equal(parsed.provider, "codex");
  assert.equal(parsed.exchangePerformed, false);
  assert.equal(parsed.authBypass, false);
  assert.equal(parsed.authJsonRead, false);
  assert.equal(parsed.tokenFilesRead, false);
  assert.equal(parsed.secretValuesPrinted, false);
  assert.equal(parsed.secretsStored, false);
  assert.equal(parsed.projectFilesWritten, false);
  assert.equal(parsed.tokensRead, false);
  assert.match(parsed.nextActions.join("\n"), /codex login/);
  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
  assert.doesNotMatch(cap.stdout[0], /oauth-token-that-must-not-print/u);
});

test("provider auth/profiles/openrouter oauth --json stays metadata-only and secret-free", async () => {
  const cwd = await tempCwd();
  const restoreRoot = setEnv("OMK_PROJECT_ROOT", cwd);
  const restoreConfig = setEnv("OMK_PROVIDER_CONFIG_PATH", join(cwd, ".config", "omk", "providers.json"));
  const restoreOpenRouterKey = setEnv("OPENROUTER_API_KEY", "openrouter-secret-value-that-must-not-print");
  const cap = captureOutput();

  try {
    await providerAuthCommand("openrouter", {
      method: "oauth",
      apiKeyEnv: "OPENROUTER_API_KEY",
      json: true,
    });
    await providerProfilesCommand({ json: true });
    await providerOAuthCommand("openrouter", { json: true });
  } finally {
    cap.restore();
    restoreOpenRouterKey();
    restoreConfig();
    restoreRoot();
  }

  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
  assert.equal(cap.stdout.length, 3);
  const auth = JSON.parse(cap.stdout[0]);
  assert.equal(auth.ok, true);
  assert.equal(auth.command, "provider auth");
  assert.equal(auth.provider, "openrouter");
  assert.equal(auth.authMethod, "oauth");
  assert.equal(auth.apiKeyEnv, "OPENROUTER_API_KEY");
  assert.equal(auth.secretValuesPrinted, false);
  const profiles = JSON.parse(cap.stdout[1]);
  assert.equal(profiles.command, "provider profiles");
  assert.ok(profiles.profiles.some((profile) => profile.id === "openrouter-credits"));
  assert.ok(profiles.profiles.some((profile) => profile.id === "codex-chatgpt-plan"));
  const oauth = JSON.parse(cap.stdout[2]);
  assert.equal(oauth.provider, "openrouter");
  assert.equal(oauth.oauthAvailable, true);
  assert.equal(oauth.exchangePerformed, false);
  assert.equal(oauth.apiKeyEnv, "OPENROUTER_API_KEY");
  assert.doesNotMatch(cap.stdout.join("\n"), /openrouter-secret-value-that-must-not-print/u);
});

// ── screenshot --json contract ───────────────────────────────

test("screenshot dir --json emits project-local directory without stderr", async () => {
  const cwd = await tempCwd();
  const restoreRoot = setEnv("OMK_PROJECT_ROOT", cwd);
  const cap = captureOutput();

  try {
    await screenshotDirCommand({ json: true });
  } finally {
    cap.restore();
    restoreRoot();
  }

  const parsed = parseSingleStdoutJson(cap);
  assert.equal(parsed.dir, join(cwd, ".omk", "screenshots"));
  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
});

test("screenshot list --json emits saved screenshot metadata without stderr", async () => {
  const cwd = await tempCwd();
  const shotDir = join(cwd, ".omk", "screenshots", "2026-05-08");
  await mkdir(shotDir, { recursive: true });
  await writeFile(join(shotDir, "sample.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const restoreRoot = setEnv("OMK_PROJECT_ROOT", cwd);
  const cap = captureOutput();

  try {
    await screenshotListCommand({ json: true });
  } finally {
    cap.restore();
    restoreRoot();
  }

  const parsed = parseSingleStdoutJson(cap);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].relativePath, ".omk/screenshots/2026-05-08/sample.png");
  assert.equal(parsed.entries[0].size, 4);
  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
});

// ── mcp doctor --json contract ───────────────────────────────

test("mcp doctor --json emits common machine-readable fields", async () => {
  const cwd = await tempCwd();
  await mkdir(join(cwd, ".kimi"), { recursive: true });
  await writeFile(join(cwd, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
  const restoreRoot = setEnv("OMK_PROJECT_ROOT", cwd);
  const restoreHome = setEnv("HOME", cwd);
  const restoreOriginalHome = setEnv("OMK_ORIGINAL_HOME", cwd);
  const cap = captureOutput();
  const previousExitCode = process.exitCode;

  try {
    await mcpDoctorCommand({ json: true });
  } finally {
    cap.restore();
    process.exitCode = previousExitCode;
    restoreOriginalHome();
    restoreHome();
    restoreRoot();
  }

  const parsed = parseSingleStdoutJson(cap);
  assert.equal(parsed.command, "mcp doctor");
  assert.match(parsed.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Array.isArray(parsed.errors));
  assert.ok(Array.isArray(parsed.warnings));
  assert.equal(parsed.data.activeScope, parsed.activeScope);
  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
});

test("doctor --json includes sanitized project root diagnostics for HOME git fallback", async () => {
  const home = await mkdtemp(join(tmpdir(), "omk-doctor-root-home-"));
  const project = join(home, "work", "app");
  await mkdir(join(project, ".omk"), { recursive: true });
  await mkdir(join(project, ".kimi"), { recursive: true });
  await writeFile(join(project, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
  const git = spawnSync("git", ["init"], { cwd: home, encoding: "utf-8" });
  assert.equal(git.status, 0, git.stderr || git.stdout);

  const restoreRoot = setEnv("OMK_PROJECT_ROOT", undefined);
  const restoreDefault = setEnv("OMK_DEFAULT_PROJECT_ROOT", project);
  const restoreHome = setEnv("HOME", home);
  const restoreOriginalHome = setEnv("OMK_ORIGINAL_HOME", home);
  const previousCwd = process.cwd();
  const cap = captureOutput();
  const previousExitCode = process.exitCode;

  try {
    process.chdir(home);
    await doctorCommand({ json: true, soft: true });
  } finally {
    cap.restore();
    process.exitCode = previousExitCode;
    process.chdir(previousCwd);
    restoreOriginalHome();
    restoreHome();
    restoreDefault();
    restoreRoot();
  }

  const parsed = parseSingleStdoutJson(cap);
  assert.equal(parsed.data.root.source, "default-env");
  assert.equal(parsed.data.root.activeCwd, "~");
  assert.equal(parsed.data.root.detectedGitRoot, "~");
  assert.equal(parsed.data.root.effectiveProjectRoot, "~/work/app");
  assert.equal(parsed.data.root.homeIsGitRepo, true);
  assert.match(parsed.data.security.childEnvIsolation, /parent env not inherited/);
  assert.match(parsed.data.security.sandboxEnforcement, /OS-level .*not enforced/);
  assert.equal(parsed.data.security.sandboxMetadata.osSandbox, "not-enforced");
  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
});

test("doctor flags empty AGENTS files and --fix restores them from templates", async () => {
  const home = await mkdtemp(join(tmpdir(), "omk-doctor-empty-agents-home-"));
  const project = join(home, "work", "app");
  await mkdir(join(project, ".omk"), { recursive: true });
  await mkdir(join(project, ".kimi"), { recursive: true });
  await writeFile(join(project, "AGENTS.md"), "", "utf-8");
  await writeFile(join(project, ".kimi", "AGENTS.md"), "", "utf-8");
  await writeFile(join(project, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");

  const restoreRoot = setEnv("OMK_PROJECT_ROOT", project);
  const restoreHome = setEnv("HOME", home);
  const restoreOriginalHome = setEnv("OMK_ORIGINAL_HOME", home);
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;

  try {
    process.chdir(project);
    const cap = captureOutput();
    try {
      await doctorCommand({ json: true, soft: true });
    } finally {
      cap.restore();
      process.exitCode = previousExitCode;
    }
    const report = parseSingleStdoutJson(cap);
    assert.ok(report.errors.some((error) => error.name === "AGENTS.md" && /empty/.test(error.message)));
    assert.ok(report.errors.some((error) => error.name === ".kimi/AGENTS.md" && /empty/.test(error.message)));

    const fixCap = captureOutput();
    try {
      await doctorCommand({ json: true, soft: true, fix: true });
    } finally {
      fixCap.restore();
      process.exitCode = previousExitCode;
    }
    const fixed = parseSingleStdoutJson(fixCap);
    assert.ok(fixed.fixes.actions.some((action) => /restored AGENTS\.md from template/.test(action)));
    assert.ok(fixed.fixes.actions.some((action) => /restored \.kimi[\\/]AGENTS\.md from template/.test(action)));
    assert.ok((await readFile(join(project, "AGENTS.md"), "utf-8")).trim().length > 0);
    assert.ok((await readFile(join(project, ".kimi", "AGENTS.md"), "utf-8")).trim().length > 0);
  } finally {
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
    restoreOriginalHome();
    restoreHome();
    restoreRoot();
  }
});

test("doctor --fix --set-default-project-root supports dry-run and sanitized backup", async () => {
  const home = await mkdtemp(join(tmpdir(), "omk-doctor-set-default-home-"));
  const project = join(home, "work", "app");
  await mkdir(project, { recursive: true });
  await mkdir(join(home, ".omk"), { recursive: true });
  await writeFile(join(home, ".omk", "config.toml"), "api_token = \"SHOULD_NOT_LEAK\"\n", "utf-8");
  const git = spawnSync("git", ["init"], { cwd: home, encoding: "utf-8" });
  assert.equal(git.status, 0, git.stderr || git.stdout);

  const restoreRoot = setEnv("OMK_PROJECT_ROOT", undefined);
  const restoreDefault = setEnv("OMK_DEFAULT_PROJECT_ROOT", undefined);
  const restoreHome = setEnv("HOME", home);
  const restoreOriginalHome = setEnv("OMK_ORIGINAL_HOME", home);
  const previousCwd = process.cwd();

  try {
    process.chdir(home);
    const dryCap = captureOutput();
    try {
      await doctorCommand({ json: true, soft: true, fix: true, dryRun: true, setDefaultProjectRoot: project });
    } finally {
      dryCap.restore();
    }
    const dryReport = parseSingleStdoutJson(dryCap);
    assert.equal(dryReport.fixes.dryRun, true);
    assert.ok(dryReport.fixes.actions.some((action) => /would set user default_project_root/.test(action)));
    assert.doesNotMatch(await readFile(join(home, ".omk", "config.toml"), "utf-8"), /default_project_root/);

    const cap = captureOutput();
    try {
      await doctorCommand({ json: true, soft: true, fix: true, setDefaultProjectRoot: project });
    } finally {
      cap.restore();
    }
    const report = parseSingleStdoutJson(cap);
    assert.ok(report.fixes.actions.some((action) => /set user default_project_root/.test(action)));
    assert.equal(report.fixes.backups.length, 1);
    assert.match(await readFile(join(home, ".omk", "config.toml"), "utf-8"), /default_project_root/);
    assert.doesNotMatch(await readFile(report.fixes.backups[0], "utf-8"), /SHOULD_NOT_LEAK/);
  } finally {
    process.chdir(previousCwd);
    restoreOriginalHome();
    restoreHome();
    restoreDefault();
    restoreRoot();
  }
});

test("doctor --fix --dry-run emits typed fixPlan without writing safe repairs", async () => {
  const home = await mkdtemp(join(tmpdir(), "omk-doctor-plan-dry-home-"));
  const project = join(home, "work", "app");
  await mkdir(join(project, ".omk", "memory"), { recursive: true });
  await writeFile(join(project, ".omk", "runtime-preset.json"), JSON.stringify({ id: "omk-core-verified" }), "utf-8");
  await writeFile(join(project, ".omk", "config.toml"), "[runtime]\nmcp_scope = \"bad\"\n[memory]\nbackend = \"bad\"\n", "utf-8");

  const restoreRoot = setEnv("OMK_PROJECT_ROOT", project);
  const restoreHome = setEnv("HOME", home);
  const restoreOriginalHome = setEnv("OMK_ORIGINAL_HOME", home);
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;

  try {
    process.chdir(project);
    const cap = captureOutput();
    try {
      await doctorCommand({ json: true, soft: true, fix: true, dryRun: true, verifyFix: false });
    } finally {
      cap.restore();
      process.exitCode = previousExitCode;
    }
    const report = parseSingleStdoutJson(cap);
    assert.equal(report.fixes.dryRun, true);
    assert.equal(report.fixes.fixPlan.dryRun, true);
    assert.equal(report.fixes.fixPlan.changed, false);
    const operations = report.fixes.fixPlan.operations;
    assert.ok(operations.some((op) => op.id === "runtime-preset-default" && op.status === "planned"));
    assert.ok(operations.some((op) => op.id === "project-config-safe-defaults" && op.status === "planned"));
    assert.ok(operations.some((op) => op.id === "lsp-config" && op.status === "planned"));
    assert.ok(operations.some((op) => op.id === "memory-graph-state" && op.status === "planned"));
    assert.doesNotMatch(await readFile(join(project, ".omk", "runtime-preset.json"), "utf-8"), /omk-parallel-orchestrator/);
    assert.match(await readFile(join(project, ".omk", "config.toml"), "utf-8"), /mcp_scope = "bad"/);
    await assert.rejects(readFile(join(project, ".omk", "lsp.json"), "utf-8"));
    await assert.rejects(readFile(join(project, ".omk", "memory", "graph-state.json"), "utf-8"));
  } finally {
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
    restoreOriginalHome();
    restoreHome();
    restoreRoot();
  }
});

test("doctor --fix repairs safe runtime scaffold and includes post-check summary", async () => {
  const home = await mkdtemp(join(tmpdir(), "omk-doctor-plan-fix-home-"));
  const project = join(home, "work", "app");
  await mkdir(join(project, ".omk", "memory"), { recursive: true });
  await writeFile(join(project, ".omk", "runtime-preset.json"), JSON.stringify({ id: "omk-core-verified" }), "utf-8");
  await writeFile(join(project, ".omk", "runtime-presets.json"), JSON.stringify({ defaultPresetId: "omk-core-verified", presets: [] }), "utf-8");
  await writeFile(
    join(project, ".omk", "config.toml"),
    "[orchestration]\nexecution_prompt = \"bad\"\n[runtime]\nmcp_scope = \"bad\"\nskills_scope = \"bad\"\nhooks_scope = \"bad\"\n[memory]\nbackend = \"bad\"\n[local_graph]\nontology = \"bad\"\n",
    "utf-8"
  );
  await writeFile(join(project, ".omk", "lsp.json"), "{bad json", "utf-8");
  await writeFile(join(project, ".omk", "memory", "graph-state.json"), "{bad json", "utf-8");

  const restoreRoot = setEnv("OMK_PROJECT_ROOT", project);
  const restoreHome = setEnv("HOME", home);
  const restoreOriginalHome = setEnv("OMK_ORIGINAL_HOME", home);
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;

  try {
    process.chdir(project);
    const cap = captureOutput();
    try {
      await doctorCommand({ json: true, soft: true, fix: true, verifyFix: true });
    } finally {
      cap.restore();
      process.exitCode = previousExitCode;
    }
    const report = parseSingleStdoutJson(cap);
    assert.equal(report.fixes.fixPlan.dryRun, false);
    assert.equal(report.fixes.fixPlan.changed, true);
    assert.ok(report.fixes.fixPlan.postCheck);
    assert.ok(report.fixes.fixPlan.postCheck.before.warnings + report.fixes.fixPlan.postCheck.before.errors >= report.fixes.fixPlan.postCheck.after.warnings + report.fixes.fixPlan.postCheck.after.errors);
    assert.ok(report.fixes.fixPlan.operations.some((op) => op.id === "runtime-preset-default" && op.status === "applied"));
    assert.ok(report.fixes.actions.some((action) => /repaired \.omk\/runtime-preset\.json/.test(action)));
    assert.match(await readFile(join(project, ".omk", "runtime-preset.json"), "utf-8"), /omk-parallel-orchestrator/);
    assert.match(await readFile(join(project, ".omk", "runtime-presets.json"), "utf-8"), /"defaultPresetId": "omk-parallel-orchestrator"/);
    const config = await readFile(join(project, ".omk", "config.toml"), "utf-8");
    assert.match(config, /execution_prompt = "ask"/);
    assert.match(config, /mcp_scope = "project"/);
    assert.match(config, /backend = "local_graph"/);
    assert.equal(JSON.parse(await readFile(join(project, ".omk", "lsp.json"), "utf-8")).enabled, true);
    assert.equal(JSON.parse(await readFile(join(project, ".omk", "memory", "graph-state.json"), "utf-8")).version, 1);
  } finally {
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
    restoreOriginalHome();
    restoreHome();
    restoreRoot();
  }
});

test("doctor --json does not flag absolute npm-global MCP binaries as npx launchers", async () => {
  const cwd = await tempCwd();
  const home = await mkdtemp(join(tmpdir(), "omk-doctor-home-"));
  await mkdir(join(home, ".kimi"), { recursive: true });
  await writeFile(
    join(home, ".kimi", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "page-design-guide": {
          command: join(home, ".npm-global", "bin", "page-design-guide"),
          args: [],
        },
      },
    }),
    "utf-8",
  );
  await writeFile(join(home, ".kimi", "config.toml"), "default_model = \"kimi\"\n# >>> omk managed hooks\n", "utf-8");
  const restoreHome = setEnv("HOME", home);
  const restoreOriginalHome = setEnv("OMK_ORIGINAL_HOME", home);
  const prevCwd = process.cwd();
  const previousExitCode = process.exitCode;
  const cap = captureOutput();

  process.chdir(cwd);
  try {
    await doctorCommand({ json: true, soft: true });
  } finally {
    cap.restore();
    process.exitCode = previousExitCode;
    process.chdir(prevCwd);
    restoreOriginalHome();
    restoreHome();
  }

  const parsed = parseSingleStdoutJson(cap);
  assert.equal(parsed.globalSync.globalMcp, "1 MCPs synced (~/.kimi/mcp.json)");
  assert.equal(parsed.warnings.some((warning) => /npx-based/.test(warning.message)), false);
  assert.ok(!parsed.warnings.some((warning) => warning.name === "Global MCP (stdio)"));
  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
});

test("doctor --json downgrades Kimi web-tools warning when agent YAML declares tools", async () => {
  const cwd = await tempCwd();
  const home = await mkdtemp(join(tmpdir(), "omk-doctor-web-home-"));
  const bin = join(home, "bin");
  await mkdir(join(cwd, ".omk", "agents"), { recursive: true });
  await mkdir(join(home, ".kimi"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(cwd, ".omk", "agents", "root.yaml"), `
version: 1
agent:
  name: test
  tools:
    - "kimi_cli.tools.web:SearchWeb"
    - "kimi_cli.tools.web:FetchURL"
`, "utf-8");
  await writeFile(join(home, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
  await writeFile(join(home, ".kimi", "config.toml"), "default_model = \"kimi\"\n# >>> omk managed hooks\n", "utf-8");
  if (process.platform === "win32") {
    await writeFile(join(bin, "kimi.cmd"), `@echo off\r\nif "%1"=="--version" (echo kimi, version 1.41.0) else (\r\necho Usage: kimi [OPTIONS] COMMAND [ARGS]...\r\necho   --agent-file FILE\r\necho   web      Run Kimi Code CLI web interface.\r\n)\r\n`, "utf-8");
  } else {
    await writeFile(join(bin, "kimi"), `#!/usr/bin/env sh\nif [ "$1" = "--version" ]; then\n  echo "kimi, version 1.41.0"\nelse\n  echo "Usage: kimi [OPTIONS] COMMAND [ARGS]..."\n  echo "  --agent-file FILE"\n  echo "  web      Run Kimi Code CLI web interface."\nfi\n`, "utf-8");
    await chmod(join(bin, "kimi"), 0o755);
  }
  const restoreHome = setEnv("HOME", home);
  const restoreOriginalHome = setEnv("OMK_ORIGINAL_HOME", home);
  const restorePath = setEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
  const prevCwd = process.cwd();
  const previousExitCode = process.exitCode;
  const cap = captureOutput();

  resetKimiCapabilities();
  process.chdir(cwd);
  try {
    await doctorCommand({ json: true, soft: true });
  } finally {
    cap.restore();
    process.exitCode = previousExitCode;
    process.chdir(prevCwd);
    restorePath();
    restoreOriginalHome();
    restoreHome();
    resetKimiCapabilities();
  }

  const parsed = parseSingleStdoutJson(cap);
  assert.equal(parsed.kimi.webTools, false);
  assert.ok(!parsed.warnings.some((warning) => warning.name === "Kimi Web Tools"));
  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
});

test("doctor --json classifies normal Kimi home files separately from pollution", async () => {
  const cwd = await tempCwd();
  const home = await mkdtemp(join(tmpdir(), "omk-doctor-pollution-home-"));
  await mkdir(join(home, ".kimi"), { recursive: true });
  for (const name of [
    "config.toml",
    "config.toml.bak",
    "mcp.json",
    "mcp.json.bak-20260508-102923",
    "mcp.manifest.json",
    "mcp.manifest.json.bak_stable_profile_20260507_094002",
    "omk.memory.toml",
    "kimi.json",
    "device_id",
    "latest_version.txt",
    "AGENTS.md",
    "ENI.md",
    "Jailbreak.md",
    "PARALLEL_AGENTS.md",
    "User.md",
    "agent.yaml",
    "mcp-web-search.sh",
    "setup.md",
    "system.md",
    "user.md",
    "eggup-493323.json",
    "eggup-493323.json:Zone.Identifier",
  ]) {
    await writeFile(join(home, ".kimi", name), "ok", "utf-8");
  }
  const restoreHome = setEnv("HOME", home);
  const restoreOriginalHome = setEnv("OMK_ORIGINAL_HOME", home);
  const prevCwd = process.cwd();
  const previousExitCode = process.exitCode;
  const cap = captureOutput();

  process.chdir(cwd);
  try {
    await doctorCommand({ json: true, soft: true });
  } finally {
    cap.restore();
    process.exitCode = previousExitCode;
    process.chdir(prevCwd);
    restoreOriginalHome();
    restoreHome();
  }

  const parsed = parseSingleStdoutJson(cap);
  assert.equal(parsed.globalSync.globalPollution, "~/.kimi clean");
  assert.ok(!parsed.warnings.some((warning) => warning.name === "Global Pollution"));
  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
});

test("doctor --json still warns for unexpected Kimi home pollution", async () => {
  const cwd = await tempCwd();
  const home = await mkdtemp(join(tmpdir(), "omk-doctor-polluted-home-"));
  await mkdir(join(home, ".kimi"), { recursive: true });
  await writeFile(join(home, ".kimi", "config.toml"), "default_model = \"kimi\"\n", "utf-8");
  await writeFile(join(home, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
  await writeFile(join(home, ".kimi", "debug-output.txt"), "unexpected", "utf-8");
  const restoreHome = setEnv("HOME", home);
  const restoreOriginalHome = setEnv("OMK_ORIGINAL_HOME", home);
  const prevCwd = process.cwd();
  const previousExitCode = process.exitCode;
  const cap = captureOutput();

  process.chdir(cwd);
  try {
    await doctorCommand({ json: true, soft: true });
  } finally {
    cap.restore();
    process.exitCode = previousExitCode;
    process.chdir(prevCwd);
    restoreOriginalHome();
    restoreHome();
  }

  const parsed = parseSingleStdoutJson(cap);
  assert.ok(parsed.warnings.some((warning) => warning.name === "Global Pollution"));
  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
});

// ── runs --json contract ──────────────────────────────────────

test("runs --json on fresh project emits empty JSON array", async () => {
  const cwd = await tempCwd();
  const prevCwd = process.cwd();
  const prevRoot = process.env.OMK_PROJECT_ROOT;
  process.env.OMK_PROJECT_ROOT = cwd;
  process.chdir(cwd);
  const cap = captureOutput();

  try {
    await runsCommand({ json: true });
  } finally {
    cap.restore();
    process.chdir(prevCwd);
    if (prevRoot !== undefined) process.env.OMK_PROJECT_ROOT = prevRoot;
    else delete process.env.OMK_PROJECT_ROOT;
  }

  assert.equal(cap.stdout.length, 1, "should emit exactly one stdout line");
  const parsed = JSON.parse(cap.stdout[0]);
  assert.ok(Array.isArray(parsed), "should be an array");
  assert.equal(parsed.length, 0, "should be empty");
});

// ── verify --json contract ────────────────────────────────────

test("verify --json with missing run emits JSON error to stdout and stderr", async () => {
  const cwd = await tempCwd();
  const prevCwd = process.cwd();
  process.chdir(cwd);
  const cap = captureOutput();

  let thrown = false;
  try {
    await verifyCommand({ run: "missing-run", json: true });
  } catch (err) {
    thrown = true;
    assert.ok(err instanceof CliError, "should throw CliError");
  } finally {
    cap.restore();
    process.chdir(prevCwd);
  }

  assert.ok(thrown, "should throw");
  assert.equal(cap.stdout.length, 1, "should emit exactly one stdout line");
  const parsed = JSON.parse(cap.stdout[0]);
  assert.ok(parsed.error, "should contain error field");
  assert.equal(cap.stderr.length, 1, "should emit to stderr");
});

test("verify --json with missing run-id env emits JSON error to stdout and stderr", async () => {
  const cwd = await tempCwd();
  const prevCwd = process.cwd();
  const prevRunId = process.env.OMK_RUN_ID;
  delete process.env.OMK_RUN_ID;
  process.chdir(cwd);
  const cap = captureOutput();

  let thrown = false;
  try {
    await verifyCommand({ json: true });
  } catch (err) {
    thrown = true;
    assert.ok(err instanceof CliError, "should throw CliError");
  } finally {
    cap.restore();
    process.chdir(prevCwd);
    if (prevRunId !== undefined) process.env.OMK_RUN_ID = prevRunId;
  }

  assert.ok(thrown, "should throw");
  assert.equal(cap.stdout.length, 1, "should emit exactly one stdout line");
  const parsed = JSON.parse(cap.stdout[0]);
  assert.ok(parsed.error, "should contain error field");
  assert.equal(cap.stderr.length, 1, "should emit to stderr");
});

test("verify --json emits common machine-readable fields for a valid run", async () => {
  const cwd = await tempCwd();
  const runId = "json-contract-run";
  const runDir = join(cwd, ".omk", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "state.json"), JSON.stringify({
    schemaVersion: 1,
    runId,
    status: "done",
    startedAt: "2026-05-08T00:00:00.000Z",
    completedAt: "2026-05-08T00:00:01.000Z",
    nodes: [],
  }), "utf-8");
  const prevCwd = process.cwd();
  const prevProjectRoot = process.env.OMK_PROJECT_ROOT;
  process.chdir(cwd);
  delete process.env.OMK_PROJECT_ROOT;
  const cap = captureOutput();

  try {
    await verifyCommand({ run: runId, json: true });
  } finally {
    cap.restore();
    if (prevProjectRoot !== undefined) process.env.OMK_PROJECT_ROOT = prevProjectRoot;
    else delete process.env.OMK_PROJECT_ROOT;
    process.chdir(prevCwd);
  }

  const parsed = parseSingleStdoutJson(cap);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "verify");
  assert.match(parsed.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.data.runId, runId);
  assert.equal(cap.stderr.length, 0, "should not emit to stderr");
});

// ── review --soft contract ────────────────────────────────────
// Note: review-options.test.mjs covers --ci --soft exit-code behavior in depth.
// The subprocess approach there correctly isolates OMK_PROJECT_ROOT.

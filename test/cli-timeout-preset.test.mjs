import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = join(process.cwd(), "dist", "cli.js");
const DESIGN_MODULE_URL = pathToFileURL(join(process.cwd(), "dist", "commands", "design.js")).href;
const OPEN_DESIGN_AGENT_MODULE_URL = pathToFileURL(join(process.cwd(), "dist", "commands", "open-design-agent.js")).href;
const RUN_MODULE_URL = pathToFileURL(join(process.cwd(), "dist", "commands", "run.js")).href;
const PARALLEL_MODULE_URL = pathToFileURL(join(process.cwd(), "dist", "commands", "parallel.js")).href;
const DAG_MODULE_URL = pathToFileURL(join(process.cwd(), "dist", "commands", "dag.js")).href;
const RUNTIME_SCOPE_MODULE_URL = pathToFileURL(join(process.cwd(), "dist", "util", "runtime-scope.js")).href;
const MODE_PRESET_MODULE_URL = pathToFileURL(join(process.cwd(), "dist", "util", "mode-preset.js")).href;

const WINDOWS_REMOVE_TREE_RETRY_CODES = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);
const WINDOWS_REMOVE_TREE_RETRY_DELAYS_MS = [0, 100, 250, 500, 1000, 1500];

function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableRemoveTreeError(error) {
  return error && typeof error === "object" && WINDOWS_REMOVE_TREE_RETRY_CODES.has(error.code);
}

function removeTree(path) {
  if (process.platform !== "win32") {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return;
  }

  let lastError;
  for (const delayMs of WINDOWS_REMOVE_TREE_RETRY_DELAYS_MS) {
    if (delayMs > 0) waitSync(delayMs);
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      if (!isRetryableRemoveTreeError(error)) throw error;
      lastError = error;
    }
  }

  process.emitWarning(
    `Temporary test cleanup failed for ${path}: ${lastError?.code || lastError?.message || "unknown error"}`,
    { code: "OMK_TEST_CLEANUP_RETRY" },
  );
}

function runHelp(command) {
  return spawnSync(process.execPath, [CLI, command, "--help"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });
}

test("run command exposes --timeout-preset", () => {
  const result = runHelp("run");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--timeout-preset <preset>/);
});

test("parallel command exposes --timeout-preset", () => {
  const result = runHelp("parallel");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--timeout-preset <preset>/);
});

test("chat, run, and parallel commands expose per-run MCP scope", () => {
  for (const command of ["chat", "run", "parallel"]) {
    const result = runHelp(command);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--mcp-scope <all\|project\|none>/);
  }
});

test("chat, run, and parallel commands expose execution selection policy", () => {
  for (const command of ["chat", "run", "parallel"]) {
    const result = runHelp(command);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--execution <ask\|auto\|parallel\|sequential>/);
  }
});

test("chat command exposes opt-in single-pane UI renderer", () => {
  const result = runHelp("chat");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--ui <legacy\|plain-modern\|rich\|system24\|green-rain\|neon-grid>/);
});

test("agent mode preset launches interactive orchestrator chat surface", async () => {
  const { getModePreset } = await import(MODE_PRESET_MODULE_URL);
  assert.equal(getModePreset("agent")?.launchCommand, "chat");
  assert.match(getModePreset("agent")?.description ?? "", /parallel vs one-by-one/);
  assert.equal(getModePreset("chat")?.launchCommand, "chat");
});

test("goal run, continue, and auto expose MCP scope/provider defaults", () => {
  for (const args of [["goal", "run", "--help"], ["goal", "continue", "--help"]]) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        OMK_STAR_PROMPT: "0",
        OMK_RENDER_LOGO: "0",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const normalized = result.stdout.replace(/\s+/g, " ");
    assert.match(result.stdout, /--mcp-scope <all\|project\|none>/);
    assert.match(result.stdout, /--provider <provider>/);
    assert.match(normalized, /provider policy \(auto \| authority \| kimi \| deepseek \| codex \| qwen \| openrouter\)/);
    assert.match(normalized, /default: "?auto"?/);
  }

  const auto = spawnSync(process.execPath, [CLI, "goal", "auto", "--help"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });
  assert.equal(auto.status, 0, auto.stderr);
  const normalizedAuto = auto.stdout.replace(/\s+/g, " ");
  assert.match(auto.stdout, /--provider <provider>/);
  assert.match(normalizedAuto, /provider policy \(auto \| authority \| kimi \| deepseek \| codex \| qwen \| openrouter\)/);
  assert.match(normalizedAuto, /default: "?auto"?/);
});

test("mcp command exposes prewarm for cache-first startup", () => {
  const result = spawnSync(process.execPath, [CLI, "mcp", "--help"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /prewarm/);
  assert.match(result.stdout, /check/);
});

test("mcp prewarm exposes --all and requires server or all", () => {
  const help = spawnSync(process.execPath, [CLI, "mcp", "prewarm", "--help"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--all/);

  const missing = spawnSync(process.execPath, [CLI, "mcp", "prewarm"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr + missing.stdout, /Provide a server name or use --all/);
});

test("mcp check exposes --all and requires server or all", () => {
  const help = spawnSync(process.execPath, [CLI, "mcp", "check", "--help"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--all/);

  const missing = spawnSync(process.execPath, [CLI, "mcp", "check"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr + missing.stdout, /Provide a server name or use --all/);
});

test("mcp doctor exposes fix safety flags", () => {
  const result = spawnSync(process.execPath, [CLI, "mcp", "doctor", "--help"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--fix/);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--global/);
});

test("top-level doctor exposes default project root repair flags", () => {
  const result = runHelp("doctor");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--fix/);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--fix-level <level>/);
  assert.match(result.stdout, /--verify-fix/);
  assert.match(result.stdout, /--no-verify-fix/);
  assert.match(result.stdout, /--set-default-project-root <path>/);
});

test("init command exposes local-user runtime scope option", () => {
  const result = runHelp("init");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--local-user/);
  assert.match(result.stdout, /--home-dir <path>/);
});

test("graph view command exposes ontology viewer options", () => {
  const result = spawnSync(process.execPath, [CLI, "graph", "view", "--help"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--limit <n>/);
  assert.match(result.stdout, /--type <types>/);
  assert.match(result.stdout, /--open/);
});

test("design open-design command exposes localhost launcher options", () => {
  const result = spawnSync(process.execPath, [CLI, "design", "open-design", "--help"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--web-port <port>/);
  assert.match(result.stdout, /--daemon-port <port>/);
  assert.match(result.stdout, /--ref <ref>/);
  assert.match(result.stdout, /--doctor/);
  assert.match(result.stdout, /--open/);
  assert.match(result.stdout, /--print-only/);
});

test("design open-design print-only shows localhost tools-dev launch plan", () => {
  const result = spawnSync(process.execPath, [
    CLI,
    "design",
    "open-design",
    "--print-only",
    "--dir",
    ".omk/open-design-test",
  ], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /http:\/\/localhost:5175/);
  assert.match(result.stdout, /Ref:\s+main \(tested: 3f7a05e7462f097bf38b7cbac0d4a4593deecd80\)/);
  assert.match(result.stdout, /Agent: OMK CLI/);
  assert.match(result.stdout, /git clone --depth 1 --branch main https:\/\/github\.com\/nexu-io\/open-design\.git/);
  assert.match(result.stdout, /corepack pnpm tools-dev start web --daemon-port 7457 --web-port 5175/);
});

test("design open-design doctor emits JSON readiness checks without starting Open Design", () => {
  const dir = join(tmpdir(), `omk-open-design-doctor-${Date.now()}`);
  const result = spawnSync(process.execPath, [
    CLI,
    "design",
    "open-design",
    "--doctor",
    "--json",
    "--dir",
    dir,
  ], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });

  assert.doesNotThrow(() => JSON.parse(result.stdout), result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.command, "design open-design --doctor");
  assert.equal(parsed.testedRef, "3f7a05e7462f097bf38b7cbac0d4a4593deecd80");
  assert.equal(parsed.ref, "main");
  assert.ok(parsed.checks.some((check) => check.id === "node24"));
  assert.ok(parsed.checks.some((check) => check.id === "checkout-package"));
});

test("top-level open-design aliases forward to the localhost launch plan", () => {
  for (const command of ["open-design", "opendesign"]) {
    const result = spawnSync(process.execPath, [
      CLI,
      command,
      "--print-only",
      "--dir",
      ".omk/open-design-test",
    ], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        OMK_STAR_PROMPT: "0",
        OMK_RENDER_LOGO: "0",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Open Design localhost/);
    assert.match(result.stdout, /Agent: OMK CLI/);
  }
});

test("open-design Node runtime can use an explicit Node 24 binary while OMK runs on older Node", async () => {
  const { resolveOpenDesignNodeRuntime } = await import(DESIGN_MODULE_URL);
  const runtime = resolveOpenDesignNodeRuntime({
    nodeVersion: "v22.22.3",
    env: {
      PATH: "/usr/bin",
      OMK_OPEN_DESIGN_NODE24: "/opt/node-v24/bin/node",
    },
    pathExistsSync: (path) => path === "/opt/node-v24/bin/node",
    platform: "linux",
  });

  assert.equal(runtime?.corepackCommand, "/opt/node-v24/bin/corepack");
  assert.equal(runtime?.nodeCommand, "/opt/node-v24/bin/node");
  assert.equal(runtime?.env?.PATH, "/opt/node-v24/bin:/usr/bin");
});

test("design open-design bridge installs awesome-design-md prompt template", async () => {
  const { ensureOpenDesignOmkBridge } = await import(DESIGN_MODULE_URL);
  const root = mkdtempSync(join(tmpdir(), "omk-open-design-bridge-"));
  try {
    const result = await ensureOpenDesignOmkBridge(root);
    const templatePath = join(root, "prompt-templates", "image", "awesome-design-md-web-ui.json");
    const template = JSON.parse(readFileSync(templatePath, "utf-8"));

    assert.equal(template.id, "awesome-design-md-web-ui");
    assert.equal(template.source.repo, "VoltAgent/awesome-design-md");
    assert.match(template.prompt, /omk design search <name>/);
    assert.match(template.prompt, /DESIGN\.md/);
    assert.equal(result.changedFiles.includes("prompt-templates/image/awesome-design-md-web-ui.json"), true);
  } finally {
    removeTree(root);
  }
});

test("design open-design bridge supports current Open Design runtime registry layout", async () => {
  const { ensureOpenDesignOmkBridge } = await import(DESIGN_MODULE_URL);
  const root = mkdtempSync(join(tmpdir(), "omk-open-design-runtime-"));
  try {
    mkdirSync(join(root, "apps/daemon/src/runtimes/defs"), { recursive: true });
    mkdirSync(join(root, "apps/web/src/components"), { recursive: true });
    mkdirSync(join(root, "apps/web/src/utils"), { recursive: true });
    mkdirSync(join(root, "apps/web/src/i18n/locales"), { recursive: true });

    writeFileSync(join(root, "apps/daemon/src/runtimes/registry.ts"), [
      "import { claudeAgentDef } from './defs/claude.js';",
      "import { codexAgentDef } from './defs/codex.js';",
      "import { kimiAgentDef } from './defs/kimi.js';",
      "import type { RuntimeAgentDef } from './types.js';",
      "",
      "export const AGENT_DEFS: RuntimeAgentDef[] = [",
      "  claudeAgentDef,",
      "  codexAgentDef,",
      "  kimiAgentDef,",
      "];",
      "",
    ].join("\n"));
    writeFileSync(join(root, "apps/daemon/src/runtimes/executables.ts"), [
      "const AGENT_BIN_ENV_KEYS = new Map<string, string>([",
      "  ['claude', 'CLAUDE_BIN'],",
      "  ['codex', 'CODEX_BIN'],",
      "  ['kimi', 'KIMI_BIN'],",
      "]);",
      "",
    ].join("\n"));
    writeFileSync(join(root, "apps/daemon/src/app-config.ts"), [
      "const AGENT_CLI_ENV_KEYS = new Map([",
      "  ['claude', new Set(['CLAUDE_BIN'])],",
      "  ['codex', new Set(['CODEX_HOME', 'CODEX_BIN', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'])],",
      "  ['kimi', new Set(['KIMI_BIN'])],",
      "]);",
      "",
    ].join("\n"));
    writeFileSync(join(root, "apps/web/src/components/SettingsDialog.tsx"), [
      "const AGENT_CLI_ENV_FIELDS = [",
      "  {",
      "    agentId: 'codex',",
      "    envKey: 'CODEX_BIN',",
      "    labelKey: 'settings.cliEnvCodexBin',",
      "    placeholder: '/absolute/path/to/codex',",
      "  },",
      "];",
      "",
    ].join("\n"));
    writeFileSync(join(root, "apps/web/src/utils/agentLabels.ts"), [
      "const AGENT_LABELS: Record<string, string> = {",
      "  codex: 'Codex',",
      "};",
      "const AGENT_ALIASES: Record<string, string> = {",
      "  'codex cli': 'codex',",
      "};",
      "",
    ].join("\n"));
    writeFileSync(join(root, "apps/web/src/components/AgentIcon.tsx"), "const ICON_EXT: Record<string, 'svg' | 'png'> = {};\n");

    const result = await ensureOpenDesignOmkBridge(root);
    const registry = readFileSync(join(root, "apps/daemon/src/runtimes/registry.ts"), "utf-8");
    const executables = readFileSync(join(root, "apps/daemon/src/runtimes/executables.ts"), "utf-8");
    const appConfig = readFileSync(join(root, "apps/daemon/src/app-config.ts"), "utf-8");
    const omkDef = readFileSync(join(root, "apps/daemon/src/runtimes/defs/omk.ts"), "utf-8");
    const agentIcon = readFileSync(join(root, "apps/web/src/components/AgentIcon.tsx"), "utf-8");

    assert.match(registry, /omkAgentDef/);
    assert.match(executables, /\['omk', 'OMK_BIN'\]/);
    assert.match(appConfig, /\['omk', new Set\(\['OMK_BIN'\]\)\]/);
    assert.match(omkDef, /--image/);
    assert.match(agentIcon, /omk: 'svg'/);
    assert.match(readFileSync(join(root, "apps/web/public/agent-icons/omk.svg"), "utf-8"), /<svg/);
    assert.equal(result.changedFiles.includes("apps/daemon/src/runtimes/defs/omk.ts"), true);
  } finally {
    removeTree(root);
  }
});

test("open-design-agent smoke exits through OMK without launching Kimi ACP", () => {
  const result = spawnSync(process.execPath, [CLI, "open-design-agent", "--smoke"], {
    cwd: process.cwd(),
    input: "Reply with only: ok",
    encoding: "utf-8",
    timeout: 5000,
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "ok");
});

test("open-design-agent help exposes bounded diagnose and stdio controls", () => {
  const result = spawnSync(process.execPath, [CLI, "open-design-agent", "--help"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--diagnose/);
  assert.match(result.stdout, /--stdio/);
  assert.match(result.stdout, /--stdin-idle-ms/);
  assert.match(result.stdout, /--stdin-max-bytes/);
  assert.match(result.stdout, /--timeout-ms/);
});

test("open-design-agent diagnose emits JSON without launching Kimi", () => {
  const workspace = mkdtempSync(join(tmpdir(), "omk-open-design-diagnose-"));
  try {
    const result = spawnSync(process.execPath, [
      CLI,
      "open-design-agent",
      "--diagnose",
      "--json",
      "--cwd",
      workspace,
      "--run-id",
      "diagnose",
    ], {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 5000,
      env: {
        ...process.env,
        OMK_STAR_PROMPT: "0",
        OMK_RENDER_LOGO: "0",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "open-design-agent --diagnose");
    assert.equal(parsed.runId, "diagnose");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("open-design-agent sanitizes Kimi control-only bridge output", async () => {
  const mod = await import(OPEN_DESIGN_AGENT_MODULE_URL);
  assert.equal(
    mod.sanitizeOpenDesignAgentOutput("<choice>STOP</choice>\n\nTo resume this session: kimi -r 819d1bcc-4192-4134-b241-21265e77227f\n"),
    "",
  );
  assert.equal(
    mod.sanitizeOpenDesignAgentOutput("Created artifact\n<choice>STOP</choice>\n"),
    "Created artifact",
  );
  const modernKey = `sk-proj-${"A".repeat(24)}`;
  const oauthToken = `oauth_token=${"B".repeat(24)}`;
  const sanitized = mod.sanitizeOpenDesignAgentOutput(`key ${modernKey}\n${oauthToken}\nBearer ${"C".repeat(24)}`);
  assert.equal(sanitized.includes(modernKey), false);
  assert.equal(sanitized.includes("B".repeat(24)), false);
  assert.equal(sanitized.includes("C".repeat(24)), false);
  assert.match(sanitized, /sk-\*\*\*/);
});

test("open-design-agent filters secret-like child env and annotates images in prompt", async () => {
  const mod = await import(OPEN_DESIGN_AGENT_MODULE_URL);
  const env = mod.buildSafeOpenDesignKimiEnv({
    PATH: "/bin",
    HOME: "/home/example",
    KIMI_BIN: "/bin/kimi",
    OPENAI_API_KEY: "sk-test",
    CODEX_OAUTH_TOKEN: "oauth-token",
    OMK_PROJECT_ROOT: "/repo",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.KIMI_BIN, "/bin/kimi");
  assert.equal(env.OMK_PROJECT_ROOT, "/repo");
  assert.equal("OPENAI_API_KEY" in env, false);
  assert.equal("CODEX_OAUTH_TOKEN" in env, false);

  const prompt = mod.buildBridgePrompt("Review screenshot", {
    artifactDir: "/tmp/od-artifacts",
    imagePaths: ["/tmp/screenshot.png"],
  });
  assert.match(prompt, /ReadMediaFile/);
  assert.match(prompt, /\/tmp\/screenshot\.png/);
  assert.match(prompt, /gpt-image-2/);
});

test("open-design-agent isolated HOME does not inherit local auth directories by default", () => {
  const root = mkdtempSync(join(tmpdir(), "omk-open-design-auth-isolation-"));
  try {
    const binDir = join(root, "bin");
    const workspace = join(root, "workspace");
    const homeRoot = join(root, "home");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(homeRoot, ".codex"), { recursive: true });
    mkdirSync(join(homeRoot, ".config", "omk"), { recursive: true });
    mkdirSync(join(homeRoot, ".config", "gh"), { recursive: true });

    const fakeKimi = join(binDir, "fake-kimi.mjs");
    writeFileSync(
      fakeKimi,
      [
        "import { existsSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "if (process.argv.includes('--help')) { console.log('kimi --model --thinking'); process.exit(0); }",
        "if (process.argv.includes('--version')) { console.log('kimi, version 1.1.0'); process.exit(0); }",
        "const leaked = ['.codex', '.config/omk', '.config/gh'].filter((entry) => existsSync(join(process.env.HOME, entry)));",
        "if (leaked.length) { console.error('leaked-local-auth:' + leaked.join(',')); process.exit(31); }",
        "console.log('OMK_OPEN_DESIGN_SUCCESS');",
      ].join("\n"),
    );

    if (process.platform === "win32") {
      writeFileSync(
        join(binDir, "kimi.cmd"),
        `@echo off\r\n"${process.execPath}" "${fakeKimi}" %*\r\n`,
      );
    } else {
      writeFileSync(
        join(binDir, "kimi"),
        `#!${process.execPath}\n${readFileSync(fakeKimi, "utf8")}\n`,
      );
      chmodSync(join(binDir, "kimi"), 0o755);
    }

    const result = spawnSync(process.execPath, [
      CLI,
      "open-design-agent",
      "--cwd",
      workspace,
      "--run-id",
      "auth-isolation",
      "--stdio",
      "--timeout-ms",
      "5000",
    ], {
      cwd: process.cwd(),
      input: "Check HOME isolation",
      encoding: "utf-8",
      timeout: 30000,
      env: {
        ...process.env,
        HOME: homeRoot,
        OMK_ORIGINAL_HOME: homeRoot,
        PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
        OMK_STAR_PROMPT: "0",
        OMK_RENDER_LOGO: "0",
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stderr + result.stdout, /leaked-local-auth/);
  } finally {
    removeTree(root);
  }
});

test("open-design-agent treats generated Open Design artifacts as success after Kimi timeout", () => {
  const root = mkdtempSync(join(tmpdir(), "omk-open-design-agent-"));
  try {
    const binDir = join(root, "bin");
    const workspace = join(root, "workspace");
    mkdirSync(binDir);
    mkdirSync(workspace);

    const fakeKimi = join(binDir, "fake-kimi.mjs");
    writeFileSync(
      fakeKimi,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "if (process.argv.includes('--help')) { console.log('kimi --model --thinking'); process.exit(0); }",
        "if (process.argv.includes('--version')) { console.log('kimi, version 1.1.0'); process.exit(0); }",
        "const artifactDir = process.env.OMK_OPEN_DESIGN_ARTIFACT_DIR || '.';",
        "mkdirSync(artifactDir, { recursive: true });",
        "writeFileSync(join(artifactDir, 'index.html'), '<html>ok</html>');",
        "setTimeout(() => {}, 5000);",
      ].join("\n"),
    );

    if (process.platform === "win32") {
      writeFileSync(
        join(binDir, "kimi.cmd"),
        `@echo off\r\n"${process.execPath}" "${fakeKimi}" %*\r\n`,
      );
    } else {
      writeFileSync(
        join(binDir, "kimi"),
        `#!${process.execPath}\n${readFileSync(fakeKimi, "utf8")}\n`,
      );
      chmodSync(join(binDir, "kimi"), 0o755);
    }

    const result = spawnSync(process.execPath, [
      CLI,
      "open-design-agent",
      "--cwd",
      workspace,
      "--run-id",
      "timeout-artifact",
      "--stdio",
      "--timeout-ms",
      "3000",
    ], {
      cwd: process.cwd(),
      input: "Generate an index.html artifact",
      encoding: "utf-8",
      timeout: 15000,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
        OMK_OPEN_DESIGN_ARTIFACT_SETTLE_MS: "0",
        OMK_STAR_PROMPT: "0",
        OMK_RENDER_LOGO: "0",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Generated Open Design artifact: .*index\.html/);
    assert.equal(readFileSync(join(workspace, ".omk", "open-design-artifacts", "timeout-artifact", "index.html"), "utf8"), "<html>ok</html>");
  } finally {
    removeTree(root);
  }
});

test("open-design-agent timeout with stdout only is not success", () => {
  const root = mkdtempSync(join(tmpdir(), "omk-open-design-stdout-timeout-"));
  try {
    const binDir = join(root, "bin");
    const workspace = join(root, "workspace");
    mkdirSync(binDir);
    mkdirSync(workspace);

    const fakeKimi = join(binDir, "fake-kimi.mjs");
    writeFileSync(
      fakeKimi,
      [
        "if (process.argv.includes('--help')) { console.log('kimi --model --thinking'); process.exit(0); }",
        "if (process.argv.includes('--version')) { console.log('kimi, version 1.1.0'); process.exit(0); }",
        "console.log('working');",
        "setTimeout(() => {}, 5000);",
      ].join("\n"),
    );

    if (process.platform === "win32") {
      writeFileSync(
        join(binDir, "kimi.cmd"),
        `@echo off\r\n"${process.execPath}" "${fakeKimi}" %*\r\n`,
      );
    } else {
      writeFileSync(
        join(binDir, "kimi"),
        `#!${process.execPath}\n${readFileSync(fakeKimi, "utf8")}\n`,
      );
      chmodSync(join(binDir, "kimi"), 0o755);
    }

    const result = spawnSync(process.execPath, [
      CLI,
      "open-design-agent",
      "--cwd",
      workspace,
      "--run-id",
      "stdout-timeout",
      "--stdio",
      "--json",
      "--timeout-ms",
      "1000",
    ], {
      cwd: process.cwd(),
      input: "Generate an index.html artifact",
      encoding: "utf-8",
      timeout: 30000,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
        OMK_OPEN_DESIGN_ARTIFACT_SETTLE_MS: "0",
        OMK_STAR_PROMPT: "0",
        OMK_RENDER_LOGO: "0",
      },
    });

    assert.notEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "timeout_no_artifact");
    assert.deepEqual(parsed.artifacts, []);
  } finally {
    removeTree(root);
  }
});

test("open-design-agent exposes precise timeout artifact statuses", async () => {
  const mod = await import(OPEN_DESIGN_AGENT_MODULE_URL);
  assert.equal(mod.classifyOpenDesignBridgeResult({
    failed: true,
    exitCode: 1,
    cleanStdout: "",
    cleanStderr: "timed out after 1000ms",
    generatedArtifacts: [{ path: ".omk/open-design-artifacts/run/index.html", size: 12, modifiedAt: Date.now() }],
  }), "timeout_artifact_ok");
  assert.equal(mod.classifyOpenDesignBridgeResult({
    failed: true,
    exitCode: 1,
    cleanStdout: "working",
    cleanStderr: "timed out after 1000ms",
    generatedArtifacts: [],
  }), "timeout_no_artifact");
  assert.equal(mod.classifyOpenDesignBridgeResult({
    failed: true,
    exitCode: 1,
    cleanStdout: "working",
    cleanStderr: "",
    generatedArtifacts: [],
  }), "fatal");
  assert.equal(mod.classifyOpenDesignBridgeResult({
    failed: true,
    exitCode: 1,
    cleanStdout: "working",
    cleanStderr: "",
    generatedArtifacts: [{ path: ".omk/open-design-artifacts/run/index.html", size: 12, modifiedAt: Date.now() }],
  }), "fatal");
  assert.equal(mod.classifyOpenDesignBridgeResult({
    failed: true,
    exitCode: 1,
    cleanStdout: "OMK_OPEN_DESIGN_SUCCESS",
    cleanStderr: "",
    generatedArtifacts: [{ path: ".omk/open-design-artifacts/run/index.html", size: 12, modifiedAt: Date.now() }],
  }), "artifact_ok");
});

test("open-design-agent does not mask fatal Kimi errors as artifact success", async () => {
  const mod = await import(OPEN_DESIGN_AGENT_MODULE_URL);
  assert.equal(
    mod.shouldTreatOpenDesignBridgeAsSuccess({
      failed: true,
      exitCode: 1,
      cleanStdout: "",
      cleanStderr: "HTTP 401: Invalid Authentication",
      generatedArtifacts: [{ path: "index.html", size: 12, modifiedAt: Date.now() }],
    }),
    false,
  );
});

test("design open-design opener uses the Windows browser bridge under WSL", async () => {
  const { resolveOpenDesignBrowserOpener } = await import(DESIGN_MODULE_URL);
  const opener = await resolveOpenDesignBrowserOpener("http://localhost:5175", {
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu-24.04" },
    commandExists: async (command) => command === "cmd.exe",
  });

  assert.deepEqual(opener, {
    command: "cmd.exe",
    args: ["/c", "start", "", "http://localhost:5175"],
  });
});

test("design open-design opener prefers wslview when available", async () => {
  const { resolveOpenDesignBrowserOpener } = await import(DESIGN_MODULE_URL);
  const opener = await resolveOpenDesignBrowserOpener("http://localhost:5175", {
    platform: "linux",
    env: { WSL_INTEROP: "/run/WSL/123_interop" },
    commandExists: async (command) => command === "wslview" || command === "cmd.exe",
  });

  assert.deepEqual(opener, {
    command: "wslview",
    args: ["http://localhost:5175"],
  });
});

test("design open-design opener falls back to xdg-open on regular Linux", async () => {
  const { resolveOpenDesignBrowserOpener } = await import(DESIGN_MODULE_URL);
  const opener = await resolveOpenDesignBrowserOpener("http://localhost:5175", {
    platform: "linux",
    env: {},
    procVersionText: "Linux version 6.1.0 generic",
    commandExists: async () => false,
  });

  assert.deepEqual(opener, {
    command: "xdg-open",
    args: ["http://localhost:5175"],
  });
});

test("provider deepseek commands expose enable disable and set helpers", () => {
  const result = spawnSync(process.execPath, [CLI, "provider", "deepseek", "--help"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /enable/);
  assert.match(result.stdout, /disable/);
  assert.match(result.stdout, /set/);
});

test("top-level deepseek commands expose official api enable disable helpers", () => {
  const result = spawnSync(process.execPath, [CLI, "deepseek", "--help"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /api/);
  assert.match(result.stdout, /enable/);
  assert.match(result.stdout, /disable/);
  assert.match(result.stdout, /doctor/);
});

test("official deepseek api command exposes safe input options without --api-key", () => {
  const result = spawnSync(process.execPath, [CLI, "deepseek", "api", "--help"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--from-env <name>/);
  assert.doesNotMatch(result.stdout, /--api-key/);
});

test("legacy DeepSeek key commands do not expose direct API key arguments", () => {
  for (const args of [
    ["provider", "deepseek", "set", "--help"],
    ["deepseekset", "--help"],
  ]) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        OMK_STAR_PROMPT: "0",
        OMK_RENDER_LOGO: "0",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--from-env <name>/);
    assert.doesNotMatch(result.stdout, /--api-key/);
    assert.doesNotMatch(result.stdout, /apiKey/i);
  }
});

test("legacy deepseekset positional input does not echo supplied key", () => {
  const fakeKey = `sk-${"d".repeat(32)}`;
  const result = spawnSync(process.execPath, [CLI, "deepseekset", fakeKey, "--json"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      OMK_STAR_PROMPT: "0",
      OMK_RENDER_LOGO: "0",
      DEEPSEEK_API_KEY: "",
    },
  });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(fakeKey));
});

test("slash command templates are packaged", () => {
  const root = join(process.cwd(), "templates", "skills", "kimi");
  const openDesign = readFileSync(join(root, "open-design", "SKILL.md"), "utf-8");
  const awesomeDesignMd = readFileSync(join(root, "awesome-design-md", "SKILL.md"), "utf-8");
  const provider = readFileSync(join(root, "provider", "SKILL.md"), "utf-8");
  const api = readFileSync(join(root, "deepseek-api", "SKILL.md"), "utf-8");
  const enable = readFileSync(join(root, "deepseek-enable", "SKILL.md"), "utf-8");
  const disable = readFileSync(join(root, "deepseek-disable", "SKILL.md"), "utf-8");
  const set = readFileSync(join(root, "deepseekset", "SKILL.md"), "utf-8");
  assert.equal(openDesign.includes("# /open-design"), true);
  assert.match(openDesign, /omk design open-design --open/);
  assert.equal(awesomeDesignMd.includes("# /awesome-design-md"), true);
  assert.match(awesomeDesignMd, /omk design search <keyword>/);
  assert.equal(provider.includes("# /provider"), true);
  assert.match(provider, /omk provider oauth <provider>/);
  assert.equal(api.includes("# /deepseek-api"), true);
  assert.match(api, /omk deepseek api/);
  assert.equal(enable.includes("# /deepseek-enable"), true);
  assert.match(enable, /omk deepseek enable/);
  assert.equal(disable.includes("# /deepseek-disable"), true);
  assert.match(disable, /omk deepseek disable/);
  assert.equal(set.includes("# /deepseekset"), true);
  assert.match(set, /omk deepseek api/);
});

test("chat command leaves mode unset for persisted mode and advertises OMK brand", () => {
  const result = runHelp("chat");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--brand <omk\|minimal\|plain\|green-rain\|neon-grid>/);
  assert.match(result.stdout, /--mode <agent\|plan\|chat\|debugging\|review>/);
  assert.doesNotMatch(result.stdout, /default: agent/);
  assert.doesNotMatch(result.stdout, /kimicat|kimichan/);
});

test("parallel keeps the historical ten-minute node timeout when no preset is requested", () => {
  const source = [
    readFileSync(join(process.cwd(), "src", "commands", "parallel.ts"), "utf-8"),
    readFileSync(join(process.cwd(), "src", "commands", "parallel", "worker.ts"), "utf-8"),
  ].join("\n");
  assert.match(source, /nodeTimeoutMs:\s*options\.timeoutPreset\s*\?\s*undefined\s*:\s*600_000/);
});


test("worker count parsing rejects malformed values and shares OMK_WORKERS fallback", async () => {
  const runMod = await import(RUN_MODULE_URL);
  const parallelMod = await import(PARALLEL_MODULE_URL);
  const dagMod = await import(DAG_MODULE_URL);
  const previousWorkers = process.env.OMK_WORKERS;
  try {
    delete process.env.OMK_WORKERS;
    for (const normalize of [runMod.normalizeWorkerCount, parallelMod.normalizeWorkerCount]) {
      assert.equal(normalize("1.5", 4), 4);
      assert.equal(normalize("2abc", 4), 4);
      assert.equal(normalize("0", 4), 4);
      assert.equal(normalize("9", 4), 6);
      assert.equal(normalize(" 3 ", 4), 3);
      assert.equal(normalize("auto", 4), 4);
    }

    process.env.OMK_WORKERS = "3";
    assert.equal(runMod.normalizeWorkerCount(undefined, 1), 3);
    assert.equal(parallelMod.normalizeWorkerCount(undefined, 1), 3);

    process.env.OMK_WORKERS = "2abc";
    assert.equal(runMod.normalizeWorkerCount(undefined, 5), 5);
    assert.equal(parallelMod.normalizeWorkerCount(undefined, 5), 5);
    assert.equal(dagMod.normalizeReplayWorkerCount("999"), 6);
    assert.equal(dagMod.normalizeReplayWorkerCount("0"), 1);
    assert.equal(dagMod.normalizeReplayWorkerCount(undefined), 1);
  } finally {
    if (previousWorkers === undefined) {
      delete process.env.OMK_WORKERS;
    } else {
      process.env.OMK_WORKERS = previousWorkers;
    }
  }
});

test("runtime scope option parser accepts clean MCP aliases and rejects typos", async () => {
  const { parseRuntimeScopeOption } = await import(RUNTIME_SCOPE_MODULE_URL);
  assert.equal(parseRuntimeScopeOption(undefined, "project"), "project");
  assert.equal(parseRuntimeScopeOption("none", "project"), "none");
  assert.equal(parseRuntimeScopeOption("off", "project"), "none");
  assert.equal(parseRuntimeScopeOption("project", "all"), "project");
  assert.equal(parseRuntimeScopeOption("local", "all"), "project");
  assert.equal(parseRuntimeScopeOption("global", "project"), "all");
  assert.throws(() => parseRuntimeScopeOption("everything", "project"), /Invalid --mcp-scope/);
});

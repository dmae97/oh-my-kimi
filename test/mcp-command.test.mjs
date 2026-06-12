import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

const OMK_ROOT = process.cwd();
const MCP_MODULE_URL = pathToFileURL(join(OMK_ROOT, "dist", "commands", "mcp.js")).href;
const OMK_PROJECT_SERVER = join(OMK_ROOT, "dist", "mcp", "omk-project-server.js");
const OMK_CLI = join(OMK_ROOT, "dist", "cli.js");
const MCP_SCRIPT_TIMEOUT_MS = process.platform === "win32" ? 240000 : 60000;

function runMcpScript(projectRoot, homeRoot, scriptBody, extraEnv = {}) {
  const evalScript = `
      import { writeSync } from "node:fs";
      const writeRetryCodes = new Set(["EAGAIN", "EINTR"]);
      const writeWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
      function writeAllSync(fd, value) {
        const buffer = Buffer.from(value);
        let offset = 0;
        let retries = 0;
        while (offset < buffer.length) {
          let written;
          try {
            written = writeSync(fd, buffer, offset, buffer.length - offset);
          } catch (error) {
            if (writeRetryCodes.has(error?.code) && retries < 1000) {
              retries += 1;
              Atomics.wait(writeWaitBuffer, 0, 0, 5);
              continue;
            }
            throw error;
          }
          if (written <= 0) throw new Error("writeSync made no progress");
          offset += written;
          retries = 0;
        }
      }
      console.log = (...args) => writeAllSync(1, args.join(" ") + "\\n");
      console.error = (...args) => writeAllSync(2, args.join(" ") + "\\n");
      import { mkdir, readFile, writeFile } from "node:fs/promises";
      import { createServer } from "node:http";
      import { join } from "node:path";
      import { buildMcpDoctorReport, mcpDoctorCommand, mcpInstallCommand, mcpListCommand, mcpPrewarmCommand, mcpSyncGlobalCommand, mcpTestCommand } from ${JSON.stringify(MCP_MODULE_URL)};
      import { doctorCommand } from ${JSON.stringify(pathToFileURL(join(OMK_ROOT, "dist", "commands", "doctor.js")).href)};
      import { resolveRuntimeMcpPreflightOptions, syncKimiMcpGlobal, writeRuntimeMcpConfig } from ${JSON.stringify(pathToFileURL(join(OMK_ROOT, "dist", "util", "fs.js")).href)};
      ${scriptBody}
    `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", evalScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      OMK_MCP_SCOPE: "",
      OMK_SKILLS_SCOPE: "",
      OMK_HOOKS_SCOPE: "",
      OMK_MCP_PREFLIGHT: "off",
      OMK_MCP_SUPPRESS_PRUNE_WARNINGS: "",
      ...extraEnv,
      HOME: homeRoot,
      OMK_ORIGINAL_HOME: homeRoot,
      OMK_PROJECT_ROOT: projectRoot,
    },
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: MCP_SCRIPT_TIMEOUT_MS,
  });
}

const REMOVE_TREE_RETRY_CODES = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);
const REMOVE_TREE_RETRY_DELAYS_MS = process.platform === "win32"
  ? [0, 100, 250, 500, 1000, 1500]
  : [0];

function isRetryableRemoveTreeError(error) {
  return error && typeof error === "object" && REMOVE_TREE_RETRY_CODES.has(error.code);
}

async function removeTree(path) {
  let lastError;
  for (const delayMs of REMOVE_TREE_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return;
    } catch (error) {
      if (!isRetryableRemoveTreeError(error)) throw error;
      lastError = error;
    }
  }
  process.emitWarning(
    `Temporary MCP test cleanup failed for ${path}: ${lastError?.code || lastError?.message || "unknown error"}`,
    { code: "OMK_TEST_CLEANUP_RETRY" },
  );
}

function buildPrependPathEnv(directory) {
  const currentPath = process.env.PATH ?? process.env.Path ?? process.env.path ?? "";
  const value = `${directory}${delimiter}${currentPath}`;
  return process.platform === "win32" ? { PATH: value, Path: value } : { PATH: value };
}

async function writeFakeNpm(binDir, body) {
  await mkdir(binDir, { recursive: true });
  const scriptPath = join(binDir, "fake-npm.mjs");
  await writeFile(scriptPath, body, "utf-8");
  if (process.platform === "win32") {
    await writeFile(join(binDir, "npm.cmd"), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf-8");
    return;
  }
  const npmPath = join(binDir, "npm");
  await writeFile(npmPath, `#!/usr/bin/env sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`, "utf-8");
  await chmod(npmPath, 0o755);
}

async function writeEmptyConfigs(projectRoot, homeRoot, omkConfig) {
  await mkdir(join(projectRoot, ".omk"), { recursive: true });
  await mkdir(join(projectRoot, ".kimi"), { recursive: true });
  await mkdir(join(homeRoot, ".kimi"), { recursive: true });
  await writeFile(join(projectRoot, ".omk", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
  await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify(omkConfig), "utf-8");
  await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
}

test("mcp test remote rejects plain HTTP 200 non-MCP endpoints", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-remote-plain-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    const result = runMcpScript(projectRoot, homeRoot, `
      const server = createServer((_, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      await mkdir(join(process.env.OMK_PROJECT_ROOT, ".omk"), { recursive: true });
      await mkdir(join(process.env.OMK_PROJECT_ROOT, ".kimi"), { recursive: true });
      await mkdir(join(process.env.OMK_ORIGINAL_HOME, ".kimi"), { recursive: true });
      await writeFile(join(process.env.OMK_PROJECT_ROOT, ".omk", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
      await writeFile(join(process.env.OMK_ORIGINAL_HOME, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
      await writeFile(join(process.env.OMK_PROJECT_ROOT, ".kimi", "mcp.json"), JSON.stringify({
        mcpServers: { plain: { url: "http://127.0.0.1:" + port + "/mcp", startup_timeout_sec: 1 } },
      }), "utf-8");
      await mcpTestCommand("plain");
    `);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Remote MCP initialize failed/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp test remote performs JSON-RPC initialize with configured headers", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-remote-init-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));
  let seenMethod = "";
  let seenAuth = "";
  let seenHttpHeader = "";

  try {
    const result = runMcpScript(projectRoot, homeRoot, `
      let seenMethod = "";
      let seenAuth = "";
      let seenHttpHeader = "";
      const server = createServer((req, res) => {
        seenMethod = req.method ?? "";
        seenAuth = String(req.headers.authorization ?? "");
        seenHttpHeader = String(req.headers["x-omk-test"] ?? "");
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          const parsed = JSON.parse(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "remote-test", version: "1.0.0" },
            },
          }));
        });
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      await mkdir(join(process.env.OMK_PROJECT_ROOT, ".omk"), { recursive: true });
      await mkdir(join(process.env.OMK_PROJECT_ROOT, ".kimi"), { recursive: true });
      await mkdir(join(process.env.OMK_ORIGINAL_HOME, ".kimi"), { recursive: true });
      await writeFile(join(process.env.OMK_PROJECT_ROOT, ".omk", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
      await writeFile(join(process.env.OMK_ORIGINAL_HOME, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
      await writeFile(join(process.env.OMK_PROJECT_ROOT, ".kimi", "mcp.json"), JSON.stringify({
        mcpServers: {
          remote: {
            url: "http://127.0.0.1:" + port + "/mcp",
            startup_timeout_sec: 5,
            headers: { Authorization: "Bearer SHOULD_NOT_LEAK" },
            http_headers: { "X-OMK-Test": "present" },
          },
        },
      }), "utf-8");
      await mcpTestCommand("remote");
      console.log(JSON.stringify({ seenMethod, seenAuthOk: seenAuth === "Bearer SHOULD_NOT_LEAK", seenHttpHeader }));
      await new Promise((resolve) => server.close(resolve));
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1));
    seenMethod = parsed.seenMethod;
    seenAuth = parsed.seenAuthOk;
    seenHttpHeader = parsed.seenHttpHeader;
    assert.equal(seenMethod, "POST");
    assert.equal(seenAuth, true);
    assert.equal(seenHttpHeader, "present");
    assert.match(result.stdout, /Remote MCP initialize succeeded/);
    assert.doesNotMatch(result.stdout + result.stderr, /SHOULD_NOT_LEAK|Bearer SHOULD/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp list and test redact secret-like command strings", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-command-redact-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));
  const secret = `sk-proj-${"A".repeat(24)}`;

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        redacted: {
          command: `missing-${secret}`,
        },
      },
    });

    const listResult = runMcpScript(projectRoot, homeRoot, `
      await mcpListCommand();
    `);
    assert.equal(listResult.status, 0, listResult.stderr || listResult.stdout);
    assert.doesNotMatch(listResult.stdout + listResult.stderr, new RegExp(secret));
    assert.match(listResult.stdout, /sk-\*\*\*/);

    const testResult = runMcpScript(projectRoot, homeRoot, `
      await mcpTestCommand("redacted");
    `);
    assert.notEqual(testResult.status, 0);
    assert.doesNotMatch(testResult.stdout + testResult.stderr, new RegExp(secret));
    assert.match(testResult.stderr, /sk-\*\*\*/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("runtime MCP cleanup does not delete active peer process configs", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-peer-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-home-"));

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        dummy: {
          command: process.execPath,
          args: ["--version"],
        },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      const cacheDir = join(process.env.OMK_PROJECT_ROOT, ".omk", "cache");
      await mkdir(cacheDir, { recursive: true });
      const peerPath = join(cacheDir, \`mcp-runtime-merged-\${process.pid}-1000.json\`);
      await writeFile(peerPath, JSON.stringify({ mcpServers: {} }), "utf-8");
      const runtimePath = await writeRuntimeMcpConfig([join(process.env.OMK_PROJECT_ROOT, ".kimi", "mcp.json")]);
      const peerStillThere = await readFile(peerPath, "utf-8").then(() => true, () => false);
      const runtimeExists = runtimePath
        ? await readFile(runtimePath, "utf-8").then(() => true, () => false)
        : false;
      console.log(JSON.stringify({ peerStillThere, runtimeExists, hasRuntimePath: Boolean(runtimePath) }));
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.peerStillThere, true);
    assert.equal(parsed.runtimeExists, true);
    assert.equal(parsed.hasRuntimePath, true);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("runtime MCP allowlist treats empty list as no servers, not all servers", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-allowlist-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-home-"));

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        alpha: {
          command: process.execPath,
          args: ["--version"],
        },
        beta: {
          command: process.execPath,
          args: ["--version"],
        },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      const configPath = join(process.env.OMK_PROJECT_ROOT, ".kimi", "mcp.json");
      const emptyRuntimePath = await writeRuntimeMcpConfig([configPath], []);
      const alphaRuntimePath = await writeRuntimeMcpConfig([configPath], ["alpha"]);
      const alphaNames = alphaRuntimePath
        ? Object.keys(JSON.parse(await readFile(alphaRuntimePath, "utf-8")).mcpServers)
        : [];
      console.log(JSON.stringify({ emptyRuntimePath, alphaNames }));
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.emptyRuntimePath, null);
    assert.deepEqual(parsed.alphaNames, ["alpha"]);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("runtime MCP preflight keeps all-scope precedence and keeps timed-out npm-family servers as prewarm-needed", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-preflight-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-home-"));
  const binDir = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-bin-"));

  try {
    await writeFakeNpm(binDir, "process.stderr.write('API_TOKEN=SHOULD_NOT_LEAK\\n'); setTimeout(() => process.exit(0), 250);");
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        shared: {
          command: "npx",
          args: ["-y", "@scope/global-server"],
          env: { API_TOKEN: "SHOULD_NOT_LEAK" },
        },
        badNpm: {
          command: "npx",
          args: ["-y", "@scope/bad-server", "--token=SHOULD_NOT_LEAK"],
          env: { API_TOKEN: "SHOULD_NOT_LEAK" },
        },
      },
    }), "utf-8");
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        shared: { command: "bash", args: ["-lc", "true"] },
      },
    }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      const runtimePath = await writeRuntimeMcpConfig([
        join(process.env.OMK_ORIGINAL_HOME, ".kimi", "mcp.json"),
        join(process.env.OMK_PROJECT_ROOT, ".kimi", "mcp.json"),
      ]);
      const parsed = JSON.parse(await readFile(runtimePath, "utf-8"));
      console.log(JSON.stringify({
        names: Object.keys(parsed.mcpServers).sort(),
        sharedCommand: parsed.mcpServers.shared.command,
        badNpmKept: Boolean(parsed.mcpServers.badNpm),
      }));
    `, {
      ...buildPrependPathEnv(binDir),
      OMK_MCP_PREFLIGHT: "warn-skip",
      OMK_MCP_PREFLIGHT_TIMEOUT_MS: "50",
      OMK_MCP_PREFLIGHT_CONCURRENCY: "1",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.deepEqual(parsed.names, ["badNpm", "shared"]);
    assert.equal(parsed.sharedCommand, "bash");
    assert.equal(parsed.badNpmKept, true);
    assert.match(result.stderr, /MCP preflight found 1 issue/);
    assert.match(result.stderr, /Kept 1 timeout server/);
    assert.doesNotMatch(result.stdout + result.stderr, /SHOULD_NOT_LEAK|Authorization|Bearer|API_TOKEN=/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
    await removeTree(binDir);
  }
});

test("runtime MCP preflight warn-skip removes exit-failed npm-family servers", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-preflight-exit-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-home-"));
  const binDir = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-bin-"));

  try {
    await writeFakeNpm(binDir, "process.stderr.write('Bearer SHOULD_NOT_LEAK\\n'); process.exit(42);");
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        maybeOkAtRuntime: {
          command: "npx",
          args: ["-y", "@scope/private-server", "--token=SHOULD_NOT_LEAK"],
          env: { API_TOKEN: "SHOULD_NOT_LEAK" },
        },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      const runtimePath = await writeRuntimeMcpConfig([join(process.env.OMK_PROJECT_ROOT, ".kimi", "mcp.json")]);
      const names = runtimePath ? Object.keys(JSON.parse(await readFile(runtimePath, "utf-8")).mcpServers) : [];
      console.log(JSON.stringify(names));
    `, {
      ...buildPrependPathEnv(binDir),
      OMK_MCP_PREFLIGHT: "warn-skip",
      OMK_MCP_PREFLIGHT_TIMEOUT_MS: "1000",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), []);
    assert.match(result.stderr, /MCP preflight found 1 issue/);
    assert.match(result.stderr, /Removed 1 failed server/);
    assert.doesNotMatch(result.stdout + result.stderr, /SHOULD_NOT_LEAK|Bearer|API_TOKEN=/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
    await removeTree(binDir);
  }
});

test("runtime MCP preflight inherits safe registry and proxy env from server config", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-preflight-env-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-home-"));
  const binDir = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-bin-"));

  try {
    await writeFakeNpm(binDir, `
      if (process.env.NPM_CONFIG_REGISTRY !== "https://registry.example.test/" || process.env.HTTPS_PROXY !== "http://proxy.example.test") {
        process.exit(42);
      }
      process.stdout.write('"1.0.0"\\n');
    `);
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        privateRegistry: {
          command: "npx",
          args: ["-y", "@scope/private-server"],
          env: {
            NPM_CONFIG_REGISTRY: "https://registry.example.test/",
            HTTPS_PROXY: "http://proxy.example.test",
            NPM_TOKEN: "SHOULD_NOT_LEAK",
          },
        },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      const runtimePath = await writeRuntimeMcpConfig([join(process.env.OMK_PROJECT_ROOT, ".kimi", "mcp.json")]);
      const parsed = JSON.parse(await readFile(runtimePath, "utf-8"));
      console.log(JSON.stringify(Object.keys(parsed.mcpServers)));
    `, {
      ...buildPrependPathEnv(binDir),
      OMK_MCP_PREFLIGHT: "warn-skip",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), ["privateRegistry"]);
    assert.doesNotMatch(result.stderr, /MCP preflight found/);
    assert.doesNotMatch(result.stdout + result.stderr, /SHOULD_NOT_LEAK|NPM_TOKEN/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
    await removeTree(binDir);
  }
});

test("runtime MCP preflight off keeps failed npm-family servers", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-preflight-off-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-home-"));
  const binDir = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-bin-"));

  try {
    await writeFakeNpm(binDir, "process.exit(42);");
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        badNpm: { command: "npx", args: ["-y", "@scope/bad-server"] },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      const runtimePath = await writeRuntimeMcpConfig([join(process.env.OMK_PROJECT_ROOT, ".kimi", "mcp.json")]);
      const parsed = JSON.parse(await readFile(runtimePath, "utf-8"));
      console.log(JSON.stringify(Object.keys(parsed.mcpServers)));
    `, {
      ...buildPrependPathEnv(binDir),
      OMK_MCP_PREFLIGHT: "off",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), ["badNpm"]);
    assert.doesNotMatch(result.stderr, /MCP preflight skipped/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
    await removeTree(binDir);
  }
});

test("runtime MCP preflight strict fails without leaking secret-like values", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-preflight-strict-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-home-"));
  const binDir = await mkdtemp(join(tmpdir(), "omk-runtime-mcp-bin-"));

  try {
    await writeFakeNpm(binDir, "process.stderr.write('Bearer SHOULD_NOT_LEAK\\n'); process.exit(42);");
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        badNpm: {
          command: "npx",
          args: ["-y", "@scope/bad-server", "--api-token=SHOULD_NOT_LEAK"],
          env: { API_TOKEN: "SHOULD_NOT_LEAK" },
        },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      await writeRuntimeMcpConfig([join(process.env.OMK_PROJECT_ROOT, ".kimi", "mcp.json")]);
    `, {
      ...buildPrependPathEnv(binDir),
      OMK_MCP_PREFLIGHT: "strict",
      OMK_MCP_PREFLIGHT_TIMEOUT_MS: "1000",
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /MCP preflight strict mode/);
    assert.doesNotMatch(result.stdout + result.stderr, /SHOULD_NOT_LEAK|Bearer|API_TOKEN=/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
    await removeTree(binDir);
  }
});

test("mcp prewarm --all reports active server results without leaking secrets", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-prewarm-all-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));
  const binDir = await mkdtemp(join(tmpdir(), "omk-mcp-bin-"));

  try {
    await writeFakeNpm(binDir, "process.stdout.write('\"1.0.0\"\\n'); process.exit(0);");
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        npmOk: {
          command: "npx",
          args: ["-y", "@scope/ok-server"],
          env: { API_TOKEN: "SHOULD_NOT_LEAK" },
        },
        local: {
          command: "bash",
          args: ["-lc", "true"],
        },
      },
    });
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        globalOnly: {
          command: "npx",
          args: ["-y", "@scope/global-server"],
          env: { API_TOKEN: "SHOULD_NOT_LEAK" },
        },
      },
    }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpPrewarmCommand(undefined, { all: true });
    `, {
      ...buildPrependPathEnv(binDir),
      OMK_MCP_SCOPE: "project",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /MCP Preflight Check All/);
    assert.match(result.stdout, /npmOk/);
    assert.match(result.stdout, /@scope\/ok-server/);
    assert.match(result.stdout, /local/);
    assert.match(result.stdout, /globalOnly .*inactive/);
    assert.match(result.stdout, /Checked 2 server/);
    assert.doesNotMatch(result.stdout + result.stderr, /SHOULD_NOT_LEAK|Authorization|Bearer|API_TOKEN=/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
    await removeTree(binDir);
  }
});

test("mcp install railway writes the remote OAuth preset without local secrets", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-install-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, { mcpServers: {} });

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpInstallCommand("railway", "railway", [], {});
      const raw = await readFile(join(process.env.OMK_PROJECT_ROOT, ".kimi", "mcp.json"), "utf-8");
      console.log(raw);
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const raw = await readFile(join(projectRoot, ".kimi", "mcp.json"), "utf-8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed.mcpServers.railway, { url: "https://mcp.railway.com" });
    assert.doesNotMatch(raw + result.stdout, /RAILWAY_TOKEN|API_KEY|Bearer|@railway\/mcp-server|secrets\.env/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp install stores secret-like env values as runtime placeholders", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-install-env-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, { mcpServers: {} });

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpInstallCommand("secreted", "node", ["server.js"], {
        env: [
          "API_TOKEN=SHOULD_NOT_STORE",
          "MONGO_URI=mongodb://user:pass@example/db",
          "REDIS_URL=redis://:pass@example:6379",
          "ERROR_DSN=https://dsn.example/secret",
          "GITHUB_PAT=ghp_should_not_store",
          "PLAIN=value",
        ],
      });
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const raw = await readFile(join(projectRoot, ".kimi", "mcp.json"), "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.mcpServers.secreted.env.API_TOKEN, "${API_TOKEN}");
    assert.equal(parsed.mcpServers.secreted.env.MONGO_URI, "${MONGO_URI}");
    assert.equal(parsed.mcpServers.secreted.env.REDIS_URL, "${REDIS_URL}");
    assert.equal(parsed.mcpServers.secreted.env.ERROR_DSN, "${ERROR_DSN}");
    assert.equal(parsed.mcpServers.secreted.env.GITHUB_PAT, "${GITHUB_PAT}");
    assert.equal(parsed.mcpServers.secreted.env.PLAIN, "value");
    assert.doesNotMatch(raw + result.stdout + result.stderr, /SHOULD_NOT_STORE|mongodb:\/\/|redis:\/\/|ghp_should_not_store|dsn\.example/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp install sanitizes remote URL and split secret args before saving", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-install-url-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, { mcpServers: {} });
    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpInstallCommand("remote", "https://mcp.example.test/sse?token=SHOULD_NOT_STORE#frag", [], {});
      await mcpInstallCommand("cmd", "node --token=SHOULD_NOT_STORE", [], {});
      await mcpInstallCommand("args", "node", ["server.js", "--api-key", "SHOULD_NOT_STORE", "--token=SHOULD_NOT_STORE"], {});
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const raw = await readFile(join(projectRoot, ".kimi", "mcp.json"), "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.mcpServers.remote.url, "https://mcp.example.test/sse?token=***#***");
    assert.equal(parsed.mcpServers.cmd.command, "node --token=***");
    assert.deepEqual(parsed.mcpServers.args.args, ["server.js", "--api-key", "[REDACTED]", "--token=[REDACTED]"]);
    assert.doesNotMatch(raw + result.stdout + result.stderr, /SHOULD_NOT_STORE|#frag/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp sync-global uses project sanitizer for URL args headers and env", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-sync-sanitize-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, { mcpServers: {} });
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        secreted: {
          url: "https://mcp.example.test/sse?token=SHOULD_NOT_STORE#frag",
          command: "node",
          args: ["server.js", "--api-key", "SHOULD_NOT_STORE"],
          env: { GITHUB_PAT: "ghp_should_not_store", PLAIN: "value" },
          headers: { Authorization: "Bearer SHOULD_NOT_STORE" },
        },
      },
    }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpSyncGlobalCommand({});
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const raw = await readFile(join(projectRoot, ".kimi", "mcp.json"), "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.mcpServers.secreted.url, "https://mcp.example.test/sse?token=***#***");
    assert.deepEqual(parsed.mcpServers.secreted.args, ["server.js", "--api-key", "[REDACTED]"]);
    assert.equal(parsed.mcpServers.secreted.env.GITHUB_PAT, "${GITHUB_PAT}");
    assert.equal(parsed.mcpServers.secreted.env.PLAIN, "value");
    assert.equal(parsed.mcpServers.secreted.headers.Authorization, "[REDACTED]");
    assert.doesNotMatch(raw + result.stdout + result.stderr, /SHOULD_NOT_STORE|ghp_should_not_store|#frag/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("runtime MCP preflight defaults warn-skip to filter broken servers before Kimi startup", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-preflight-default-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, { mcpServers: {} });
    const result = runMcpScript(projectRoot, homeRoot, `
      console.log(JSON.stringify(resolveRuntimeMcpPreflightOptions({})));
    `, { OMK_MCP_PREFLIGHT: "" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout.trim()).mode, "warn-skip");
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor accepts remote URL MCP servers without requiring command", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-doctor-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        railway: { url: "https://mcp.railway.com" },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpDoctorCommand();
      console.log("DOCTOR_OK");
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /DOCTOR_OK/);
    assert.match(result.stdout, /url:.*https:\/\/mcp\.railway\.com/);
    assert.doesNotMatch(result.stdout, /missing command/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor does not validate scoped npx package names as filesystem paths", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-doctor-npx-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        memory: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-memory"],
        },
      },
    }), "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpDoctorCommand();
      console.log("DOCTOR_OK");
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /DOCTOR_OK/);
    assert.doesNotMatch(result.stdout, /arg path not found: @modelcontextprotocol\/server-memory/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor reports omk-project as virtual runtime MCP injection", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-doctor-virtual-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, { mcpServers: {} });

    const result = runMcpScript(projectRoot, homeRoot, `
      const report = await buildMcpDoctorReport();
      console.log(JSON.stringify(report.servers.find((server) => server.name === "omk-project")));
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const server = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(server.status, "ok");
    assert.deepEqual(server.sources, ["runtime:auto-injected"]);
    assert.ok(server.checks.some((check) => check.kind === "virtual-runtime-injected" && /virtual runtime MCP injected/.test(check.message)));
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor flags PDF server command missing --stdio before Kimi JSON-RPC parse fails", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-doctor-pdf-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        pdf: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-pdf"],
        },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      const report = await buildMcpDoctorReport();
      console.log(JSON.stringify({
        ok: report.ok,
        errors: report.errors,
        pdfChecks: report.servers.find((server) => server.name === "pdf")?.checks ?? [],
      }));
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(parsed.ok, false);
    assert.match(parsed.errors.join("\n"), /server-pdf defaults to HTTP/);
    assert.equal(parsed.pdfChecks.some((check) => check.kind === "stdio-protocol-mismatch"), true);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor flags Windows set and missing inline MCP scripts before runtime startup", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-doctor-runtime-blocker-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        broken: {
          command: "bash",
          args: ["-lc", "/mnt/c/WINDOWS/System32/set -a; exec node /tmp/omk-missing-mcp/index.js"],
        },
        stale: {
          command: "npx",
          args: ["-y", "sqlite-mcp", "/home/not-current/.opencode/data.db"],
        },
        pagedesign: {
          command: "page-design-guide",
        },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpDoctorCommand();
    `);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /runtime startup blocker: Windows System32 set/);
    assert.match(result.stdout, /runtime startup blocker: inline MCP script references a missing local script/);
    assert.match(result.stdout, /runtime startup blocker: MCP config references a different user home path/);
    assert.match(result.stdout, /runtime startup blocker: stdio MCP config starts an HTTP MCP server/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor --fix disables project MCP runtime startup blockers", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-doctor-runtime-fix-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        broken: {
          command: "bash",
          args: ["-lc", "/mnt/c/WINDOWS/System32/set -a; exec node /tmp/omk-missing-mcp/index.js"],
        },
        stale: {
          command: "npx",
          args: ["-y", "sqlite-mcp", "/home/not-current/.opencode/data.db"],
        },
        pagedesign: {
          command: "page-design-guide",
        },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpDoctorCommand({ fix: true, json: true });
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.ok(report.fixes.actions.some((action) => /disabled MCP "broken"/.test(action)));
    assert.ok(report.fixes.actions.some((action) => /disabled MCP "stale"/.test(action)));
    assert.ok(report.fixes.actions.some((action) => /disabled MCP "pagedesign"/.test(action)));

    const projectConfig = JSON.parse(await readFile(join(projectRoot, ".kimi", "mcp.json"), "utf-8"));
    assert.deepEqual(projectConfig.mcpServers, {});
    assert.ok(projectConfig._omkDisabledMcpServers.broken);
    assert.ok(projectConfig._omkDisabledMcpServers.stale);
    assert.ok(projectConfig._omkDisabledMcpServers.pagedesign);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor --fix migrates stale package references in active project config only", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-doctor-fix-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        supabase: {
          command: "npx",
          args: ["-y", "@supabase/mcp-server@latest"],
        },
      },
    }), "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        globalSupabase: {
          command: "npx",
          args: ["-y", "@supabase/mcp-server@latest"],
        },
      },
    }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpDoctorCommand({ fix: true });
      const projectRaw = await readFile(join(process.env.OMK_PROJECT_ROOT, ".kimi", "mcp.json"), "utf-8");
      const homeRaw = await readFile(join(process.env.OMK_ORIGINAL_HOME, ".kimi", "mcp.json"), "utf-8");
      console.log(JSON.stringify({ project: JSON.parse(projectRaw), home: JSON.parse(homeRaw) }));
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.deepEqual(parsed.project.mcpServers.supabase.args, ["-y", "@supabase/mcp-server-supabase@latest"]);
    assert.deepEqual(parsed.home.mcpServers.globalSupabase.args, ["-y", "@supabase/mcp-server@latest"]);
    assert.doesNotMatch(result.stdout + result.stderr, /API_KEY|TOKEN|PASSWORD|SECRET|Bearer/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor --fix --dry-run reports planned actions without writing backups or configs", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-doctor-dry-run-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    const projectPath = join(projectRoot, ".kimi", "mcp.json");
    const original = JSON.stringify({
      mcpServers: {
        supabase: {
          command: "npx",
          args: ["-y", "@supabase/mcp-server@latest"],
        },
      },
    });
    await writeFile(projectPath, original, "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpDoctorCommand({ fix: true, json: true, dryRun: true });
    `);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.fixes.dryRun, true);
    assert.equal(report.fixes.changed, false);
    assert.deepEqual(report.fixes.backups, []);
    assert.ok(report.fixes.actions.some((action) => /replaced stale MCP package argument/.test(action)));
    assert.equal(await readFile(projectPath, "utf-8"), original);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor --fix creates sanitized backup before project-local writes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-doctor-backup-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        supabase: {
          command: "npx",
          args: [
            "-y",
            "@supabase/mcp-server@latest",
            "--api-token=SHOULD_NOT_LEAK",
            "https://example.test/mcp?client_secret=SHOULD_NOT_LEAK#SHOULD_NOT_LEAK",
          ],
          env: { SUPABASE_ACCESS_TOKEN: "SHOULD_NOT_LEAK" },
          headers: { Authorization: "Bearer SHOULD_NOT_LEAK" },
        },
      },
    }), "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpDoctorCommand({ fix: true, json: true });
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout + result.stderr, /SHOULD_NOT_LEAK|Bearer SHOULD_NOT_LEAK/);
    const report = JSON.parse(result.stdout);
    assert.equal(report.fixes.backups.length, 1);
    const backupPath = report.fixes.backups[0];
    const backupRaw = await readFile(backupPath, "utf-8");
    assert.doesNotMatch(backupRaw, /SHOULD_NOT_LEAK|Bearer SHOULD_NOT_LEAK/);
    assert.match(backupRaw, /client_secret=\\*\\*\\*/);
    const mode = (await stat(backupPath)).mode & 0o777;
    if (process.platform !== "win32") assert.equal(mode, 0o600);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor --fix --global explicitly mutates global MCP config and backs it up", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-doctor-global-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
    const globalPath = join(homeRoot, ".kimi", "mcp.json");
    const globalOriginal = JSON.stringify({
      mcpServers: {
        globalUrl: {
          command: "https://example.test/mcp?token=SHOULD_NOT_LEAK#SHOULD_NOT_LEAK",
          args: [],
        },
      },
    });
    await writeFile(globalPath, globalOriginal, "utf-8");

    const localOnly = runMcpScript(projectRoot, homeRoot, `
      process.env.OMK_MCP_SCOPE = "all";
      await mcpDoctorCommand({ fix: true, json: true });
    `);
    assert.equal(localOnly.status, 1, localOnly.stderr || localOnly.stdout);
    assert.equal(await readFile(globalPath, "utf-8"), globalOriginal);

    const globalFix = runMcpScript(projectRoot, homeRoot, `
      process.env.OMK_MCP_SCOPE = "all";
      await mcpDoctorCommand({ fix: true, json: true, global: true });
    `);
    assert.equal(globalFix.status, 0, globalFix.stderr || globalFix.stdout);
    assert.doesNotMatch(globalFix.stdout + globalFix.stderr, /SHOULD_NOT_LEAK/);
    const report = JSON.parse(globalFix.stdout);
    assert.equal(report.fixes.global, true);
    assert.equal(report.fixes.backups.length, 1);
    const parsedGlobal = JSON.parse(await readFile(globalPath, "utf-8"));
    assert.equal(parsedGlobal.mcpServers.globalUrl.url, "https://example.test/mcp?token=SHOULD_NOT_LEAK#SHOULD_NOT_LEAK");
    assert.equal(parsedGlobal.mcpServers.globalUrl.command, undefined);
    const backupRaw = await readFile(report.fixes.backups[0], "utf-8");
    assert.doesNotMatch(backupRaw, /SHOULD_NOT_LEAK/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor reports preflight package failures as prewarm-needed without disabling servers", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-doctor-preflight-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));
  const binDir = await mkdtemp(join(tmpdir(), "omk-mcp-bin-"));

  try {
    await writeFakeNpm(binDir, "process.stderr.write('Bearer SHOULD_NOT_LEAK\\n'); process.exit(42);");
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        badNpm: {
          command: "npm",
          args: ["exec", "--yes", "@scope/missing-server"],
          env: { API_TOKEN: "SHOULD_NOT_LEAK" },
        },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpDoctorCommand({ fix: true, json: true });
    `, {
      ...buildPrependPathEnv(binDir),
      OMK_MCP_PREFLIGHT: "warn-skip",
      OMK_MCP_PREFLIGHT_TIMEOUT_MS: "1000",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout + result.stderr, /SHOULD_NOT_LEAK|Bearer SHOULD_NOT_LEAK|API_TOKEN=/);
    const report = JSON.parse(result.stdout);
    const badNpm = report.servers.find((server) => server.name === "badNpm");
    assert.ok(badNpm.checks.some((check) => check.kind === "preflight-package-unavailable"));
    assert.ok(badNpm.checks.some((check) => check.kind === "prewarm-needed"));
    const projectConfig = JSON.parse(await readFile(join(projectRoot, ".kimi", "mcp.json"), "utf-8"));
    assert.ok(projectConfig.mcpServers.badNpm);
    assert.equal(projectConfig._omkDisabledMcpServers?.badNpm, undefined);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
    await removeTree(binDir);
  }
});

test("mcp doctor reports preflight timeouts separately from package failures", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-doctor-preflight-timeout-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));
  const binDir = await mkdtemp(join(tmpdir(), "omk-mcp-bin-"));

  try {
    await writeFakeNpm(binDir, "setTimeout(() => {}, 1000);");
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        slowNpm: {
          command: "npm",
          args: ["exec", "--yes", "@scope/slow-server"],
        },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpDoctorCommand({ json: true });
    `, {
      ...buildPrependPathEnv(binDir),
      OMK_MCP_PREFLIGHT: "warn-skip",
      OMK_MCP_PREFLIGHT_TIMEOUT_MS: "50",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    const slowNpm = report.servers.find((server) => server.name === "slowNpm");
    assert.equal(slowNpm.status, "warn");
    assert.ok(slowNpm.checks.some((check) => check.kind === "preflight-timeout"));
    assert.ok(slowNpm.checks.some((check) => /warn: handshake-timeout/.test(check.message)));
    assert.ok(slowNpm.checks.some((check) => check.kind === "prewarm-needed"));
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
    await removeTree(binDir);
  }
});

test("mcp doctor --fix migrates legacy .omk MCP servers before creating .kimi fallback", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-legacy-fix-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".omk"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".omk", "mcp.json"), JSON.stringify({
      mcpServers: {
        legacy: {
          command: "npx",
          args: ["-y", "firecrawl-mcp"],
        },
      },
    }), "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpDoctorCommand({ fix: true, json: true });
      const raw = await readFile(join(process.env.OMK_PROJECT_ROOT, ".kimi", "mcp.json"), "utf-8");
      console.error("PROJECT_KIMI_MCP=" + raw);
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const raw = await readFile(join(projectRoot, ".kimi", "mcp.json"), "utf-8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed.mcpServers.legacy.args, ["-y", "firecrawl-mcp"]);
    assert.match(result.stdout, /migrated legacy MCP servers/);
    assert.doesNotMatch(raw, /"mcpServers":\\s*\\{\\s*\\}/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor --fix keeps project duplicate overrides instead of deleting them", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-dupe-override-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        memory: { command: "bash", args: ["-lc", "true"] },
      },
    }), "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        memory: { command: "bash", args: ["-lc", "echo global"] },
      },
    }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      process.env.OMK_MCP_SCOPE = "all";
      await mcpDoctorCommand({ fix: true, json: true });
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.issueCount, 0);
    assert.ok(report.fixes.skipped.some((item) => /kept project override/.test(item)));
    assert.ok(report.servers[0].checks.some((check) => check.kind === "project-overrides-global" && check.severity === "info"));
    const projectConfig = JSON.parse(await readFile(join(projectRoot, ".kimi", "mcp.json"), "utf-8"));
    assert.deepEqual(projectConfig.mcpServers.memory.args, ["-lc", "true"]);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("global MCP sync preserves scoped and bare npm package args while rewriting explicit paths", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-sync-package-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        scoped: { command: "npx", args: ["-y", "@scope/package"] },
        bare: { command: "npx", args: ["-y", "firecrawl-mcp"] },
        pathy: { command: "node", args: ["./server.js"] },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      await syncKimiMcpGlobal({ quiet: true });
      const raw = await readFile(join(process.env.OMK_ORIGINAL_HOME, ".kimi", "mcp.json"), "utf-8");
      console.log(raw);
    `, { OMK_MCP_ALLOW_WRITE_CONFIG: "1" });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(await readFile(join(homeRoot, ".kimi", "mcp.json"), "utf-8"));
    assert.deepEqual(parsed.mcpServers.scoped.args, ["-y", "@scope/package"]);
    assert.deepEqual(parsed.mcpServers.bare.args, ["-y", "firecrawl-mcp"]);
    assert.equal(parsed.mcpServers.pathy.args[0], join(projectRoot, "./server.js"));
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("doctor --fix --json skips global sync by default without stderr or success action", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-doctor-json-fix-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".omk"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi", "skills", "demo"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".omk", "kimi.config.toml"), [
      "[[hooks]]",
      "event = \"SubagentStop\"",
      "command = \".omk/hooks/subagent-stop-audit.sh\"",
      "",
    ].join("\n"), "utf-8");
    await writeFile(join(projectRoot, ".omk", "mcp.json"), JSON.stringify({
      mcpServers: { local: { command: "bash", args: ["-lc", "true"] } },
    }), "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await doctorCommand({ fix: true, json: true, soft: true });
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.fixes.globalSync.blocked, false);
    assert.equal(parsed.fixes.globalSync.changed, false);
    assert.equal(parsed.fixes.actions.some((action) => /synced global Kimi hooks/.test(action)), false);
    assert.ok(parsed.fixes.skipped.some((item) => /global sync skipped/.test(item)));
    assert.equal(parsed.fixes.skipped.some((item) => /\.kimi[\\/]+skills[\\/]+demo/.test(item)), false);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("doctor --fix explicit global mode reports blocked global sync when write guard is unset", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-doctor-json-global-fix-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".omk"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi", "skills", "demo"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".omk", "kimi.config.toml"), [
      "[[hooks]]",
      "event = \"SubagentStop\"",
      "command = \".omk/hooks/subagent-stop-audit.sh\"",
      "",
    ].join("\n"), "utf-8");
    await writeFile(join(projectRoot, ".omk", "mcp.json"), JSON.stringify({
      mcpServers: { local: { command: "bash", args: ["-lc", "true"] } },
    }), "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await doctorCommand({ fix: true, json: true, soft: true });
    `, { OMK_DOCTOR_FIX_GLOBAL: "1" });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.fixes.globalSync.blocked, true);
    assert.ok(parsed.fixes.skipped.some((item) => /global sync: .*blocked/.test(item)));
    assert.equal(parsed.fixes.actions.some((action) => /synced global/.test(action)), false);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("doctor follows root.yaml extend chain for inherited agent tools", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-doctor-agent-tools-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".omk", "agents"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
    await writeFile(join(projectRoot, ".omk", "agents", "okabe.yaml"), [
      "version: 1",
      "agent:",
      "  name: omk-okabe-base",
      "  tools:",
      "    - Agent",
      "    - SearchWeb",
      "    - FetchURL",
      "",
    ].join("\n"), "utf-8");
    await writeFile(join(projectRoot, ".omk", "agents", "root.yaml"), [
      "version: 1",
      "agent:",
      "  extend: ./okabe.yaml",
      "  name: omk-root",
      "",
    ].join("\n"), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await doctorCommand({ soft: true });
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Agent YAML Tools/);
    assert.match(result.stdout, /agent inheritance includes Agent, SearchWeb, FetchURL/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("doctor --fix merges missing root subagent aliases without replacing existing aliases", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-doctor-root-alias-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".omk", "agents"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
    await writeFile(join(projectRoot, ".omk", "agents", "root.yaml"), [
      "version: 1",
      "agent:",
      "  extend: ./okabe.yaml",
      "  name: omk-root",
      "  subagents:",
      "    coder:",
      "      path: ./roles/custom-coder.yaml",
      "",
    ].join("\n"), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await doctorCommand({ fix: true, json: true, soft: true });
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.fixes.actions.some((item) => /missing root subagent alias/.test(item)));
    const rootYaml = await readFile(join(projectRoot, ".omk", "agents", "root.yaml"), "utf-8");
    assert.match(rootYaml, /router:/);
    assert.match(rootYaml, /security:/);
    assert.match(rootYaml, /tester:/);
    assert.match(rootYaml, /aggregator:/);
    assert.match(rootYaml, /custom-coder\.yaml/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor ignores inactive global JSON and server errors in project scope", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-inactive-global-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        local: { url: "https://mcp.example.test" },
      },
    }), "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), "{not-json", "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpDoctorCommand({ json: true });
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.issueCount, 0);
    const homeSource = parsed.sources.find((source) => source.path.includes(homeRoot));
    assert.ok(homeSource, "expected home source to be present in sources");
    assert.equal(homeSource.active, false);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor --json emits structured status without leaking secrets", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-doctor-json-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        railway: {
          url: "https://mcp.railway.com",
          env: { RAILWAY_TOKEN: "${RAILWAY_TOKEN}" },
        },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpDoctorCommand({ json: true });
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.activeScope, "project");
    assert.equal(parsed.issueCount, 0);
    assert.equal(parsed.servers[0].name, "railway");
    assert.equal(parsed.servers[0].transport, "remote");
    assert.equal(parsed.servers[0].url, "https://mcp.railway.com");
    assert.ok(parsed.servers[0].checks.some((check) => check.kind === "url" && check.severity === "ok"));
    assert.doesNotMatch(result.stdout + result.stderr, /super-secret|Bearer|RAILWAY_TOKEN=/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});


test("MCP diagnostics report invalid JSON without leaking config contents", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-invalid-json-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".omk"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".omk", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), `{ "mcpServers": { "bad": { "env": { "API_TOKEN": "super-secret-value" } } }`, "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), `{ "mcpServers": { "global": { "env": { "PASSWORD": "global-secret" } } }`, "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpListCommand();
      await mcpDoctorCommand();
      await doctorCommand({ soft: true });
      console.log("INVALID_JSON_DIAGNOSTICS_OK");
    `);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /Invalid JSON/);
    assert.match(result.stdout, /MCP JSON/);
    assert.match(result.stdout, /INVALID_JSON_DIAGNOSTICS_OK/);
    assert.doesNotMatch(result.stdout + result.stderr, /super-secret-value|global-secret/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("omk-project MCP returns tool-level errors instead of JSON-RPC internal errors", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-tool-error-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    const input = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "omk-mcp-test", version: "0.0.0" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "omk_goal_show",
          arguments: { goalId: "missing-goal" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "resources/read",
        params: {
          uri: "omk://goal/missing-goal",
        },
      },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";

    const result = spawnSync(process.execPath, [OMK_PROJECT_SERVER], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: homeRoot,
        OMK_PROJECT_ROOT: projectRoot,
      },
      input,
      encoding: "utf-8",
      timeout: 10000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);

    const responses = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const toolResponse = responses.find((response) => response.id === 3);
    const resourceResponse = responses.find((response) => response.id === 4);

    assert.ok(toolResponse, "expected response for tools/call id 3");
    assert.equal(toolResponse.error, undefined);
    assert.equal(toolResponse.result.isError, true);
    assert.match(toolResponse.result.content[0].text, /OMK tool-level failure/);
    assert.match(toolResponse.result.content[0].text, /Goal not found: missing-goal/);
    assert.doesNotMatch(toolResponse.result.content[0].text, /Internal error/);
    assert.ok(resourceResponse, "expected response for resources/read id 4");
    assert.equal(resourceResponse.error.code, -32000);
    assert.doesNotMatch(resourceResponse.error.message, /Internal error/);
    assert.match(result.stderr, /tool_call_failed/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("omk-project MCP hides and denies write-capable tools by default", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-permission-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    const input = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "omk-mcp-test", version: "0.0.0" },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "omk_memory_write",
          arguments: { path: "project.md", content: "blocked" },
        },
      },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";

    const result = spawnSync(process.execPath, [OMK_PROJECT_SERVER], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: homeRoot,
        OMK_PROJECT_ROOT: projectRoot,
        OMK_MCP_PERMISSION_PROFILE: "",
      },
      input,
      encoding: "utf-8",
      timeout: 10000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const responses = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const listResponse = responses.find((response) => response.id === 2);
    const writeResponse = responses.find((response) => response.id === 3);
    const toolNames = listResponse.result.tools.map((tool) => tool.name);
    assert.equal(toolNames.includes("omk_memory_read"), true);
    assert.equal(toolNames.includes("omk_memory_write"), false);
    assert.equal(writeResponse.result.isError, true);
    assert.match(writeResponse.result.content[0].text, /permission profile 'default'/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("omk-project MCP exposes secret-free run telemetry tools", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-run-telemetry-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    const runId = "telemetry-run";
    const runDir = join(projectRoot, ".omk", "runs", runId);
    await mkdir(runDir, { recursive: true });
    const token = ["sk", "123456789012345678901234"].join("-");
    await writeFile(join(runDir, "state.json"), JSON.stringify({
      schemaVersion: 1,
      runId,
      startedAt: "2026-05-09T00:00:00.000Z",
      nodes: [],
    }, null, 2));
    await writeFile(join(runDir, "events.jsonl"), [
      JSON.stringify({ schemaVersion: "telemetry.v1", seq: 1, type: "lane.started", timestamp: "2026-05-09T00:00:00.000Z", runId, nodeId: "n1", data: { summary: token } }),
      JSON.stringify({ schemaVersion: "telemetry.v1", seq: 2, type: "lane.heartbeat", timestamp: "2026-05-09T00:00:01.000Z", runId, nodeId: "n1" }),
    ].join("\n") + "\n");
    await writeFile(join(runDir, "todos.json"), JSON.stringify([
      { title: `Review ${token}`, status: "pending", evidence: `saw ${token}` },
    ]));
    await writeFile(join(runDir, "mcp-status.json"), JSON.stringify({
      servers: [{ name: "omk-project", status: "connected", toolsCount: 3 }],
      headers: { authorization: token },
    }));

    const input = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "omk-mcp-test", version: "0.0.0" },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "omk_tail_run_events", arguments: { runId, afterSeq: 1 } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "omk_read_runtime_status", arguments: { runId } },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "omk_read_todos", arguments: { runId } },
      },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";

    const result = spawnSync(process.execPath, [OMK_PROJECT_SERVER], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: homeRoot,
        OMK_PROJECT_ROOT: projectRoot,
      },
      input,
      encoding: "utf-8",
      timeout: 10000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const responses = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const listResponse = responses.find((response) => response.id === 2);
    const tailResponse = responses.find((response) => response.id === 3);
    const statusResponse = responses.find((response) => response.id === 4);
    const todoResponse = responses.find((response) => response.id === 5);
    const toolNames = listResponse.result.tools.map((tool) => tool.name);
    assert.equal(toolNames.includes("omk_tail_run_events"), true);
    assert.equal(toolNames.includes("omk_read_run_state"), true);
    assert.equal(toolNames.includes("omk_read_runtime_status"), true);
    assert.equal(tailResponse.result.content[0].text.includes("lane.heartbeat"), true);
    assert.equal(tailResponse.result.content[0].text.includes("lane.started"), false);
    assert.doesNotMatch(statusResponse.result.content[0].text, new RegExp(token));
    assert.doesNotMatch(todoResponse.result.content[0].text, new RegExp(token));
    assert.match(statusResponse.result.content[0].text, /REDACTED|\*\*\*/);
    assert.match(todoResponse.result.content[0].text, /REDACTED|\*\*\*/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("filesystem-readonly MCP exposes read tools and denies write tool calls", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-readonly-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(projectRoot, ".omk", "cache"), { recursive: true });
    await writeFile(join(projectRoot, "README.md"), "readonly ok", "utf-8");
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({ token: "SECRET" }), "utf-8");
    await writeFile(join(projectRoot, ".omk", "cache", "mcp-runtime.json"), JSON.stringify({ token: "SECRET" }), "utf-8");
    const input = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "omk-mcp-test", version: "0.0.0" },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "read_file", arguments: { path: "README.md" } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "write_file", arguments: { path: "README.md", content: "mutate" } },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "read_file", arguments: { path: ".kimi/mcp.json" } },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "get_file_info", arguments: { path: ".omk/cache/mcp-runtime.json" } },
      },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "list_directory", arguments: { path: "." } },
      },
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "list_directory", arguments: { path: ".omk" } },
      },
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "search_files", arguments: { pattern: "mcp" } },
      },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";

    const result = spawnSync(process.execPath, [OMK_CLI, "mcp", "serve", "filesystem-readonly"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: homeRoot,
        OMK_PROJECT_ROOT: projectRoot,
      },
      input,
      encoding: "utf-8",
      timeout: 10000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const responses = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const listResponse = responses.find((response) => response.id === 2);
    const readResponse = responses.find((response) => response.id === 3);
    const writeResponse = responses.find((response) => response.id === 4);
    const secretReadResponse = responses.find((response) => response.id === 5);
    const secretInfoResponse = responses.find((response) => response.id === 6);
    const rootListResponse = responses.find((response) => response.id === 7);
    const omkListResponse = responses.find((response) => response.id === 8);
    const searchResponse = responses.find((response) => response.id === 9);
    const toolNames = listResponse.result.tools.map((tool) => tool.name);

    assert.deepEqual(toolNames.sort(), [
      "get_file_info",
      "list_allowed_directories",
      "list_directory",
      "read_file",
      "search_files",
    ].sort());
    assert.equal(toolNames.includes("write_file"), false);
    assert.match(readResponse.result.content[0].text, /readonly ok/);
    assert.equal(writeResponse.result.isError, true);
    assert.match(writeResponse.result.content[0].text, /not read-only/);
    assert.equal(secretReadResponse.result.isError, true);
    assert.match(secretReadResponse.result.content[0].text, /secret-bearing file pattern/);
    assert.doesNotMatch(secretReadResponse.result.content[0].text, /SECRET/);
    assert.equal(secretInfoResponse.result.isError, true);
    assert.match(secretInfoResponse.result.content[0].text, /secret-bearing file pattern/);
    assert.doesNotMatch(rootListResponse.result.content[0].text, /\.kimi/);
    assert.doesNotMatch(omkListResponse.result.content[0].text, /cache/);
    assert.doesNotMatch(searchResponse.result.content[0].text, /\.kimi|\.omk\/cache/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp test exercises an omk CLI connection through tools/call id 3", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-cli-connection-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));
  const binRoot = await mkdtemp(join(tmpdir(), "omk-mcp-bin-"));

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        "omk-cli": {
          command: "omk",
          args: ["mcp", "serve", "omk-project"],
          env: { OMK_PROJECT_ROOT: projectRoot },
        },
      },
    });
    if (process.platform === "win32") {
      await writeFile(
        join(binRoot, "omk.cmd"),
        `@echo off\r\n"${process.execPath}" "${OMK_CLI}" %*\r\n`,
        "utf-8"
      );
    } else {
      const omkWrapper = join(binRoot, "omk");
      await writeFile(
        omkWrapper,
        `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(OMK_CLI)} "$@"\n`,
        "utf-8"
      );
      await chmod(omkWrapper, 0o755);
    }

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpTestCommand("omk-cli");
      console.log("MCP_TEST_OK");
    `, buildPrependPathEnv(binRoot));

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /MCP Test: omk-cli/);
    assert.match(result.stdout, /JSON-RPC initialize succeeded/);
    assert.match(result.stdout, /tools\/call id 3 returned OMK tool-level error without -32603/);
    assert.match(result.stdout, /MCP_TEST_OK/);
    assert.doesNotMatch(result.stdout + result.stderr, /Internal error/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
    await removeTree(binRoot);
  }
});

test("mcp test does not pass ambient secret env but expands explicit placeholders", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-test-env-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    const serverPath = join(projectRoot, "env-mcp.mjs");
    await writeFile(serverPath, `
      if (process.env.AMBIENT_TEST_SECRET) {
        process.stdout.write("ambient leaked\\n");
        process.exit(0);
      }
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        if (process.env.API_TOKEN !== "explicit-secret") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "missing explicit env" } }) + "\\n");
          return;
        }
        for (const line of input.split(/\\r?\\n/)) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                serverInfo: { name: "env-safe", version: "0.0.0" }
              }
            }) + "\\n");
          }
        }
      });
    `, "utf-8");
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        "env-safe": {
          command: process.execPath,
          args: [serverPath],
          env: { API_TOKEN: "${API_TOKEN}" },
        },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpTestCommand("env-safe");
      console.log("MCP_TEST_ENV_OK");
    `, {
      API_TOKEN: "explicit-secret",
      AMBIENT_TEST_SECRET: "ambient-leak",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /MCP_TEST_ENV_OK/);
    assert.doesNotMatch(result.stdout + result.stderr, /ambient leaked|ambient-leak|explicit-secret/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp test fails when initialize response omits serverInfo", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-missing-server-info-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    const serverPath = join(projectRoot, "missing-server-info.mjs");
    await writeFile(serverPath, `
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        for (const line of input.split(/\\r?\\n/)) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: "2024-11-05", capabilities: {} }
            }) + "\\n");
          }
        }
      });
    `, "utf-8");
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        "missing-info": { command: process.execPath, args: [serverPath] },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpTestCommand("missing-info");
    `);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /missing serverInfo/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp test fails when initialize times out before serverInfo", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-init-timeout-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    const serverPath = join(projectRoot, "init-timeout.mjs");
    await writeFile(serverPath, `
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        if (input.includes('"initialize"')) setInterval(() => {}, 1000);
      });
    `, "utf-8");
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        "init-timeout": { command: process.execPath, args: [serverPath], startup_timeout_sec: 1 },
      },
    });

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpTestCommand("init-timeout");
    `);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /initialize timed out before serverInfo/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor does not fail on inactive omk-project mirror duplicates", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-doctor-dupe-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".omk"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    const projectServer = { command: "bash", args: ["-lc", "true"] };
    await writeFile(join(projectRoot, ".omk", "mcp.json"), JSON.stringify({
      mcpServers: { "omk-project": projectServer },
    }), "utf-8");
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: { "omk-project": projectServer },
    }), "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: { "omk-project": { command: "bash", args: ["-lc", "echo stale-global"] } },
    }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpDoctorCommand();
      console.log("DOCTOR_OK");
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Active MCP scope: project/);
    assert.match(result.stdout, /duplicate mirror outside active scope/);
    assert.match(result.stdout, /DOCTOR_OK/);
    assert.doesNotMatch(result.stdout, /issue\\(s\\) found/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor validates the effective project MCP definition over stale .omk fallback", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-effective-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".omk"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".omk", "mcp.json"), JSON.stringify({
      mcpServers: { memory: { command: "definitely-missing-omk-cmd" } },
    }), "utf-8");
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: { memory: { command: "bash", args: ["-lc", "true"] } },
    }), "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpDoctorCommand();
      console.log("DOCTOR_OK");
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /duplicate mirror outside active scope/);
    assert.match(result.stdout, /DOCTOR_OK/);
    assert.doesNotMatch(result.stdout + result.stderr, /definitely-missing-omk-cmd/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp list displays the effective active server over stale .omk fallback", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-list-effective-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".omk"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".omk", "mcp.json"), JSON.stringify({
      mcpServers: { memory: { command: "stale-omk-command" } },
    }), "utf-8");
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: { memory: { command: "bash", args: ["-lc", "true"] } },
    }), "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpListCommand();
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /command:\s+bash/);
    assert.doesNotMatch(result.stdout, /command:\s+stale-omk-command/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp list includes global .omk source in all scope", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-list-global-omk-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".omk"), { recursive: true });
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
    await writeFile(join(homeRoot, ".omk", "mcp.json"), JSON.stringify({
      mcpServers: { globalOmk: { command: "bash", args: ["-lc", "true"] } },
    }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      process.env.OMK_MCP_SCOPE = "all";
      await mcpListCommand();
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\.omk[\\/]mcp\.json.*\[active\]/);
    assert.match(result.stdout, /globalOmk/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp doctor does not fail on active omk-project mirror duplicates in all scope", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-doctor-all-dupe-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));

  try {
    await mkdir(join(projectRoot, ".omk"), { recursive: true });
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    const projectServer = { command: "bash", args: ["-lc", "true"] };
    await writeFile(join(projectRoot, ".omk", "mcp.json"), JSON.stringify({
      mcpServers: { "omk-project": projectServer },
    }), "utf-8");
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: { "omk-project": projectServer },
    }), "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: { "omk-project": { command: "bash", args: ["-lc", "echo stale-global"] } },
    }), "utf-8");

    const result = runMcpScript(projectRoot, homeRoot, `
      process.env.OMK_MCP_SCOPE = "all";
      await mcpDoctorCommand();
      console.log("DOCTOR_OK");
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Active MCP scope: all/);
    assert.match(result.stdout, /managed omk-project mirror duplicate/);
    assert.match(result.stdout, /DOCTOR_OK/);
    assert.doesNotMatch(result.stdout, /issue\\(s\\) found/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp test fails fast when a stdio server writes non-JSON startup logs to stdout", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-noisy-stdout-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));
  const binDir = await mkdtemp(join(tmpdir(), "omk-mcp-bin-"));
  const serverPath = join(binDir, "noisy-mcp");

  try {
    await writeEmptyConfigs(projectRoot, homeRoot, {
      mcpServers: {
        noisy: { command: serverPath },
      },
    });
    await writeFile(serverPath, `#!/usr/bin/env node
const { writeSync } = require('node:fs');
writeSync(1, 'MCP server listening on http://localhost:3001/mcp\\n');
setTimeout(() => process.exit(0), 20);
`, "utf-8");
    await chmod(serverPath, 0o755);

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpTestCommand("noisy");
    `, buildPrependPathEnv(binDir));

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /non-JSON text to stdout/);
    assert.match(result.stderr, /MCP stdio servers must write only JSON-RPC frames to stdout/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
    await removeTree(binDir);
  }
});

test("mcp test fails fast when stdout starts with invalid JSON", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-invalid-json-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));
  const binDir = await mkdtemp(join(tmpdir(), "omk-mcp-bin-"));
  const serverPath = join(binDir, "invalid-json-mcp");

  try {
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        badjson: { command: serverPath },
      },
    }), "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
    await writeFile(serverPath, `#!/usr/bin/env node
const { writeSync } = require('node:fs');
writeSync(1, '{not-json}\\\\n');
setTimeout(() => process.exit(0), 20);
`, "utf-8");
    await chmod(serverPath, 0o755);

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpTestCommand("badjson");
    `, buildPrependPathEnv(binDir));

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /non-JSON text to stdout/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
    await removeTree(binDir);
  }
});

test("mcp test fails fast on JSON-shaped stdout logs that are not JSON-RPC frames", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-json-log-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-home-"));
  const binDir = await mkdtemp(join(tmpdir(), "omk-mcp-bin-"));
  const serverPath = join(binDir, "json-log-mcp");

  try {
    await mkdir(join(projectRoot, ".kimi"), { recursive: true });
    await mkdir(join(homeRoot, ".kimi"), { recursive: true });
    await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        jsonlog: { command: serverPath },
      },
    }), "utf-8");
    await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");
    await writeFile(serverPath, `#!/usr/bin/env node
const { writeSync } = require('node:fs');
writeSync(1, JSON.stringify({ level: 'info', message: 'starting' }) + '\\n');
setTimeout(() => process.exit(0), 20);
`, "utf-8");
    await chmod(serverPath, 0o755);

    const result = runMcpScript(projectRoot, homeRoot, `
      await mcpTestCommand("jsonlog");
    `, buildPrependPathEnv(binDir));

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /non-JSON text to stdout/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
    await removeTree(binDir);
  }
});

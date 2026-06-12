import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const OMK_ROOT = process.cwd();
const AUTOCONNECT_MODULE_URL = pathToFileURL(join(OMK_ROOT, "dist", "mcp", "autoconnect.js")).href;

function runAutoConnectScript(projectRoot, homeRoot, scriptBody, extraEnv = {}) {
  const evalScript = `
    import { runMcpAutoConnect, renderMcpAutoConnectBanner, mcpConnectCommand } from ${JSON.stringify(AUTOCONNECT_MODULE_URL)};
    ${scriptBody}
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", evalScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...extraEnv,
      OMK_MCP_SCOPE: "project",
      OMK_MCP_PREFLIGHT: "off",
      OMK_SKIP_UPDATE_CHECK: "1",
      OMK_PROJECT_ROOT: projectRoot,
      OMK_ORIGINAL_HOME: homeRoot,
      HOME: homeRoot,
      NO_COLOR: "1",
    },
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60000,
  });
}

async function createProjectWithMcp(config) {
  const projectRoot = await mkdtemp(join(tmpdir(), "omk-mcp-autoconnect-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "omk-mcp-autoconnect-home-"));
  await mkdir(join(projectRoot, ".kimi"), { recursive: true });
  await mkdir(join(projectRoot, ".omk"), { recursive: true });
  await mkdir(join(homeRoot, ".kimi"), { recursive: true });
  await writeFile(join(projectRoot, ".kimi", "mcp.json"), JSON.stringify(config, null, 2), "utf-8");
  await writeFile(join(homeRoot, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2), "utf-8");
  return { projectRoot, homeRoot };
}

async function removeTree(path) {
  await rm(path, { recursive: true, force: true });
}

test("MCP AutoConnect mounts omk-project as the root control-plane baseline", async () => {
  const { projectRoot, homeRoot } = await createProjectWithMcp({ mcpServers: {} });
  try {
    const result = runAutoConnectScript(projectRoot, homeRoot, `
      const report = await runMcpAutoConnect({ preflight: "fast" });
      console.log(JSON.stringify(report));
      console.log(renderMcpAutoConnectBanner(report));
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const [jsonLine, ...bannerLines] = result.stdout.trim().split("\n");
    const report = JSON.parse(jsonLine);
    assert.equal(report.ok, true);
    assert.equal(report.scope, "project");
    assert.equal(report.preflight, "fast");
    assert.ok(report.autoMounted.some((entry) => entry.name === "omk-project" && entry.status === "mounted"));
    assert.equal(report.command, "mcp connect");
    assert.match(bannerLines.join("\n"), /MCP Tool Plane/);
    assert.match(bannerLines.join("\n"), /Built-in omk-project MCP mounted/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("MCP AutoConnect report does not print MCP env secret values", async () => {
  const { projectRoot, homeRoot } = await createProjectWithMcp({
    mcpServers: {
      "sample-local": {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: {
          API_TOKEN: "super-secret-autoconnect-token",
        },
      },
    },
  });
  try {
    const result = runAutoConnectScript(projectRoot, homeRoot, `
      const report = await runMcpAutoConnect({ preflight: "fast" });
      console.log(JSON.stringify(report));
      console.log(renderMcpAutoConnectBanner(report));
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const combined = result.stdout + result.stderr;
    assert.doesNotMatch(combined, /super-secret-autoconnect-token|API_TOKEN=/);
    assert.match(combined, /sample-local/);
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp connect --json emits the AutoConnect JSON contract", async () => {
  const { projectRoot, homeRoot } = await createProjectWithMcp({ mcpServers: {} });
  try {
    const result = runAutoConnectScript(projectRoot, homeRoot, `
      await mcpConnectCommand({ json: true });
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.ok, true);
    assert.equal(report.command, "mcp connect");
    assert.equal(report.scope, "project");
    assert.equal(report.preflight, "fast");
    assert.ok(Array.isArray(report.autoMounted));
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

test("mcp connect --json --all emits full preflight command contract", async () => {
  const { projectRoot, homeRoot } = await createProjectWithMcp({ mcpServers: {} });
  try {
    const result = runAutoConnectScript(projectRoot, homeRoot, `
      await mcpConnectCommand({ json: true, all: true });
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.ok, true);
    assert.equal(report.command, "mcp connect");
    assert.equal(report.scope, "project");
    assert.equal(report.preflight, "full");
    assert.ok(Array.isArray(report.autoMounted));
  } finally {
    await removeTree(projectRoot);
    await removeTree(homeRoot);
  }
});

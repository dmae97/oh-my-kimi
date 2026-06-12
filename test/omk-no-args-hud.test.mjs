import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist", "cli.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("omk with no arguments", () => {
  it("shows the HUD instead of crashing or exiting immediately", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "omk-no-args-hud-"));
    const homeDir = mkdtempSync(join(tmpdir(), "omk-no-args-home-"));
    const markerPath = join(tempDir, "mcp-server-started.marker");
    mkdirSync(join(tempDir, ".omk"), { recursive: true });
    mkdirSync(join(tempDir, ".kimi"), { recursive: true });
    mkdirSync(join(homeDir, ".kimi"), { recursive: true });
    writeFileSync(join(tempDir, ".omk", "config.toml"), "", "utf-8");
    writeFileSync(join(tempDir, ".kimi", "mcp.json"), JSON.stringify({
      mcpServers: {
        "sample-local": {
          command: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started")`],
          env: {
            API_TOKEN: "super-secret-root-mcp-token",
          },
        },
      },
    }), "utf-8");
    writeFileSync(join(homeDir, ".kimi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");

    const childEnv = { ...process.env };
    delete childEnv.FORCE_COLOR;
    delete childEnv.FORCE_COLORS;

    const child = spawn(process.execPath, [CLI], {
      cwd: tempDir,
      env: {
        ...childEnv,
        OMK_SKIP_UPDATE_CHECK: "1",
        NO_COLOR: "1",
        OMK_STAR_PROMPT: "0",
        OMK_RENDER_LOGO: "0",
        OMK_MCP_SCOPE: "project",
        OMK_MCP_PREFLIGHT: "strict",
        OMK_PROJECT_ROOT: tempDir,
        OMK_ORIGINAL_HOME: homeDir,
        HOME: homeDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let exitCode = null;
    let exited = false;

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => { exitCode = code; exited = true; });

    // Give the process time to render output. Full-suite runs can be slower than
    // focused runs because HUD probes share CPU/IO with many preceding tests.
    const renderDeadline = Date.now() + 5000;
    while (!exited && stdout.length === 0 && stderr.length === 0 && Date.now() < renderDeadline) {
      await sleep(100);
    }

    const hadExitedByNow = exited;

    // In a TTY the HUD stays alive waiting for mode input.
    // In non-TTY it prints suggestions and exits cleanly.
    // We handle both paths so the test is stable in CI and locally.
    if (!exited) {
      // TTY path: process should still be alive
      child.stdin.end();
      // Wait a bit for graceful exit after EOF
      await sleep(500);
      if (!exited) {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
        await sleep(500);
        if (!exited) {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    }

    // Give a little more time for the exit event to fire
    await sleep(300);

    try {
      // Assert the process did not crash (exit code 0, or killed by us)
      assert.ok(
        exitCode === 0 || exitCode === null,
        `process crashed with exit code ${exitCode}. stderr: ${stderr}`
      );

      // Assert stdout contains expected HUD strings
      const combined = stdout + stderr;
      const hudIndicators = [
        "OMK",
        "Open Multi-agent Kit",
        "Provider-neutral",
        "orchestrator",
      ];
      const foundAny = hudIndicators.some((s) => combined.includes(s));
      assert.ok(
        foundAny,
        `expected HUD output not found. stdout: ${stdout}\nstderr: ${stderr}`
      );
      assert.match(combined, /MCP: project scope .* fast\/offline/);
      assert.match(combined, /MCP Tool Plane/);
      assert.match(combined, /Offline snapshot only; no MCP servers were started/);
      assert.match(combined, /Built-in omk-project MCP mounted/);
      assert.match(combined, /omk mcp doctor/);
      assert.match(combined, /omk mcp connect --all/);
      assert.doesNotMatch(combined, /super-secret-root-mcp-token|API_TOKEN=/);
      assert.equal(existsSync(markerPath), false, "root MCP summary must not start configured MCP servers");

      // In TTY mode the process should stay alive for input (not exit immediately).
      // In non-TTY CI it exits quickly after printing suggestions, which is expected.
      if (process.stdout.isTTY && process.stdin.isTTY) {
        assert.ok(
          !hadExitedByNow,
          "process exited immediately in TTY mode instead of showing interactive HUD"
        );
      }
    } finally {
      // Cleanup
      if (!exited) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

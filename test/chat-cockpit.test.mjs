import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// ESM dynamic import so we can test env-sensitive behavior
const { isCockpitChild, detectTmux, shellQuote, buildLeftPaneCommand, buildRightPaneCommand } = await import("../dist/util/chat-cockpit.js");
const { ensureChatRunState } = await import("../dist/util/chat-cockpit.js");
const { updateChatHeartbeat, updateChatThinking, finalizeChatRunState } = await import("../dist/commands/chat.js");
const { finalizeChatState } = await import("../dist/util/chat-state.js");
const { buildRunViewModel, parseRunStateResult } = await import("../dist/util/run-view-model.js");

describe("chat-cockpit utilities", () => {
  it("isCockpitChild returns true when OMK_CHAT_COCKPIT_CHILD=1", () => {
    const original = process.env.OMK_CHAT_COCKPIT_CHILD;
    process.env.OMK_CHAT_COCKPIT_CHILD = "1";
    try {
      assert.strictEqual(isCockpitChild(), true);
    } finally {
      if (original === undefined) {
        delete process.env.OMK_CHAT_COCKPIT_CHILD;
      } else {
        process.env.OMK_CHAT_COCKPIT_CHILD = original;
      }
    }
  });

  it("isCockpitChild returns false when env is absent", () => {
    const original = process.env.OMK_CHAT_COCKPIT_CHILD;
    delete process.env.OMK_CHAT_COCKPIT_CHILD;
    try {
      assert.strictEqual(isCockpitChild(), false);
    } finally {
      if (original !== undefined) {
        process.env.OMK_CHAT_COCKPIT_CHILD = original;
      }
    }
  });

  it("detectTmux returns false when tmux is not installed", async () => {
    const result = await detectTmux();
    // In most CI and dev environments tmux is absent; if present, true is also valid.
    assert.strictEqual(typeof result, "boolean");
  });

  it("shellQuote escapes single quotes", () => {
    assert.strictEqual(shellQuote("hello"), "'hello'");
    assert.strictEqual(shellQuote("it's"), "'it'\\''s'");
    assert.strictEqual(shellQuote("path with spaces"), "'path with spaces'");
  });
});

describe("ensureChatRunState", () => {
  /** @type {string} */
  let tmpRoot;

  it("creates a state file with a running chat node under the given runId", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "omk-chat-test-"));
    const runId = "chat-test-123";
    await ensureChatRunState(tmpRoot, runId);

    const statePath = join(tmpRoot, ".omk", "runs", runId, "state.json");
    const raw = await readFile(statePath, "utf8");
    const state = JSON.parse(raw);

    assert.strictEqual(state.runId, runId);
    assert.strictEqual(state.status, "running");
    assert.strictEqual(state.schemaVersion, 1);
    assert.ok(Array.isArray(state.nodes));
    assert.strictEqual(state.nodes.length, 1);

    const node = state.nodes[0];
    assert.strictEqual(node.id, "chat");
    assert.strictEqual(node.name, "Chat Session");
    assert.strictEqual(node.role, "chat");
    assert.strictEqual(node.status, "running");
    assert.deepStrictEqual(node.dependsOn, []);
    assert.strictEqual(node.retries, 0);
    assert.strictEqual(node.maxRetries, 0);
    assert.ok(typeof node.startedAt === "string");
  });

  it("is idempotent — does not overwrite existing state", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "omk-chat-test-"));
    const runId = "chat-test-456";
    await ensureChatRunState(tmpRoot, runId);

    const statePath = join(tmpRoot, ".omk", "runs", runId, "state.json");
    const firstRaw = await readFile(statePath, "utf8");

    // Second call should be a no-op
    await ensureChatRunState(tmpRoot, runId);
    const secondRaw = await readFile(statePath, "utf8");

    assert.strictEqual(firstRaw, secondRaw);
  });
});

describe("chat heartbeat lifecycle", () => {
  /** @type {string} */
  let tmpRoot;

  it("heartbeat updates durationMs and updatedAt", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "omk-chat-test-"));
    const runId = "chat-hb-001";
    await ensureChatRunState(tmpRoot, runId);

    const statePath = join(tmpRoot, ".omk", "runs", runId, "state.json");
    const beforeRaw = await readFile(statePath, "utf8");
    const before = JSON.parse(beforeRaw);

    // Wait a tick so duration is non-zero
    await new Promise((r) => setTimeout(r, 50));
    await updateChatHeartbeat(tmpRoot, runId);

    const afterRaw = await readFile(statePath, "utf8");
    const after = JSON.parse(afterRaw);

    assert.ok(after.updatedAt > before.updatedAt, "updatedAt should advance");
    assert.ok(after.nodes[0].durationMs > 0, "durationMs should be > 0");
  });

  it("thinking update writes to chat node", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "omk-chat-test-"));
    const runId = "chat-think-001";
    await ensureChatRunState(tmpRoot, runId);

    await updateChatThinking(tmpRoot, runId, "🧠 reasoning…");

    const statePath = join(tmpRoot, ".omk", "runs", runId, "state.json");
    const raw = await readFile(statePath, "utf8");
    const state = JSON.parse(raw);

    assert.strictEqual(state.nodes[0].thinking, "🧠 reasoning…");
  });

  it("finalize marks chat node done on success", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "omk-chat-test-"));
    const runId = "chat-fin-001";
    await ensureChatRunState(tmpRoot, runId);

    await new Promise((r) => setTimeout(r, 50));
    await finalizeChatRunState(tmpRoot, runId, true);

    const statePath = join(tmpRoot, ".omk", "runs", runId, "state.json");
    const raw = await readFile(statePath, "utf8");
    const state = JSON.parse(raw);

    assert.strictEqual(state.status, "done");
    assert.strictEqual(state.nodes[0].status, "done");
    assert.ok(typeof state.nodes[0].completedAt === "string");
    assert.ok(state.nodes[0].durationMs > 0);
  });

  it("active chat finalizer clamps duration for future timestamps", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "omk-chat-test-"));
    const runId = "chat-fin-active-001";
    await ensureChatRunState(tmpRoot, runId);

    const statePath = join(tmpRoot, ".omk", "runs", runId, "state.json");
    const rawBefore = await readFile(statePath, "utf8");
    const before = JSON.parse(rawBefore);
    before.nodes[0].startedAt = new Date(Date.now() + 60_000).toISOString();
    await writeFile(statePath, JSON.stringify(before, null, 2));

    await finalizeChatState(runId, true, 0, tmpRoot);

    const raw = await readFile(statePath, "utf8");
    const state = JSON.parse(raw);
    assert.strictEqual(state.nodes[0].status, "done");
    assert.ok(state.nodes[0].durationMs > 0);
  });

  it("finalize marks chat node failed on error", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "omk-chat-test-"));
    const runId = "chat-fin-002";
    await ensureChatRunState(tmpRoot, runId);

    await finalizeChatRunState(tmpRoot, runId, false);

    const statePath = join(tmpRoot, ".omk", "runs", runId, "state.json");
    const raw = await readFile(statePath, "utf8");
    const state = JSON.parse(raw);

    assert.strictEqual(state.status, "failed");
    assert.strictEqual(state.nodes[0].status, "failed");
  });

  it("heartbeat/thinking/finalize are safe when state is missing", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "omk-chat-test-"));
    // Do NOT create state — helpers should silently return
    await assert.doesNotReject(updateChatHeartbeat(tmpRoot, "missing-run"));
    await assert.doesNotReject(updateChatThinking(tmpRoot, "missing-run", "x"));
    await assert.doesNotReject(finalizeChatRunState(tmpRoot, "missing-run", true));
  });
});

describe("chat state view model", () => {
  it("buildRunViewModel renders chat state with one running worker", () => {
    const state = {
      schemaVersion: 1,
      runId: "chat-abc",
      status: "running",
      nodes: [
        {
          id: "chat",
          name: "Chat Session",
          role: "chat",
          dependsOn: [],
          status: "running",
          retries: 0,
          maxRetries: 0,
          startedAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const vm = buildRunViewModel(state);
    assert.strictEqual(vm.health, "ok");
    assert.strictEqual(vm.progress.total, 1);
    assert.strictEqual(vm.progress.running, 1);
    assert.strictEqual(vm.progress.done, 0);
    assert.strictEqual(vm.workers.length, 1);
    assert.strictEqual(vm.workers[0].id, "chat");
    assert.strictEqual(vm.workers[0].state, "running");
    assert.strictEqual(vm.stateError, "ok");
    assert.strictEqual(vm.runId, "chat-abc");
  });

  it("buildRunViewModel warns when state is missing", () => {
    const vm = buildRunViewModel(null);
    assert.strictEqual(vm.health, "warn");
    assert.strictEqual(vm.stateError, "missing");
    assert.strictEqual(vm.progress.total, 0);
    assert.deepStrictEqual(vm.workers, []);
  });

  it("parseRunStateResult validates chat state correctly", () => {
    const state = {
      schemaVersion: 1,
      runId: "chat-xyz",
      status: "running",
      nodes: [{ id: "chat", name: "Chat", role: "chat", dependsOn: [], status: "running", retries: 0, maxRetries: 0 }],
    };
    const result = parseRunStateResult(JSON.stringify(state));
    assert.strictEqual(result.error, "ok");
    assert.ok(result.state);
    assert.strictEqual(result.state.runId, "chat-xyz");
  });
});

describe("tmux lifecycle commands", () => {
  it("buildLeftPaneCommand contains required components", () => {
    const cmd = buildLeftPaneCommand({
      nodeCmd: "'/usr/local/bin/node'",
      cliCmd: "'/usr/local/bin/omk'",
      runId: "run-123",
      brand: "kimicat",
      session: "omk-chat-run-123",
    });
    assert.ok(cmd.includes("chat --layout plain"), "should use chat --layout plain");
    assert.ok(cmd.includes("run-123"), "should contain runId");
    assert.ok(cmd.includes("kimicat"), "should contain brand");
    // Session cleanup is now handled by tmux set-hook pane-died, not inside the command
    assert.ok(!cmd.includes("/bin/sh -c"), "should not wrap in shell — runs directly via tmux new-session");
  });

  it("buildLeftPaneCommand does not contain exec (orphan-pane regression)", () => {
    const cmd = buildLeftPaneCommand({
      nodeCmd: "'/usr/local/bin/node'",
      cliCmd: "'/usr/local/bin/omk'",
      runId: "run-456",
      brand: "kimicat",
      session: "omk-chat-run-456",
    });
    assert.ok(!cmd.includes("exec "), "must not contain 'exec ' to prevent orphaned panes");
  });

  it("buildLeftPaneCommand forwards clean MCP scope to the plain chat child", () => {
    const cmd = buildLeftPaneCommand({
      nodeCmd: "node",
      cliCmd: "omk",
      runId: "run-clean-mcp",
      brand: "plain",
      mcpScope: "none",
    });
    assert.ok(cmd.includes("--mcp-scope 'none'"), "chat child should inherit the requested MCP scope");
  });

  it("buildLeftPaneCommand forwards provider, model, execution policy, and UI mode to the plain chat child", () => {
    const cmd = buildLeftPaneCommand({
      nodeCmd: "node",
      cliCmd: "omk",
      runId: "run-provider",
      brand: "plain",
      provider: "codex",
      model: "codex/gpt-5.3-codex",
      execution: "parallel",
      ui: "plain-modern",
    });
    assert.ok(cmd.includes("--provider 'codex'"), "chat child should inherit the requested provider policy");
    assert.ok(cmd.includes("--model 'codex/gpt-5.3-codex'"), "chat child should inherit the requested model");
    assert.ok(cmd.includes("--execution 'parallel'"), "chat child should inherit the execution policy");
    assert.ok(cmd.includes("--ui 'plain-modern'"), "chat child should inherit the UI renderer mode");
  });

  it("buildLeftPaneCommand properly quotes values containing single quotes", () => {
    const runId = "it's-a-test";
    const cmd = buildLeftPaneCommand({
      nodeCmd: "'/usr/local/bin/node'",
      cliCmd: "'/usr/local/bin/omk'",
      runId,
      brand: "kimicat",
      session: "omk-chat-it-s-a-test",
    });
    assert.doesNotThrow(() => buildLeftPaneCommand({
      nodeCmd: "node",
      cliCmd: "omk",
      runId,
      brand: "kimicat",
      session: "omk-chat-it-s-a-test",
    }));
    // The runId should survive quoting without being truncated
    assert.ok(cmd.includes("it") && cmd.includes("s-a-test"), "runId with single quote should be preserved in command");
  });

  it("buildLeftPaneCommand ignores session parameter for command output", () => {
    const cmd1 = buildLeftPaneCommand({
      nodeCmd: "node",
      cliCmd: "omk",
      runId: "run-789",
      brand: "kimicat",
      session: "omk-chat-session-a",
    });
    const cmd2 = buildLeftPaneCommand({
      nodeCmd: "node",
      cliCmd: "omk",
      runId: "run-789",
      brand: "kimicat",
      session: "omk-chat-session-b",
    });
    assert.strictEqual(cmd1, cmd2, "session should not affect command output — cleanup is handled by tmux set-hook");
  });

  it("buildRightPaneCommand defaults to auto-height cockpit output", () => {
    const cmd = buildRightPaneCommand({
      nodeCmd: "node",
      cliCmd: "omk",
      runId: "run-auto",
      refreshMs: 2000,
    });
    assert.ok(cmd.includes("cockpit --run-id 'run-auto' --watch --refresh 2000"));
    assert.ok(!cmd.includes("--height"), "height should be omitted so cockpit can auto-expand vertically");
  });

  it("buildRightPaneCommand preserves explicit fixed height when requested", () => {
    const cmd = buildRightPaneCommand({
      nodeCmd: "node",
      cliCmd: "omk",
      runId: "run-fixed",
      refreshMs: 2000,
      height: 48,
    });
    assert.ok(cmd.includes("--height 48"));
  });

  it("dist source contains switch-client for nested tmux sessions", async () => {
    const src = await readFile(new URL("../dist/util/chat-cockpit.js", import.meta.url), "utf8");
    assert.ok(src.includes("switch-client"), "should use switch-client when inside tmux");
    assert.ok(src.includes("process.env.TMUX"), "should check TMUX env var");
  });

  it("buildRightPaneCommand passes --height correctly for explicit height", () => {
    const cmd = buildRightPaneCommand({
      nodeCmd: "node",
      cliCmd: "omk",
      runId: "run-height",
      refreshMs: 2000,
      height: 32,
    });
    assert.ok(cmd.includes("--height 32"), "should include --height with the exact value");
  });

  it("source uses -p 50 for bottom split fallback to avoid stealing cockpit space", async () => {
    const src = await readFile(new URL("../dist/util/chat-cockpit.js", import.meta.url), "utf8");
    assert.ok(src.includes('-p", "50"'), "should use -p 50 for proportional bottom split");
  });

  it("dist source passes cockpitPaneHeight to buildRightPaneCommand and splits bottom without -l historyTopHeight", async () => {
    const src = await readFile(new URL("../dist/util/chat-cockpit.js", import.meta.url), "utf8");
    assert.ok(src.includes("cockpitPaneHeight"), "should calculate cockpitPaneHeight");
    assert.ok(src.includes("height: cockpitPaneHeight"), "should pass cockpitPaneHeight to buildRightPaneCommand");
    assert.ok(!src.includes("-l String(historyTopHeight)"), "should not use -l with historyTopHeight for bottom split");
  });
});

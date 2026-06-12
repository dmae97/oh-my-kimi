import test from "node:test";
import assert from "node:assert/strict";

const { NeonGridRenderer } = await import("../dist/cli/ui/neon-grid-renderer.js");
const { resolveChatUi, renderChatIntro } = await import("../dist/commands/chat/utils.js");

function createStreams(columns = 80, isTTY = false) {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    streams: {
      stdout: { write: (chunk) => stdout.push(String(chunk)), columns },
      stderr: { write: (chunk) => stderr.push(String(chunk)), isTTY, columns },
    },
  };
}

test("NeonGridRenderer renders OMK Control copy without cloning external brands", () => {
  const { stdout, stderr, streams } = createStreams(92);
  const renderer = new NeonGridRenderer(streams);

  renderer.start();
  renderer.emit({
    type: "session:start",
    runId: "neon-grid-run-123456",
    provider: "auto",
    model: "auto",
    root: "/tmp/open_multi-agent_kit",
    cwd: "/tmp/open_multi-agent_kit",
    rootSource: "cwd",
  });
  renderer.emit({ type: "prompt:ready" });
  renderer.emit({ type: "input:submitted", text: "route agents and verify evidence" });

  assert.equal(stdout.join(""), "");
  const output = stderr.join("");
  assert.match(output, /OMK\/\/CONTROL/);
  assert.match(output, /Route agents\. Verify evidence\. Control the loop\./);
  assert.match(output, /agent grid online/);
  assert.match(output, /evidence gate armed/);
  assert.match(output, /route agents and verify evidence/);
  assert.doesNotMatch(output, /Cyberpunk|THE\s+MATRIX/i);
});

test("chat UI resolver accepts neon-grid aliases", () => {
  assert.equal(resolveChatUi("neon-grid"), "neon-grid");
  assert.equal(resolveChatUi("neon"), "neon-grid");
  assert.equal(resolveChatUi("grid"), "neon-grid");
  assert.equal(resolveChatUi("control"), "neon-grid");
  assert.equal(resolveChatUi(undefined, { OMK_UI: "omk-control" }), "neon-grid");
});

test("neon-grid chat intro uses compact OMK Control copy", () => {
  const output = renderChatIntro("neon-grid", {
    agent: "root.yaml",
    runId: "neon-grid-intro",
    layout: "plain",
    trust: "bounded",
    mode: "agent",
  });

  assert.match(output, /OMK\/\/CONTROL ready/);
  assert.match(output, /OMK\/\/CONTROL/);
  assert.match(output, /NEON GRID ONLINE/);
  assert.doesNotMatch(output, /GREEN\s+RAIN\s+MODE|THE\s+MATRIX/i);
});

test("default OMK chat intro uses Neon Grid copy instead of Matrix splash", () => {
  const output = renderChatIntro("omk", {
    agent: "root.yaml",
    runId: "default-intro",
    layout: "plain",
    trust: "bounded",
    mode: "agent",
  });

  assert.match(output, /OMK\/\/CONTROL/);
  assert.match(output, /NEON GRID ONLINE/);
  assert.doesNotMatch(output, /GREEN\s+RAIN\s+MODE|THE\s+MATRIX/i);
});

test("NeonGridRenderer honors NO_COLOR and clamps visible width", () => {
  const previousNoColor = process.env.NO_COLOR;
  const previousForceColor = process.env.FORCE_COLOR;
  try {
    process.env.NO_COLOR = "1";
    delete process.env.FORCE_COLOR;
    const { stderr, streams } = createStreams(50, true);
    const renderer = new NeonGridRenderer(streams);
    renderer.start();
    renderer.emit({
      type: "session:start",
      runId: "neon-grid-accessible",
      provider: "auto",
      model: "very-long-model-name-that-should-be-truncated",
      root: "/tmp/open_multi-agent_kit/with/a/very/long/root/path",
      cwd: "/tmp/open_multi-agent_kit/with/a/very/long/root/path",
      rootSource: "cwd",
    });

    const output = stderr.join("");
    assert.doesNotMatch(output, /\x1b\[/);
    for (const line of output.split("\n").filter(Boolean)) {
      assert.ok(line.length <= 48, `line exceeded width: ${line}`);
    }
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previousNoColor;
    if (previousForceColor === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = previousForceColor;
  }
});

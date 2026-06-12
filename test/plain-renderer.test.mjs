import { strictEqual, match, doesNotMatch, ok } from "node:assert";
import { test } from "node:test";

const { PlainModernRenderer, renderAssistantCard, renderRouteCard } = await import("../dist/cli/ui/plain-renderer.js");

test("renderRouteCard renders deterministic modern plain route metadata", () => {
  const output = renderRouteCard({
    type: "turn:route",
    provider: "codex",
    model: "codex-cli",
    risk: "write",
    sandbox: "workspace-write",
    mcp: ["omk-project"],
    skills: ["omk-test-debug-loop"],
    hooks: ["protect-secrets.sh"],
  });

  match(output, /^◇ Route/m);
  match(output, /provider  codex/);
  match(output, /model     codex-cli/);
  match(output, /risk      write/);
  match(output, /sandbox   workspace-write/);
  match(output, /mcp       omk-project/);
  match(output, /skills    omk-test-debug-loop/);
  match(output, /hooks     protect-secrets\.sh/);
  doesNotMatch(output, /\u001b\[[0-9;]*m/);
  doesNotMatch(output, /\r/);
});

test("renderAssistantCard wraps assistant output without adding ANSI", () => {
  const output = renderAssistantCard("hello\n");

  strictEqual(output, "\n● Assistant\nhello\n");
  doesNotMatch(output, /\u001b\[[0-9;]*m/);
});

test("renderAssistantCard sanitizes control-plane leakage", () => {
  const output = renderAssistantCard("Loop Guard: {\"stop\": true}\nraw metadata");

  match(output, /검증 완료/);
  doesNotMatch(output, /Loop Guard/);
  doesNotMatch(output, /raw metadata/);
});

test("PlainModernRenderer routes status to stderr and assistant output to stdout", () => {
  const stdout = [];
  const stderr = [];
  const renderer = new PlainModernRenderer({
    stdout: { write: (chunk) => stdout.push(String(chunk)) },
    stderr: { write: (chunk) => stderr.push(String(chunk)), isTTY: false },
  });

  renderer.emit({ type: "session:start", runId: "r1", provider: "codex", model: "codex-cli", layout: "plain" });
  renderer.emit({ type: "input:submitted", text: "hello" });
  renderer.emit({ type: "turn:route", provider: "codex", model: "codex-cli", risk: "read", sandbox: "read-only" });
  renderer.emit({ type: "turn:heartbeat", elapsedMs: 3000, provider: "codex", model: "codex-cli" });
  renderer.emit({ type: "assistant:final", text: "answer" });
  renderer.emit({ type: "turn:finish", durationMs: 3400, exitCode: 0 });

  const statusOutput = stderr.join("");
  const assistantOutput = stdout.join("");
  match(statusOutput, /OMK Agent Console/);
  match(statusOutput, /› hello/);
  match(statusOutput, /◇ Route/);
  match(statusOutput, /◌ Running 3s/);
  match(statusOutput, /● Finished 3\.4s · exit 0/);
  strictEqual(assistantOutput, "\n● Assistant\nanswer\n");
  ok(!assistantOutput.includes("Route"));
});

test("PlainModernRenderer sanitizes control and error output", () => {
  const stdout = [];
  const stderr = [];
  const renderer = new PlainModernRenderer({
    stdout: { write: (chunk) => stdout.push(String(chunk)) },
    stderr: { write: (chunk) => stderr.push(String(chunk)), isTTY: false },
  });

  renderer.emit({ type: "control:output", text: "The model may report evidence\nraw payload" });
  renderer.emit({ type: "turn:error", message: "Loop Guard: {\"stop\": true}" });

  const output = `${stdout.join("")}${stderr.join("")}`;
  match(output, /검증 완료/);
  doesNotMatch(output, /The model may report evidence/);
  doesNotMatch(output, /Loop Guard/);
  doesNotMatch(output, /raw payload/);
});

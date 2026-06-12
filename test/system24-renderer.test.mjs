import { strictEqual, match, doesNotMatch } from "node:assert/strict";
import { test } from "node:test";

const { System24Renderer } = await import("../dist/cli/ui/system24-renderer.js");
const { GREEN_RAIN_THEME } = await import("../dist/brand/theme.js");

test("System24Renderer renders the real prompt at prompt:ready instead of a fake post-turn input panel", () => {
  const stdout = [];
  const stderr = [];
  const renderer = new System24Renderer({
    stdout: { write: (chunk) => stdout.push(String(chunk)), columns: 80 },
    stderr: { write: (chunk) => stderr.push(String(chunk)), isTTY: false, columns: 80 },
  });

  renderer.start();
  renderer.emit({ type: "prompt:ready" });
  renderer.emit({ type: "input:submitted", text: "hello" });
  renderer.emit({ type: "turn:finish", durationMs: 1200, exitCode: 0 });

  strictEqual(stdout.join(""), "");
  const output = stderr.join("");
  match(output, /input/);
  match(output, /›/);
  match(output, /hello/);
  doesNotMatch(output, /type your message/);
  strictEqual((output.match(/input/g) ?? []).length, 1);
});

test("System24Renderer clamps tiny TTY widths instead of throwing", () => {
  const stdout = [];
  const stderr = [];
  const renderer = new System24Renderer({
    stdout: { write: (chunk) => stdout.push(String(chunk)), columns: 0 },
    stderr: { write: (chunk) => stderr.push(String(chunk)), isTTY: false, columns: 0 },
  });

  renderer.start();
  renderer.emit({ type: "prompt:ready" });
  renderer.emit({ type: "turn:finish", durationMs: 1, exitCode: 0 });

  strictEqual(stdout.join(""), "");
  match(stderr.join(""), /input/);
});

test("System24Renderer shows the active root in the session panel", () => {
  const stdout = [];
  const stderr = [];
  const renderer = new System24Renderer({
    stdout: { write: (chunk) => stdout.push(String(chunk)), columns: 100 },
    stderr: { write: (chunk) => stderr.push(String(chunk)), isTTY: false, columns: 100 },
  });

  renderer.start();
  renderer.emit({
    type: "session:start",
    runId: "chat-root-visibility",
    provider: "mimo",
    model: "mimo-v2.5-pro",
    root: "/tmp/current-bash-root",
    cwd: "/tmp/current-bash-root",
    rootSource: "cwd",
  });

  strictEqual(stdout.join(""), "");
  const output = stderr.join("");
  match(output, /root/);
  match(output, /current-bash-root/);
  match(output, /cwd/);
});


test("System24Renderer accepts Green Rain theme tokens", () => {
  const stdout = [];
  const stderr = [];
  const renderer = new System24Renderer({
    stdout: { write: (chunk) => stdout.push(String(chunk)), columns: 100 },
    stderr: { write: (chunk) => stderr.push(String(chunk)), isTTY: false, columns: 100 },
  }, GREEN_RAIN_THEME, { noColor: false });

  renderer.start();
  renderer.emit({
    type: "session:start",
    runId: "green-rain-theme",
    provider: "auto",
    model: "auto",
    root: "/tmp/current-bash-root",
    cwd: "/tmp/current-bash-root",
    rootSource: "cwd",
  });

  strictEqual(stdout.join(""), "");
  const output = stderr.join("");
  match(output, /38;2;90;255;120m/);
  match(output, /OMK/);
});


test("System24Renderer honors noColor output option", () => {
  const stdout = [];
  const stderr = [];
  const renderer = new System24Renderer({
    stdout: { write: (chunk) => stdout.push(String(chunk)), columns: 100 },
    stderr: { write: (chunk) => stderr.push(String(chunk)), isTTY: false, columns: 100 },
  }, GREEN_RAIN_THEME, { noColor: true });

  renderer.start();
  renderer.emit({
    type: "session:start",
    runId: "green-rain-no-color",
    provider: "auto",
    model: "auto",
    root: "/tmp/current-bash-root",
    cwd: "/tmp/current-bash-root",
    rootSource: "cwd",
  });

  strictEqual(stdout.join(""), "");
  doesNotMatch(stderr.join(""), /\x1b\[/);
});

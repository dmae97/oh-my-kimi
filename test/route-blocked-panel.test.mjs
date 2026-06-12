import test from "node:test";
import assert from "node:assert/strict";

const { isUnsupportedRuntimeError, renderRouteBlockedPanel } = await import("../dist/cli/ui/route-blocked-panel.js");
const { PlainModernRenderer } = await import("../dist/cli/ui/plain-renderer.js");
const { System24Renderer } = await import("../dist/cli/ui/system24-renderer.js");

test("route blocked panel explains unsupported runtime errors", () => {
  const message = "No runtime supports task for node chat-turn";
  const output = renderRouteBlockedPanel(message, { width: 72 });

  assert.equal(isUnsupportedRuntimeError(message), true);
  assert.match(output, /ROUTE BLOCKED/);
  assert.match(output, /No runtime supports this task/);
  assert.match(output, /Node\s+chat-turn/);
  assert.match(output, /Provider\s+auto/);
  assert.match(output, /Capability\s+provider capability mismatch/);
  assert.match(output, /Security\s+OMK blocks runtimes/);
  assert.match(output, /omk doctor/);
  assert.match(output, /\/provider auto/);
  assert.match(output, /\/mode plan/);
});

test("route blocked panel explains MCP authority mismatches as security boundaries", () => {
  const message = "No runtime supports task for node chat-turn; Node requires MCP authority";
  const output = renderRouteBlockedPanel(message, { width: 88 });

  assert.match(output, /ROUTE BLOCKED/);
  assert.match(output, /Node\s+chat-turn/);
  assert.match(output, /OMK keeps MCP authority behind approved runtimes/);
  assert.match(output, /Node requires MCP authority/);
  assert.match(output, /replan without MCP requirement/);
});

test("route blocked panel labels write and shell blocks as env-hardened but not OS-sandboxed", () => {
  const message = "No runtime supports task for node patch-turn; Node requires provider capability write";
  const output = renderRouteBlockedPanel(message, { width: 96 });

  assert.match(output, /ROUTE BLOCKED/);
  assert.match(output, /env-hardened but not OS-sandboxed/);
  assert.match(output, /write or shell capability/);
  assert.match(output, /provider-native/);
});

test("plain renderer renders unsupported runtime errors as recovery panels", () => {
  const stderr = [];
  const renderer = new PlainModernRenderer({
    stdout: { write: () => undefined },
    stderr: { write: (chunk) => stderr.push(String(chunk)), isTTY: false },
  });

  renderer.emit({ type: "turn:error", message: "No runtime supports task for node chat-turn" });

  const output = stderr.join("");
  assert.match(output, /ROUTE BLOCKED/);
  assert.match(output, /chat-turn/);
  assert.doesNotMatch(output, /✖ No runtime supports/);
});

test("system24 renderer renders unsupported runtime errors as recovery panels", () => {
  const stderr = [];
  const renderer = new System24Renderer({
    stdout: { write: () => undefined, columns: 80 },
    stderr: { write: (chunk) => stderr.push(String(chunk)), isTTY: false, columns: 80 },
  }, undefined, { noColor: true });

  renderer.start();
  renderer.emit({ type: "turn:error", message: "No runtime supports task for node chat-turn" });

  const output = stderr.join("");
  assert.match(output, /ROUTE BLOCKED/);
  assert.match(output, /chat-turn/);
  assert.doesNotMatch(output, /✖ No runtime supports/);
});

import test from "node:test";
import assert from "node:assert/strict";

import { TerminalFrameRenderer } from "../dist/tui/terminal-frame-renderer.js";

function createCapturedRenderer(options = {}) {
  const writes = [];
  const renderer = new TerminalFrameRenderer({
    mode: options.mode ?? "diff",
    height: options.height,
    write: (chunk) => writes.push(chunk),
    clear: () => writes.push("<clear>"),
  });
  return { renderer, writes };
}

test("diff mode writes changed lines and clears stale trailing lines", () => {
  const { renderer, writes } = createCapturedRenderer({ mode: "diff" });

  renderer.render("alpha\nbeta");
  renderer.render("alpha\ngamma");
  renderer.render("alpha");

  assert.equal(writes[0], "\x1b[Halpha\x1b[K\r\nbeta\x1b[K");
  assert.equal(writes[1], "\x1b[H\r\ngamma\x1b[K");
  assert.equal(writes[2], "\x1b[H\r\n\x1b[K");
});

test("full mode clears frame before writing full content", () => {
  const { renderer, writes } = createCapturedRenderer({ mode: "full" });

  renderer.render("one\ntwo");

  assert.deepEqual(writes, ["<clear>", "one\ntwo\n"]);
});

test("append mode writes complete frames without clearing", () => {
  const { renderer, writes } = createCapturedRenderer({ mode: "append" });

  renderer.render("one");
  renderer.render("two");

  assert.deepEqual(writes, ["one\n", "two\n"]);
});

test("renderer mode can be changed between frames", () => {
  const { renderer, writes } = createCapturedRenderer({ mode: "diff" });

  renderer.render("one");
  renderer.mode = "full";
  renderer.render("two");

  assert.equal(writes[0], "\x1b[Hone\x1b[K");
  assert.deepEqual(writes.slice(1), ["<clear>", "two\n"]);
});

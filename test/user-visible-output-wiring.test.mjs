import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

async function readSource(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("chat runtime sanitizes runtime-backed raw provider output before stdout", async () => {
  const source = await readSource("src/commands/chat/runtime.ts");

  assert.match(source, /sanitizeUserVisibleOutput/);
  assert.match(source, /process\.stdout\.write\(sanitizeUserVisibleOutput\(text\)\)/);
});

test("provider streaming adapters sanitize user-visible chunks", async () => {
  const kimi = await readSource("src/adapters/kimi/runner.ts");
  const codex = await readSource("src/runtime/codex-runtime.ts");
  const local = await readSource("src/runtime/local-llm-runtime.ts");

  assert.match(kimi, /circularPush\(sanitizeUserVisibleOutput\(data\)\)/);
  assert.match(kimi, /const safeChunk = sanitizeUserVisibleOutput\(chunk\)/);
  assert.match(kimi, /options\.onOutput\?\.\(safeChunk\)/);
  assert.match(codex, /task\.context\.onOutput\?\.\(sanitizeUserVisibleOutput\(line\)\)/);
  assert.match(local, /onOutput\?\.\(sanitizeUserVisibleOutput\(delta\.content\)\)/);
});

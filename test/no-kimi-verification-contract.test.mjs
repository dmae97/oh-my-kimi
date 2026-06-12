import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("verify:no-kimi includes native non-smoke execution coverage", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const scripts = pkg.scripts ?? {};
  const verifyNoKimi = String(scripts["verify:no-kimi"] ?? "");
  const nativeTurn = String(scripts["native:no-kimi:turn"] ?? "");

  assert.match(verifyNoKimi, /native:no-kimi:turn/);
  assert.match(nativeTurn, /no-kimi-native-turn\.test\.mjs/);
  assert.doesNotMatch(nativeTurn, /--smoke/);
  assert.ok(
    verifyNoKimi
      .split("&&")
      .map((part) => part.trim())
      .some((part) => part.includes("native:no-kimi:turn") && !part.includes("smoke")),
    "verify:no-kimi must not remain smoke-only"
  );
});

import test from "node:test";
import assert from "node:assert/strict";

const {
  extractNaturalPromptInvocation,
  looksLikeNaturalPrompt,
} = await import("../dist/ux/natural-entrypoint.js");
const { routeNaturalPrompt } = await import("../dist/ux/intent-router.js");

const known = new Set(["parallel", "do", "why", "review"]);

test("natural entrypoint extracts quoted prompts and options", () => {
  const invocation = extractNaturalPromptInvocation(
    ["--provider", "codex", "--mode=plan", "--run-id", "run-ux", "fix the failing tests", "--dry-run"],
    known,
  );

  assert.equal(invocation?.prompt, "fix the failing tests");
  assert.equal(invocation?.options.provider, "codex");
  assert.equal(invocation?.options.mode, "plan");
  assert.equal(invocation?.options.runId, "run-ux");
  assert.equal(invocation?.options.dryRun, true);
});

test("natural entrypoint bypasses known subcommands", () => {
  assert.equal(extractNaturalPromptInvocation(["parallel", "fix tests"], known), undefined);
  assert.equal(extractNaturalPromptInvocation(["review"], known), undefined);
});

test("natural entrypoint accepts Korean task prompts", () => {
  assert.equal(looksLikeNaturalPrompt("테스트 고쳐줘"), true);
  const invocation = extractNaturalPromptInvocation(["테스트 고쳐줘"], known);
  assert.equal(invocation?.prompt, "테스트 고쳐줘");
});

test("natural prompt router maps common coding tasks to friendly modes", () => {
  assert.deepEqual(routeNaturalPrompt("explain this repo").intent, "explain");
  assert.deepEqual(routeNaturalPrompt("explain this repo").mode, "plan");
  assert.deepEqual(routeNaturalPrompt("review my changes").intent, "review");
  assert.deepEqual(routeNaturalPrompt("review my changes").execution, "plan-only");
  assert.deepEqual(routeNaturalPrompt("fix the failing tests").intent, "fix");
  assert.deepEqual(routeNaturalPrompt("fix the failing tests").safety, "ask-before-edit");
  assert.deepEqual(routeNaturalPrompt("add dark mode", {}, "autopilot").safety, "workspace-write");
});

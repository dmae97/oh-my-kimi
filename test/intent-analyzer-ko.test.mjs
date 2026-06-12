import test from "node:test";
import assert from "node:assert/strict";

import { analyzeUserIntentFast, analyzeUserIntentV2 } from "../dist/goal/intent-analyzer.js";

test("Korean OMK TUI prompt maps to TUI target surface", async () => {
  const intent = await analyzeUserIntentV2({
    rawPrompt: "omk 레포에서 tui 고도화 하는법 봐줘",
  });

  assert.ok(intent.targetSurfaces.includes("tui"));
  assert.ok(intent.domainTerms.includes("tui"));
  assert.equal(intent.language, "mixed");
  assert.ok(intent.confidence >= 0.6);
});

test("mixed NLP intent routing prompt maps to NLP target surface", () => {
  const intent = analyzeUserIntentFast("nlp intent 라우팅 개선 방향 잡아줘");

  assert.ok(intent.targetSurfaces.includes("nlp"));
  assert.ok(intent.domainTerms.includes("nlp"));
  assert.ok(intent.domainTerms.includes("intent"));
  assert.ok(intent.requiredRoles.includes("nlp-architect"));
});

test("Korean harness prompt requests common harness routing hints", () => {
  const intent = analyzeUserIntentFast("기존 하네스 연결하고 TaskRunner / DagExecutor 기준으로 검증해줘");

  assert.ok(intent.targetSurfaces.includes("harness"));
  assert.ok(intent.routingHints.requireHarness);
  assert.ok(intent.routingHints.requireEvidence);
  assert.ok(intent.domainTerms.includes("하네스"));
});

test("direct OMK admin command is high-severity ambiguity", () => {
  const intent = analyzeUserIntentFast("omk doctor 실행해줘");
  const adminSignals = intent.ambiguitySignals.filter((signal) => signal.kind === "admin-command");

  assert.equal(adminSignals.length, 1);
  assert.equal(adminSignals[0].severity, "high");
});

test("command feature improvement is not classified as direct admin execution", () => {
  const intent = analyzeUserIntentFast("doctor 기능 개선해줘");
  const adminSignals = intent.ambiguitySignals.filter((signal) => signal.kind === "admin-command");

  assert.equal(adminSignals.length, 1);
  assert.equal(adminSignals[0].severity, "low");
  assert.doesNotMatch(intent.rationale, /admin-command:high/);
  assert.ok(!intent.targetSurfaces.includes("docs"));
});

test("explicit OMK command feature improvement is not direct admin execution", () => {
  const intent = analyzeUserIntentFast("omk doctor 기능 개선해줘");
  const adminSignals = intent.ambiguitySignals.filter((signal) => signal.kind === "admin-command");

  assert.equal(adminSignals.length, 1);
  assert.equal(adminSignals[0].severity, "low");
  assert.doesNotMatch(intent.rationale, /admin-command:high/);
});

test("ASCII domain terms do not match inside unrelated words", () => {
  const intent = analyzeUserIntentFast("latest status 확인해줘");

  assert.ok(!intent.targetSurfaces.includes("tests"));
});

test("extracts explicit files and commands from architecture prompts", () => {
  const intent = analyzeUserIntentFast("`omk cockpit --watch`와 `src/commands/cockpit/update-loop.ts`를 확인해줘");

  assert.deepEqual(intent.extractedCommands, ["omk cockpit --watch"]);
  assert.ok(intent.extractedFiles.includes("src/commands/cockpit/update-loop.ts"));
  assert.ok(intent.targetSurfaces.includes("tui"));
});

test("redacts secret-like command arguments before exposing extracted commands", () => {
  const apiKey = ["sk", "1234567890abcdef"].join("-");
  const tokenAssignment = ["TO", "KEN=sample-token-value"].join("");
  const intent = analyzeUserIntentFast(`\`npm run deploy -- --api-key=${apiKey} ${tokenAssignment}\` 실행 전 검토해줘`);

  assert.equal(intent.extractedCommands.length, 1);
  assert.match(intent.extractedCommands[0], /\*\*\*REDACTED\*\*\*/);
  assert.doesNotMatch(intent.extractedCommands[0], new RegExp(apiKey));
  assert.doesNotMatch(intent.extractedCommands[0], new RegExp(tokenAssignment));
});

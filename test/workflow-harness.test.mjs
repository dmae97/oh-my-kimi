import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf-8");
}

test("release workflow does not mask npm test failures behind tee", () => {
  const workflow = read(".github/workflows/release.yml");
  const runTestsStep = workflow.match(/- name: Run tests\n(?<body>(?:        .+\n|          .+\n)+)/)?.groups?.body ?? "";

  assert.match(runTestsStep, /npm test 2>&1 \| tee test-output\.log/);
  assert.match(runTestsStep, /set -o pipefail/);
});

test("CI exposes the local release:check gate", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /verify-no-kimi:/);
  assert.match(workflow, /npm run verify:no-kimi/);
  assert.match(workflow, /release-check:/);
  assert.match(workflow, /npm run release:check/);
  assert.match(workflow, /node scripts\/run-tests\.mjs/);
  assert.match(workflow, /npm run native:build/);
  assert.match(workflow, /npm run audit:package/);
  assert.match(workflow, /npm run secret:scan:runtime/);
  assert.doesNotMatch(workflow, /OMK_SKIP_DIST_FRESHNESS/);
});

test("release workflow runs YAML, package audit, and install smoke gates", () => {
  const workflow = read(".github/workflows/release.yml");
  assert.match(workflow, /npm run yaml:check/);
  assert.match(workflow, /npm run secret:scan:runtime/);
  assert.match(workflow, /native:/);
  assert.match(workflow, /npm run native:build/);
  assert.match(workflow, /pattern: native-\*/);
  assert.match(workflow, /npm run native:normalize/);
  assert.match(workflow, /npm run audit:package/);
  assert.match(workflow, /node scripts\/package-audit\.mjs --tarball/);
  assert.match(workflow, /node scripts\/smoke-test\.mjs --tarball/);
  assert.match(workflow, /open-multi-agent-kit-\*\.tgz/);
  assert.doesNotMatch(workflow, /oh-my-kimi-cli-\*\.tgz/);
});

test("smoke workflow tests before packaging and audits the produced tarball", () => {
  const workflow = read(".github/workflows/smoke-test.yml");
  assert.match(workflow, /npm run yaml:check/);
  assert.match(workflow, /npm rebuild/);
  assert.match(workflow, /npm run build:clean/);
  assert.match(workflow, /npm test/);
  assert.doesNotMatch(workflow, /OMK_SKIP_DIST_FRESHNESS/);
  assert.match(workflow, /native:/);
  assert.match(workflow, /npm run native:build/);
  assert.match(workflow, /pattern: native-\*/);
  assert.match(workflow, /npm run native:normalize/);
  assert.match(workflow, /npm run audit:package/);
  assert.match(workflow, /node scripts\/package-audit\.mjs --tarball/);
  assert.match(workflow, /open-multi-agent-kit-\*\.tgz/);
  assert.doesNotMatch(workflow, /oh-my-kimi-cli-\*\.tgz/);
});

test("pack-smoke evidence includes pack, audit, and install smoke phases", () => {
  const script = read("scripts/pack-smoke.mjs");
  assert.match(script, /Pack Smoke Evidence/);
  assert.match(script, /package audit/);
  assert.match(script, /install smoke/);
});

test("package release:check composes the full local gate", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts.verify, /npm run secret:scan:runtime/);
  assert.match(pkg.scripts["verify:no-kimi"], /npm run native:no-kimi:turn/);
  assert.match(pkg.scripts["release:check"], /npm run verify/);
  assert.match(pkg.scripts["release:check"], /npm run native:build/);
  assert.match(pkg.scripts["release:check"], /npm run audit:package/);
  assert.match(pkg.scripts["release:check"], /npm run smoke:pack/);
});

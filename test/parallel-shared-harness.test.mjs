import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const workerSourcePath = join(process.cwd(), "src", "commands", "parallel", "worker.ts");

async function readWorkerSource() {
  return readFile(workerSourcePath, "utf-8");
}

test("parallel worker delegates DAG execution to the shared harness", async () => {
  const source = await readWorkerSource();

  assert.match(source, /import \{ createHarnessTaskRunner \} from "\.\.\/\.\.\/harness\/create-harness-task-runner\.js";/);
  assert.match(source, /import \{ executeHarnessRun \} from "\.\.\/\.\.\/harness\/execute-harness-run\.js";/);
  assert.doesNotMatch(source, /from "\.\.\/\.\.\/orchestration\/executor\.js"/);
  assert.doesNotMatch(source, /from "\.\.\/\.\.\/orchestration\/state-persister\.js"/);
  assert.doesNotMatch(source, /createExecutor\s*\(/);
  assert.doesNotMatch(source, /createStatePersister\s*\(/);
  assert.doesNotMatch(source, /\.execute\(dag, runner/);
});

test("parallel shared harness call preserves run-state resume and telemetry options", async () => {
  const source = await readWorkerSource();
  const call = /await executeHarnessRun\(\{([\s\S]*?)\n    \}\);/.exec(source)?.[1] ?? "";

  assert.match(call, /root,/);
  assert.match(call, /runId,/);
  assert.match(call, /dag,/);
  assert.match(call, /runner,/);
  assert.match(call, /env: harnessEnv,/);
  assert.match(call, /workers: workerCount,/);
  assert.match(call, /approvalPolicy:/);
  assert.match(call, /nodeTimeoutMs: options\.timeoutPreset \? undefined : 600_000,/);
  assert.match(call, /timeoutPreset: options\.timeoutPreset,/);
  assert.match(call, /resumeFromState: routedState,/);
  assert.match(call, /eventRunDir: runDir,/);
  assert.match(call, /ensemble: resources\.ensembleDefaultEnabled \? \{\} : false,/);
  assert.match(call, /signal: abortController\.signal,/);
  assert.match(call, /onStateChange: handleStateChange,/);
});

test("parallel runner factory receives the same harness env used for execution", async () => {
  const source = await readWorkerSource();
  const runnerCall = /await createHarnessTaskRunner\(\{([\s\S]*?)\n  \}\);/.exec(source)?.[1] ?? "";

  assert.match(runnerCall, /mode: "parallel",/);
  assert.match(runnerCall, /providerPolicy,/);
  assert.match(runnerCall, /eventRunDir: runDir,/);
  assert.match(runnerCall, /mcpScope,/);
  assert.match(runnerCall, /skillsScope: resources\.skillsScope,/);
  assert.match(runnerCall, /hooksScope: resources\.hooksScope,/);
  assert.match(runnerCall, /env: harnessEnv,/);

  const executionCall = /await executeHarnessRun\(\{([\s\S]*?)\n    \}\);/.exec(source)?.[1] ?? "";
  assert.match(executionCall, /env: harnessEnv,/);
});

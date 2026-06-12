import { appendFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { InputEnvelope } from "../input/input-envelope.js";
import type { LoopDecision, OrchestrationLoopState } from "./loop-state.js";

export interface PersistLoopArtifactsOptions {
  root: string;
  runId?: string;
  nextInputEnvelope?: InputEnvelope;
}

export interface PersistLoopArtifactsResult {
  runDir: string;
  statePath: string;
  decisionsPath: string;
  nextInputPath?: string;
}

export async function persistLoopArtifacts(
  state: OrchestrationLoopState,
  decision: LoopDecision,
  options: PersistLoopArtifactsOptions,
): Promise<PersistLoopArtifactsResult> {
  const runId = options.runId ?? state.runId;
  const runDir = join(options.root, ".omk", "runs", runId);
  await mkdir(runDir, { recursive: true });
  const statePath = join(runDir, "loop-state.json");
  const decisionsPath = join(runDir, "loop-decisions.jsonl");
  const nextInputPath = options.nextInputEnvelope
    ? join(runDir, "next-input-envelope.json")
    : undefined;
  await Promise.all([
    writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8"),
    appendFile(decisionsPath, `${JSON.stringify(decision)}\n`, "utf-8"),
    nextInputPath && options.nextInputEnvelope
      ? writeFile(nextInputPath, `${JSON.stringify(options.nextInputEnvelope, null, 2)}\n`, "utf-8")
      : Promise.resolve(),
  ]);
  return { runDir, statePath, decisionsPath, nextInputPath };
}

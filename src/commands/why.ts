import { readFile } from "fs/promises";

import type { LoopDecision, OrchestrationLoopState } from "../orchestration/loop-state.js";
import { getRunArtifactPath, listValidRunIds, resolveProjectRoot } from "../util/fs.js";
import { explainLoopDecision } from "../ux/explain-loop-decision.js";

export interface WhyCommandOptions {
  runId?: string;
  root?: string;
  json?: boolean;
  emit?: boolean;
}

export interface WhyCommandResult {
  runId: string;
  decision: LoopDecision;
  lines: string[];
  statePath: string;
}

export async function whyCommand(options: WhyCommandOptions = {}): Promise<WhyCommandResult> {
  const root = options.root ?? resolveProjectRoot().root;
  const runId = await resolveRunId(root, options.runId ?? process.env.OMK_RUN_ID);
  const statePath = getRunArtifactPath(runId, "loop-state.json", root);
  const state = await readLoopState(statePath);
  const decision = state.decisions.at(-1);
  if (!decision) throw new Error(`No loop decisions found for run ${runId}`);
  const lines = explainLoopDecision(decision);

  if (options.emit !== false) {
    if (options.json) {
      console.log(JSON.stringify({ runId, statePath, decision }, null, 2));
    } else {
      console.log(`Why ${runId}`);
      for (const line of lines) console.log(`  ${line}`);
    }
  }

  return { runId, decision, lines, statePath };
}

async function resolveRunId(root: string, requested: string | undefined): Promise<string> {
  if (requested) return requested;
  const runIds = await listValidRunIds(root);
  const latest = runIds.sort().at(-1);
  if (!latest) throw new Error("No OMK run found. Pass --run-id <id>.");
  return latest;
}

async function readLoopState(path: string): Promise<OrchestrationLoopState> {
  const raw = await readFile(path, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!isLoopState(parsed)) throw new Error(`Invalid loop-state artifact: ${path}`);
  return parsed;
}

function isLoopState(value: unknown): value is OrchestrationLoopState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { schemaVersion?: unknown; decisions?: unknown };
  return candidate.schemaVersion === 1 && Array.isArray(candidate.decisions);
}

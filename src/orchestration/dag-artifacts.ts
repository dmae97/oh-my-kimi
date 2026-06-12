import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { DagCompileResult } from "./dag-compiler-types.js";

export interface PersistDagCompileArtifactsOptions {
  root: string;
  runId?: string;
}

export async function persistDagCompileArtifacts(
  result: DagCompileResult,
  options: PersistDagCompileArtifactsOptions,
): Promise<{ runDir: string; dagPath: string; reportPath: string }> {
  const runId = options.runId ?? result.runId;
  const runDir = join(options.root, ".omk", "runs", runId);
  await mkdir(runDir, { recursive: true });
  const dagPath = join(runDir, "dag.json");
  const reportPath = join(runDir, "dag-compile-report.json");
  await Promise.all([
    writeFile(dagPath, `${JSON.stringify(result.dag, null, 2)}\n`, "utf-8"),
    writeFile(
      reportPath,
      `${JSON.stringify(renderDagCompileReport(result), null, 2)}\n`,
      "utf-8",
    ),
    result.intent
      ? writeFile(
          join(runDir, "intent-analysis.json"),
          `${JSON.stringify({ schemaVersion: 1, analyzer: "UserIntentV2", inputId: result.inputId, intent: result.intent, createdAt: result.compiledAt }, null, 2)}\n`,
          "utf-8",
        )
      : Promise.resolve(),
    result.intentFrame
      ? writeFile(
          join(runDir, "intent-frame.json"),
          `${JSON.stringify(result.intentFrame, null, 2)}\n`,
          "utf-8",
        )
      : Promise.resolve(),
  ]);
  return { runDir, dagPath, reportPath };
}

export function renderDagCompileReport(
  result: DagCompileResult,
): Record<string, unknown> {
  return {
    schemaVersion: result.schemaVersion,
    inputId: result.inputId,
    runId: result.runId,
    workerCount: result.workerCount,
    executionStrategy: result.executionStrategy,
    explanation: result.artifacts.explanation,
    nodeCount: result.dag.nodes.length,
    nodes: result.dag.nodes.map((node) => ({
      id: node.id,
      role: node.role,
      status: node.status,
      provider: node.routing?.provider,
      model: node.routing?.providerModel,
      readOnly: node.routing?.readOnly,
      risk: node.routing?.risk,
      evidenceRequired: node.routing?.evidenceRequired,
    })),
    compiledAt: result.compiledAt,
  };
}
